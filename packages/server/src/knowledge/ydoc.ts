/**
 * The block-structured CRDT document model ([07] §2, [01] §5).
 *
 * One `Y.Doc` per node:
 *  - `blocks`      Y.Array<Y.Map{ id: string (10-char, server-minted), text: Y.Text (Markdown source) }>
 *  - `properties`  Y.Map — frontmatter/properties with per-key merge semantics
 *  - `attribution` Y.Map — block id → `{actor, at}` (server-authoritative, [07] §5.3)
 *
 * Block segmentation ([07] §12.1): top-level CommonMark (+GFM) AST nodes — paragraph, heading, list
 * (a whole list is one block), code fence, table, blockquote, thematic break, html, definitions.
 * Block text is the exact source slice; the rendered document joins blocks with a blank line.
 *
 * Docs are created with `gc: false`: the reconcile path ([07] §5.2) applies deltas computed against a
 * pinned base revision, and Yjs drops inserts whose left/right origin was garbage-collected. Keeping
 * tombstones guarantees a base-relative delta always integrates into the live head.
 */
import * as Y from 'yjs';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { diffLines } from 'diff';
import { mintBlockId, type Actor } from '@breadboard/shared';

export const BLOCKS_KEY = 'blocks';
export const PROPERTIES_KEY = 'properties';
export const ATTRIBUTION_KEY = 'attribution';
export const BLOCK_SEPARATOR = '\n\n';

export interface Block {
  id: string;
  text: string;
}

export interface AttributionEntry {
  actor: Actor;
  at: string;
}

export function newDoc(): Y.Doc {
  return new Y.Doc({ gc: false });
}

export function blocksOf(doc: Y.Doc): Y.Array<Y.Map<unknown>> {
  return doc.getArray<Y.Map<unknown>>(BLOCKS_KEY);
}
export function propertiesMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(PROPERTIES_KEY);
}
export function attributionMap(doc: Y.Doc): Y.Map<AttributionEntry> {
  return doc.getMap<AttributionEntry>(ATTRIBUTION_KEY);
}

/** Thrown when Markdown cannot be segmented (surfaced as `parse-failed`). */
export class MarkdownParseError extends Error {}

/**
 * Split Markdown into top-level blocks, each the exact source slice of one top-level AST node.
 * Leading YAML-style frontmatter is not special-cased (properties live in the separate Y.Map).
 */
export function splitMarkdownIntoBlocks(md: string): string[] {
  if (typeof md !== 'string') throw new MarkdownParseError('markdown must be a string');
  if (md.includes('\u0000')) throw new MarkdownParseError('markdown contains NUL characters');
  const src = md.replace(/\r\n?/g, '\n');
  if (!src.trim()) return [];
  let tree;
  try {
    tree = fromMarkdown(src, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  } catch (e) {
    throw new MarkdownParseError((e as Error)?.message ?? String(e));
  }
  const out: string[] = [];
  for (const child of tree.children) {
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const text = src.slice(start, end).replace(/\s+$/, '');
    if (text.trim()) out.push(text);
  }
  return out;
}

export function blocksToMarkdown(blocks: Array<string | Block>): string {
  return blocks.map((b) => (typeof b === 'string' ? b : b.text)).join(BLOCK_SEPARATOR);
}

export function docBlocks(doc: Y.Doc): Block[] {
  const out: Block[] = [];
  for (const m of blocksOf(doc).toArray()) {
    if (!(m instanceof Y.Map)) continue;
    const id = m.get('id');
    const text = m.get('text');
    out.push({ id: typeof id === 'string' ? id : '', text: text instanceof Y.Text ? text.toString() : typeof text === 'string' ? text : '' });
  }
  return out;
}

export function docToMarkdown(doc: Y.Doc): string {
  return blocksToMarkdown(docBlocks(doc));
}

/** Total characters of block text (the denominator of the wipeout guard). */
export function docCharCount(doc: Y.Doc): number {
  let n = 0;
  for (const b of docBlocks(doc)) n += b.text.length;
  return n;
}

export function propertiesOf(doc: Y.Doc): Record<string, unknown> {
  return propertiesMap(doc).toJSON() as Record<string, unknown>;
}

export function attributionOf(doc: Y.Doc): Record<string, AttributionEntry> {
  return attributionMap(doc).toJSON() as Record<string, AttributionEntry>;
}

/** Strip undefined fields so actors encode cleanly into Y.Map values. */
export function plainActor(a: Actor): Actor {
  return JSON.parse(JSON.stringify(a)) as Actor;
}

export function makeBlock(text: string, id: string = mintBlockId()): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('id', id);
  m.set('text', new Y.Text(text));
  return m;
}

/**
 * Initialize an empty doc from Markdown (and optional properties). Every block is attributed to `actor`.
 * Runs in one transaction tagged with `origin` (defaults to the actor).
 */
export function initDocFromMarkdown(doc: Y.Doc, md: string, actor: Actor, opts: { properties?: Record<string, unknown>; origin?: unknown } = {}): void {
  const texts = splitMarkdownIntoBlocks(md);
  const at = new Date().toISOString();
  const who = plainActor(actor);
  doc.transact(() => {
    const arr = blocksOf(doc);
    if (arr.length > 0) arr.delete(0, arr.length);
    const maps = texts.map((t) => makeBlock(t));
    if (maps.length) arr.insert(0, maps);
    const attr = attributionMap(doc);
    for (const m of maps) attr.set(m.get('id') as string, { actor: who, at });
    if (opts.properties) {
      const props = propertiesMap(doc);
      for (const [k, v] of Object.entries(opts.properties)) {
        if (v === undefined) continue;
        props.set(k, JSON.parse(JSON.stringify(v)));
      }
    }
  }, opts.origin ?? actor);
}

export function docFromRevisionState(state: Buffer | Uint8Array): Y.Doc {
  const doc = newDoc();
  Y.applyUpdate(doc, state instanceof Uint8Array ? state : new Uint8Array(state));
  return doc;
}

export function cloneDoc(doc: Y.Doc): Y.Doc {
  const c = newDoc();
  Y.applyUpdate(c, Y.encodeStateAsUpdate(doc));
  return c;
}

export function encodeState(doc: Y.Doc): Buffer {
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}

export function encodeVector(doc: Y.Doc): Buffer {
  return Buffer.from(Y.encodeStateVector(doc));
}

export function sameVector(a: Uint8Array | Buffer | null | undefined, b: Uint8Array | Buffer | null | undefined): boolean {
  if (!a || !b) return false;
  // Compare decoded vectors (encoding order of clients is not guaranteed stable).
  const da = Y.decodeStateVector(a instanceof Uint8Array ? a : new Uint8Array(a));
  const db = Y.decodeStateVector(b instanceof Uint8Array ? b : new Uint8Array(b));
  if (da.size !== db.size) return false;
  for (const [k, v] of da) if (db.get(k) !== v) return false;
  return true;
}

/**
 * Fraction of `before`'s characters deleted to reach `after` (line-granular diff; cheap on large notes).
 * 0 when `before` is empty.
 */
export function wipeoutFraction(before: string, after: string): number {
  if (!before.length) return 0;
  let removed = 0;
  for (const part of diffLines(before, after)) if (part.removed) removed += part.value.length;
  return Math.min(1, removed / before.length);
}

/**
 * Count characters of currently-live block text that applying `update` to `doc` would delete — exact,
 * CRDT-level (reads the update's delete set against the doc's struct store; no clone). Deleting a block
 * map counts its whole text. Items the update itself introduces are ignored (they were never "before").
 */
export function countDeletedChars(doc: Y.Doc, update: Uint8Array): number {
  let ds: { clients: Map<number, Array<{ clock: number; len: number }>> };
  try {
    ds = Y.decodeUpdate(update).ds as any;
  } catch {
    return 0;
  }
  if (!ds.clients.size) return 0;
  const store = (doc as any).store.clients as Map<number, Array<any>>;
  const blocksType = blocksOf(doc);
  const deletedBlocks = new Set<Y.Map<unknown>>();
  const textHits: Array<{ block: unknown; n: number }> = [];
  for (const [client, ranges] of ds.clients) {
    const structs = store.get(client);
    if (!structs || !structs.length) continue;
    for (const r of ranges) {
      const rStart = r.clock;
      const rEnd = r.clock + r.len;
      // binary search the last struct starting at or before rStart
      let lo = 0;
      let hi = structs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (structs[mid].id.clock <= rStart) lo = mid;
        else hi = mid - 1;
      }
      for (let i = lo; i < structs.length; i++) {
        const s = structs[i];
        const sStart = s.id.clock;
        const sEnd = sStart + s.length;
        if (sStart >= rEnd) break;
        if (sEnd <= rStart) continue;
        if (!(s instanceof Y.Item) || s.deleted) continue;
        const content = s.content;
        if (content instanceof Y.ContentString) {
          const parent = s.parent as any;
          const block = parent instanceof Y.Text ? parent._item?.parent : null;
          if (block instanceof Y.Map && (block as any)._item?.parent === blocksType) {
            textHits.push({ block, n: Math.min(sEnd, rEnd) - Math.max(sStart, rStart) });
          }
        } else if (content instanceof Y.ContentType && content.type instanceof Y.Map && s.parent === blocksType) {
          deletedBlocks.add(content.type as Y.Map<unknown>);
        }
      }
    }
  }
  let count = 0;
  for (const m of deletedBlocks) {
    const t = m.get('text');
    if (t instanceof Y.Text) count += t.length;
  }
  for (const h of textHits) if (!deletedBlocks.has(h.block as Y.Map<unknown>)) count += h.n;
  return count;
}
