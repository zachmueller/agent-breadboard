/**
 * Layout of a CRDT node's Y.Doc ([07] §2, §5.3; [01] §5): one Y.Doc per node holding
 *  - `blocks`:      Y.Array<Y.Map> — each block map `{ id: string (10 chars), text: Y.Text }` (Markdown source)
 *  - `properties`:  Y.Map — frontmatter (title, tags, domains, aliases, …), per-key merge
 *  - `attribution`: Y.Map — block id → `{ actor, at }`, server-stamped on every write
 *
 * Specs name the block text field `ytext`; the binding reads either key and writes whichever the
 * document already uses (default `text`).
 */
import * as Y from 'yjs';
import type { Actor } from '@breadboard/shared';

export const BLOCKS_KEY = 'blocks';
export const PROPERTIES_KEY = 'properties';
export const ATTRIBUTION_KEY = 'attribution';
export const BLOCK_ID_KEY = 'id';
export const BLOCK_TEXT_KEY = 'text';
export const BLOCK_TEXT_KEY_ALT = 'ytext';

/** Separator between blocks in the concatenated editor document. */
export const BLOCK_SEPARATOR = '\n\n';

/** 10-char block id alphabet ([07] §12.4) — same as the server's nanoid alphabet. */
export const BLOCK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-';
export const BLOCK_ID_LENGTH = 10;

export function mintBlockId(): string {
  const bytes = new Uint8Array(BLOCK_ID_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += BLOCK_ID_ALPHABET[b & 63];
  return out;
}

export type BlockMap = Y.Map<unknown>;

export interface AttributionEntry {
  actor: Actor;
  at: string;
}

export function getBlocks(doc: Y.Doc): Y.Array<BlockMap> {
  return doc.getArray<BlockMap>(BLOCKS_KEY);
}
export function getProperties(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(PROPERTIES_KEY);
}
export function getAttribution(doc: Y.Doc): Y.Map<AttributionEntry> {
  return doc.getMap<AttributionEntry>(ATTRIBUTION_KEY);
}

/** The Y.Text of a block, tolerating either field name. */
export function blockYText(block: BlockMap): Y.Text | null {
  const t = block.get(BLOCK_TEXT_KEY);
  if (t instanceof Y.Text) return t;
  const alt = block.get(BLOCK_TEXT_KEY_ALT);
  if (alt instanceof Y.Text) return alt;
  return null;
}

export function blockId(block: BlockMap): string {
  const id = block.get(BLOCK_ID_KEY);
  return typeof id === 'string' ? id : '';
}

export function blockString(block: BlockMap): string {
  return blockYText(block)?.toString() ?? '';
}

/** Which key existing blocks use for their text (so client-minted blocks match server-minted ones). */
export function detectTextKey(blocks: Y.Array<BlockMap>): string {
  for (const b of blocks) {
    if (b.get(BLOCK_TEXT_KEY) instanceof Y.Text) return BLOCK_TEXT_KEY;
    if (b.get(BLOCK_TEXT_KEY_ALT) instanceof Y.Text) return BLOCK_TEXT_KEY_ALT;
  }
  return BLOCK_TEXT_KEY;
}

export function makeBlock(id: string, text: string, textKey = BLOCK_TEXT_KEY): BlockMap {
  const m = new Y.Map<unknown>();
  m.set(BLOCK_ID_KEY, id);
  m.set(textKey, new Y.Text(text));
  return m;
}

/** `blocks.map(text).join('\n\n')` — the editor document. */
export function blocksToMarkdown(blocks: Y.Array<BlockMap>): string {
  return blocks.toArray().map(blockString).join(BLOCK_SEPARATOR);
}

/** Initialise a doc's blocks from Markdown (tests, local fixtures). Splits on every blank-line separator. */
export function seedBlocks(blocks: Y.Array<BlockMap>, markdown: string, mint: () => string = mintBlockId): void {
  const parts = markdown === '' ? [] : markdown.split(BLOCK_SEPARATOR);
  const key = detectTextKey(blocks);
  blocks.insert(blocks.length, parts.map((p) => makeBlock(mint(), p, key)));
}
