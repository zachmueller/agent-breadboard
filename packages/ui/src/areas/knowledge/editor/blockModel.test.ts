import { describe, expect, it } from 'vitest';
import { absolute, affectedRange, applyPlan, docLength, insideOpenFence, joinTexts, locate, planChange, segmentInsert, simpleDiff, spansFor } from './blockModel';
import { BLOCK_ID_ALPHABET, mintBlockId, seedBlocks, blocksToMarkdown, getBlocks } from './ydocSchema';
import * as Y from 'yjs';

let n = 0;
const mint = () => `new${n++}`;

describe('offset mapping', () => {
  const lengths = [3, 0, 5]; // "abc" "" "defgh" → "abc\n\n\n\ndefgh"
  it('spans and length', () => {
    expect(spansFor(lengths)).toEqual([
      { from: 0, to: 3 },
      { from: 5, to: 5 },
      { from: 7, to: 12 },
    ]);
    expect(docLength(lengths)).toBe(12);
    expect(docLength([])).toBe(0);
  });
  it('locate covers block text, separator interiors and boundaries', () => {
    expect(locate(lengths, 0)).toEqual({ block: 0, offset: 0, inSeparator: false });
    expect(locate(lengths, 3)).toEqual({ block: 0, offset: 3, inSeparator: false });
    expect(locate(lengths, 4)).toEqual({ block: 0, offset: 3, inSeparator: true });
    expect(locate(lengths, 5)).toEqual({ block: 1, offset: 0, inSeparator: false });
    expect(locate(lengths, 6)).toEqual({ block: 1, offset: 0, inSeparator: true });
    expect(locate(lengths, 7)).toEqual({ block: 2, offset: 0, inSeparator: false });
    expect(locate(lengths, 12)).toEqual({ block: 2, offset: 5, inSeparator: false });
  });
  it('absolute inverts locate for in-block positions', () => {
    for (let p = 0; p <= 12; p++) {
      const l = locate(lengths, p);
      if (!l.inSeparator) expect(absolute(lengths, l.block, l.offset)).toBe(p);
    }
  });
  it('affectedRange', () => {
    expect(affectedRange([3, 3], 1, 2)).toEqual({ first: 0, last: 0 });
    expect(affectedRange([3, 3], 3, 3)).toEqual({ first: 0, last: 0 }); // end of block 0
    expect(affectedRange([3, 3], 4, 4)).toEqual({ first: 0, last: 1 }); // inside separator
    expect(affectedRange([3, 3], 5, 5)).toEqual({ first: 1, last: 1 }); // start of block 1
    expect(affectedRange([3, 3], 3, 5)).toEqual({ first: 0, last: 1 }); // the separator
  });
});

describe('join/split invariants', () => {
  it('segmentInsert round-trips through join', () => {
    for (const s of ['', 'a', 'a\n\nb', '\n\n', '\n\n\n', 'a\n\n\n\nb', '```\nx\n\ny\n```\n\nz']) {
      expect(joinTexts(segmentInsert(s))).toBe(s);
    }
    expect(segmentInsert('```\nx\n\ny\n```\n\nz')).toEqual(['```\nx\n\ny\n```', 'z']);
  });
  it('seedBlocks/blocksToMarkdown round-trip', () => {
    for (const s of ['', 'a', 'a\n\nb', 'a\n\n\nb', '\n\n\n\n']) {
      const d = new Y.Doc();
      seedBlocks(getBlocks(d), s);
      expect(blocksToMarkdown(getBlocks(d))).toBe(s);
    }
  });
  it('planChange output always joins to the edited document', () => {
    const docs = [['a', 'b', 'c'], ['', ''], ['x\ny'], ['```', 'code']];
    const inserts = ['', 'q', '\n', '\n\n', 'a\n\nb', '\n\n\n'];
    for (const texts of docs) {
      const blocks = texts.map((t, i) => ({ id: `b${i}`, text: t }));
      const doc = joinTexts(texts);
      for (let from = 0; from <= doc.length; from++)
        for (let to = from; to <= doc.length; to++)
          for (const ins of inserts) {
            const want = doc.slice(0, from) + ins + doc.slice(to);
            const out = applyPlan(blocks, planChange(blocks, from, to, ins, mint));
            expect(joinTexts(out.map((b) => b.text)), JSON.stringify({ texts, from, to, ins })).toBe(want);
            expect(new Set(out.map((b) => b.id)).size).toBe(out.length);
          }
    }
  });
  it('in-block edits carry an exact edit hint', () => {
    const plan = planChange([{ id: 'a', text: 'hello' }], 1, 3, 'EY', mint);
    expect(plan.blocks).toEqual([{ id: 'a', text: 'hEYlo', reused: true, edit: { offset: 1, deleteCount: 2, insert: 'EY' } }]);
  });
  it('fence detection', () => {
    expect(insideOpenFence('```js\nx')).toBe(true);
    expect(insideOpenFence('```js\nx\n```')).toBe(false);
    expect(insideOpenFence('text ``` inline')).toBe(false);
  });
});

describe('misc', () => {
  it('simpleDiff', () => {
    expect(simpleDiff('abc', 'abc')).toBeNull();
    expect(simpleDiff('abc', 'aXc')).toEqual({ offset: 1, deleteCount: 1, insert: 'X' });
    expect(simpleDiff('aa', 'aaa')).toEqual({ offset: 2, deleteCount: 0, insert: 'a' });
    expect(simpleDiff('', 'x')).toEqual({ offset: 0, deleteCount: 0, insert: 'x' });
  });
  it('mints 10-char ids from the server alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const id = mintBlockId();
      expect(id).toHaveLength(10);
      for (const ch of id) expect(BLOCK_ID_ALPHABET).toContain(ch);
    }
  });
});
