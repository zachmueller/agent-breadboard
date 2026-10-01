import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BreadboardError, mintSessionId, mintUid, zBreadboardConfig, SCHEMA_TAGS, type BreadboardConfig, type SessionRecord } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import type { ConfigService, EnqueueRunInput, EventBus, Orchestrator, SessionStore } from '../core/services.js';
import { createContentService } from '../content/service.js';
import { createTaskService, type TaskServiceImpl } from './tasks.js';

let f: Foundation;
let tasks: TaskServiceImpl;
let settings: BreadboardConfig;
const TRIAGE = mintUid();
const DIRECT = mintUid();
const enqueued: EnqueueRunInput[] = [];
const published: Array<{ topic: string; payload: any }> = [];

function rowToSession(row: any): SessionRecord {
  return { ...row, circuit_uid: row.circuit_uid?.trim() ?? null, task_uid: row.task_uid?.trim() ?? null } as SessionRecord;
}

beforeAll(async () => {
  f = await createFoundation();
  settings = zBreadboardConfig.parse({ schema: SCHEMA_TAGS.breadboard, intake: { triage_circuit: TRIAGE, draft_retention_days: 30 } });
  const events = { publish: async (topic: string, payload: any) => void published.push({ topic, payload }) } as unknown as EventBus;
  const sessions = {
    async get(id: string) {
      const r = await f.db.query(`SELECT * FROM sessions WHERE session_id=$1`, [id]);
      return r.rows[0] ? rowToSession(r.rows[0]) : null;
    },
    async list(flt: { task?: string; state?: string[] }) {
      const r = await f.db.query(`SELECT * FROM sessions WHERE ($1::text IS NULL OR task_uid=$1) AND ($2::text[] IS NULL OR state = ANY($2::text[]))`, [flt.task ?? null, flt.state ?? null]);
      return { items: r.rows.map(rowToSession), next_cursor: null };
    },
  } as unknown as SessionStore;
  const orchestrator = {
    async enqueue(input: EnqueueRunInput) {
      enqueued.push(input);
      const sid = mintSessionId();
      await f.db.query(`INSERT INTO sessions (session_id, team_id, kind, circuit_uid, task_uid, state, budget) VALUES ($1,$2,'circuit-run',$3,$4,'queued','{}')`, [sid, f.team_id, input.circuit_uid, input.task_uid ?? null]);
      return (await sessions.get(sid))!;
    },
  } as unknown as Orchestrator;
  const config = {
    settings: async () => settings,
    circuit: async (uid: string) => {
      if (uid === TRIAGE || uid === DIRECT) return { uid } as any;
      throw new BreadboardError('not-found', `circuit ${uid} not found`);
    },
  } as unknown as ConfigService;
  const content = createContentService({
    db: f.db, team_id: f.team_id, nodes: f.nodes, edges: f.edges, graph: f.graph, linkIndexer: f.linkIndexer, identity: f.identity,
    events, settings: async () => settings, knowledge: () => null, sessions: () => sessions, log: f.log,
  });
  tasks = createTaskService({
    db: f.db, team_id: f.team_id, nodes: f.nodes, edges: f.edges, graph: f.graph, content,
    orchestrator: () => orchestrator, sessions: () => sessions, config, knowledge: () => null, events, log: f.log,
  });
});
afterAll(async () => f.close());

async function setSessionsDone(taskUid: string) {
  await f.db.query(`UPDATE sessions SET state='completed' WHERE task_uid=$1`, [taskUid]);
}

describe('TaskService', () => {
  it('creates queued tasks with an intake revision, origin and default priority', async () => {
    const t = await tasks.create({ title: 'Benchmark the parser', body: 'Measure parse throughput on big files.', by: f.memberPrincipal });
    expect(t.type).toBe('task');
    expect(t.crdt).toBe(false);
    expect(t.body_text).toContain('throughput');
    expect(t.properties).toMatchObject({ status: 'queued', priority: 'p2', origin: { kind: 'user' } });
    expect(t.tags.some((x) => x.startsWith('origin:'))).toBe(false);
    expect(t.head_revision).toBe(1);
    expect((await f.nodes.listRevisions(t.uid))[0]!.labels).toEqual(['intake']);
    expect(published.some((p) => p.topic === 'task.status' && p.payload.uid === t.uid)).toBe(true);

    const api = await tasks.create({ title: 'From API', body: 'x', by: f.servicePrincipal });
    expect(api.tags).toContain('origin:api');
    await expect(tasks.create({ title: 'bad', body: '', target_circuit: mintUid(), by: f.memberPrincipal })).rejects.toMatchObject({ code: 'validation-failed' });
    await expect(tasks.create({ title: 'bad', body: '', priority: 'p9', by: f.memberPrincipal })).rejects.toMatchObject({ code: 'validation-failed' });
  });

  it('flags likely duplicates with possible-dup-of tags and references edges', async () => {
    const a = await tasks.create({ title: 'Investigate flaky login integration test', body: 'The login integration test fails intermittently on CI.', draft: true, by: f.memberPrincipal });
    const b = await tasks.create({ title: 'Flaky login integration test on CI', body: 'Login integration test intermittently fails.', draft: true, by: f.memberPrincipal });
    expect(b.tags).toContain(`possible-dup-of:${a.uid}`);
    expect(await f.edges.exists('references', b.uid, a.uid)).toBeTruthy();
    const sim = await tasks.similar('flaky login test', f.memberPrincipal);
    expect(sim.map((s) => s.uid)).toEqual(expect.arrayContaining([a.uid, b.uid]));
    // drafts have no revision until accepted
    expect(a.head_revision).toBeNull();
    const acc = await tasks.accept(a.uid, f.memberPrincipal);
    expect(acc.properties.status).toBe('queued');
    expect(acc.head_revision).toBe(1);
    await expect(tasks.accept(a.uid, f.memberPrincipal)).rejects.toMatchObject({ code: 'invalid-state' });
    await tasks.discard(b.uid, f.memberPrincipal);
    expect(await f.nodes.get(b.uid)).toBeNull();
    await f.db.query(`UPDATE nodes SET properties = properties || '{"status":"rejected"}' WHERE uid=$1`, [a.uid]);
  });

  it('promote raises priority, strips origin tags, marks reviewed; reject records reason', async () => {
    const t = await tasks.create({ title: 'Agent idea', body: 'y', by: f.servicePrincipal, priority: 'p3' });
    const p = await tasks.promote(t.uid, f.memberPrincipal);
    expect(p.properties.priority).toBe('p2');
    expect(p.tags).toEqual(expect.arrayContaining(['reviewed']));
    expect(p.tags.some((x) => x.startsWith('origin:'))).toBe(false);
    const r = await tasks.reject(t.uid, f.memberPrincipal, 'not now');
    expect(r.properties).toMatchObject({ status: 'rejected', rejected_reason: 'not now' });
    const m = await tasks.markReviewed((await tasks.create({ title: 'z', body: 'z', by: f.servicePrincipal })).uid, f.memberPrincipal);
    expect(m.tags).toEqual(expect.arrayContaining(['reviewed', 'origin:api']));
  });

  it('dispatches via triage or target_circuit, once per active session, honoring dependencies', async () => {
    // Clear the queue from earlier tests.
    await f.db.query(`UPDATE nodes SET properties = properties || '{"status":"done"}' WHERE type='task' AND properties->>'status'='queued'`);
    enqueued.length = 0;
    const dep = await tasks.create({ title: 'Prerequisite', body: 'first', by: f.memberPrincipal });
    const waiter = await tasks.create({ title: 'Follow-up', body: 'second', target_circuit: DIRECT, by: f.memberPrincipal });
    await f.edges.emit({ type: 'depends-on', src_uid: waiter.uid, dst_uid: dep.uid, created_by: f.memberPrincipal.actor });

    const s1 = await tasks.dispatchQueued();
    expect(s1).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ circuit_uid: TRIAGE, task_uid: dep.uid, priority: 'p2', input: { task: { uid: dep.uid, revision_id: 1 }, title: 'Prerequisite', body: 'first' } });
    expect(enqueued[0]!.created_by).toMatchObject({ kind: 'service', id: 'dispatcher' });
    expect((await f.nodes.get(dep.uid))!.properties.status).toBe('triaging');

    // No duplicate while active; waiter blocked by dependency.
    expect(await tasks.dispatchQueued()).toEqual([]);

    await tasks.setStatus(dep.uid, 'done', f.servicePrincipal.actor, { reason: 'test' });
    await setSessionsDone(dep.uid);
    const hist = (await f.nodes.get(dep.uid))!.properties.status_history as any[];
    expect(hist.map((h) => h.to)).toEqual(['triaging', 'done']);

    const s2 = await tasks.dispatchQueued();
    expect(s2).toHaveLength(1);
    expect(enqueued[1]).toMatchObject({ circuit_uid: DIRECT, task_uid: waiter.uid });
    // Target-circuit bypass leaves the task queued; the active session prevents re-dispatch.
    expect((await f.nodes.get(waiter.uid))!.properties.status).toBe('queued');
    expect(await tasks.dispatchQueued()).toEqual([]);
    await setSessionsDone(waiter.uid);
    await tasks.setStatus(waiter.uid, 'done', f.servicePrincipal.actor);

    // Without a triage circuit, untargeted tasks stay queued.
    settings = { ...settings, intake: { ...settings.intake, triage_circuit: undefined } };
    const lonely = await tasks.create({ title: 'Lonely', body: 'q', by: f.memberPrincipal });
    expect(await tasks.dispatchQueued()).toEqual([]);
    expect((await f.nodes.get(lonely.uid))!.properties.status).toBe('queued');
  });

  it('lists the queue with queue_age_s and drafts filter; archives stale drafts', async () => {
    const list = await tasks.list({}, f.memberPrincipal);
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((t) => ['queued', 'triaging', 'active', 'gated'].includes(t.properties.status as string))).toBe(true);
    const queued = list.items.find((t) => t.properties.status === 'queued')!;
    expect(typeof queued.queue_age_s).toBe('number');

    const d = await tasks.create({ title: 'Old draft', body: 'stale', draft: true, by: f.memberPrincipal });
    const drafts = await tasks.list({ drafts: 'true' }, f.memberPrincipal);
    expect(drafts.items.map((t) => t.uid)).toContain(d.uid);
    expect(drafts.items.every((t) => t.queue_age_s === null)).toBe(true);
    await f.db.query(`UPDATE nodes SET updated_at = now() - interval '40 days' WHERE uid=$1`, [d.uid]);
    expect(await tasks.archiveStaleDrafts()).toBe(1);
    expect(await f.nodes.get(d.uid)).toBeNull();
  });
});
