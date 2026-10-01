import { createHash } from 'node:crypto';
import {
  mintUid,
  isUid,
  BreadboardError,
  notFound,
  type Actor,
  type NodeRecord,
  type NodeRevision,
  type NodeType,
  type RevisionLabel,
  type Scope,
  type Page,
} from '@breadboard/shared';
import type { Db, Queryable } from '../db/index.js';
import { decodeCursor, encodeCursor, clampLimit } from './cursor.js';

export interface CreateNodeInput {
  type: NodeType;
  title?: string;
  properties?: Record<string, unknown>;
  body?: unknown;
  body_text?: string | null;
  crdt?: boolean;
  tags?: string[];
  scope?: Scope;
  created_by: Actor;
  session_id?: string | null;
  uid?: string;
}

export interface PatchNodeInput {
  title?: string;
  properties?: Record<string, unknown>; // shallow-merged; null values delete keys
  body?: unknown;
  body_text?: string | null;
  tags_add?: string[];
  tags_remove?: string[];
  tags?: string[];
  scope?: Scope;
}

export interface ListNodesFilter {
  type?: string[];
  tag?: string[];
  scope?: string[];
  q?: string;
  created_after?: string;
  created_before?: string;
  session_id?: string;
  need_input_role?: string;
  need_input_username?: string;
  need_input_open?: boolean;
  circuit?: string;
  status?: string[]; // properties.status
  priority?: string[];
  origin_kind?: string[];
  include_deleted?: boolean;
  /** Restrict to nodes whose properties.domains overlaps these. */
  domains?: string[];
  cursor?: string | null;
  limit?: number;
  /** Visibility: include `session`-scoped nodes only from these sessions (null = all, [] = none). */
  visible_sessions?: string[] | null;
}

export interface CutRevisionInput {
  labels: RevisionLabel[];
  created_by: Actor;
  ydoc_state?: Buffer | null;
  ydoc_vector?: Buffer | null;
  /** Override the snapshot (for CRDT heads the caller supplies the rendered body_text). */
  properties?: Record<string, unknown>;
  body?: unknown;
  body_text?: string | null;
}

const NODE_COLS = `uid, team_id, type, title, properties, body, body_text, crdt, tags, scope, created_at, created_by, updated_at, deleted_at, session_id`;

function rowToNode(r: any): NodeRecord & { session_id: string | null } {
  return {
    uid: r.uid,
    team_id: r.team_id,
    type: r.type,
    title: r.title,
    properties: r.properties ?? {},
    body: r.body ?? null,
    body_text: r.body_text ?? null,
    crdt: !!r.crdt,
    tags: r.tags ?? [],
    scope: r.scope,
    created_at: toIso(r.created_at),
    created_by: r.created_by,
    updated_at: toIso(r.updated_at),
    deleted_at: r.deleted_at ? toIso(r.deleted_at) : null,
    session_id: r.session_id ?? null,
  };
}

export function toIso(v: any): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return new Date(v).toISOString();
  return String(v);
}

function rowToRevision(r: any): NodeRevision & { ydoc_state_buf: Buffer | null; ydoc_vector_buf: Buffer | null } {
  return {
    uid: r.uid,
    revision_id: r.revision_id,
    labels: r.labels ?? [],
    properties: r.properties ?? {},
    body: r.body ?? null,
    body_text: r.body_text ?? null,
    created_at: toIso(r.created_at),
    created_by: r.created_by,
    ydoc_state: r.ydoc_state ? Buffer.from(r.ydoc_state).toString('base64') : null,
    ydoc_vector: r.ydoc_vector ? Buffer.from(r.ydoc_vector).toString('base64') : null,
    ydoc_state_buf: r.ydoc_state ? Buffer.from(r.ydoc_state) : null,
    ydoc_vector_buf: r.ydoc_vector ? Buffer.from(r.ydoc_vector) : null,
  };
}

export function contentHash(properties: unknown, body: unknown, body_text: string | null | undefined): string {
  return createHash('sha256').update(JSON.stringify([properties ?? {}, body ?? null, body_text ?? null])).digest('hex');
}

/**
 * Content-plane node storage ([01] §3, §5, §8). Visibility/grants are enforced by callers (API layer)
 * except for the `visible_sessions` list filter, which the API passes down for session-scoped nodes.
 */
export class NodeStore {
  constructor(
    private db: Db,
    private teamId: string,
  ) {}

  async create(input: CreateNodeInput, q: Queryable = this.db): Promise<NodeRecord> {
    const title = input.title ?? (typeof input.properties?.title === 'string' ? (input.properties.title as string) : '');
    const properties = { ...(input.properties ?? {}), title };
    const tags = [...new Set(input.tags ?? [])];
    for (let attempt = 0; attempt < 2; attempt++) {
      const uid = input.uid ?? mintUid();
      try {
        const r = await q.query(
          `INSERT INTO nodes (uid, team_id, type, title, properties, body, body_text, crdt, tags, scope, created_by, session_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${NODE_COLS}`,
          [uid, this.teamId, input.type, title, JSON.stringify(properties), input.body === undefined ? null : JSON.stringify(input.body), input.body_text ?? null, !!input.crdt, tags, input.scope ?? 'team', JSON.stringify(input.created_by), input.session_id ?? null],
        );
        return rowToNode(r.rows[0]);
      } catch (e: any) {
        // Retry once on primary-key conflict ([01] §10.2) unless the caller pinned the uid.
        if (input.uid || attempt === 1 || !/duplicate key|unique/i.test(String(e?.message))) throw e;
      }
    }
    throw new Error('unreachable');
  }

  async get(uid: string, q: Queryable = this.db, opts: { includeDeleted?: boolean } = {}): Promise<(NodeRecord & { session_id: string | null }) | null> {
    if (!isUid(uid)) return null;
    const r = await q.query(`SELECT ${NODE_COLS} FROM nodes WHERE uid = $1 AND team_id = $2${opts.includeDeleted ? '' : ' AND deleted_at IS NULL'}`, [uid, this.teamId]);
    return r.rows[0] ? rowToNode(r.rows[0]) : null;
  }

  async mustGet(uid: string, q: Queryable = this.db): Promise<NodeRecord & { session_id: string | null }> {
    const n = await this.get(uid, q);
    if (!n) throw notFound('node', uid);
    return n;
  }

  async getMany(uids: string[], q: Queryable = this.db): Promise<Map<string, NodeRecord & { session_id: string | null }>> {
    const out = new Map<string, NodeRecord & { session_id: string | null }>();
    const valid = uids.filter(isUid);
    if (valid.length === 0) return out;
    const r = await q.query(`SELECT ${NODE_COLS} FROM nodes WHERE team_id = $1 AND uid = ANY($2::char(20)[]) AND deleted_at IS NULL`, [this.teamId, valid]);
    for (const row of r.rows) out.set(row.uid, rowToNode(row));
    return out;
  }

  async patch(uid: string, patch: PatchNodeInput, q: Queryable = this.db): Promise<NodeRecord> {
    const cur = await this.mustGet(uid, q);
    const properties = { ...cur.properties };
    if (patch.properties) {
      for (const [k, v] of Object.entries(patch.properties)) {
        if (v === null) delete properties[k];
        else properties[k] = v;
      }
    }
    const title = patch.title ?? (typeof properties.title === 'string' ? (properties.title as string) : cur.title);
    properties.title = title;
    let tags = patch.tags ? [...patch.tags] : [...cur.tags];
    if (patch.tags_add) tags.push(...patch.tags_add);
    if (patch.tags_remove) tags = tags.filter((t) => !patch.tags_remove!.includes(t));
    tags = [...new Set(tags)];
    const body = patch.body === undefined ? cur.body : patch.body;
    const body_text = patch.body_text === undefined ? cur.body_text : patch.body_text;
    const scope = patch.scope ?? cur.scope;
    const r = await q.query(
      `UPDATE nodes SET title=$3, properties=$4, body=$5, body_text=$6, tags=$7, scope=$8, updated_at=now() WHERE uid=$1 AND team_id=$2 RETURNING ${NODE_COLS}`,
      [uid, this.teamId, title, JSON.stringify(properties), body === null || body === undefined ? null : JSON.stringify(body), body_text, tags, scope],
    );
    return rowToNode(r.rows[0]);
  }

  /** Update only the body_text mirror (debounced CRDT head refresh, [01] §10.3). */
  async setBodyText(uid: string, body_text: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE nodes SET body_text=$3, updated_at=now() WHERE uid=$1 AND team_id=$2`, [uid, this.teamId, body_text]);
  }

  async setSessionId(uid: string, sessionId: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE nodes SET session_id=$3 WHERE uid=$1 AND team_id=$2 AND session_id IS NULL`, [uid, this.teamId, sessionId]);
  }

  async softDelete(uid: string, q: Queryable = this.db): Promise<void> {
    const r = await q.query(`UPDATE nodes SET deleted_at = now(), updated_at = now() WHERE uid=$1 AND team_id=$2 AND deleted_at IS NULL`, [uid, this.teamId]);
    if (r.rowCount === 0) throw notFound('node', uid);
  }

  async restore(uid: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE nodes SET deleted_at = NULL, updated_at = now() WHERE uid=$1 AND team_id=$2`, [uid, this.teamId]);
  }

  async list(f: ListNodesFilter, q: Queryable = this.db): Promise<Page<NodeRecord & { session_id: string | null; rank?: number }>> {
    const where: string[] = ['n.team_id = $1'];
    const params: unknown[] = [this.teamId];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (!f.include_deleted) where.push('n.deleted_at IS NULL');
    if (f.type?.length) where.push(`n.type = ANY(${p(f.type)}::text[])`);
    if (f.scope?.length) where.push(`n.scope = ANY(${p(f.scope)}::text[])`);
    if (f.tag?.length) where.push(`n.tags && ${p(f.tag)}::text[]`);
    if (f.session_id) where.push(`n.session_id = ${p(f.session_id)}`);
    if (f.created_after) where.push(`n.created_at >= ${p(f.created_after)}::timestamptz`);
    if (f.created_before) where.push(`n.created_at <= ${p(f.created_before)}::timestamptz`);
    if (f.status?.length) where.push(`(n.properties->>'status') = ANY(${p(f.status)}::text[])`);
    if (f.priority?.length) where.push(`(n.properties->>'priority') = ANY(${p(f.priority)}::text[])`);
    if (f.origin_kind?.length) where.push(`(n.properties->'origin'->>'kind') = ANY(${p(f.origin_kind)}::text[])`);
    if (f.circuit) where.push(`(n.properties->>'circuit_uid' = ${p(f.circuit)} OR n.properties->>'target_circuit' = ${p(f.circuit)})`);
    if (f.domains?.length) {
      where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(n.properties->'domains')='array' THEN n.properties->'domains' ELSE '[]'::jsonb END) d WHERE d = ANY(${p(f.domains)}::text[]))`);
    }
    if (f.need_input_open) where.push(`jsonb_array_length(coalesce(n.properties->'need-input','[]'::jsonb)) > 0`);
    if (f.need_input_role) where.push(`n.properties->'need-input' @> ${p(JSON.stringify([{ role: f.need_input_role }]))}::jsonb`);
    if (f.need_input_username) where.push(`n.properties->'need-input' @> ${p(JSON.stringify([{ username: f.need_input_username }]))}::jsonb`);
    if (f.visible_sessions !== undefined && f.visible_sessions !== null) {
      where.push(`(n.scope <> 'session' OR n.session_id = ANY(${p(f.visible_sessions)}::text[]))`);
    }
    const limit = clampLimit(f.limit);
    let rankSel = '';
    let order = 'n.created_at DESC, n.uid DESC';
    if (f.q && f.q.trim()) {
      const tsq = p(f.q.trim());
      where.push(`to_tsvector('english', coalesce(n.title,'') || ' ' || coalesce(n.properties->>'aliases','') || ' ' || coalesce(n.body_text,'')) @@ websearch_to_tsquery('english', ${tsq})`);
      rankSel = `, ts_rank(to_tsvector('english', coalesce(n.title,'') || ' ' || coalesce(n.properties->>'aliases','') || ' ' || coalesce(n.body_text,'')), websearch_to_tsquery('english', ${tsq})) AS rank`;
      order = 'rank DESC, n.created_at DESC, n.uid DESC';
    }
    const cur = decodeCursor(f.cursor);
    if (cur && !f.q) where.push(`(n.created_at, n.uid) < (${p(cur.created_at)}::timestamptz, ${p(cur.key)})`);
    const offset = cur && f.q ? Number(cur.key) || 0 : 0;
    const sql = `SELECT ${NODE_COLS.split(', ')
      .map((c) => 'n.' + c)
      .join(', ')}${rankSel} FROM nodes n WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit + 1}${offset ? ` OFFSET ${offset}` : ''}`;
    const r = await q.query(sql, params);
    const rows = r.rows.slice(0, limit).map((row: any) => ({ ...rowToNode(row), rank: row.rank }));
    let next_cursor: string | null = null;
    if (r.rows.length > limit) {
      const last = rows[rows.length - 1]!;
      next_cursor = f.q ? encodeCursor({ created_at: '', key: String(offset + limit) }) : encodeCursor({ created_at: last.created_at, key: last.uid });
    }
    return { items: rows, next_cursor };
  }

  // --- Revisions ([01] §3.3) ---------------------------------------------------

  async headRevisionId(uid: string, q: Queryable = this.db): Promise<number | null> {
    const r = await q.query<{ m: number | null }>(`SELECT max(revision_id) AS m FROM node_revisions WHERE uid = $1`, [uid]);
    return r.rows[0]?.m ?? null;
  }

  async latestRevision(uid: string, q: Queryable = this.db) {
    const r = await q.query(`SELECT * FROM node_revisions WHERE uid = $1 ORDER BY revision_id DESC LIMIT 1`, [uid]);
    return r.rows[0] ? rowToRevision(r.rows[0]) : null;
  }

  async getRevision(uid: string, revisionId: number, q: Queryable = this.db) {
    const r = await q.query(`SELECT * FROM node_revisions WHERE uid = $1 AND revision_id = $2`, [uid, revisionId]);
    return r.rows[0] ? rowToRevision(r.rows[0]) : null;
  }

  async listRevisions(uid: string, q: Queryable = this.db, opts: { limit?: number; before?: number } = {}) {
    const limit = clampLimit(opts.limit, 50, 500);
    const r = await q.query(
      `SELECT uid, revision_id, labels, properties, body, body_text, created_at, created_by FROM node_revisions WHERE uid = $1 ${opts.before ? 'AND revision_id < $3' : ''} ORDER BY revision_id DESC LIMIT $2`,
      opts.before ? [uid, limit, opts.before] : [uid, limit],
    );
    return r.rows.map(rowToRevision);
  }

  /**
   * Cut a revision of the node's current head (or of the supplied snapshot). Content-deduplicated:
   * if byte-identical to the latest revision, the labels are appended to it instead ([01] §3.3).
   */
  async cutRevision(uid: string, input: CutRevisionInput, q: Queryable = this.db): Promise<NodeRevision> {
    const node = await this.mustGet(uid, q);
    const properties = input.properties ?? node.properties;
    const body = input.body === undefined ? node.body : input.body;
    const body_text = input.body_text === undefined ? node.body_text : input.body_text;
    const hash = contentHash(properties, body, body_text);
    const latest = await q.query(`SELECT revision_id, labels, content_hash FROM node_revisions WHERE uid=$1 ORDER BY revision_id DESC LIMIT 1`, [uid]);
    const last = latest.rows[0];
    if (last && last.content_hash === hash) {
      const labels = [...new Set([...(last.labels ?? []), ...input.labels])];
      if (labels.length !== (last.labels ?? []).length) {
        await q.query(`UPDATE node_revisions SET labels=$3 WHERE uid=$1 AND revision_id=$2`, [uid, last.revision_id, labels]);
      }
      return (await this.getRevision(uid, last.revision_id, q))!;
    }
    const nextId = (last?.revision_id ?? 0) + 1;
    const r = await q.query(
      `INSERT INTO node_revisions (uid, revision_id, labels, properties, body, body_text, ydoc_state, ydoc_vector, content_hash, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [uid, nextId, input.labels, JSON.stringify(properties), body === null || body === undefined ? null : JSON.stringify(body), body_text ?? null, input.ydoc_state ?? null, input.ydoc_vector ?? null, hash, JSON.stringify(input.created_by)],
    );
    return rowToRevision(r.rows[0]);
  }

  /** Delete revisions older than `keepFrom` except pinned ones (compaction helper, [07] §6). */
  async pruneRevisions(uid: string, keepFrom: number, keep: number[], q: Queryable = this.db): Promise<number> {
    const r = await q.query(`DELETE FROM node_revisions WHERE uid=$1 AND revision_id < $2 AND NOT (revision_id = ANY($3::int[]))`, [uid, keepFrom, keep]);
    return r.rowCount;
  }

  async count(filter: { type?: string; tag?: string; status?: string }, q: Queryable = this.db): Promise<number> {
    const where = ['team_id=$1', 'deleted_at IS NULL'];
    const params: unknown[] = [this.teamId];
    if (filter.type) {
      params.push(filter.type);
      where.push(`type=$${params.length}`);
    }
    if (filter.tag) {
      params.push([filter.tag]);
      where.push(`tags && $${params.length}::text[]`);
    }
    if (filter.status) {
      params.push(filter.status);
      where.push(`properties->>'status' = $${params.length}`);
    }
    const r = await q.query<{ c: number }>(`SELECT count(*)::int AS c FROM nodes WHERE ${where.join(' AND ')}`, params);
    return r.rows[0]?.c ?? 0;
  }
}

export function assertNodeType(node: NodeRecord, type: NodeType): void {
  if (node.type !== type) throw new BreadboardError('invalid-state', `node ${node.uid} is a ${node.type}, not a ${type}`);
}
