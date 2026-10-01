/**
 * The three-way reconcile ([07] §5.2 step 3): an AI's full revised Markdown → minimal CRDT operations
 * against a pinned base, encoded as a delta since the base's state vector so that applying it to the
 * live head merges with concurrent human edits by ordinary CRDT semantics.
 *
 * Classification (block level):
 *  - LCS over normalized fingerprints (whitespace-collapsed, lowercased) → retain / delete / insert.
 *  - Within each delete/insert hunk, deleted↔inserted blocks are paired in order when their trigram
 *    Dice similarity ≥ 0.5 → `replace` (the edited block keeps its ID; its Y.Text gets a minimal diff).
 *  - Fingerprint-equal blocks whose exact text differs (case/whitespace edits) are also `replace`.
 *  - Only true inserts mint new block IDs.
 */
import * as Y from 'yjs';
import { diffWordsWithSpace } from 'diff';
import type { Actor } from '@breadboard/shared';
import { attributionMap, blocksOf, docBlocks, makeBlock, plainActor, splitMarkdownIntoBlocks, type Block } from './ydoc.js';

export interface ReconcileOrigin {
  actor: Actor;
  /** Transaction origin passed to `doc.transact` (defaults to this object). */
  txOrigin?: unknown;
  at?: string;
}

export interface ReconcileStats {
  retained: number;
  replaced: number;
  inserted: number;
  deleted: number;
}

export interface ReconcileResult {
  update: Uint8Array;
  stats: ReconcileStats;
  /** Block ids touched (replaced + inserted), for callers that want to report them. */
  changed_block_ids: string[];
}

export const REPLACE_SIMILARITY = 0.5;

export function fingerprint(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function trigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.length < 3 ? s.padEnd(3, ' ') : s;
  for (let i = 0; i + 3 <= t.length; i++) {
    const g = t.slice(i, i + 3);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice coefficient over character trigrams of the fingerprints. */
export function similarity(a: string, b: string): number {
  const fa = fingerprint(a);
  const fb = fingerprint(b);
  if (fa === fb) return 1;
  if (!fa.length || !fb.length) return 0;
  const ga = trigrams(fa);
  const gb = trigrams(fb);
  let inter = 0;
  let na = 0;
  let nb = 0;
  for (const v of ga.values()) na += v;
  for (const v of gb.values()) nb += v;
  for (const [g, v] of ga) {
    const w = gb.get(g);
    if (w) inter += Math.min(v, w);
  }
  return (2 * inter) / (na + nb);
}

type Op = { kind: 'retain'; i: number; j: number } | { kind: 'replace'; i: number; j: number } | { kind: 'delete'; i: number } | { kind: 'insert'; j: number };

/** Block-level diff plan: base blocks (by index) → revised blocks (by index). */
export function planBlockOps(base: string[], revised: string[]): Op[] {
  const fa = base.map(fingerprint);
  const fb = revised.map(fingerprint);
  const ops: Op[] = [];
  // Trim common prefix/suffix first (keeps the LCS table small for typical small edits).
  let pre = 0;
  while (pre < fa.length && pre < fb.length && fa[pre] === fb[pre]) pre++;
  let suf = 0;
  while (suf < fa.length - pre && suf < fb.length - pre && fa[fa.length - 1 - suf] === fb[fb.length - 1 - suf]) suf++;
  const eq = (i: number, j: number): Op => (base[i] === revised[j] ? { kind: 'retain', i, j } : { kind: 'replace', i, j });
  for (let k = 0; k < pre; k++) ops.push(eq(k, k));

  const a0 = pre;
  const a1 = fa.length - suf;
  const b0 = pre;
  const b1 = fb.length - suf;
  const n = a1 - a0;
  const m = b1 - b0;
  // LCS table over the middle
  const raw: Op[] = [];
  if (n > 0 && m > 0) {
    const w = m + 1;
    const T = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        T[i * w + j] = fa[a0 + i] === fb[b0 + j] ? T[(i + 1) * w + j + 1] + 1 : Math.max(T[(i + 1) * w + j], T[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (fa[a0 + i] === fb[b0 + j]) {
        raw.push(eq(a0 + i, b0 + j));
        i++;
        j++;
      } else if (T[(i + 1) * w + j] >= T[i * w + j + 1]) {
        raw.push({ kind: 'delete', i: a0 + i });
        i++;
      } else {
        raw.push({ kind: 'insert', j: b0 + j });
        j++;
      }
    }
    for (; i < n; i++) raw.push({ kind: 'delete', i: a0 + i });
    for (; j < m; j++) raw.push({ kind: 'insert', j: b0 + j });
  } else {
    for (let i = a0; i < a1; i++) raw.push({ kind: 'delete', i });
    for (let j = b0; j < b1; j++) raw.push({ kind: 'insert', j });
  }

  // Second pass: pair deletes↔inserts inside each hunk (run between retained anchors).
  let k = 0;
  while (k < raw.length) {
    const op = raw[k]!;
    if (op.kind === 'retain' || op.kind === 'replace') {
      ops.push(op);
      k++;
      continue;
    }
    const dels: number[] = [];
    const ins: number[] = [];
    while (k < raw.length && (raw[k]!.kind === 'delete' || raw[k]!.kind === 'insert')) {
      const h = raw[k]!;
      if (h.kind === 'delete') dels.push(h.i);
      else if (h.kind === 'insert') ins.push(h.j);
      k++;
    }
    ops.push(...pairHunk(dels, ins, base, revised));
  }
  for (let s = 0; s < suf; s++) ops.push(eq(fa.length - suf + s, fb.length - suf + s));
  return ops;
}

function pairHunk(dels: number[], ins: number[], base: string[], revised: string[]): Op[] {
  const out: Op[] = [];
  if (!dels.length || !ins.length) {
    for (const i of dels) out.push({ kind: 'delete', i });
    for (const j of ins) out.push({ kind: 'insert', j });
    return out;
  }
  // Greedy, order-preserving: each deleted block takes the most similar remaining insert after the last pair.
  const pairs: Array<[number, number]> = []; // indexes into dels / ins
  let nextIns = 0;
  for (let d = 0; d < dels.length && nextIns < ins.length; d++) {
    let best = -1;
    let bestScore = REPLACE_SIMILARITY;
    for (let x = nextIns; x < ins.length; x++) {
      const s = similarity(base[dels[d]!]!, revised[ins[x]!]!);
      if (s >= bestScore && (best === -1 || s > bestScore)) {
        best = x;
        bestScore = s;
      }
    }
    if (best >= 0) {
      pairs.push([d, best]);
      nextIns = best + 1;
    }
  }
  let d = 0;
  let x = 0;
  for (const [pd, px] of pairs) {
    for (; d < pd; d++) out.push({ kind: 'delete', i: dels[d]! });
    for (; x < px; x++) out.push({ kind: 'insert', j: ins[x]! });
    out.push({ kind: 'replace', i: dels[pd]!, j: ins[px]! });
    d = pd + 1;
    x = px + 1;
  }
  for (; d < dels.length; d++) out.push({ kind: 'delete', i: dels[d]! });
  for (; x < ins.length; x++) out.push({ kind: 'insert', j: ins[x]! });
  return out;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Apply the minimal edit turning `ytext` (currently `from`) into `to`. */
export function applyTextDiff(ytext: Y.Text, from: string, to: string): void {
  if (from === to) return;
  let p = 0;
  const max = Math.min(from.length, to.length);
  while (p < max && from.charCodeAt(p) === to.charCodeAt(p)) p++;
  if (p > 0 && isHighSurrogate(from.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && from.charCodeAt(from.length - 1 - s) === to.charCodeAt(to.length - 1 - s)) s++;
  if (s > 0 && from.length - s < from.length && isHighSurrogate(from.charCodeAt(from.length - s - 1))) s--;
  const oldMid = from.slice(p, from.length - s);
  const newMid = to.slice(p, to.length - s);
  if (!oldMid.length) {
    ytext.insert(p, newMid);
    return;
  }
  if (!newMid.length) {
    ytext.delete(p, oldMid.length);
    return;
  }
  // Word-level diff of the middle keeps untouched words (and concurrent edits near them) intact.
  let pos = p;
  for (const part of diffWordsWithSpace(oldMid, newMid)) {
    if (part.added) {
      ytext.insert(pos, part.value);
      pos += part.value.length;
    } else if (part.removed) {
      ytext.delete(pos, part.value.length);
    } else {
      pos += part.value.length;
    }
  }
}

/**
 * Reconcile `revisedMarkdown` into `baseDoc` in ONE transaction and return only the delta since the
 * base's state vector. `baseDoc` is mutated (callers pass a doc reconstructed from the base revision).
 */
export function reconcile(baseDoc: Y.Doc, revisedMarkdown: string, origin: ReconcileOrigin): ReconcileResult {
  const revised = splitMarkdownIntoBlocks(revisedMarkdown);
  const baseBlocks: Block[] = docBlocks(baseDoc);
  const ops = planBlockOps(
    baseBlocks.map((b) => b.text),
    revised,
  );
  const vector = Y.encodeStateVector(baseDoc);
  const stats: ReconcileStats = { retained: 0, replaced: 0, inserted: 0, deleted: 0 };
  const changed: string[] = [];
  const at = origin.at ?? new Date().toISOString();
  const actor = plainActor(origin.actor);
  const hasChanges = ops.some((o) => o.kind !== 'retain');
  if (!hasChanges) {
    stats.retained = ops.length;
    return { update: Y.encodeStateAsUpdate(baseDoc, vector), stats, changed_block_ids: [] };
  }
  baseDoc.transact(() => {
    const arr = blocksOf(baseDoc);
    const attr = attributionMap(baseDoc);
    let idx = 0;
    for (const op of ops) {
      switch (op.kind) {
        case 'retain':
          stats.retained++;
          idx++;
          break;
        case 'replace': {
          const m = arr.get(idx);
          const t = m.get('text');
          const id = m.get('id') as string;
          if (t instanceof Y.Text) applyTextDiff(t, t.toString(), revised[op.j]!);
          else m.set('text', new Y.Text(revised[op.j]!));
          attr.set(id, { actor, at });
          changed.push(id);
          stats.replaced++;
          idx++;
          break;
        }
        case 'delete':
          arr.delete(idx, 1);
          stats.deleted++;
          break;
        case 'insert': {
          const m = makeBlock(revised[op.j]!);
          arr.insert(idx, [m]);
          const id = m.get('id') as string;
          attr.set(id, { actor, at });
          changed.push(id);
          stats.inserted++;
          idx++;
          break;
        }
      }
    }
  }, origin.txOrigin ?? origin);
  return { update: Y.encodeStateAsUpdate(baseDoc, vector), stats, changed_block_ids: changed };
}
