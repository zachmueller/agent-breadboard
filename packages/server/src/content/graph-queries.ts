import type { EdgeRecord, Scope } from '@breadboard/shared';
import type { Db, Queryable } from '../db/index.js';
import { toIso } from './nodes.js';

export interface TraversalOptions {
  depth?: number; // max hops (default 10, max 50)
  maxRows?: number; // default 500, max 2000
  types?: string[]; // edge types to follow (default provenance set)
}

export interface TraversalResult {
  edges: EdgeRecord[];
  truncated: boolean;
}

const PROVENANCE = ['produces', 'updates', 'derived-from'];

/**
 * The single module through which all graph traversal flows ([01] §2, §8.1) — the documented seam
 * for a future dedicated graph store. Every traversal has mandatory depth + row guards.
 */
export class GraphQueries {
  constructor(private db: Db) {}

  private guards(o: TraversalOptions) {
    return { depth: Math.min(Math.max(o.depth ?? 10, 1), 50), maxRows: Math.min(Math.max(o.maxRows ?? 500, 1), 2000), types: o.types?.length ? o.types : PROVENANCE };
  }

  /**
   * Everything upstream of `uid` (toward origins). Direction is per edge type: `produces`/`updates` are
   * incoming (a session step touched the node); `derived-from`/`references`/`attached-to`/`blocks`/`depends-on`
   * are outgoing (the node points at what it was built on / refers to). Recursion walks node→node types only.
   */
  async upstream(uid: string, opts: TraversalOptions = {}, q: Queryable = this.db): Promise<TraversalResult> {
    const g = this.guards(opts);
    const nodeTypes = g.types.filter((t) => t !== 'produces' && t !== 'updates');
    const sessTypes = g.types.filter((t) => t === 'produces' || t === 'updates');
    const r = await q.query(
      `WITH RECURSIVE frontier(uid, depth) AS (
         SELECT $1::char(20), 0
         UNION
         SELECT e.dst_uid, f.depth + 1 FROM edges e JOIN frontier f ON e.src_uid = f.uid
          WHERE e.type = ANY($2::text[]) AND e.retracted_at IS NULL AND f.depth < $3
       )
       SELECT DISTINCT ON (e.edge_id) e.* FROM edges e JOIN frontier f
         ON ((e.dst_uid = f.uid AND e.type = ANY($5::text[])) OR (e.src_uid = f.uid AND e.type = ANY($2::text[])))
        WHERE e.retracted_at IS NULL ORDER BY e.edge_id LIMIT $4`,
      [uid, nodeTypes, g.depth, g.maxRows + 1, sessTypes],
    );
    return this.finish(r.rows, g.maxRows);
  }

  /** Everything downstream of `uid` (where it was consumed): nodes whose node→node edges point at it, recursively. */
  async downstream(uid: string, opts: TraversalOptions = {}, q: Queryable = this.db): Promise<TraversalResult> {
    const g = this.guards(opts);
    const nodeTypes = g.types.filter((t) => t !== 'produces' && t !== 'updates');
    const r = await q.query(
      `WITH RECURSIVE frontier(uid, depth) AS (
         SELECT $1::char(20), 0
         UNION
         SELECT e.src_uid, f.depth + 1 FROM edges e JOIN frontier f ON e.dst_uid = f.uid
          WHERE e.type = ANY($2::text[]) AND e.retracted_at IS NULL AND e.src_uid IS NOT NULL AND f.depth < $3
       )
       SELECT DISTINCT ON (e.edge_id) e.* FROM edges e JOIN frontier f ON (e.dst_uid = f.uid AND e.type = ANY($2::text[]))
        WHERE e.retracted_at IS NULL ORDER BY e.edge_id LIMIT $4`,
      [uid, nodeTypes, g.depth, g.maxRows + 1],
    );
    return this.finish(r.rows, g.maxRows);
  }

  /** Nodes that `derived-from`-descend from uid (used for scope-narrowing checks). Returns widest scope found. */
  async widestDescendantScope(uid: string, q: Queryable = this.db): Promise<Scope | null> {
    const r = await q.query<{ scope: Scope }>(
      `WITH RECURSIVE d AS (
         SELECT e.src_uid AS uid, 1 AS depth FROM edges e WHERE e.dst_uid = $1 AND e.type='derived-from' AND e.retracted_at IS NULL
         UNION ALL
         SELECT e.src_uid, d.depth+1 FROM edges e JOIN d ON e.dst_uid = d.uid WHERE e.type='derived-from' AND e.retracted_at IS NULL AND d.depth < 20
       )
       SELECT n.scope FROM d JOIN nodes n ON n.uid = d.uid WHERE n.deleted_at IS NULL
       ORDER BY CASE n.scope WHEN 'external' THEN 2 WHEN 'team' THEN 1 ELSE 0 END DESC LIMIT 1`,
      [uid],
    );
    return r.rows[0]?.scope ?? null;
  }

  /** Scopes of the nodes a new node derives from (for propagation defaults). */
  async scopesOf(uids: string[], q: Queryable = this.db): Promise<Scope[]> {
    if (!uids.length) return [];
    const r = await q.query<{ scope: Scope }>(`SELECT scope FROM nodes WHERE uid = ANY($1::char(20)[])`, [uids]);
    return r.rows.map((x) => x.scope);
  }

  /** Backlinks: incoming `references` edges to a node. */
  async backlinks(uid: string, q: Queryable = this.db): Promise<EdgeRecord[]> {
    const r = await q.query(`SELECT * FROM edges WHERE dst_uid=$1 AND type='references' AND retracted_at IS NULL ORDER BY created_at DESC LIMIT 500`, [uid]);
    return r.rows.map(rowToEdge);
  }

  /** The session (and step) that produced a node, if any. */
  async producer(uid: string, q: Queryable = this.db): Promise<{ session_id: string; step_id: string | null; revision: number | null } | null> {
    const r = await q.query(`SELECT src_session_id, src_step_id, dst_revision FROM edges WHERE dst_uid=$1 AND type='produces' AND retracted_at IS NULL AND src_session_id IS NOT NULL ORDER BY edge_id ASC LIMIT 1`, [uid]);
    const row = r.rows[0];
    return row ? { session_id: row.src_session_id, step_id: row.src_step_id ?? null, revision: row.dst_revision ?? null } : null;
  }

  private finish(rows: any[], maxRows: number): TraversalResult {
    const truncated = rows.length > maxRows;
    return { edges: rows.slice(0, maxRows).map(rowToEdge), truncated };
  }
}

function rowToEdge(r: any): EdgeRecord {
  return {
    edge_id: Number(r.edge_id),
    type: r.type,
    src_uid: r.src_uid ?? null,
    src_session_id: r.src_session_id ?? null,
    src_step_id: r.src_step_id ?? null,
    dst_uid: r.dst_uid,
    dst_revision: r.dst_revision ?? null,
    properties: r.properties ?? {},
    created_at: toIso(r.created_at),
    created_by: r.created_by,
    retracted_at: r.retracted_at ? toIso(r.retracted_at) : null,
    retracted_by: r.retracted_by ?? null,
  };
}
