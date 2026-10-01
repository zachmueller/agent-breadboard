/**
 * Comment- and order-preserving YAML editing.
 *
 * Structured editors (flow canvas, inspectors, forms) work on plain JS values. `editYaml` parses
 * the file into a `yaml` Document, lets the caller mutate a plain clone, then *reconciles* the
 * Document's node tree to the new value: unchanged nodes are left untouched (keeping comments,
 * flow/block style, quoting), changed scalars keep their node (and comments), map keys keep
 * their order (new keys append), and sequence items are matched by identity (`id`, `name`, …)
 * so comments travel with the step/exit/grant they annotate. The YAML file stays the source of
 * truth and never gains UI-only keys.
 */
import { diffArrays } from 'diff';
import { parseDocument, isMap, isSeq, isScalar, isNode, isPair, isAlias, type Document, type Node, type Pair } from 'yaml';

const STRINGIFY_OPTS = { lineWidth: 0 } as const;

export class YamlEditError extends Error {}

export function parseYamlValue(text: string): { ok: true; value: any } | { ok: false; error: string } {
  const doc = parseDocument(text);
  if (doc.errors.length) return { ok: false, error: doc.errors[0]!.message };
  return { ok: true, value: doc.toJS({ maxAliasCount: -1 }) };
}

export function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => stableEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object).filter((k) => (a as any)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as any)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => stableEqual((a as any)[k], (b as any)[k]));
}

/** Order-sensitive equality (key order matters) — used to detect "nothing changed". */
function strictEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const IDENTITY_FIELDS = ['id', 'name', 'key', 'fixture_id', 'tool', 'mcp', 'circuit', 'host'] as const;

function identityOf(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  for (const f of IDENTITY_FIELDS) {
    const x = (v as any)[f];
    if (typeof x === 'string' && x) return `${f}:${x}`;
  }
  return null;
}

function keyString(k: unknown): string {
  if (isScalar(k)) return String(k.value);
  return String(k);
}

function carryComments(from: Node | null | undefined, to: Node): Node {
  if (from && isNode(from)) {
    const f = from as any;
    const t = to as any;
    if (f.commentBefore && !t.commentBefore) t.commentBefore = f.commentBefore;
    if (f.comment && !t.comment) t.comment = f.comment;
    if (f.spaceBefore) t.spaceBefore = f.spaceBefore;
  }
  return to;
}

function create(doc: Document, value: unknown, prev?: Node | null): Node {
  const n = doc.createNode(value) as Node;
  if (typeof value === 'string' && value.includes('\n') && isScalar(n)) n.type = 'BLOCK_LITERAL';
  return carryComments(prev, n);
}

/** Reconcile `node` to represent `value`, reusing nodes wherever possible. Returns the (possibly new) node. */
export function reconcileNode(doc: Document, node: unknown, value: unknown): Node | null {
  if (value === undefined) return null;
  const existing = (isNode(node) ? node : null) as Node | null;
  if (existing && isAlias(existing)) {
    if (strictEqual(existing.toJS(doc), value)) return existing;
    return create(doc, value, existing);
  }

  if (Array.isArray(value)) {
    if (!existing || !isSeq(existing)) return create(doc, value, existing);
    const oldItems = existing.items as unknown[];
    const oldJs = oldItems.map((it) => (isNode(it) ? it.toJS(doc) : it));
    const used = new Set<number>();
    const next: unknown[] = value.map((v, idx) => {
      const id = identityOf(v);
      let match = -1;
      if (id) match = oldJs.findIndex((o, j) => !used.has(j) && identityOf(o) === id);
      if (match < 0 && idx < oldItems.length && !used.has(idx) && (identityOf(oldJs[idx]) === null || id === null)) match = idx;
      if (match >= 0) {
        used.add(match);
        return reconcileNode(doc, oldItems[match], v) ?? create(doc, null);
      }
      return create(doc, v);
    });
    existing.items = next as any;
    return existing;
  }

  if (value !== null && typeof value === 'object') {
    if (!existing || !isMap(existing)) return create(doc, value, existing);
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    const items = existing.items as Pair<unknown, unknown>[];
    const kept = items.filter((p) => isPair(p) && keys.includes(keyString(p.key)));
    // Preserve a removed pair's leading comment by moving it to the following kept pair.
    for (let i = 0; i < items.length; i++) {
      const p = items[i]!;
      if (kept.includes(p)) continue;
      const pc = (isNode(p.key) ? (p.key as any).commentBefore : null) as string | null;
      if (pc) {
        const nextKept = items.slice(i + 1).find((x) => kept.includes(x));
        if (nextKept && isNode(nextKept.key) && !(nextKept.key as any).commentBefore) (nextKept.key as any).commentBefore = pc;
      }
    }
    existing.items = kept as any;
    for (const k of keys) {
      const pair = kept.find((p) => keyString(p.key) === k);
      if (pair) pair.value = reconcileNode(doc, pair.value, obj[k]);
      else existing.items.push(doc.createPair(k, obj[k]) as any);
    }
    return existing;
  }

  // Scalars (string/number/boolean/null).
  if (existing && isScalar(existing)) {
    if (existing.value === value) return existing;
    existing.value = value;
    const multiline = typeof value === 'string' && value.includes('\n');
    if (multiline) existing.type = 'BLOCK_LITERAL';
    else if (existing.type === 'BLOCK_LITERAL' || existing.type === 'BLOCK_FOLDED') existing.type = undefined;
    else if (typeof value !== 'string' && existing.type !== 'PLAIN') existing.type = undefined;
    (existing as any).format = undefined;
    (existing as any).source = undefined;
    return existing;
  }
  return create(doc, value, existing);
}

export function documentToString(doc: Document): string {
  return doc.toString(STRINGIFY_OPTS);
}

/**
 * Apply a structured edit to YAML text. `mutate` receives a deep clone of the current value and
 * may mutate it in place or return a replacement. Returns the original text untouched when the
 * value didn't change (byte-identical round trip).
 */
export function editYaml(text: string, mutate: (draft: any) => any): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new YamlEditError(`cannot edit: YAML has errors (${doc.errors[0]!.message})`);
  const current = doc.toJS({ maxAliasCount: -1 }) ?? {};
  const draft = structuredClone(current);
  const ret = mutate(draft);
  const next = ret === undefined ? draft : ret;
  if (strictEqual(current, next)) return text;
  const normalizedBase = documentToString(parseDocument(text));
  doc.contents = reconcileNode(doc, doc.contents, next) as any;
  const normalizedNext = documentToString(doc);
  return minimalRewrite(text, normalizedBase, normalizedNext);
}

/**
 * The `yaml` stringifier normalizes formatting (column-aligned trailing comments, flow-collection
 * spacing) across the whole file. To keep git diffs to the lines that actually changed, three-way
 * merge the original text (formatting changes vs the normalized base) with the normalized edit
 * (semantic changes vs the same base): untouched regions keep their original bytes. Falls back to
 * the normalized output if the merge would not round-trip to the same value and comments.
 */
export function minimalRewrite(original: string, normalizedBase: string, normalizedNext: string): string {
  if (original === normalizedBase) return normalizedNext;
  const merged = merge3(normalizedBase.split('\n'), original.split('\n'), normalizedNext.split('\n')).join('\n');
  const want = parseDocument(normalizedNext);
  const got = parseDocument(merged);
  if (got.errors.length || !strictEqual(got.toJS({ maxAliasCount: -1 }), want.toJS({ maxAliasCount: -1 }))) return normalizedNext;
  if (documentToString(got) !== normalizedNext) return normalizedNext; // comments/structure drifted
  return merged;
}

/** base line index → matched line index in `other` (LCS), or -1. */
function matchLines(base: string[], other: string[], loose = false): Int32Array {
  const m = new Int32Array(base.length).fill(-1);
  let i = 0;
  let j = 0;
  const key = (l: string) => l.replace(/\s+/g, '');
  const parts = loose ? diffArrays(base, other, { comparator: (x: string, y: string) => x === y || key(x) === key(y) }) : diffArrays(base, other);
  for (const part of parts) {
    const n = part.count ?? part.value.length;
    if (part.added) j += n;
    else if (part.removed) i += n;
    else for (let k = 0; k < n; k++) m[i++] = j++;
  }
  return m;
}

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** diff3-style line merge: `a` carries formatting-only changes, `b` the semantic edit; `b` wins conflicts. */
export function merge3(base: string[], a: string[], b: string[]): string[] {
  // `a` differs from `base` only in formatting: match lines modulo whitespace so each keeps its bytes.
  const ma = matchLines(base, a, true);
  const mb = matchLines(base, b);
  const out: string[] = [];
  let ib = 0;
  let ia = 0;
  let ibb = 0;
  for (let k = 0; k <= base.length; k++) {
    const end = k === base.length;
    if (!end && !(ma[k]! >= ia && mb[k]! >= ibb)) continue;
    const aEnd = end ? a.length : ma[k]!;
    const bEnd = end ? b.length : mb[k]!;
    const baseChunk = base.slice(ib, k);
    const aChunk = a.slice(ia, aEnd);
    const bChunk = b.slice(ibb, bEnd);
    if (sameLines(bChunk, baseChunk)) out.push(...aChunk);
    else out.push(...bChunk);
    if (!end) out.push(a[aEnd]!);
    ib = k + 1;
    ia = aEnd + 1;
    ibb = bEnd + 1;
  }
  return out;
}

/** Replace the whole value (convenience over `editYaml`). */
export function setYamlValue(text: string, value: unknown): string {
  return editYaml(text, () => value);
}

/** Serialize a fresh value (no prior document). */
export function yamlOf(value: unknown): string {
  const doc = parseDocument('{}');
  doc.contents = create(doc, value) as any;
  return documentToString(doc);
}
