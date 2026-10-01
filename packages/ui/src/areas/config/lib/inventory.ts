/** Pure helpers shared by the inventory pages. */
import { parseConfigPath } from '@breadboard/shared';
import type { FileChange } from './configApi';

/** UID of the definition minted by `POST /config/new`, read from the root file of the change set. */
export function uidFromChanges(changes: FileChange[], kind: string): string | null {
  for (const c of changes) {
    const p = parseConfigPath(c.path);
    if (p && p.kind === kind && p.uid) return p.uid;
  }
  for (const c of changes) {
    const m = /([0-9A-HJKMNP-TV-Z]{20})/.exec(c.path);
    if (m) return m[1]!;
  }
  return null;
}

/** Case-insensitive all-terms match over the given fields. */
export function matchesQuery(q: string, ...fields: Array<string | null | undefined | string[]>): boolean {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = fields
    .flat()
    .filter((x): x is string => typeof x === 'string')
    .join(' ')
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Tree entries that carry a UID (singletons like presets/tenets do not). */
export function withUid<T extends { uid: string | null }>(entries: T[]): Array<T & { uid: string }> {
  return entries.filter((e): e is T & { uid: string } => !!e.uid);
}
