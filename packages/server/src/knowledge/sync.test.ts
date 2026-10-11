import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { aiPrincipal, createKnowledgeKit, type KnowledgeKit } from './testkit.js';
import { SYNC_PATH } from './sync.js';
import { blocksOf, docToMarkdown } from './ydoc.js';
import { WebSocket as WsWebSocket } from 'ws';

async function until(pred: () => boolean | Promise<boolean>, ms = 5000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('HocuspocusSyncServer over WebSocket', () => {
  let kit: KnowledgeKit;
  let app: FastifyInstance;
  let url: string;
  const cleanups: Array<() => void> = [];

  beforeEach(async () => {
    kit = await createKnowledgeKit();
    app = Fastify();
    await app.register(websocket);
    await kit.sync.register(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as { port: number };
    url = `ws://127.0.0.1:${addr.port}${SYNC_PATH}`;
    kit.tokens.set('member-token', kit.f.memberPrincipal);
    kit.tokens.set('reader-token', { ...kit.f.memberPrincipal, scopes: ['knowledge:read'] });
    kit.tokens.set('ai-secret-token', aiPrincipal(kit.f, { read: ['secret'], write: ['secret'] }));
  });

  afterEach(async () => {
    for (const c of cleanups.splice(0)) c();
    await kit.sync.stop();
    await app.close();
    await kit.close();
  });

  function connect(name: string, token: string, opts: { query?: string; headers?: Record<string, string> } = {}) {
    const document = new Y.Doc({ gc: false });
    const state = { synced: false, authFailed: null as string | null, stateless: [] as string[] };
    // The global WebSocket cannot set headers; `ws` can (a proxy adds its header to the upgrade request).
    const extra = opts.headers;
    const Polyfill = extra
      ? class extends (WsWebSocket as any) {
          constructor(address: string, protocols?: string | string[]) {
            super(address, protocols, { headers: extra });
          }
        }
      : globalThis.WebSocket;
    const websocketProvider = new HocuspocusProviderWebsocket({ url: url + (opts.query ?? ''), WebSocketPolyfill: Polyfill as any });
    const provider = new HocuspocusProvider({
      websocketProvider,
      name,
      document,
      token,
      onSynced: () => {
        state.synced = true;
      },
      onAuthenticationFailed: ({ reason }: { reason: string }) => {
        state.authFailed = reason;
      },
      onStateless: ({ payload }: { payload: string }) => {
        state.stateless.push(payload);
      },
    } as any);
    provider.attach(); // a shared (caller-owned) websocket provider must be attached explicitly
    cleanups.push(() => {
      provider.destroy();
      websocketProvider.destroy();
    });
    return { document, provider, state };
  }

  it('authenticates a socket that came through the trusted proxy, and only that one', async () => {
    const note = await kit.knowledge.createNote({ title: 'Proxied', markdown: 'hello', domains: ['ops'], by: kit.f.memberPrincipal });
    kit.proxy.principal = { ...kit.f.memberPrincipal, token_kind: 'proxy' };
    const proxied = connect(note.uid, '', { headers: { 'x-test-proxy': kit.proxy.secret } });
    await until(() => proxied.state.synced, 5000, 'proxied client synced');
    expect(docToMarkdown(proxied.document)).toBe('hello');

    const wrong = connect(note.uid, '', { headers: { 'x-test-proxy': 'not-the-secret' } });
    const none = connect(note.uid, '');
    await until(() => !!wrong.state.authFailed && !!none.state.authFailed, 5000, 'unproxied clients refused');
    expect(wrong.state.synced || none.state.synced).toBe(false);
  });

  it('syncs edits between two clients and persists them to yjs_updates', async () => {
    const note = await kit.knowledge.createNote({ title: 'Shared', markdown: 'first block\n\nsecond block', domains: ['ops'], by: kit.f.memberPrincipal });
    const a = connect(note.uid, 'member-token');
    const b = connect(note.uid, 'member-token');
    await until(() => a.state.synced && b.state.synced, 5000, 'both synced');
    expect(docToMarkdown(a.document)).toBe('first block\n\nsecond block');

    const before = Number((await kit.f.db.query(`SELECT count(*)::int AS n FROM yjs_updates WHERE uid=$1`, [note.uid])).rows[0].n);
    (blocksOf(a.document).get(0).get('text') as Y.Text).insert(0, 'EDITED ');
    await until(() => docToMarkdown(b.document).startsWith('EDITED first block'), 5000, 'edit to reach client b');

    await kit.sync.flush(note.uid);
    const rows = await kit.f.db.query(`SELECT origin FROM yjs_updates WHERE uid=$1 ORDER BY seq`, [note.uid]);
    expect(rows.rows.length).toBeGreaterThan(before);
    expect(rows.rows.some((r: any) => r.origin?.actor?.kind === 'user' && r.origin.actor.id === kit.f.member.user_id)).toBe(true);

    // Server-side view and attribution follow; the debounced store refreshes the body_text mirror.
    expect(await kit.knowledge.markdownOf(note.uid)).toBe('EDITED first block\n\nsecond block');
    const id0 = blocksOf(a.document).get(0).get('id') as string;
    await until(async () => (await kit.knowledge.attribution(note.uid))[id0]?.actor.kind === 'user', 3000, 'attribution');
    await until(async () => (await kit.f.nodes.get(note.uid))?.body_text === 'EDITED first block\n\nsecond block', 3000, 'body_text mirror');

    // Server-originated (AI) edits reach connected clients.
    const ai = aiPrincipal(kit.f, { read: ['ops'], write: ['ops'] });
    const base = await kit.knowledge.readNote(note.uid, ai);
    await kit.knowledge.proposeEdit({ uid: note.uid, base_revision: base.base_revision, markdown: base.markdown + '\n\nthird block from AI', by: ai });
    await until(() => docToMarkdown(a.document).endsWith('third block from AI') && docToMarkdown(b.document).endsWith('third block from AI'), 5000, 'AI edit to reach clients');
  });

  it('read-only connections cannot write', async () => {
    const note = await kit.knowledge.createNote({ title: 'RO', markdown: 'original text', domains: ['ops'], by: kit.f.memberPrincipal });
    const writer = connect(note.uid, 'member-token');
    const reader = connect(note.uid, 'reader-token');
    await until(() => writer.state.synced && reader.state.synced, 5000, 'both synced');

    (blocksOf(reader.document).get(0).get('text') as Y.Text).insert(0, 'HACK ');
    await sleep(300);
    expect(await kit.knowledge.markdownOf(note.uid)).toBe('original text');
    expect(docToMarkdown(writer.document)).toBe('original text');

    // But the read-only client still receives writes from others.
    (blocksOf(writer.document).get(0).get('text') as Y.Text).insert(13, ' plus');
    await until(() => docToMarkdown(reader.document).includes('plus'), 5000, 'reader to receive');
    expect(await kit.knowledge.markdownOf(note.uid)).toBe('original text plus');
  });

  it('connector-owned (read-only tagged) notes are read-only even for writers', async () => {
    const ro = await kit.f.nodes.create({ type: 'knowledge', title: 'Upstream', properties: { domains: ['ops'] }, body_text: 'upstream body', crdt: true, tags: ['read-only'], created_by: { kind: 'service', id: 'connector' } });
    const c = connect(ro.uid, 'member-token');
    await until(() => c.state.synced, 5000, 'synced');
    (blocksOf(c.document).get(0).get('text') as Y.Text).insert(0, 'X');
    await sleep(300);
    expect(await kit.knowledge.markdownOf(ro.uid)).toBe('upstream body');
  });

  it('rejects bad tokens and missing domain grants at doc-open', async () => {
    const note = await kit.knowledge.createNote({ title: 'Ops', markdown: 'ops only', domains: ['ops'], by: kit.f.memberPrincipal });
    const bad = connect(note.uid, 'nope');
    const ai = connect(note.uid, 'ai-secret-token');
    await until(() => bad.state.authFailed !== null && ai.state.authFailed !== null, 5000, 'auth failures');
    expect(bad.state.synced).toBe(false);
    expect(ai.state.authFailed).toMatch(/grant|domain|denied/i);
  });

  it('blocks a wipeout from an editor connection', async () => {
    const body = 'This is a reasonably long paragraph that should not be erased by accident.\n\nAnd a second paragraph that also holds valuable content for the team.';
    const note = await kit.knowledge.createNote({ title: 'Guarded', markdown: body, domains: ['ops'], by: kit.f.memberPrincipal });
    const c = connect(note.uid, 'member-token');
    await until(() => c.state.synced, 5000, 'synced');
    const arr = blocksOf(c.document);
    c.document.transact(() => arr.delete(0, arr.length));
    await until(() => kit.events.published.some((e) => e.payload?.wipeout_blocked), 5000, 'wipeout event');
    await sleep(200);
    expect(await kit.knowledge.markdownOf(note.uid)).toBe(body);
  });
});
