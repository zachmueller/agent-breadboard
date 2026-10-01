import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ChangeSet, EditorState, type TransactionSpec } from '@codemirror/state';
import { createBindingCore, fromYjs, type BindingCore, type BindingHost } from './yBlockBinding';
import { blockId, blockString, blocksToMarkdown, getBlocks, makeBlock, seedBlocks, type BlockMap } from './ydocSchema';
import { affectedRange } from './blockModel';

// ------------------------------------------------------------ harness

/** Seeded PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let idCounter = 0;
const mint = () => `id${(idCounter++).toString().padStart(8, '0')}`;

class FakeHost implements BindingHost {
  state = EditorState.create({ doc: '' });
  core: BindingCore | null = null;
  dispatch(spec: TransactionSpec) {
    const tr = this.state.update(spec);
    this.state = tr.state;
    if (tr.docChanged && !tr.annotation(fromYjs)) this.core?.applyLocal(tr.changes, tr.startState.doc);
  }
  get text() {
    return this.state.doc.toString();
  }
}

function bind(doc: Y.Doc, paranoid = true) {
  const host = new FakeHost();
  const resyncs: string[] = [];
  host.core = createBindingCore(getBlocks(doc), host, { mintId: mint, paranoid, onResync: (r) => resyncs.push(r) });
  return { host, resyncs };
}

function snapshot(doc: Y.Doc) {
  return getBlocks(doc)
    .toArray()
    .map((m) => ({ id: blockId(m), text: blockString(m) }));
}

/** Wire docs together like a Hocuspocus room (updates applied with a remote origin). */
function connect(docs: Y.Doc[]) {
  for (const d of docs) {
    d.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return;
      for (const o of docs) if (o !== d) Y.applyUpdate(o, u, 'remote');
    });
  }
}

const ALPHA = ['a', 'b', 'c', ' ', '\n', '\n', '\n\n', '\n\n', '#', '```', 'xy'];
function randText(r: () => number, max = 4): string {
  const n = Math.floor(r() * max);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHA[Math.floor(r() * ALPHA.length)];
  return s;
}

function randChanges(r: () => number, len: number): Array<{ from: number; to: number; insert: string }> {
  const count = r() < 0.8 ? 1 : 2 + Math.floor(r() * 2);
  const points = Array.from({ length: count * 2 }, () => Math.floor(r() * (len + 1))).sort((x, y) => x - y);
  const out: Array<{ from: number; to: number; insert: string }> = [];
  for (let i = 0; i < count; i++) {
    let from = points[2 * i];
    let to = points[2 * i + 1];
    if (r() < 0.4) to = from; // pure insertion
    if (out.length && from < out[out.length - 1].to) from = to = out[out.length - 1].to;
    out.push({ from, to, insert: r() < 0.25 ? '' : randText(r) });
  }
  return out;
}

const SEED_DOCS = ['', 'hello', 'a\n\nb', '# Title\n\nPara one.\n\n- item\n- item 2\n\n```\ncode\n\nmore\n```\n\nEnd', '\n\n\n\nx', 'one\n\ntwo\n\nthree'];

function seeded(md: string) {
  const doc = new Y.Doc();
  seedBlocks(getBlocks(doc), md, mint);
  return doc;
}

// ------------------------------------------------------------ tests

describe('yBlockBinding — single editor', () => {
  it('initialises the editor from the blocks', () => {
    const doc = seeded('a\n\nb\n\nc');
    const { host } = bind(doc);
    expect(host.text).toBe('a\n\nb\n\nc');
    expect(host.core!.blockRanges().map((r) => [r.from, r.to])).toEqual([
      [0, 1],
      [3, 4],
      [6, 7],
    ]);
  });

  it('typing inside a block edits only that block', () => {
    const doc = seeded('alpha\n\nbeta');
    const before = snapshot(doc);
    const { host } = bind(doc);
    host.dispatch({ changes: { from: 9, insert: 'XX' } });
    expect(host.text).toBe('alpha\n\nbeXXta');
    const after = snapshot(doc);
    expect(after.map((b) => b.id)).toEqual(before.map((b) => b.id));
    expect(after[1].text).toBe('beXXta');
  });

  it('splits a block on an inserted blank line: first half keeps the id', () => {
    const doc = seeded('foobar');
    const [orig] = snapshot(doc);
    const { host } = bind(doc);
    host.dispatch({ changes: { from: 3, insert: '\n\n' } });
    const after = snapshot(doc);
    expect(after.map((b) => b.text)).toEqual(['foo', 'bar']);
    expect(after[0].id).toBe(orig.id);
    expect(after[1].id).not.toBe(orig.id);
  });

  it('pressing Enter twice at the end of a block creates a new empty block', () => {
    const doc = seeded('foo\n\nnext');
    const before = snapshot(doc);
    const { host } = bind(doc);
    host.dispatch({ changes: { from: 3, insert: '\n' } });
    host.dispatch({ changes: { from: 4, insert: '\n' } });
    host.dispatch({ changes: { from: 5, insert: 'bar' } });
    const after = snapshot(doc);
    expect(after.map((b) => b.text)).toEqual(['foo', 'bar', 'next']);
    expect(after[0].id).toBe(before[0].id);
    expect(after[2].id).toBe(before[1].id);
  });

  it('deleting a separator merges blocks, keeping the first id', () => {
    const doc = seeded('one\n\ntwo\n\nthree');
    const before = snapshot(doc);
    const { host } = bind(doc);
    host.dispatch({ changes: { from: 3, to: 5 } });
    const after = snapshot(doc);
    expect(after.map((b) => b.text)).toEqual(['onetwo', 'three']);
    expect(after.map((b) => b.id)).toEqual([before[0].id, before[2].id]);
  });

  it('backspace into a separator (one newline) merges', () => {
    const doc = seeded('one\n\ntwo');
    const before = snapshot(doc);
    const { host } = bind(doc);
    host.dispatch({ changes: { from: 4, to: 5 } });
    expect(host.text).toBe('one\ntwo');
    expect(snapshot(doc)).toEqual([{ id: before[0].id, text: 'one\ntwo' }]);
  });

  it('cross-block deletion drops the covered blocks and keeps both ends', () => {
    const doc = seeded('aaa\n\nbbb\n\nccc\n\nddd');
    const before = snapshot(doc);
    const { host } = bind(doc);
    host.dispatch({ changes: { from: 1, to: 11 } }); // "aa\n\nbbb\n\ncc" removed → "a" + "cc"... (a|aa..c|cc)
    expect(host.text).toBe('acc\n\nddd');
    expect(snapshot(doc).map((b) => b.id)).toEqual([before[0].id, before[3].id]);
  });

  it('deleting whole blocks from start to start keeps the following block id', () => {
    const doc = seeded('A\n\nB\n\nC');
    const before = snapshot(doc);
    const { host } = bind(doc);
    host.dispatch({ changes: { from: 3, to: 6 } }); // "B\n\n"
    expect(host.text).toBe('A\n\nC');
    expect(snapshot(doc).map((b) => b.id)).toEqual([before[0].id, before[2].id]);
  });

  it('pasting a multi-paragraph text mints ids only for the new paragraphs', () => {
    const doc = seeded('start\n\nend');
    const before = snapshot(doc);
    const { host } = bind(doc);
    host.dispatch({ changes: { from: 7, insert: 'p1\n\np2\n\n' } });
    const after = snapshot(doc);
    expect(after.map((b) => b.text)).toEqual(['start', 'p1', 'p2', 'end']);
    expect(after[0].id).toBe(before[0].id);
    expect(after[3].id).toBe(before[1].id);
    expect(new Set(after.map((b) => b.id)).size).toBe(4);
  });

  it('does not split inside an open code fence', () => {
    const doc = seeded('```js\nx = 1');
    const { host } = bind(doc);
    host.dispatch({ changes: { from: host.text.length, insert: '\n\ny = 2\n```' } });
    expect(snapshot(doc).map((b) => b.text)).toEqual(['```js\nx = 1\n\ny = 2\n```']);
  });

  it('typing into an empty document creates the first block', () => {
    const doc = new Y.Doc();
    const { host } = bind(doc);
    host.dispatch({ changes: { from: 0, insert: 'hi\n\nthere' } });
    expect(snapshot(doc).map((b) => b.text)).toEqual(['hi', 'there']);
  });

  it('select-all + delete leaves one empty block', () => {
    const doc = seeded('a\n\nb\n\nc');
    const first = snapshot(doc)[0].id;
    const { host } = bind(doc);
    host.dispatch({ changes: { from: 0, to: host.text.length } });
    expect(snapshot(doc)).toEqual([{ id: first, text: '' }]);
    expect(host.text).toBe('');
  });

  it('local transactions carry the local origin', () => {
    const doc = seeded('a');
    const { host } = bind(doc);
    const origins: unknown[] = [];
    doc.on('afterTransaction', (t: Y.Transaction) => origins.push(t.origin));
    host.dispatch({ changes: { from: 1, insert: 'b' } });
    expect(origins).toEqual([host.core!.origin]);
    expect(host.core!.origin).toEqual({ kind: 'user', local: true });
  });
});

describe('yBlockBinding — remote changes', () => {
  it('maps a remote text edit into the right block offset', () => {
    const doc = seeded('one\n\ntwo\n\nthree');
    const { host } = bind(doc);
    const yt = getBlocks(doc).get(1).get('text') as Y.Text;
    doc.transact(() => yt.insert(1, 'XX'), 'remote');
    expect(host.text).toBe('one\n\ntXXwo\n\nthree');
  });

  it('maps remote block inserts/deletes (server-minted ids)', () => {
    const doc = seeded('one\n\ntwo\n\nthree');
    const { host } = bind(doc);
    const blocks = getBlocks(doc);
    doc.transact(() => {
      blocks.delete(1, 1);
      blocks.insert(0, [makeBlock('srv0000001', 'zero')]);
      blocks.insert(blocks.length, [makeBlock('srv0000002', 'four')]);
      (blocks.get(1).get('text') as Y.Text).insert(0, '1:');
    }, 'server');
    expect(host.text).toBe('zero\n\n1:one\n\nthree\n\nfour');
  });

  it('remote edits do not echo back into Yjs', () => {
    const doc = seeded('one');
    const { host } = bind(doc);
    let n = 0;
    doc.on('update', () => n++); // (YTextEvent.delta opens an empty transaction; only real writes emit updates)
    doc.transact(() => (getBlocks(doc).get(0).get('text') as Y.Text).insert(3, '!'), 'remote');
    expect(n).toBe(1);
    expect(host.text).toBe('one!');
  });

  it('reads blocks that use the `ytext` key and writes new blocks with it', () => {
    const doc = new Y.Doc();
    const blocks = getBlocks(doc);
    const m = new Y.Map<unknown>();
    m.set('id', 'srv0000001');
    m.set('ytext', new Y.Text('legacy'));
    blocks.insert(0, [m]);
    const { host } = bind(doc);
    expect(host.text).toBe('legacy');
    host.dispatch({ changes: { from: 6, insert: '\n\nnew' } });
    expect(blocks.get(1).get('ytext')).toBeInstanceOf(Y.Text);
    expect(blocksToMarkdown(blocks)).toBe('legacy\n\nnew');
  });

  it('relative positions survive concurrent edits', () => {
    const doc = seeded('one\n\ntwo');
    const { host } = bind(doc);
    const rel = host.core!.relativeFromPos(6); // "t|wo"
    doc.transact(() => getBlocks(doc).insert(0, [makeBlock('srv0000009', 'zero')]), 'remote');
    expect(host.core!.posFromRelative(rel)).toBe(12); // zero\n\none\n\nt|wo
  });
});

describe('yBlockBinding — property tests', () => {
  it('random local edits keep cmDoc === join(blocks), ids unique, untouched blocks stable', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const doc = seeded(SEED_DOCS[seed % SEED_DOCS.length]);
      const { host, resyncs } = bind(doc);
      for (let step = 0; step < 40; step++) {
        const before = snapshot(doc);
        const changes = randChanges(r, host.text.length);
        host.dispatch({ changes });
        const after = snapshot(doc);
        const ctx = `seed ${seed} step ${step} changes ${JSON.stringify(changes)} before ${JSON.stringify(before)}`;
        expect(host.text, ctx).toBe(blocksToMarkdown(getBlocks(doc)));
        expect(new Set(after.map((b) => b.id)).size, ctx).toBe(after.length);
        if (changes.length === 1 && before.length) {
          const c = changes[0];
          const { first, last } = affectedRange(
            before.map((b) => b.text.length),
            c.from,
            c.to,
          );
          // Blocks outside the touched range are untouched: same ids, same text, same order.
          expect(after.slice(0, first), ctx).toEqual(before.slice(0, first));
          const tail = before.slice(last + 1);
          expect(after.slice(after.length - tail.length), ctx).toEqual(tail);
          // Pure in-block edits (no newlines, not touching separators) never change the id list.
          const loc = (p: number) => {
            let s = 0;
            for (let i = 0; i < before.length; i++) {
              if (p >= s && p <= s + before[i].text.length) return i;
              s += before[i].text.length + 2;
            }
            return -1;
          };
          if (!c.insert.includes('\n') && loc(c.from) >= 0 && loc(c.from) === loc(c.to) && c.insert !== '' ) {
            expect(after.map((b) => b.id), ctx).toEqual(before.map((b) => b.id));
          }
        }
      }
      expect(resyncs).toEqual([]);
    }
  });

  it('concurrent editors + server-side block edits converge, each editor mirrors its doc', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed * 7919);
      const server = seeded(SEED_DOCS[seed % SEED_DOCS.length]);
      const a = new Y.Doc();
      const b = new Y.Doc();
      Y.applyUpdate(a, Y.encodeStateAsUpdate(server), 'remote');
      Y.applyUpdate(b, Y.encodeStateAsUpdate(server), 'remote');
      const ea = bind(a);
      const eb = bind(b);
      // Buffered network: updates queue and flush at random points (simulates latency/concurrency).
      const queues = new Map<Y.Doc, Array<{ to: Y.Doc; u: Uint8Array }>>([
        [a, []],
        [b, []],
        [server, []],
      ]);
      const peers = [a, b, server];
      for (const d of peers) {
        d.on('update', (u: Uint8Array, origin: unknown) => {
          if (origin === 'remote') return;
          for (const o of peers) if (o !== d) queues.get(d)!.push({ to: o, u });
        });
      }
      const flush = (d: Y.Doc) => {
        const q = queues.get(d)!.splice(0);
        for (const { to, u } of q) Y.applyUpdate(to, u, 'remote');
      };
      for (let step = 0; step < 30; step++) {
        const roll = r();
        if (roll < 0.35) ea.host.dispatch({ changes: randChanges(r, ea.host.text.length) });
        else if (roll < 0.7) eb.host.dispatch({ changes: randChanges(r, eb.host.text.length) });
        else {
          // Server/AI write: block-level ops with server-minted ids.
          const blocks = getBlocks(server);
          server.transact(() => {
            const op = r();
            if (op < 0.3 || !blocks.length) blocks.insert(Math.floor(r() * (blocks.length + 1)), [makeBlock(`srv${seed}_${step}`.padEnd(10, 'x'), randText(r, 3).replace(/\n\n/g, '\n'))]);
            else if (op < 0.5) blocks.delete(Math.floor(r() * blocks.length), 1);
            else {
              const m = blocks.get(Math.floor(r() * blocks.length));
              const yt = m.get('text') as Y.Text;
              const p = Math.floor(r() * (yt.length + 1));
              if (r() < 0.5 && p < yt.length) yt.delete(p, 1);
              else yt.insert(p, randText(r, 3).replace(/\n\n/g, '\n') || 'q');
            }
          }, 'server');
        }
        if (r() < 0.5) flush(peers[Math.floor(r() * 3)]);
        const ctx = `seed ${seed} step ${step}`;
        expect(ea.host.text, ctx).toBe(blocksToMarkdown(getBlocks(a)));
        expect(eb.host.text, ctx).toBe(blocksToMarkdown(getBlocks(b)));
      }
      for (let i = 0; i < 3; i++) peers.forEach(flush);
      const md = blocksToMarkdown(getBlocks(server));
      expect(blocksToMarkdown(getBlocks(a))).toBe(md);
      expect(ea.host.text).toBe(md);
      expect(eb.host.text).toBe(md);
      expect(ea.resyncs).toEqual([]);
      expect(eb.resyncs).toEqual([]);
    }
  });

  it('connect() helper sanity: two bound editors converge', () => {
    const a = seeded('x');
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    connect([a, b]);
    const ea = bind(a);
    const eb = bind(b);
    ea.host.dispatch({ changes: { from: 1, insert: '\n\ny' } });
    eb.host.dispatch({ changes: { from: 0, insert: 'w' } });
    expect(ea.host.text).toBe('wx\n\ny');
    expect(eb.host.text).toBe('wx\n\ny');
  });
});

describe('ChangeSet sanity', () => {
  it('multi-change transactions apply in one Yjs transaction', () => {
    const doc = seeded('aa\n\nbb\n\ncc');
    const { host } = bind(doc);
    let n = 0;
    doc.on('afterTransaction', () => n++);
    const cs = ChangeSet.of(
      [
        { from: 0, insert: '1' },
        { from: 4, insert: '2' },
        { from: 8, insert: '3' },
      ],
      host.text.length,
    );
    host.dispatch({ changes: cs });
    expect(n).toBe(1);
    expect(host.text).toBe('1aa\n\n2bb\n\n3cc');
    expect(blocksToMarkdown(getBlocks(doc))).toBe(host.text);
  });
});

// keep the type import used
export type _B = BlockMap;
