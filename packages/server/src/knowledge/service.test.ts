import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as Y from 'yjs';
import { BreadboardError, TAG, type Actor } from '@breadboard/shared';
import { aiPrincipal, createKnowledgeKit, type KnowledgeKit } from './testkit.js';
import { createSyncServer } from './sync.js';
import { blocksOf, docToMarkdown } from './ydoc.js';

const NOTE = ['# Payment runbook', 'Block A: restart the payment service when latency alarms fire.', 'Block B: check the error dashboards for spikes.', 'Block C: escalate to the database team if the replica lag exceeds a minute.'].join('\n\n');

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BreadboardError) return e.code;
    throw e;
  }
  return 'no-error';
}

function humanEditBlock(doc: Y.Doc, idx: number, suffix: string) {
  const t = blocksOf(doc).get(idx).get('text') as Y.Text;
  t.insert(t.length, suffix);
}

describe('KnowledgeService', () => {
  let kit: KnowledgeKit;
  beforeEach(async () => {
    kit = await createKnowledgeKit();
  });
  afterEach(async () => {
    await kit.close();
  });

  const human = (): Actor => kit.f.memberPrincipal.actor;

  it('creates and reads a note pinned to a base revision', async () => {
    const node = await kit.knowledge.createNote({ title: 'Payments', markdown: NOTE, domains: ['ops'], by: kit.f.memberPrincipal });
    const read = await kit.knowledge.readNote(node.uid, kit.f.memberPrincipal);
    expect(read.markdown).toBe(NOTE);
    expect(read.domains).toEqual(['ops']);
    expect(read.read_only).toBe(false);
    const rev = await kit.f.nodes.getRevision(node.uid, read.base_revision);
    expect(rev?.ydoc_state_buf).toBeTruthy();
    expect(rev?.labels).toContain('publish');
    // Unchanged doc → same base revision.
    expect((await kit.knowledge.readNote(node.uid, kit.f.memberPrincipal)).base_revision).toBe(read.base_revision);
    expect(await code(kit.knowledge.createNote({ title: 'x', markdown: 'y', domains: ['nope'], by: kit.f.memberPrincipal }))).toBe('validation-failed');
  });

  it('reverting an edit made on a service token keeps later human edits too', async () => {
    const node = await kit.knowledge.createNote({ title: 'Payments', markdown: NOTE, domains: ['ops'], by: kit.f.memberPrincipal });
    const base = await kit.knowledge.readNote(node.uid, kit.f.servicePrincipal);
    const res = await kit.knowledge.proposeEdit({ uid: node.uid, base_revision: base.base_revision, markdown: base.markdown.replace('exceeds a minute', 'exceeds thirty seconds'), by: kit.f.servicePrincipal });
    await kit.sync.transact(node.uid, human(), (d) => humanEditBlock(d, 2, ' (later)'));
    await kit.knowledge.revertAiEdit({ uid: node.uid, pre_ai_edit_revision: res.pre_ai_edit_revision, by: kit.f.memberPrincipal });
    const after = await kit.knowledge.markdownOf(node.uid);
    expect(after).toContain('exceeds a minute');
    expect(after).toContain('spikes. (later)');
  });

  it('merges a concurrent human edit with an AI revision, and revert restores only the AI change', async () => {
    const ai = aiPrincipal(kit.f, { read: ['ops'], write: ['ops'] });
    const node = await kit.knowledge.createNote({ title: 'Payments', markdown: NOTE, domains: ['ops'], by: kit.f.memberPrincipal });
    const base = await kit.knowledge.readNote(node.uid, ai);

    // Human edits block A after the AI read its base.
    await kit.sync.transact(node.uid, human(), (doc) => humanEditBlock(doc, 1, ' (human note)'));

    // AI revises block C against the (now stale) base.
    const revised = base.markdown.replace('exceeds a minute', 'exceeds thirty seconds');
    const res = await kit.knowledge.proposeEdit({ uid: node.uid, base_revision: base.base_revision, markdown: revised, by: ai });
    expect(res.applied).toBe(true);
    expect(res.had_concurrent_edits).toBe(true);
    expect(res.blocks_changed).toBe(1);
    expect(res.merged_markdown).toContain('latency alarms fire. (human note)');
    expect(res.merged_markdown).toContain('exceeds thirty seconds');
    expect(await kit.knowledge.markdownOf(node.uid)).toBe(res.merged_markdown);
    const pre = await kit.f.nodes.getRevision(node.uid, res.pre_ai_edit_revision);
    expect(pre?.labels).toContain('pre-ai-edit');
    expect(pre?.body_text).toContain('(human note)');
    expect(pre?.body_text).toContain('exceeds a minute');

    // Attribution: block C is the AI's, block A the human's.
    const doc = await kit.sync.openDoc(node.uid);
    const ids = blocksOf(doc).toArray().map((m) => m.get('id') as string);
    const attr = await kit.knowledge.attribution(node.uid);
    expect(attr[ids[3]!]!.actor.kind).toBe('subagent');
    expect(attr[ids[1]!]!.actor.kind).toBe('user');

    // Another human edit after the AI edit, then revert.
    await kit.sync.transact(node.uid, human(), (d) => humanEditBlock(d, 2, ' (later)'));
    const rv = await kit.knowledge.revertAiEdit({ uid: node.uid, pre_ai_edit_revision: res.pre_ai_edit_revision, by: kit.f.memberPrincipal });
    const after = await kit.knowledge.markdownOf(node.uid);
    expect(after).toContain('exceeds a minute');
    expect(after).not.toContain('thirty seconds');
    expect(after).toContain('(human note)');
    expect(after).toContain('spikes. (later)');
    expect(rv.new_head_revision).toBeGreaterThan(res.new_head_revision);
  });

  it('is a no-op when the revision equals the base', async () => {
    const ai = aiPrincipal(kit.f, { read: ['ops'], write: ['ops'] });
    const node = await kit.knowledge.createNote({ title: 'P', markdown: NOTE, domains: ['ops'], by: kit.f.memberPrincipal });
    const base = await kit.knowledge.readNote(node.uid, ai);
    const res = await kit.knowledge.proposeEdit({ uid: node.uid, base_revision: base.base_revision, markdown: base.markdown, by: ai });
    expect(res).toMatchObject({ applied: true, had_concurrent_edits: false, blocks_changed: 0, new_head_revision: base.base_revision });
  });

  it('tool code reads notes: a code step reads every domain; a tool a subagent calls reads only its domains', async () => {
    const secret = await kit.knowledge.createNote({ title: 'Secret', markdown: 'classified material here', domains: ['secret'], by: kit.f.memberPrincipal });
    const sub = aiPrincipal(kit.f, { read: ['ops'] });
    const codeStep = { ...sub, actor: { kind: 'code-step' as const, id: 'TOOL0000000000000001', session_id: sub.session_id! }, grants: null };
    expect((await kit.knowledge.readNote(secret.uid, codeStep)).markdown).toContain('classified');
    expect(await code(kit.knowledge.readNote(secret.uid, { ...sub, execution_key: 'S:step:1:0' }))).toBe('grant-denied');
  });

  it('typed failures: base-revision-too-old, read-only-source, grant-denied, wipeout-detected, parse/validation', async () => {
    const ai = aiPrincipal(kit.f, { read: ['ops'], write: ['ops'] });
    const node = await kit.knowledge.createNote({ title: 'P', markdown: NOTE, domains: ['ops'], by: kit.f.memberPrincipal });
    const base = await kit.knowledge.readNote(node.uid, ai);

    // base-revision-too-old: unknown revision, and a revision whose merge state was compacted away.
    expect(await code(kit.knowledge.proposeEdit({ uid: node.uid, base_revision: 999, markdown: 'x', by: ai }))).toBe('base-revision-too-old');
    await kit.f.db.query(`UPDATE node_revisions SET ydoc_state=NULL, ydoc_vector=NULL WHERE uid=$1 AND revision_id=$2`, [node.uid, base.base_revision]);
    expect(await code(kit.knowledge.proposeEdit({ uid: node.uid, base_revision: base.base_revision, markdown: NOTE + '\n\nmore', by: ai }))).toBe('base-revision-too-old');

    // read-only-source: connector-owned note.
    const ro = await kit.f.nodes.create({ type: 'knowledge', title: 'Upstream', properties: { domains: ['ops'], external_id: 'a.md' }, body_text: 'Upstream doc body.', crdt: true, tags: [TAG.readOnly, TAG.connector('01J8T0G1TMDC0NNECT00')], created_by: { kind: 'service', id: 'connector' } });
    const roRead = await kit.knowledge.readNote(ro.uid, ai);
    expect(roRead.read_only).toBe(true);
    expect(await code(kit.knowledge.proposeEdit({ uid: ro.uid, base_revision: roRead.base_revision, markdown: 'changed', by: ai }))).toBe('read-only-source');

    // grant-denied: subagent principal without the note's domain.
    const secret = await kit.knowledge.createNote({ title: 'Secret', markdown: 'classified material here', domains: ['secret'], by: kit.f.memberPrincipal });
    expect(await code(kit.knowledge.readNote(secret.uid, ai))).toBe('grant-denied');
    const readOnlyAi = aiPrincipal(kit.f, { read: ['ops'], write: [] });
    const b2 = await kit.knowledge.readNote(node.uid, readOnlyAi);
    expect(await code(kit.knowledge.proposeEdit({ uid: node.uid, base_revision: b2.base_revision, markdown: b2.markdown + '\n\nmore', by: readOnlyAi }))).toBe('grant-denied');
    expect(await code(kit.knowledge.createNote({ title: 'n', markdown: 'n', domains: ['secret'], by: ai }))).toBe('grant-denied');
    expect(await code(kit.knowledge.createNote({ title: 'n', markdown: 'n', domains: [], by: ai }))).toBe('grant-denied');

    // wipeout-detected: replacing nearly everything.
    const b3 = await kit.knowledge.readNote(node.uid, ai);
    const before = await kit.knowledge.markdownOf(node.uid);
    let err: BreadboardError | null = null;
    try {
      await kit.knowledge.proposeEdit({ uid: node.uid, base_revision: b3.base_revision, markdown: 'x', by: ai });
    } catch (e) {
      err = e as BreadboardError;
    }
    expect(err?.code).toBe('wipeout-detected');
    expect((err?.detail as any)?.total_chars).toBeGreaterThan(64);
    expect(await kit.knowledge.markdownOf(node.uid)).toBe(before);
    expect(kit.events.published.some((e) => e.payload?.wipeout_detected)).toBe(true);

    // scope check for service tokens without knowledge:write
    const svc = { ...kit.f.memberPrincipal, scopes: ['knowledge:read'] };
    expect(await code(kit.knowledge.proposeEdit({ uid: node.uid, base_revision: b3.base_revision, markdown: before + '\n\nz', by: svc }))).toBe('forbidden');
    // invisible session-scoped note surfaces as not found
    expect(await code(kit.knowledge.readNote('0000000000000000000Z', ai))).toBe('note-not-found');
  });

  it('restores a revision and replaces bodies with a server actor', async () => {
    const node = await kit.knowledge.createNote({ title: 'P', markdown: 'one\n\ntwo', domains: ['ops'], by: kit.f.memberPrincipal });
    const r1 = (await kit.knowledge.readNote(node.uid, kit.f.memberPrincipal)).base_revision;
    const { revision } = await kit.knowledge.replaceBody({ uid: node.uid, markdown: 'one\n\ntwo changed\n\nthree', by: { kind: 'service', id: 'connector' }, label: 'connector-sync' });
    expect((await kit.f.nodes.getRevision(node.uid, revision))?.labels).toEqual(['connector-sync']);
    expect(await kit.knowledge.markdownOf(node.uid)).toBe('one\n\ntwo changed\n\nthree');
    await kit.knowledge.restoreRevision({ uid: node.uid, revision_id: r1, by: kit.f.memberPrincipal });
    expect(await kit.knowledge.markdownOf(node.uid)).toBe('one\n\ntwo');
    expect((await kit.f.nodes.get(node.uid))?.body_text).toBe('one\n\ntwo');
  });

  it('AI create: every domain must be writable; tagged with its origin; the returned revision is an edit base', async () => {
    const ai = aiPrincipal(kit.f, { read: ['ops'], write: ['ops'] });
    expect(await code(kit.knowledge.createNote({ title: 'n', markdown: 'n', domains: ['ops', 'secret'], by: ai }))).toBe('grant-denied');
    const n = await kit.knowledge.createNote({ title: 'Pager rota', markdown: 'Rotate the pager weekly.', domains: ['ops'], tags: [TAG.readOnly, 'rota'], by: ai });
    expect(n.tags).toEqual(['rota', TAG.origin('subagent')]);
    expect(n.possible_duplicates).toEqual([]);
    const edit = await kit.knowledge.proposeEdit({ uid: n.uid, base_revision: n.revision_id, markdown: 'Rotate the pager weekly.\n\nHand over on Mondays.', by: ai });
    expect(edit.merged_markdown).toBe('Rotate the pager weekly.\n\nHand over on Mondays.');
    // Humans are not tagged or deduped.
    const human = await kit.knowledge.createNote({ title: 'Pager rota', markdown: 'Rotate the pager weekly.', domains: ['ops'], by: kit.f.memberPrincipal });
    expect(human.tags).toEqual([]);
  });

  it('AI create flags and links near-duplicates without blocking', async () => {
    const original = await kit.knowledge.createNote({ title: 'Payment latency runbook', markdown: 'Restart the payment service when latency alarms fire.', domains: ['ops'], by: kit.f.memberPrincipal });
    const other = await kit.knowledge.createNote({ title: 'Orders table', markdown: 'The orders table stores customer purchases with totals.', domains: ['ops'], by: kit.f.memberPrincipal });
    for (const n of [original, other]) await kit.knowledge.reindexEmbeddings(n.uid);
    const ai = aiPrincipal(kit.f, { read: ['ops'], write: ['ops'] });

    const dup = await kit.knowledge.createNote({ title: 'Payment latency runbook', markdown: 'Restart the payment service when latency alarms fire.', domains: ['ops'], by: ai });
    expect(dup.possible_duplicates.map((h) => h.uid)).toEqual([original.uid]);
    expect(dup.tags).toContain(TAG.possibleDupOf(original.uid));
    const refs = await kit.f.edges.listForNode(dup.uid, { direction: 'out', type: ['references'] });
    expect(refs.map((e) => [e.dst_uid, e.properties.reason])).toEqual([[original.uid, 'possible-duplicate']]);

    const distinct = await kit.knowledge.createNote({ title: 'Freezer inventory', markdown: 'Count the freezer racks every Friday.', domains: ['ops'], by: ai });
    expect(distinct.possible_duplicates).toEqual([]);
    expect(distinct.tags.some((t) => t.startsWith('possible-dup-of:'))).toBe(false);
  });

  it('AI create still succeeds when dedup search is unavailable', async () => {
    await kit.close();
    kit = await createKnowledgeKit({ gatewayFail: true });
    const ai = aiPrincipal(kit.f, { read: ['ops'], write: ['ops'] });
    const n = await kit.knowledge.createNote({ title: 'Pager rota', markdown: 'Rotate the pager weekly.', domains: ['ops'], by: ai });
    expect(n.possible_duplicates).toEqual([]);
  });

  it('lineage: create emits produces and an applied edit emits updates, only from a session step', async () => {
    const sid = 'ses_00000000000000000001';
    await kit.f.db.query(`INSERT INTO sessions (session_id, team_id, kind, budget) VALUES ($1, $2, 'circuit-run', '{}')`, [sid, kit.f.team_id]);
    const ai = aiPrincipal(kit.f, { read: ['ops'], write: ['ops'], session_id: sid });
    const lineage = async (uid: string, type: 'produces' | 'updates') => (await kit.f.edges.listForNode(uid, { direction: 'in', type: [type] })).map((e) => [e.src_session_id, e.src_step_id, e.dst_revision]);

    const n = await kit.knowledge.createNote({ title: 'Pager rota', markdown: 'Rotate the pager weekly.', domains: ['ops'], by: ai, step_id: 'write' });
    expect(await lineage(n.uid, 'produces')).toEqual([[sid, 'write', n.revision_id]]);
    expect((await kit.f.nodes.getRevision(n.uid, n.revision_id))?.labels).toEqual(['step-completion']);

    const same = await kit.knowledge.proposeEdit({ uid: n.uid, base_revision: n.revision_id, markdown: 'Rotate the pager weekly.', by: ai, step_id: 'edit' });
    expect(same.blocks_changed).toBe(0);
    expect(await lineage(n.uid, 'updates')).toEqual([]);
    const edit = await kit.knowledge.proposeEdit({ uid: n.uid, base_revision: n.revision_id, markdown: 'Rotate the pager every week.', by: ai, step_id: 'edit' });
    expect(await lineage(n.uid, 'updates')).toEqual([[sid, 'edit', edit.new_head_revision]]);

    // No step (e.g. an MCP call) means no provenance edge.
    const loose = await kit.knowledge.createNote({ title: 'Loose', markdown: 'No step here.', domains: ['ops'], by: ai });
    expect(await lineage(loose.uid, 'produces')).toEqual([]);
    expect((await kit.f.nodes.getRevision(loose.uid, loose.revision_id))?.labels).toEqual(['publish']);
  });

  it('searches text vs semantic with AI domain filtering', async () => {
    const ops = await kit.knowledge.createNote({ title: 'Payment latency', markdown: 'Restart the payment service when latency alarms fire.', domains: ['ops'], by: kit.f.memberPrincipal });
    const data = await kit.knowledge.createNote({ title: 'Orders table', markdown: 'The orders table stores customer purchases with totals.', domains: ['data'], by: kit.f.memberPrincipal });
    const secret = await kit.knowledge.createNote({ title: 'Launch codes', markdown: 'Rotation procedure for launch codes and vault keys.', domains: ['secret'], by: kit.f.memberPrincipal });
    for (const n of [ops, data, secret]) await kit.knowledge.reindexEmbeddings(n.uid);
    const chunks = await kit.f.db.query(`SELECT count(*)::int AS n FROM knowledge_chunks`);
    expect(chunks.rows[0].n).toBe(3);

    const member = kit.f.memberPrincipal;
    const text = await kit.knowledge.search({ q: 'orders', mode: 'text', by: member });
    expect(text.map((h) => h.uid)).toEqual([data.uid]);
    expect(text[0]!.source).toBe('text');
    expect(text[0]!.snippet).toContain('orders table');

    const sem = await kit.knowledge.search({ q: 'payment service latency alarms', mode: 'semantic', by: member });
    expect(sem[0]!.uid).toBe(ops.uid);
    expect(sem[0]!.source).toBe('semantic');

    const ai = aiPrincipal(kit.f, { read: ['ops', 'data'] });
    const aiSem = await kit.knowledge.search({ q: 'launch codes rotation vault keys', mode: 'semantic', by: ai });
    expect(aiSem.map((h) => h.uid)).not.toContain(secret.uid);
    expect((await kit.knowledge.search({ q: 'launch', mode: 'text', by: ai })).map((h) => h.uid)).toEqual([]);
    expect((await kit.knowledge.search({ q: 'launch', mode: 'text', by: member })).map((h) => h.uid)).toEqual([secret.uid]);
    // explicit domain filter outside the grant yields nothing
    expect(await kit.knowledge.search({ q: 'launch codes', mode: 'hybrid', domains: ['secret'], by: ai })).toEqual([]);

    const hybrid = await kit.knowledge.search({ q: 'orders table purchases', by: member });
    expect(hybrid[0]!.uid).toBe(data.uid);
    expect(hybrid[0]!.source).toBe('hybrid');
  });

  it('embeds new notes and unchanged connector bodies without waiting for a live edit', async () => {
    await kit.close();
    kit = await createKnowledgeKit({ embedDebounceMs: 10 });
    const chunks = async (uid: string) => (await kit.f.db.query(`SELECT count(*)::int AS n FROM knowledge_chunks WHERE uid = $1`, [uid])).rows[0].n as number;
    const eventually = async (uid: string) => {
      for (let i = 0; i < 100 && (await chunks(uid)) === 0; i++) await new Promise((r) => setTimeout(r, 20));
      return chunks(uid);
    };
    const created = await kit.knowledge.createNote({ title: 'Freezer inventory', markdown: 'Count the freezer racks every Friday.', domains: ['ops'], by: kit.f.memberPrincipal });
    expect(await eventually(created.uid)).toBe(1);
    // The connector path: the node is created with its body, then replaced with the same markdown.
    const md = 'Synced from the wiki.';
    const synced = await kit.f.nodes.create({ type: 'knowledge', title: 'Wiki page', properties: { domains: ['ops'] }, body_text: md, crdt: true, tags: [], scope: 'team', created_by: { kind: 'service', id: 'connector' } });
    await kit.knowledge.replaceBody({ uid: synced.uid, markdown: md, by: { kind: 'service', id: 'connector' }, label: 'connector-sync' });
    expect(await eventually(synced.uid)).toBe(1);
  });

  it('falls back to text search when embeddings fail in hybrid mode', async () => {
    await kit.close();
    kit = await createKnowledgeKit({ gatewayFail: true });
    const n = await kit.knowledge.createNote({ title: 'Orders', markdown: 'orders table', domains: ['data'], by: kit.f.memberPrincipal });
    await kit.knowledge.reindexEmbeddings(n.uid); // logs + skips
    expect((await kit.knowledge.search({ q: 'orders', by: kit.f.memberPrincipal })).map((h) => h.uid)).toEqual([n.uid]);
    expect(await code(kit.knowledge.search({ q: 'orders', mode: 'semantic', by: kit.f.memberPrincipal }))).toBe('invalid-state');
  });

  it('injection rule table:orders matches a note tagged table:orders', async () => {
    const n = await kit.knowledge.createNote({ title: 'orders table semantics', markdown: 'Totals are in cents.', domains: ['data'], tags: ['table:orders'], by: kit.f.memberPrincipal });
    await kit.knowledge.createNote({ title: 'customers', markdown: 'PII.', domains: ['data'], tags: ['table:customers_archive'], by: kit.f.memberPrincipal });
    const inj = await kit.knowledge.injectionsFor('SELECT total FROM orders WHERE id = 1', ['data']);
    expect(inj).toHaveLength(1);
    expect(inj[0]).toMatchObject({ uid: n.uid, title: 'orders table semantics', markdown: 'Totals are in cents.' });
    expect(inj[0]!.rule).toContain('data:');
    expect(await kit.f.nodes.getRevision(n.uid, inj[0]!.revision_id)).toBeTruthy();
    expect(await kit.knowledge.injectionsFor('SELECT total FROM orders', ['ops'])).toEqual([]);
    expect(await kit.knowledge.injectionsFor('SELECT total FROM orders', null)).toHaveLength(1);
    expect(await kit.knowledge.injectionsFor('nothing relevant', null)).toEqual([]);
  });

  it('reports domains with note counts', async () => {
    await kit.knowledge.createNote({ title: 'a', markdown: 'a', domains: ['ops'], by: kit.f.memberPrincipal });
    await kit.knowledge.createNote({ title: 'b', markdown: 'b', domains: ['ops', 'data'], by: kit.f.memberPrincipal });
    const d = await kit.knowledge.domains();
    expect(d).toEqual([
      { slug: 'ops', description: 'Operations', note_count: 2 },
      { slug: 'data', description: 'Data', note_count: 1 },
      { slug: 'secret', description: 'Restricted', note_count: 0 },
    ]);
  });

  it('compaction prunes yjs_updates while revisions stay readable', async () => {
    const node = await kit.knowledge.createNote({ title: 'Log', markdown: 'start', domains: ['ops'], by: kit.f.memberPrincipal });
    const r1 = (await kit.knowledge.readNote(node.uid, kit.f.memberPrincipal)).base_revision;
    for (let i = 0; i < 20; i++) await kit.sync.transact(node.uid, human(), (doc) => humanEditBlock(doc, 0, ` ${i}`));
    const finalMd = await kit.knowledge.markdownOf(node.uid);
    const count = async () => Number((await kit.f.db.query(`SELECT count(*)::int AS n FROM yjs_updates WHERE uid=$1`, [node.uid])).rows[0].n);
    const before = await count();
    expect(before).toBeGreaterThanOrEqual(20);
    // Age the log past the retention window.
    await kit.f.db.query(`UPDATE yjs_updates SET created_at = now() - interval '2 days' WHERE uid=$1`, [node.uid]);
    const pruned = await kit.knowledge.compact(node.uid);
    expect(pruned).toBe(before);
    expect(await count()).toBe(0);
    const latest = await kit.f.nodes.latestRevision(node.uid);
    expect(latest?.labels).toContain('compaction');
    expect(latest?.body_text).toBe(finalMd);
    expect((await kit.f.nodes.getRevision(node.uid, r1))?.body_text).toBe('start');

    // A fresh sync server reloads the doc from the snapshot alone.
    const sync2 = createSyncServer({ db: kit.f.db, team_id: kit.f.team_id, nodes: kit.f.nodes, linkIndexer: kit.f.linkIndexer, auth: { authenticate: async () => kit.f.memberPrincipal }, events: kit.events, settings: () => kit.settings, log: kit.f.log, compactIntervalMs: 0 });
    try {
      expect(docToMarkdown(await sync2.openDoc(node.uid))).toBe(finalMd);
    } finally {
      await sync2.stop();
    }
  });
});
