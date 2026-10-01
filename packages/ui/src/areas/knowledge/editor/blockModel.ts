/**
 * Pure helpers for the block binding ([07] §12.4): the editor shows `texts.join('\n\n')`; these map
 * editor offsets to blocks and plan how one editor change rewrites the block list (split / merge /
 * cross-block edits) while preserving block ids wherever content survives.
 */
import { BLOCK_SEPARATOR } from './ydocSchema';

const SEP_LEN = BLOCK_SEPARATOR.length;

export interface BlockLike {
  id: string;
  text: string;
}

export interface Span {
  /** Start offset of the block text in the joined document. */
  from: number;
  /** End offset (exclusive) of the block text. */
  to: number;
}

export function joinTexts(texts: readonly string[]): string {
  return texts.join(BLOCK_SEPARATOR);
}

/** Document spans for blocks of the given lengths. */
export function spansFor(lengths: readonly number[]): Span[] {
  const out: Span[] = [];
  let pos = 0;
  for (let i = 0; i < lengths.length; i++) {
    out.push({ from: pos, to: pos + lengths[i] });
    pos += lengths[i] + SEP_LEN;
  }
  return out;
}

export function docLength(lengths: readonly number[]): number {
  if (!lengths.length) return 0;
  let n = SEP_LEN * (lengths.length - 1);
  for (const l of lengths) n += l;
  return n;
}

export interface Location {
  block: number;
  /** Offset within the block text; for separator positions, the offset clamps to the block's end. */
  offset: number;
  /** True when the position is strictly inside the separator after `block`. */
  inSeparator: boolean;
}

/** Map a document offset to (block, offset). Positions inside a separator belong to the preceding block. */
export function locate(lengths: readonly number[], pos: number): Location {
  if (!lengths.length) return { block: -1, offset: 0, inSeparator: false };
  let start = 0;
  for (let i = 0; i < lengths.length; i++) {
    const end = start + lengths[i];
    if (pos <= end) return { block: i, offset: Math.max(0, pos - start), inSeparator: false };
    if (pos < end + SEP_LEN) return { block: i, offset: lengths[i], inSeparator: true };
    start = end + SEP_LEN;
  }
  const last = lengths.length - 1;
  return { block: last, offset: lengths[last], inSeparator: false };
}

/** Absolute document offset of (block, offset). */
export function absolute(lengths: readonly number[], block: number, offset: number): number {
  let pos = 0;
  for (let i = 0; i < block; i++) pos += lengths[i] + SEP_LEN;
  return pos + offset;
}

/**
 * Blocks touched by replacing [from, to): `first` is the first block whose text or trailing
 * separator contains `from`; `last` is the last block whose text or leading separator contains `to`.
 */
export function affectedRange(lengths: readonly number[], from: number, to: number): { first: number; last: number } {
  const spans = spansFor(lengths);
  let first = spans.length - 1;
  for (let j = 0; j < spans.length; j++) {
    if (from <= spans[j].to + 1) {
      first = j;
      break;
    }
  }
  let last = 0;
  for (let j = spans.length - 1; j >= 0; j--) {
    if (spans[j].from - 1 <= to) {
      last = j;
      break;
    }
  }
  return { first, last: Math.max(first, last) };
}

const FENCE_RE = /^ {0,3}(```|~~~)/;

/** Is the end of `text` inside an open fenced code block? */
export function insideOpenFence(text: string): boolean {
  let open = false;
  for (const line of text.split('\n')) if (FENCE_RE.test(line)) open = !open;
  return open;
}

export interface PlannedBlock {
  id: string;
  text: string;
  /** True when `id` belongs to an existing block in the replaced range (update in place). */
  reused: boolean;
  /**
   * For reused blocks whose text contains the whole edit: the exact in-block edit (lets the Y side
   * apply the user's actual delete/insert rather than a recomputed diff).
   */
  edit?: { offset: number; deleteCount: number; insert: string };
}

export interface ChangePlan {
  /** Index of the first replaced block. */
  start: number;
  /** Number of existing blocks replaced (from `start`). */
  deleteCount: number;
  /** Blocks that take their place, in order. */
  blocks: PlannedBlock[];
}

/**
 * Plan how replacing doc range [from, to) with `insert` rewrites the block list.
 *
 * Segmentation of the rewritten region: original separators that the change doesn't touch stay
 * block boundaries; a `\n\n` created by the change (overlapping the inserted text, or formed at the
 * deletion seam) becomes a new boundary unless it falls inside an open code fence; deleting (part
 * of) a separator merges the neighbours. Untouched `\n\n` inside a block's own text is left alone.
 *
 * Id assignment: each old block (in order) claims the new segment holding most of its surviving
 * characters (ties → earliest), so a split keeps the id on the first half, a merge keeps the first
 * block's id, and fully-deleted blocks drop out. Leftover segments inherit the id of the block whose
 * position they occupy (first segment ← first block; segment after a surviving separator ← the
 * block that followed it), else get a fresh id (true insert).
 */
export function planChange(blocks: readonly BlockLike[], from: number, to: number, insert: string, mint: () => string): ChangePlan {
  if (!blocks.length) {
    const texts = segmentInsert(insert);
    return { start: 0, deleteCount: 0, blocks: insert === '' ? [] : texts.map((t) => ({ id: mint(), text: t, reused: false })) };
  }
  const lengths = blocks.map((b) => b.text.length);
  const spans = spansFor(lengths);
  const { first: f, last: l } = affectedRange(lengths, from, to);
  const base = spans[f].from;
  const region = joinTexts(blocks.slice(f, l + 1).map((b) => b.text));
  const a = from - base;
  const bOld = to - base;
  const next = region.slice(0, a) + insert + region.slice(bOld);
  const b = a + insert.length;
  const shift = b - bOld;

  // Surviving original separators, in rewritten-region coordinates. `hardBefore[k]` = separator
  // preceding old block (f + k), k ≥ 1.
  const hard: Array<{ pos: number; nextOld: number }> = [];
  for (let j = f; j < l; j++) {
    const p = spans[j].to - base;
    if (p + SEP_LEN <= a) hard.push({ pos: p, nextOld: j + 1 });
    else if (p >= bOld) hard.push({ pos: p + shift, nextOld: j + 1 });
  }

  // New boundaries created by the edit.
  const boundaries: Array<{ pos: number; nextOld: number | null }> = hard.map((h) => ({ pos: h.pos, nextOld: h.nextOld }));
  const overlapsHard = (i: number) => hard.some((h) => Math.abs(i - h.pos) < SEP_LEN);
  const lo = Math.max(0, a - 1);
  const hi = Math.max(a, b) - 1;
  let lastChosen = -Infinity;
  for (let i = lo; i <= hi && i + SEP_LEN <= next.length; i++) {
    if (next.charCodeAt(i) !== 10 || next.charCodeAt(i + 1) !== 10) continue;
    if (i < lastChosen + SEP_LEN || overlapsHard(i)) continue;
    let segStart = 0;
    for (const h of hard) if (h.pos + SEP_LEN <= i) segStart = Math.max(segStart, h.pos + SEP_LEN);
    if (lastChosen >= 0) segStart = Math.max(segStart, lastChosen + SEP_LEN);
    if (insideOpenFence(next.slice(segStart, i))) continue;
    boundaries.push({ pos: i, nextOld: null });
    lastChosen = i;
  }
  boundaries.sort((x, y) => x.pos - y.pos);

  const segs: Array<{ from: number; to: number; afterOld: number | null }> = [];
  let cur = 0;
  let curAfter: number | null = null;
  for (const bd of boundaries) {
    segs.push({ from: cur, to: bd.pos, afterOld: curAfter });
    cur = bd.pos + SEP_LEN;
    curAfter = bd.nextOld;
  }
  segs.push({ from: cur, to: next.length, afterOld: curAfter });

  // Score: surviving chars of old block j inside each segment (+0.5 if its start survives there).
  const claimed: Array<number | null> = segs.map(() => null);
  const used = new Set<number>();
  const segIndexAt = (pos: number) => {
    for (let s = 0; s < segs.length; s++) if (pos >= segs[s].from && pos <= segs[s].to) return s;
    return -1;
  };
  for (let j = f; j <= l; j++) {
    const s0 = spans[j].from - base;
    const e0 = spans[j].to - base;
    const pieces: Array<[number, number]> = [];
    if (s0 < a) pieces.push([s0, Math.min(e0, a)]);
    if (e0 > bOld) pieces.push([Math.max(s0, bOld) + shift, e0 + shift]);
    let startAt = -1;
    if (s0 >= bOld) startAt = s0 + shift;
    else if (s0 < a) startAt = s0;
    let best = -1;
    let bestScore = 0;
    for (let s = 0; s < segs.length; s++) {
      let score = 0;
      for (const [x, y] of pieces) score += Math.max(0, Math.min(y, segs[s].to) - Math.max(x, segs[s].from));
      if (startAt >= 0 && segIndexAt(startAt) === s) score += 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (best >= 0 && claimed[best] === null) {
      claimed[best] = j;
      used.add(j);
    }
  }
  if (claimed[0] === null && !used.has(f)) {
    claimed[0] = f;
    used.add(f);
  }
  for (let s = 1; s < segs.length; s++) {
    const k = segs[s].afterOld;
    if (claimed[s] === null && k !== null && !used.has(k)) {
      claimed[s] = k;
      used.add(k);
    }
  }
  // Safety: kept blocks must stay in their original relative order.
  let prev = -1;
  for (let s = 0; s < segs.length; s++) {
    const j = claimed[s];
    if (j === null) continue;
    if (j <= prev) {
      claimed[s] = null;
      used.delete(j);
    } else prev = j;
  }

  const out: PlannedBlock[] = segs.map((seg, s) => {
    const text = next.slice(seg.from, seg.to);
    const j = claimed[s];
    if (j === null) return { id: mint(), text, reused: false };
    const pb: PlannedBlock = { id: blocks[j].id, text, reused: true };
    const s0 = spans[j].from - base;
    const e0 = spans[j].to - base;
    if (s0 <= a && bOld <= e0 && seg.from === s0 && seg.to === e0 + shift) {
      pb.edit = { offset: a - s0, deleteCount: bOld - a, insert };
    }
    return pb;
  });
  return { start: f, deleteCount: l - f + 1, blocks: out };
}

/** Segment text typed into an empty document: split on `\n\n` outside code fences. */
export function segmentInsert(text: string): string[] {
  const out: string[] = [];
  let segStart = 0;
  let i = 0;
  while (i + SEP_LEN <= text.length) {
    if (text.charCodeAt(i) === 10 && text.charCodeAt(i + 1) === 10 && !insideOpenFence(text.slice(segStart, i))) {
      out.push(text.slice(segStart, i));
      segStart = i + SEP_LEN;
      i = segStart;
    } else i++;
  }
  out.push(text.slice(segStart));
  return out;
}

/** Apply a plan to a plain block list (reference model for tests and for previews). */
export function applyPlan(blocks: readonly BlockLike[], plan: ChangePlan): BlockLike[] {
  return [...blocks.slice(0, plan.start), ...plan.blocks.map((b) => ({ id: b.id, text: b.text })), ...blocks.slice(plan.start + plan.deleteCount)];
}

/** Minimal single-range diff (common prefix/suffix). */
export function simpleDiff(a: string, b: string): { offset: number; deleteCount: number; insert: string } | null {
  if (a === b) return null;
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { offset: p, deleteCount: a.length - p - s, insert: b.slice(p, b.length - s) };
}
