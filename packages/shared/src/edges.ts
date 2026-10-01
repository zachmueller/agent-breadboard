import type { Actor } from './actor.js';

export const EDGE_TYPES = ['produces', 'updates', 'derived-from', 'attached-to', 'blocks', 'depends-on', 'references'] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** Provenance edges bind to a revision; currency edges bind to the node ([01] §4.2). */
export const PROVENANCE_EDGE_TYPES: readonly EdgeType[] = ['produces', 'updates', 'derived-from'];
export const CURRENCY_EDGE_TYPES: readonly EdgeType[] = ['attached-to', 'blocks', 'depends-on', 'references'];
/** Only the orchestrator may emit these ([01] §4.3). */
export const ORCHESTRATOR_ONLY_EDGE_TYPES: readonly EdgeType[] = ['produces', 'updates'];
/** Edge types a subagent/user may emit explicitly via `emit_edge` / POST /edges. */
export const EXPLICIT_EDGE_TYPES: readonly EdgeType[] = ['derived-from', 'attached-to', 'blocks', 'depends-on', 'references'];

export interface EdgeRecord {
  edge_id: number;
  type: EdgeType;
  src_uid: string | null;
  src_session_id: string | null;
  src_step_id: string | null;
  dst_uid: string;
  dst_revision: number | null;
  properties: Record<string, unknown>;
  created_at: string;
  created_by: Actor;
  retracted_at: string | null;
  retracted_by: Actor | null;
}

export function isProvenanceEdge(t: EdgeType): boolean {
  return PROVENANCE_EDGE_TYPES.includes(t);
}
