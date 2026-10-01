/**
 * Revision diffing for the revision browser ([10] §3): a unified text diff between two Markdown
 * snapshots (via `diff`'s `createTwoFilesPatch`), parsed into display rows with line numbers.
 */
import { createTwoFilesPatch } from 'diff';
import type { NodeRevision } from '@breadboard/shared';

export type DiffRowKind = 'hunk' | 'add' | 'del' | 'ctx';

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface RevisionDiff {
  patch: string;
  rows: DiffRow[];
  added: number;
  removed: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse a unified patch (as produced by `createTwoFilesPatch`) into display rows. */
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const h = HUNK.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[3]);
      inHunk = true;
      rows.push({ kind: 'hunk', text: line, oldNo: null, newNo: null });
      continue;
    }
    if (!inHunk) continue; // file headers (Index / === / --- / +++)
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    const sign = line[0];
    const text = line.slice(1);
    if (sign === '+') rows.push({ kind: 'add', text, oldNo: null, newNo: n++ });
    else if (sign === '-') rows.push({ kind: 'del', text, oldNo: o++, newNo: null });
    else if (sign === ' ') rows.push({ kind: 'ctx', text, oldNo: o++, newNo: n++ });
  }
  return rows;
}

/** Diff two Markdown snapshots. Trailing newlines are normalised so they never show as a change. */
export function diffRevisions(oldText: string, newText: string, oldLabel = 'old', newLabel = 'new', context = 3): RevisionDiff {
  const norm = (s: string) => (s.endsWith('\n') ? s : `${s}\n`);
  const patch = createTwoFilesPatch(oldLabel, newLabel, norm(oldText ?? ''), norm(newText ?? ''), '', '', { context });
  const rows = parsePatch(patch);
  return { patch, rows, added: rows.filter((r) => r.kind === 'add').length, removed: rows.filter((r) => r.kind === 'del').length };
}

/** The Markdown text of a revision snapshot (`body_text` for CRDT nodes; string bodies as a fallback). */
export function revisionText(rev: Pick<NodeRevision, 'body_text' | 'body'> | null | undefined): string {
  if (!rev) return '';
  if (typeof rev.body_text === 'string') return rev.body_text;
  if (typeof rev.body === 'string') return rev.body;
  return '';
}

/** Order a picked pair oldest → newest. */
export function orderPair(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}

/**
 * Toggle a revision in a "pick two" selection: picking a third drops the oldest pick, so the
 * selection always holds the two most recently picked revisions.
 */
export function togglePick(picked: readonly number[], id: number): number[] {
  if (picked.includes(id)) return picked.filter((p) => p !== id);
  return [...picked, id].slice(-2);
}

export const PRE_AI_EDIT = 'pre-ai-edit';

/** `pre-ai-edit` revisions (one per AI write), newest first — each is a one-click revert point ([07] §5.3). */
export function aiEditRevisions<T extends { revision_id: number; labels: readonly string[] }>(revs: readonly T[]): T[] {
  return revs.filter((r) => r.labels?.includes(PRE_AI_EDIT)).sort((a, b) => b.revision_id - a.revision_id);
}

/** Pseudo revision id for the live document (edits not yet cut into a revision). */
export const CURRENT = -1;

export const revLabel = (id: number) => (id === CURRENT ? 'current' : `r${id}`);

/** Order a compare pair oldest → newest, with the live document always newest. */
export function orderCompare(a: number, b: number): [number, number] {
  if (a === CURRENT) return [b, a];
  if (b === CURRENT) return [a, b];
  return orderPair(a, b);
}

/** The revision right after `pre` (i.e. the AI write's result), or the live document if none. */
export function afterRevision(revs: readonly { revision_id: number }[], pre: number): number {
  let best = CURRENT;
  for (const r of revs) if (r.revision_id > pre && (best === CURRENT || r.revision_id < best)) best = r.revision_id;
  return best;
}
