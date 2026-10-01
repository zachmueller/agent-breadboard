/** Pure helpers for the Knowledge area ([07] §8–§10). */
import type { EdgeRecord } from '@breadboard/shared';

export const CONNECTOR_READ_ONLY_REASON = 'Synced from a connector; edit at the source';

export interface ConnectorInfo {
  /** Connector config UID from a `connector:<uid>` tag, if any. */
  connectorUid: string | null;
  /** Carries the `read-only` tag. */
  readOnly: boolean;
  /** Either of the above: badge as connector-sourced. */
  isConnector: boolean;
}

export function connectorInfo(tags: readonly string[] | null | undefined): ConnectorInfo {
  const list = tags ?? [];
  const tag = list.find((t) => t.startsWith('connector:'));
  const connectorUid = tag ? tag.slice('connector:'.length) || null : null;
  const readOnly = list.includes('read-only');
  return { connectorUid, readOnly, isConnector: readOnly || !!tag };
}

/**
 * Why the editor is read-only, in priority order: connector-owned notes, an explicit caller reason,
 * the sync server granting only a read scope, or an auth failure. `null` = editable.
 */
export function readOnlyReason(o: { connector: boolean; explicit?: string | null; scope?: string | null; authError?: string | null }): string | null {
  if (o.connector) return CONNECTOR_READ_ONLY_REASON;
  if (o.explicit) return o.explicit;
  if (o.authError) return 'You can’t edit this note right now (the live session was refused).';
  if (o.scope === 'readonly') return 'You have read access to this note but not edit access.';
  return null;
}

/** Distinct, live source nodes of incoming `references` edges (the backlinks panel), newest first. */
export function backlinkSources(edges: readonly EdgeRecord[], self?: string): Array<{ uid: string; at: string }> {
  const seen = new Map<string, string>();
  for (const e of [...edges].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))) {
    if (e.type !== 'references' || e.retracted_at || !e.src_uid || e.src_uid === self) continue;
    if (!seen.has(e.src_uid)) seen.set(e.src_uid, e.created_at);
  }
  return [...seen].map(([uid, at]) => ({ uid, at }));
}

export interface KnowledgeHit {
  uid: string;
  title: string;
  snippet: string;
  score: number;
  domains: string[];
  tags: string[];
  source: 'text' | 'semantic' | 'hybrid' | string;
}

/** The search API has no tag parameter: tag filtering happens client-side (prefix match for `connector:` etc.). */
export function filterHitsByTag<T extends { tags?: readonly string[] | null }>(hits: readonly T[], tag: string | null | undefined): T[] {
  const t = (tag ?? '').trim();
  if (!t) return [...hits];
  return hits.filter((h) => (h.tags ?? []).some((x) => x === t || (t.endsWith(':') && x.startsWith(t))));
}

export function formatScore(score: number | null | undefined): string {
  if (typeof score !== 'number' || !Number.isFinite(score)) return '—';
  if (score !== 0 && Math.abs(score) < 0.01) return score.toExponential(1);
  return score.toFixed(2);
}

export const SEARCH_MODES = ['hybrid', 'text', 'semantic'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export function asSearchMode(v: string | null | undefined): SearchMode {
  return (SEARCH_MODES as readonly string[]).includes(v ?? '') ? (v as SearchMode) : 'hybrid';
}
