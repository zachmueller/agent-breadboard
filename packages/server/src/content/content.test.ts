import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { NodeStore } from './nodes.js';
import { EdgeStore } from './edges.js';
import { GraphQueries } from './graph-queries.js';
import { LinkIndexer } from './link-indexer.js';
import { IdentityStore } from '../identity/identity.js';
import { SERVICE_ACTOR } from '@breadboard/shared';

let db: Db;
let nodes: NodeStore;
let edges: EdgeStore;
let graph: GraphQueries;
let indexer: LinkIndexer;
const svc = SERVICE_ACTOR('test');

beforeAll(async () => {
  db = await connectDb({ url: 'pglite://memory' });
  await migrate(db);
  const id = new IdentityStore(db);
  const team = await id.ensureTeam('t');
  nodes = new NodeStore(db, team.team_id);
  edges = new EdgeStore(db);
  graph = new GraphQueries(db);
  indexer = new LinkIndexer(db, edges);
});
afterAll(async () => db.close());

describe('content DAL', () => {
  it('creates, revises (with dedup), patches, lists, searches', async () => {
    const a = await nodes.create({ type: 'artifact', title: 'Plan A', body_text: 'the plan mentions latency', created_by: svc, tags: ['intermediate'] });
    expect(a.uid).toHaveLength(20);
    const r1 = await nodes.cutRevision(a.uid, { labels: ['step-completion'], created_by: svc });
    expect(r1.revision_id).toBe(1);
    const r1b = await nodes.cutRevision(a.uid, { labels: ['publish'], created_by: svc });
    expect(r1b.revision_id).toBe(1);
    expect(r1b.labels.sort()).toEqual(['publish', 'step-completion']);
    await nodes.patch(a.uid, { body_text: 'the plan mentions throughput', tags_add: ['deliverable'], tags_remove: ['intermediate'] });
    const r2 = await nodes.cutRevision(a.uid, { labels: ['step-completion'], created_by: svc });
    expect(r2.revision_id).toBe(2);
    expect(await nodes.headRevisionId(a.uid)).toBe(2);
    const page = await nodes.list({ type: ['artifact'], tag: ['deliverable'] });
    expect(page.items.map((n) => n.uid)).toContain(a.uid);
    const fts = await nodes.list({ q: 'throughput' });
    expect(fts.items.map((n) => n.uid)).toEqual([a.uid]);
    const none = await nodes.list({ q: 'latency' });
    expect(none.items).toHaveLength(0);
  });

  it('paginates with cursors', async () => {
    for (let i = 0; i < 5; i++) await nodes.create({ type: 'comment', title: `c${i}`, created_by: svc });
    const p1 = await nodes.list({ type: ['comment'], limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = await nodes.list({ type: ['comment'], limit: 2, cursor: p1.next_cursor });
    expect(p2.items).toHaveLength(2);
    expect(new Set([...p1.items, ...p2.items].map((n) => n.uid)).size).toBe(4);
  });

  it('edges + lineage traversal with guards', async () => {
    const team = (await db.query(`SELECT team_id FROM teams LIMIT 1`)).rows[0].team_id;
    await db.query(`INSERT INTO sessions (session_id, team_id, kind, budget) VALUES ('ses_00000000000000000001', $1, 'circuit-run', '{}')`, [team]);
    const src = await nodes.create({ type: 'artifact', title: 'sources', created_by: svc });
    const sum = await nodes.create({ type: 'artifact', title: 'summary', created_by: svc });
    const rs = await nodes.cutRevision(src.uid, { labels: ['step-completion'], created_by: svc });
    const rsum = await nodes.cutRevision(sum.uid, { labels: ['step-completion'], created_by: svc });
    await edges.emit({ type: 'produces', src_session_id: 'ses_00000000000000000001', src_step_id: 'gather#1', dst_uid: src.uid, dst_revision: rs.revision_id, created_by: svc });
    await edges.emit({ type: 'produces', src_session_id: 'ses_00000000000000000001', src_step_id: 'summarize#1', dst_uid: sum.uid, dst_revision: rsum.revision_id, created_by: svc });
    await edges.emit({ type: 'derived-from', src_uid: sum.uid, dst_uid: src.uid, dst_revision: rs.revision_id, created_by: svc });
    const up = await graph.upstream(sum.uid);
    expect(up.edges.map((e) => e.type).sort()).toEqual(['derived-from', 'produces', 'produces']);
    expect(up.truncated).toBe(false);
    const down = await graph.downstream(src.uid, { types: ['derived-from'] });
    expect(down.edges).toHaveLength(1);
    const prod = await graph.producer(sum.uid);
    expect(prod?.step_id).toBe('summarize#1');
    // explicit edges cannot be produces/updates
    expect(() => edges.assertExplicitType('produces')).toThrow();
    // retract tombstones
    const e = await edges.emit({ type: 'references', src_uid: sum.uid, dst_uid: src.uid, created_by: svc });
    await edges.retract(e.edge_id, svc);
    const list = await edges.listForNode(sum.uid, { type: ['references'] });
    expect(list).toHaveLength(0);
  });

  it('link indexer materializes and prunes references edges', async () => {
    const target = await nodes.create({ type: 'knowledge', title: 'Glossary', created_by: svc });
    const note = await nodes.create({ type: 'knowledge', title: 'Note', body_text: `see [[${target.uid}|Glossary]]`, created_by: svc });
    const r = await indexer.reindex(note);
    expect(r.added).toEqual([target.uid]);
    const back = await graph.backlinks(target.uid);
    expect(back).toHaveLength(1);
    const updated = await nodes.patch(note.uid, { body_text: 'no links now' });
    const r2 = await indexer.reindex(updated);
    expect(r2.removed).toEqual([target.uid]);
    expect(await graph.backlinks(target.uid)).toHaveLength(0);
  });

  it('identity: users, roles, service tokens', async () => {
    const id = new IdentityStore(db);
    const team = await id.ensureTeam('t');
    const u = await id.upsertUser({ team_id: team.team_id, handle: 'zach', is_admin: true });
    const role = await id.ensureRole(team.team_id, 'scientist');
    await id.setMembership(role.role_id, u.user_id, true);
    expect(await id.rolesOfUser(u.user_id)).toEqual(['scientist']);
    const { token, secret } = await id.createServiceToken({ team_id: team.team_id, name: 'ci', scopes: ['tasks:write'], created_by: svc });
    expect(token.scopes).toEqual(['tasks:write']);
    const found = await id.findServiceToken(secret);
    expect(found?.token_id).toBe(token.token_id);
    await id.revokeServiceToken(token.token_id);
    expect(await id.findServiceToken(secret)).toBeNull();
  });
});
