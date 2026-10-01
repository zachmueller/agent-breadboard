import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mintUid, zBreadboardConfig, SCHEMA_TAGS, type BreadboardConfig, type SessionRecord } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import type { EventBus, SessionStore } from '../core/services.js';
import type { Principal } from '../core/principal.js';
import { createContentService, locateQuote, type ContentServiceImpl } from './service.js';

let f: Foundation;
let svc: ContentServiceImpl;
const published: Array<{ topic: string; payload: any; visibility: any }> = [];
const SES_A = 'ses_AAAAAAAAAAAAAAAAAAAA';
const SES_B = 'ses_BBBBBBBBBBBBBBBBBBBB';
const CIRCUIT = mintUid();

function aiPrincipal(sessionId: string): Principal {
  return {
    ...f.servicePrincipal,
    actor: { kind: 'subagent', id: mintUid(), session_id: sessionId } as any,
    user: null,
    roles: [],
    is_admin: false,
    scopes: null,
    grants: { subagent_uid: mintUid(), tools: new Map(), mcp: new Map(), circuits: { read: new Set(), execute: new Set() }, knowledge: { read: new Set(['ops']), write: new Set(['ops']) }, primitives: new Set(), tools_override: false } as any,
    session_id: sessionId,
    visible_sessions: [sessionId],
    token_kind: 'actor' as any,
  } as Principal;
}

function sessionsFake(): SessionStore {
  return {
    async get(id: string) {
      const r = await f.db.query(`SELECT session_id, kind, circuit_uid, state, task_uid FROM sessions WHERE session_id=$1`, [id]);
      const row = r.rows[0];
      return row ? ({ ...row, circuit_uid: row.circuit_uid?.trim() ?? null } as unknown as SessionRecord) : null;
    },
  } as unknown as SessionStore;
}

beforeAll(async () => {
  f = await createFoundation();
  for (const [sid, circuit] of [[SES_A, CIRCUIT], [SES_B, null]] as const) {
    await f.db.query(`INSERT INTO sessions (session_id, team_id, kind, circuit_uid, state, budget) VALUES ($1, $2, 'circuit-run', $3, 'running', '{}')`, [sid, f.team_id, circuit]);
  }
  const settings: BreadboardConfig = zBreadboardConfig.parse({ schema: SCHEMA_TAGS.breadboard });
  const events: EventBus = { publish: async (topic: string, payload: any, visibility: any) => void published.push({ topic, payload, visibility }) } as unknown as EventBus;
  svc = createContentService({
    db: f.db,
    team_id: f.team_id,
    nodes: f.nodes,
    edges: f.edges,
    graph: f.graph,
    linkIndexer: f.linkIndexer,
    identity: f.identity,
    events,
    settings: async () => settings,
    knowledge: () => null,
    sessions: sessionsFake,
    log: f.log,
    objects: f.objects,
    objectThresholdBytes: 1024,
  });
});
afterAll(async () => f.close());

describe('ContentService artifacts + provenance', () => {
  it('createArtifact/updateArtifact cut step-completion revisions and emit revision-bound produces/updates edges', async () => {
    const ai = aiPrincipal(SES_A);
    const a = await svc.createArtifact({ title: 'Plan', body: '# Plan\n\nstep one', scope: 'session', by: ai, session_id: SES_A, step_id: 'plan#1' });
    expect(a.revision_id).toBe(1);
    expect(a.node.tags).toContain('intermediate');
    expect((a.node as any).session_id).toBe(SES_A);
    expect(a.node.head_revision).toBe(1);
    const revs = await svc.revisions(a.uid, ai);
    expect(revs[0]!.labels).toContain('step-completion');
    const up = await svc.edges(a.uid, ai, { direction: 'in' });
    const produces = up.find((e) => e.type === 'produces')!;
    expect(produces).toMatchObject({ src_session_id: SES_A, src_step_id: 'plan#1', dst_revision: 1 });

    const u = await svc.updateArtifact({ uid: a.uid, body: '# Plan\n\nstep two', by: ai, session_id: SES_A, step_id: 'revise#1' });
    expect(u.revision_id).toBe(2);
    const edges = await svc.edges(a.uid, ai, { direction: 'in', type: ['updates'] });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ src_step_id: 'revise#1', dst_revision: 2 });
    expect(published.some((p) => p.topic === 'node.updated' && p.payload.uid === a.uid)).toBe(true);
  });

  it('team-scoped artifacts without session get a publish revision and no default tag; large bodies spill', async () => {
    const a = await svc.createArtifact({ title: 'Report', body: { rows: [1, 2] }, scope: 'team', by: f.memberPrincipal });
    expect(a.node.tags).toEqual([]);
    expect(a.node.body).toEqual({ rows: [1, 2] });
    expect((await svc.revision(a.uid, a.revision_id, f.memberPrincipal)).labels).toEqual(['publish']);
    const big = await svc.createArtifact({ title: 'Big', body: 'x'.repeat(5000), scope: 'team', by: f.memberPrincipal });
    expect(String(big.node.properties.body_ref)).toMatch(/^obj:/);
    expect(big.node.properties.body_bytes).toBe(5000);
  });

  it('propagates the narrowest parent scope and rejects narrowing below a wider descendant', async () => {
    const parent = await svc.createArtifact({ title: 'scratch', body: 'notes', scope: 'session', by: aiPrincipal(SES_A), session_id: SES_A, step_id: 's#1' });
    const child = await svc.createNode({ type: 'artifact', title: 'child', body: 'derived', by: f.servicePrincipal, derived_from: [{ uid: parent.uid, revision_id: parent.revision_id }] });
    expect(child.scope).toBe('session');
    const derived = await svc.edges(child.uid, f.servicePrincipal, { direction: 'out', type: ['derived-from'] });
    expect(derived[0]).toMatchObject({ dst_uid: parent.uid, dst_revision: parent.revision_id });

    const root = await svc.createArtifact({ title: 'root', body: 'r', scope: 'team', by: f.memberPrincipal });
    await svc.createArtifact({ title: 'leaf', body: 'l', scope: 'team', by: f.memberPrincipal, derived_from: [{ uid: root.uid, revision_id: root.revision_id }] });
    await expect(svc.patchNode(root.uid, { scope: 'session' }, f.memberPrincipal)).rejects.toMatchObject({ code: 'scope-narrowing-rejected' });
  });

  it('hides session-scoped nodes from other sessions and from user lists without a session filter', async () => {
    const a = await svc.createArtifact({ title: 'secret scratch', body: 'zebra', scope: 'session', by: aiPrincipal(SES_A), session_id: SES_A, step_id: 'x#1' });
    await expect(svc.getNode(a.uid, aiPrincipal(SES_B))).rejects.toMatchObject({ code: 'not-found' });
    expect((await svc.getNode(a.uid, aiPrincipal(SES_A))).uid).toBe(a.uid);
    const userList = await svc.listNodes({ type: 'artifact' }, f.memberPrincipal);
    expect(userList.items.map((n) => n.uid)).not.toContain(a.uid);
    const filtered = await svc.listNodes({ type: 'artifact', session_id: SES_A }, f.memberPrincipal);
    expect(filtered.items.map((n) => n.uid)).toContain(a.uid);
    expect((await svc.getNode(a.uid, f.memberPrincipal)).uid).toBe(a.uid);
    const otherAi = await svc.listNodes({ type: 'artifact' }, aiPrincipal(SES_B));
    expect(otherAi.items.map((n) => n.uid)).not.toContain(a.uid);
  });

  it('rejects body patches on CRDT nodes and routes markdown patches to body_text', async () => {
    const note = await svc.createNode({ type: 'knowledge', title: 'Note', body: 'hello', crdt: true, properties: { domains: ['ops'] }, by: f.memberPrincipal });
    await expect(svc.patchNode(note.uid, { body: 'new' }, f.memberPrincipal)).rejects.toMatchObject({ code: 'invalid-state' });
    const t = await svc.createNode({ type: 'artifact', title: 'plain', body: 'a', by: f.memberPrincipal });
    const p = await svc.patchNode(t.uid, { body: 'b [[' + note.uid + '|Note]]' }, f.memberPrincipal);
    expect(p.body_text).toContain('b [[');
    const refs = await svc.edges(t.uid, f.memberPrincipal, { direction: 'out', type: ['references'] });
    expect(refs.map((e) => e.dst_uid)).toEqual([note.uid]);
  });

  it('emitEdge validates endpoint types and is idempotent', async () => {
    const t1 = await svc.createNode({ type: 'task', title: 't1', by: f.memberPrincipal });
    const t2 = await svc.createNode({ type: 'task', title: 't2', by: f.memberPrincipal });
    const art = await svc.createNode({ type: 'artifact', title: 'a', by: f.memberPrincipal });
    const e1 = await svc.emitEdge({ type: 'depends-on', src: t1.uid, dst: t2.uid, by: f.memberPrincipal });
    const e2 = await svc.emitEdge({ type: 'depends-on', src: t1.uid, dst: t2.uid, by: f.memberPrincipal });
    expect(e2.edge_id).toBe(e1.edge_id);
    await expect(svc.emitEdge({ type: 'blocks', src: art.uid, dst: t1.uid, by: f.memberPrincipal })).rejects.toMatchObject({ code: 'validation-failed' });
    await expect(svc.emitEdge({ type: 'depends-on', src: t2.uid, dst: t1.uid, by: f.memberPrincipal })).rejects.toMatchObject({ code: 'validation-failed' });
    await expect(svc.emitEdge({ type: 'attached-to', src: art.uid, dst: t1.uid, by: f.memberPrincipal })).rejects.toMatchObject({ code: 'validation-failed' });
    await expect(svc.emitEdge({ type: 'produces', src: art.uid, dst: t1.uid, by: f.memberPrincipal })).rejects.toBeTruthy();
    const r = await svc.retractEdge(e1.edge_id, f.memberPrincipal);
    expect(r.retracted_at).toBeTruthy();
  });

  it('lineage up/down returns edges, node chips and session summaries', async () => {
    const ai = aiPrincipal(SES_A);
    const src = await svc.createArtifact({ title: 'sources', body: 's', scope: 'team', by: ai, session_id: SES_A, step_id: 'gather#1' });
    const sum = await svc.createArtifact({ title: 'summary', body: 'm', scope: 'team', by: ai, session_id: SES_A, step_id: 'summarize#1', derived_from: [{ uid: src.uid, revision_id: src.revision_id }] });
    const up = await svc.lineage(sum.uid, 'up', 5, f.memberPrincipal);
    expect(up.root).toBe(sum.uid);
    expect(up.edges.map((e) => e.type).sort()).toEqual(['derived-from', 'produces', 'produces']);
    expect(up.nodes.map((n) => n.uid).sort()).toEqual([src.uid, sum.uid].sort());
    expect(up.sessions).toEqual([{ session_id: SES_A, kind: 'circuit-run', circuit_uid: CIRCUIT, state: 'running' }]);
    expect(up.truncated).toBe(false);
    const down = await svc.lineage(src.uid, 'down', 5, f.memberPrincipal);
    expect(down.edges.map((e) => e.src_uid)).toEqual([sum.uid]);
  });
});

describe('comments + anchors', () => {
  const md = '# Title\n\nThe latency budget is 200ms.\n\nWe repeat this line.\n\nWe repeat this line.\n\nTail.';

  it('locateQuote tiers', () => {
    expect(locateQuote(md, 'latency budget').status).toBe('resolved');
    expect(locateQuote(md, 'latency budget').block_id).toBe('idx:1');
    expect(locateQuote(md, 'We repeat this line.').status).toBe('ambiguous');
    expect(locateQuote(md, 'THE   LATENCY budget').status).toBe('resolved');
    expect(locateQuote(md, 'not present').status).toBe('not_found');
    expect(locateQuote('', 'x').status).toBe('unmappable');
    expect(locateQuote('alpha foo beta. gamma foo delta.', 'foo', 'gamma foo delta')).toMatchObject({ status: 'resolved', offset: 22 });
  });

  it('anchors comments, reports ambiguity and staleness, and gives AI typed failures', async () => {
    const art = await svc.createArtifact({ title: 'Doc', body: md, scope: 'team', by: f.memberPrincipal });
    const c1 = await svc.addComment({ target: art.uid, body: 'Is 200ms right?', anchor: { quote: 'latency budget is 200ms' }, by: f.memberPrincipal });
    expect(c1.anchor_status).toBe('resolved');
    expect(c1.type).toBe('comment');
    expect((c1.properties.anchor as any).revision).toBe(1);
    const c2 = await svc.addComment({ target: art.uid, body: 'which one?', anchor: { quote: 'We repeat this line.' }, by: f.memberPrincipal });
    expect(c2.anchor_status).toBe('stale');
    expect((c2.properties.anchor as any).status).toBe('ambiguous');
    await expect(svc.addComment({ target: art.uid, body: 'x', anchor: { quote: 'We repeat this line.' }, by: aiPrincipal(SES_A) })).rejects.toMatchObject({ code: 'anchor-ambiguous' });
    await expect(svc.addComment({ target: art.uid, body: 'x', anchor: { quote: 'nowhere' }, by: aiPrincipal(SES_A) })).rejects.toMatchObject({ code: 'anchor-not-found' });
    const plain = await svc.addComment({ target: art.uid, body: 'general remark', by: f.memberPrincipal });
    expect(plain.anchor_status).toBe('none');

    let list = await svc.comments(art.uid, f.memberPrincipal);
    expect(list).toHaveLength(3);
    expect(list.find((c) => c.uid === c1.uid)!.stale).toBe(false);

    // Head moves; the quote disappears → c1 is stale.
    await svc.updateArtifact({ uid: art.uid, body: '# Title\n\nThe budget changed.', by: f.memberPrincipal });
    list = await svc.comments(art.uid, f.memberPrincipal);
    const s1 = list.find((c) => c.uid === c1.uid)!;
    expect(s1.stale).toBe(true);
    expect(s1.anchor_status).toBe('not_found');
    expect(list.find((c) => c.uid === plain.uid)!.stale).toBe(false);
  });
});

describe('need-input', () => {
  it('tags, targets, resolves, records history, and feeds the review queue and health metric', async () => {
    const ai = aiPrincipal(SES_A);
    const art = await svc.createArtifact({ title: 'Deliverable', body: 'final', tags: ['deliverable'], scope: 'team', by: ai, session_id: SES_A, step_id: 'final#1' });
    const req = await svc.tagNeedInput({ uid: art.uid, role: 'scientist', prompt: 'check the numbers', by: ai });
    expect(req.requested_by).toMatchObject({ kind: 'subagent', session_id: SES_A });
    let node = await svc.getNode(art.uid, f.memberPrincipal);
    expect(node.tags).toEqual(expect.arrayContaining(['need-input', 'need-input:role=scientist', 'deliverable']));
    expect(published.some((p) => p.topic === 'need-input.tagged' && p.payload.request_id === req.request_id)).toBe(true);

    await expect(svc.tagNeedInput({ uid: art.uid, role: 'nonexistent', by: ai })).rejects.toMatchObject({ code: 'validation-failed' });
    await expect(svc.tagNeedInput({ uid: art.uid, username: 'ghost', by: ai })).rejects.toMatchObject({ code: 'validation-failed' });

    // Review queue: member (scientist) sees it; count matches.
    const q = await svc.reviewQueue(f.memberPrincipal);
    const item = q.find((i) => i.node.uid === art.uid)!;
    expect(item.requests.map((r) => r.request_id)).toEqual([req.request_id]);
    expect(await svc.reviewCount(f.memberPrincipal)).toBe(q.length);

    // A non-targeted user is forbidden.
    const outsider = await f.identity.upsertUser({ team_id: f.team_id, handle: 'outsider', display_name: 'O', is_admin: false });
    const { userPrincipal } = await import('../core/principal.js');
    await expect(svc.resolveNeedInput({ uid: art.uid, request_id: req.request_id, by: userPrincipal(outsider, []) })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await svc.reviewQueue(userPrincipal(outsider, []))).some((i) => i.node.uid === art.uid)).toBe(false);

    const res = await svc.resolveNeedInput({ uid: art.uid, request_id: req.request_id, comment: 'looks good', by: f.memberPrincipal });
    expect(res.remaining_open).toBe(0);
    node = await svc.getNode(art.uid, f.memberPrincipal);
    expect(node.tags.filter((t) => t.startsWith('need-input'))).toEqual([]);
    const hist = node.properties['need-input-history'] as any[];
    expect(hist[0]).toMatchObject({ request_id: req.request_id, comment: 'looks good', resolved_by: { kind: 'user' } });
    await expect(svc.resolveNeedInput({ uid: art.uid, request_id: req.request_id, by: f.memberPrincipal })).rejects.toMatchObject({ code: 'invalid-state' });

    // Gate-created requests need a verdict (via the gate-verdict endpoint).
    const gate = await svc.tagNeedInput({ uid: art.uid, username: 'member', by: f.servicePrincipal, gate: { session_id: SES_A, step_id: 'review#1' } });
    await expect(svc.resolveNeedInput({ uid: art.uid, request_id: gate.request_id, by: f.memberPrincipal })).rejects.toMatchObject({ code: 'invalid-state' });
    const gq = await svc.reviewQueue(f.memberPrincipal);
    expect(gq[0]!.node.uid).toBe(art.uid);
    expect(gq[0]!.gating_session).toEqual({ session_id: SES_A, circuit_uid: CIRCUIT, state: 'running', kind: 'circuit-run' });
    const gr = await svc.resolveNeedInput({ uid: art.uid, request_id: gate.request_id, verdict: 'approve', by: f.memberPrincipal });
    expect(gr.resolved.gate).toEqual({ session_id: SES_A, step_id: 'review#1' });

    const h = await svc.healthMetric({ days: 7 });
    expect(h.series).toHaveLength(7);
    const today = h.series[h.series.length - 1]!;
    expect(today.requests).toBe(2);
    expect(today.deliverables).toBe(1);
    expect(today.rate).toBe(2);
    expect(h.by_circuit.find((c) => c.circuit_uid === CIRCUIT)).toMatchObject({ requests: 2, deliverables: 1 });
  });
});
