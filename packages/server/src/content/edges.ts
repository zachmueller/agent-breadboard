import { type Actor, type EdgeRecord, type EdgeType, BreadboardError, isProvenanceEdge, EXPLICIT_EDGE_TYPES } from '@breadboard/shared';
import type { Db, Queryable } from '../db/index.js';
import { toIso } from './nodes.js';

export interface EmitEdgeInput {
  type: EdgeType;
  src_uid?: string | null;
  src_session_id?: string | null;
  src_step_id?: string | null;
  dst_uid: string;
  dst_revision?: number | null;
  properties?: Record<string, unknown>;
  created_by: Actor;
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

/** Edge storage ([01] §4). Tombstone-only deletion except for indexer-owned `references` edges. */
export class EdgeStore {
  constructor(private db: Db) {}

  async emit(input: EmitEdgeInput, q: Queryable = this.db): Promise<EdgeRecord> {
    if (!input.src_uid && !input.src_session_id) throw new BreadboardError('validation-failed', 'edge needs a src_uid or src_session_id');
    if (isProvenanceEdge(input.type) && input.type !== 'derived-from' && !input.src_session_id) {
      throw new BreadboardError('validation-failed', `${input.type} edges are emitted by the orchestrator from a session step`);
    }
    const r = await q.query(
      `INSERT INTO edges (type, src_uid, src_session_id, src_step_id, dst_uid, dst_revision, properties, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [input.type, input.src_uid ?? null, input.src_session_id ?? null, input.src_step_id ?? null, input.dst_uid, input.dst_revision ?? null, JSON.stringify(input.properties ?? {}), JSON.stringify(input.created_by)],
    );
    return rowToEdge(r.rows[0]);
  }

  /** Validate an explicitly-emitted edge (subagent/user path, [01] §4.3). */
  assertExplicitType(type: string): asserts type is EdgeType {
    if (!EXPLICIT_EDGE_TYPES.includes(type as EdgeType)) {
      throw new BreadboardError('validation-failed', `edge type '${type}' cannot be emitted explicitly (allowed: ${EXPLICIT_EDGE_TYPES.join(', ')})`);
    }
  }

  async get(edgeId: number, q: Queryable = this.db): Promise<EdgeRecord | null> {
    const r = await q.query(`SELECT * FROM edges WHERE edge_id = $1`, [edgeId]);
    return r.rows[0] ? rowToEdge(r.rows[0]) : null;
  }

  async retract(edgeId: number, by: Actor, q: Queryable = this.db): Promise<EdgeRecord> {
    const r = await q.query(`UPDATE edges SET retracted_at = now(), retracted_by = $2 WHERE edge_id = $1 AND retracted_at IS NULL RETURNING *`, [edgeId, JSON.stringify(by)]);
    if (!r.rows[0]) throw new BreadboardError('not-found', `edge ${edgeId} not found or already retracted`);
    return rowToEdge(r.rows[0]);
  }

  async listForNode(uid: string, opts: { direction?: 'in' | 'out' | 'both'; type?: EdgeType[]; limit?: number } = {}, q: Queryable = this.db): Promise<EdgeRecord[]> {
    const dir = opts.direction ?? 'both';
    const where: string[] = ['retracted_at IS NULL'];
    const params: unknown[] = [uid];
    if (dir === 'in') where.push('dst_uid = $1');
    else if (dir === 'out') where.push('src_uid = $1');
    else where.push('(dst_uid = $1 OR src_uid = $1)');
    if (opts.type?.length) {
      params.push(opts.type);
      where.push(`type = ANY($${params.length}::text[])`);
    }
    const limit = Math.min(opts.limit ?? 500, 2000);
    const r = await q.query(`SELECT * FROM edges WHERE ${where.join(' AND ')} ORDER BY created_at ASC, edge_id ASC LIMIT ${limit}`, params);
    return r.rows.map(rowToEdge);
  }

  async listForSession(sessionId: string, q: Queryable = this.db): Promise<EdgeRecord[]> {
    const r = await q.query(`SELECT * FROM edges WHERE src_session_id = $1 AND retracted_at IS NULL ORDER BY edge_id`, [sessionId]);
    return r.rows.map(rowToEdge);
  }

  /** Does an active edge already exist with this (type, src, dst)? Used for idempotent explicit emission. */
  async exists(type: EdgeType, src_uid: string, dst_uid: string, q: Queryable = this.db): Promise<EdgeRecord | null> {
    const r = await q.query(`SELECT * FROM edges WHERE type=$1 AND src_uid=$2 AND dst_uid=$3 AND retracted_at IS NULL LIMIT 1`, [type, src_uid, dst_uid]);
    return r.rows[0] ? rowToEdge(r.rows[0]) : null;
  }

  /**
   * Indexer-owned `references` edges ([01] §4.3 exception): upsert the set for a source node, true-deleting
   * stale ones. Marked `properties.indexer = true` so explicit references are never touched.
   */
  async replaceIndexedReferences(srcUid: string, targets: string[], by: Actor, q: Queryable = this.db): Promise<{ added: string[]; removed: string[] }> {
    const existing = await q.query<{ edge_id: number; dst_uid: string }>(`SELECT edge_id, dst_uid FROM edges WHERE type='references' AND src_uid=$1 AND (properties->>'indexer')='true' AND retracted_at IS NULL`, [srcUid]);
    const have = new Map(existing.rows.map((r) => [r.dst_uid, r.edge_id] as const));
    const want = new Set(targets.filter((t) => t !== srcUid));
    const added: string[] = [];
    const removed: string[] = [];
    for (const [dst, id] of have) {
      if (!want.has(dst)) {
        await q.query(`DELETE FROM edges WHERE edge_id=$1`, [id]);
        removed.push(dst);
      }
    }
    if (want.size) {
      // only link to nodes that exist (broken links render distinctly but don't get edges)
      const exist = await q.query<{ uid: string }>(`SELECT uid FROM nodes WHERE uid = ANY($1::char(20)[]) AND deleted_at IS NULL`, [[...want]]);
      for (const { uid: dst } of exist.rows) {
        if (have.has(dst)) continue;
        await q.query(`INSERT INTO edges (type, src_uid, dst_uid, properties, created_by) VALUES ('references',$1,$2,'{"indexer":true}',$3)`, [srcUid, dst, JSON.stringify(by)]);
        added.push(dst);
      }
    }
    return { added, removed };
  }
}
