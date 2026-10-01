/** Pure glue between the binding, the Y.Doc maps and the editor chrome (kept React/DOM-free for tests). */
import type { CommentAnchor } from '../../../lib/types';
import type { AttributedRange } from './extensions';
import type { BlockRange } from './yBlockBinding';
import type { AttributionEntry } from './ydocSchema';
import type { CollabSnapshot } from './collab';
import { buildContext } from './anchors';

/** Join current block ranges with the server-stamped attribution map (block id → `{actor, at}`). */
export function attributedRanges(ranges: readonly BlockRange[], entry: (blockId: string) => AttributionEntry | undefined | null): AttributedRange[] {
  const out: AttributedRange[] = [];
  for (const r of ranges) {
    const e = entry(r.id);
    if (!e || !e.actor || typeof e.actor !== 'object') continue;
    out.push({ id: r.id, from: r.from, to: r.to, actor: e.actor, at: typeof e.at === 'string' ? e.at : null });
  }
  return out;
}

/** The block containing `pos` (block ends are inclusive, so a caret at a block's end belongs to it). */
export function blockIdAt(ranges: readonly BlockRange[], pos: number): string | null {
  return ranges.find((r) => pos >= r.from && pos <= r.to)?.id ?? null;
}

/**
 * Anchor for a new comment on `[from, to)` of the live document: the selection trimmed of
 * surrounding whitespace, ±40 chars of context, the head revision (omitted when the node has none —
 * the server validates it exists) and the containing block.
 */
export function newCommentAnchor(doc: string, from: number, to: number, head: number | null | undefined, ranges: readonly BlockRange[] = []): (CommentAnchor & { quote: string }) | null {
  let a = Math.max(0, Math.min(from, to));
  let b = Math.min(doc.length, Math.max(from, to));
  while (a < b && /\s/.test(doc[a]!)) a++;
  while (b > a && /\s/.test(doc[b - 1]!)) b--;
  if (b - a < 2) return null;
  const anchor: CommentAnchor & { quote: string } = { quote: doc.slice(a, b), context: buildContext(doc, a, b) };
  if (typeof head === 'number') anchor.revision = head;
  const block = blockIdAt(ranges, a);
  if (block) anchor.block_id = block;
  return anchor;
}

export interface ConnectionMeta {
  label: string;
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
  detail: string;
}

export function connectionMeta(s: Pick<CollabSnapshot, 'status' | 'synced' | 'unsynced' | 'authError'>): ConnectionMeta {
  if (s.authError) return { label: 'Refused', tone: 'danger', detail: `The sync server refused the session (${s.authError}).` };
  if (s.status === 'connected' && !s.synced) return { label: 'Syncing…', tone: 'neutral', detail: 'Loading the live document.' };
  if (s.status === 'connected') return s.unsynced > 0 ? { label: 'Saving…', tone: 'neutral', detail: 'Sending your latest edits.' } : { label: 'Live', tone: 'ok', detail: 'Connected; edits are shared as you type.' };
  if (s.status === 'connecting') return { label: 'Connecting…', tone: 'neutral', detail: 'Connecting to the sync server.' };
  return {
    label: 'Offline',
    tone: 'warn',
    detail: s.synced ? 'Disconnected. Your edits are kept locally and will sync when the connection returns.' : 'Can’t reach the sync server. Retrying…',
  };
}

/** Shallow equality for `{id: top}` maps (avoids re-render loops when re-measuring the rail). */
export function sameTops(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? NaN)) < 0.5);
}
