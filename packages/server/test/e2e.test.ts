/**
 * End-to-end: boot the real service container against the shipped config seed (PGlite in-memory, or Postgres with
 * TEST_DATABASE_URL; mock model provider, process sandbox), then drive the Phase 6 acceptance path from
 * specs/13-roadmap.md through the REST API:
 * task → auto-dispatch → triage → lit-review (LLM + code steps) → gate → review queue → verdict → done, with lineage.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../src/core/env.js';
import { testDatabaseUrl } from '../src/test/harness.js';
import { silentLogger } from '../src/core/logger.js';
import { buildServices, startBackground, stopServices, type BuiltServices } from '../src/core/build.js';
import { buildApp } from '../src/app.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const ADMIN = 'dev-admin-token-change-me';
const MEMBER = 'dev-member-token-change-me';

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as any).port;
      s.close(() => res(p));
    });
  });
}

let services: BuiltServices;
let app: FastifyInstance;
let tmp: string;
let dropDb: () => Promise<void> = async () => undefined;

async function api(method: string, path: string, token = ADMIN, body?: unknown) {
  const res = await app.inject({ method: method as any, url: `/api/v1${path}`, headers: { authorization: `Bearer ${token}`, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) }, payload: JSON.stringify(body ?? (method === 'GET' ? undefined : {})) });
  let json: any = null;
  try {
    json = res.json();
  } catch {}
  return { status: res.statusCode, json };
}

async function waitUntil(fn: () => Promise<boolean>, ms = 60_000, every = 250): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error('timed out waiting');
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'bb-e2e-'));
  const port = await freePort();
  const proxyPort = await freePort();
  const testDb = await testDatabaseUrl();
  dropDb = testDb.drop;
  const env = loadEnv({
    DATABASE_URL: testDb.url,
    CONFIG_REPO_DIR: join(tmp, 'repo'),
    CONFIG_WORKTREE_CACHE_DIR: join(tmp, 'trees'),
    CONFIG_SEED_DIR: resolve(ROOT, 'config-seed'),
    OBJECT_STORE_DIR: join(tmp, 'objects'),
    MODEL_PROVIDER: 'mock',
    SANDBOX_RUNNER: 'process',
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    PORT: port,
    SANDBOX_EGRESS_PROXY_PORT: proxyPort,
    LOG_PRETTY: false,
    CONNECTORS_ENABLED: false,
  } as any);
  services = await buildServices({ env, log: silentLogger, root: ROOT });
  app = await buildApp(services);
  await app.listen({ port, host: '127.0.0.1' });
  await startBackground(services);
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (services) await stopServices(services);
  await dropDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('end-to-end against the shipped seed', () => {
  it('serves health, auth, and the seeded config tree', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(health.statusCode).toBe(200);
    const me = await api('GET', '/me');
    expect(me.status).toBe(200);
    expect(me.json.user.handle).toBe('admin');
    expect(me.json.is_admin).toBe(true);
    const member = await api('GET', '/me', MEMBER);
    expect(member.json.roles).toContain('scientist');
    const anon = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(anon.statusCode).toBe(401);
    const tree = await api('GET', '/config/tree');
    expect(tree.status).toBe(200);
    const items = tree.json.items ?? tree.json;
    expect(items.filter((e: any) => e.kind === 'circuit').length).toBeGreaterThanOrEqual(7);
    expect(items.filter((e: any) => e.kind === 'subagent').length).toBeGreaterThanOrEqual(13);
    const validation = await services.config.validateTree();
    expect(validation.errors).toEqual([]);
    // Claude and Nova 2 models are invocable on Bedrock only through an inference profile, not the bare model id.
    const presets = await services.config.presets();
    for (const entry of Object.values(presets.presets).flat()) {
      if (/anthropic\.|nova-2/.test(entry.model_id)) expect(entry.model_id).toMatch(/^(us|eu|apac|global)\./);
    }
  });

  it('runs a task through triage → lit-review → gate → verdict → done with lineage', async () => {
    const created = await api('POST', '/tasks', ADMIN, { title: 'Survey prior art on CRDT text editors', body: 'We want a short literature review.', priority: 'p1' });
    expect(created.status, JSON.stringify(created.json)).toBeLessThan(300);
    const taskUid = created.json.uid;
    expect(taskUid).toHaveLength(20);
    expect(created.json.properties.status).toBe('queued');

    // Auto-dispatch: a top-level triage session appears and the gate eventually suspends it (or its child).
    let gated: any = null;
    await waitUntil(async () => {
      const r = await api('GET', `/sessions?task=${taskUid}`);
      const sessions = r.json.items ?? [];
      gated = sessions.find((s: any) => s.state === 'suspended-gate' && s.kind === 'circuit-run') ?? null;
      const errored = sessions.find((s: any) => s.state === 'suspended-error');
      if (errored) {
        const detail = await api('GET', `/sessions/${errored.session_id}`);
        throw new Error('session suspended with error: ' + JSON.stringify(detail.json.state_detail));
      }
      return !!gated;
    }, 90_000);

    // The gating artifact is in the scientist's review queue with a gate-created request.
    const queue = await api('GET', '/review-queue', MEMBER);
    expect(queue.status).toBe(200);
    const items = queue.json.items ?? queue.json;
    const item = items.find((i: any) => i.requests.some((r: any) => r.gate));
    expect(item, JSON.stringify(items)).toBeTruthy();
    const req = item.requests.find((r: any) => r.gate);
    expect(req.role).toBe('scientist');

    // A non-targeted actor cannot record a verdict; the targeted scientist can.
    const svc = await services.identity.createServiceToken({ team_id: services.team_id, name: 'ci', scopes: ['nodes:write'], created_by: { kind: 'service', id: 'test' } });
    const denied = await api('POST', `/nodes/${item.node.uid}/gate-verdict`, svc.secret, { request_id: req.request_id, verdict: 'approve' });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    const verdict = await api('POST', `/nodes/${item.node.uid}/gate-verdict`, MEMBER, { request_id: req.request_id, verdict: 'approve', comment: 'Looks good.' });
    expect(verdict.status, JSON.stringify(verdict.json)).toBeLessThan(300);

    // The run completes and the task is done.
    await waitUntil(async () => {
      const r = await api('GET', `/sessions?task=${taskUid}`);
      const top = (r.json.items ?? []).find((s: any) => !s.parent_session);
      return top?.state === 'completed';
    }, 90_000);
    const task = await api('GET', `/nodes/${taskUid}`);
    expect(task.json.properties.status).toBe('done');

    // Lineage: the deliverable traces up to the producing session, and the task has a produces edge chain.
    const lineage = await api('GET', `/nodes/${item.node.uid}/lineage?direction=up&depth=5`);
    expect(lineage.status).toBe(200);
    expect(lineage.json.edges.some((e: any) => e.type === 'produces' && e.src_session_id)).toBe(true);
    const summary = await api('GET', `/sessions/${gated.session_id}`);
    expect(summary.json.steps.length).toBeGreaterThanOrEqual(3);
    expect(summary.json.cost_usd).toBeGreaterThan(0);
    const events = await api('GET', `/sessions/${gated.session_id}/events`);
    const types = (events.json.items ?? events.json).map((e: any) => e.event_type);
    for (const t of ['session-started', 'config-resolved', 'step-started', 'turn', 'step-exited', 'checkpoint', 'gate-suspended', 'gate-verdict', 'gate-resolved']) expect(types, t).toContain(t);
    // Revisions carry the gate-resolution label on the gated artifact.
    const revs = await api('GET', `/nodes/${item.node.uid}/revisions`);
    const labels = (revs.json.items ?? revs.json).flatMap((r: any) => r.labels);
    expect(labels).toContain('gate-resolution');
  }, 200_000);

  it('knowledge: create a note, AI edit via reconcile, search, and MCP tool listing', async () => {
    const note = await api('POST', '/knowledge', ADMIN, { title: 'Glossary', markdown: '# Glossary\n\nCRDT: conflict-free replicated data type.\n', domains: ['glossary'] });
    expect(note.status, JSON.stringify(note.json)).toBeLessThan(300);
    const uid = note.json.uid;
    const read = await api('GET', `/knowledge/${uid}`);
    expect(read.json.base_revision).toBeGreaterThan(0);
    const edit = await api('POST', `/knowledge/${uid}/edits`, ADMIN, { base_revision: read.json.base_revision, markdown: read.json.markdown + '\nYjs: a CRDT implementation.\n' });
    expect(edit.status, JSON.stringify(edit.json)).toBeLessThan(300);
    expect(edit.json.applied).toBe(true);
    expect(edit.json.merged_markdown).toContain('Yjs');
    await waitUntil(async () => (await api('GET', '/knowledge/search?q=Yjs&mode=text')).json.items?.length > 0, 15_000);
    const prim = await api('GET', '/primitives');
    const names = (prim.json.items ?? prim.json).map((p: any) => p.name);
    expect(names).toContain('create_task');
    expect(names).toContain('propose_note_edit');
  }, 60_000);

  it('config plane: propose, validate, merge a subagent change through the API', async () => {
    const def = await api('GET', '/config/definitions/01J8SATR1AGEC1ASS000');
    expect(def.status).toBe(200);
    const raw: string = def.json.raw;
    const changed = raw.replace('title: ', 'title: Edited ');
    const proposal = await api('POST', '/config/proposals', ADMIN, { changes: [{ path: def.json.path, content: changed }], message: 'Rename classifier' });
    expect(proposal.status, JSON.stringify(proposal.json)).toBeLessThan(300);
    expect(proposal.json.validation.ok).toBe(true);
    expect(proposal.json.diff).toContain('Edited');
    const merged = await api('POST', `/config/proposals/${proposal.json.proposal_id}/merge`, ADMIN);
    expect(merged.status, JSON.stringify(merged.json)).toBeLessThan(300);
    expect(merged.json.status).toBe('merged');
    const after = await api('GET', '/config/definitions/01J8SATR1AGEC1ASS000');
    expect(after.json.raw).toContain('Edited');
    const history = await api('GET', `/config/history?path=${encodeURIComponent(def.json.path)}`);
    expect((history.json.items ?? history.json).length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('designer chat: an async message is accepted at once and the reply lands on the session', async () => {
    const settings = await api('GET', '/config/definitions/breadboard');
    const designer: string = settings.json.definition.designers.tool;
    const conv = await api('POST', '/conversations', ADMIN, { kind: 'conversation', subagent_uid: designer, context: { definition_uid: '01J8T0REP0SEARCH0000' }, title: 'Designer: repo-search' });
    expect(conv.status, JSON.stringify(conv.json)).toBe(201);
    const sid: string = conv.json.session_id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${sid}/messages`,
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json', prefer: 'respond-async', 'idempotency-key': 'e2e-designer-1' },
      payload: JSON.stringify({ text: 'Tighten the description', context: { definition_uid: '01J8T0REP0SEARCH0000' } }),
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ accepted: true, session_id: sid });
    let snap: any = null;
    await waitUntil(async () => {
      snap = (await api('GET', `/conversations/${sid}`)).json;
      return snap.busy === false && snap.turns.some((t: any) => t.role === 'assistant');
    });
    expect(snap.last_error).toBeNull();
    expect(snap.turns[0]).toMatchObject({ role: 'user', username: 'admin' });
    expect(Array.isArray(snap.proposals)).toBe(true);
  }, 60_000);
});
