import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BreadboardError, TAG } from '@breadboard/shared';
import { createKnowledgeKit, testSettings, type KnowledgeKit } from './testkit.js';
import { createConnectorScheduler, type ConnectorSchedulerImpl } from './connectors.js';

const TOOL = '01J8T0G1TMDC0NNECT00';

describe('ConnectorScheduler', () => {
  let kit: KnowledgeKit;
  let docs: Record<string, { title: string; updated_at: string; markdown: string }>;
  let calls: Array<{ export: string; input: unknown }>;
  let sched: ConnectorSchedulerImpl;

  beforeEach(async () => {
    kit = await createKnowledgeKit({ settings: testSettings({ connectors: [{ tool: TOOL, domains: ['ops', 'undeclared'], settings: { repo_url: 'https://example.com/r.git' } }] }) });
    docs = {
      'a.md': { title: 'A', updated_at: '2026-09-01T00:00:00Z', markdown: '# A\n\nalpha body' },
      'b.md': { title: 'B', updated_at: '2026-09-01T00:00:00Z', markdown: '# B\n\nbeta body' },
      'c.md': { title: 'C', updated_at: '2026-09-01T00:00:00Z', markdown: '# C\n\ngamma body' },
    };
    calls = [];
    const toolbox = {
      async invoke(inv: any) {
        calls.push({ export: inv.export, input: inv.input });
        expect(inv.ambient.invocation).toBe('connector');
        expect(inv.settings).toEqual({ repo_url: 'https://example.com/r.git' });
        if (inv.export === 'list') {
          const ids = Object.keys(docs).sort();
          const start = inv.input[0] ? Number(String(inv.input[0]).slice(2)) : 0;
          const page = ids.slice(start, start + 2);
          return { output: { items: page.map((id) => ({ external_id: id, title: docs[id]!.title, updated_at: docs[id]!.updated_at })), next_cursor: start + 2 < ids.length ? `o:${start + 2}` : null }, logs: [], execution_key: 'k', replayed: false, cost_units: 0, duration_ms: 1 };
        }
        const d = docs[inv.input[0]];
        if (!d) throw new Error('missing');
        return { output: { markdown: d.markdown, metadata: { title: d.title, source_url: `https://example.com/${inv.input[0]}` } }, logs: [], execution_key: 'k', replayed: false, cost_units: 0, duration_ms: 1 };
      },
    };
    const config = { async tool(uid: string) { return { uid, commit: 'c0', dir: 'tools/x', tool: { slug: 'git-markdown-connector', connector: { schedule_minutes: 360, domains: [] } } } as any; } };
    sched = createConnectorScheduler({ db: kit.f.db, team_id: kit.f.team_id, nodes: kit.f.nodes, knowledge: kit.knowledge, toolbox, config, settings: () => kit.settings, log: kit.f.log });
  });
  afterEach(async () => {
    await sched.stop();
    await kit.close();
  });

  it('materializes read-only notes, syncs incrementally and reports status', async () => {
    const r1 = await sched.syncNow(TOOL, kit.f.adminPrincipal);
    expect(r1).toEqual({ fetched: 3, updated: 3, errors: [] });
    expect(calls.filter((c) => c.export === 'list').map((c) => c.input)).toEqual([[null], ['o:2']]);
    const page = await kit.f.nodes.list({ type: ['knowledge'], tag: [TAG.connector(TOOL)] });
    expect(page.items).toHaveLength(3);
    const a = page.items.find((n) => n.properties.external_id === 'a.md')!;
    expect(a.tags).toEqual(expect.arrayContaining([TAG.readOnly, TAG.connector(TOOL)]));
    expect(a.properties).toMatchObject({ domains: ['ops'], source_url: 'https://example.com/a.md', source_updated_at: '2026-09-01T00:00:00Z' });
    expect(await kit.knowledge.markdownOf(a.uid)).toBe('# A\n\nalpha body');
    expect((await kit.f.nodes.latestRevision(a.uid))?.labels).toContain('connector-sync');
    expect((await kit.f.nodes.latestRevision(a.uid))?.created_by.kind).toBe('service');

    // Unchanged upstream → nothing fetched.
    calls = [];
    expect(await sched.syncNow(TOOL, kit.f.adminPrincipal)).toEqual({ fetched: 0, updated: 0, errors: [] });
    expect(calls.every((c) => c.export === 'list')).toBe(true);

    // Changed upstream → only that doc re-fetched; the CRDT body updates.
    docs['a.md'] = { title: 'A2', updated_at: '2026-09-02T00:00:00Z', markdown: '# A\n\nalpha body revised' };
    expect(await sched.syncNow(TOOL, kit.f.adminPrincipal)).toMatchObject({ fetched: 1, updated: 1 });
    expect(await kit.knowledge.markdownOf(a.uid)).toBe('# A\n\nalpha body revised');
    expect((await kit.f.nodes.get(a.uid))?.title).toBe('A2');

    const st = await sched.status();
    expect(st).toEqual([expect.objectContaining({ tool_uid: TOOL, slug: 'git-markdown-connector', running: false, doc_count: 3, schedule_minutes: 360, last_error: null })]);
    expect(st[0]!.last_sync_at).toBeTruthy();

    // Connector notes are read-only for edits.
    const read = await kit.knowledge.readNote(a.uid, kit.f.memberPrincipal);
    await expect(kit.knowledge.proposeEdit({ uid: a.uid, base_revision: read.base_revision, markdown: 'x', by: kit.f.memberPrincipal })).rejects.toMatchObject({ code: 'read-only-source' });
  });

  it('requires admin for manual sync and records per-document errors', async () => {
    await expect(sched.syncNow(TOOL, kit.f.memberPrincipal)).rejects.toBeInstanceOf(BreadboardError);
    docs['b.md']!.markdown = 'has a NUL \u0000 char';
    const r = await sched.syncNow(TOOL, kit.f.adminPrincipal);
    expect(r.updated).toBe(2);
    expect(r.errors).toHaveLength(1);
    expect((await sched.status())[0]!.last_error).toContain('b.md');
  });
});
