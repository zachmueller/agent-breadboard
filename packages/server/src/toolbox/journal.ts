/**
 * Tool execution journal ([06] §4.4): every execution is a `tool_executions` row keyed by
 * `session_id + step_id + attempt + call-index`. On orchestrator replay a completed key returns its journaled
 * output instead of re-executing, which makes step replay safe for side-effecting tools.
 */
import { createHash } from 'node:crypto';
import { mintUid } from '@breadboard/shared';
import type { Db } from '../db/index.js';
import type { ObjectStore } from '../core/object-store.js';

/** Outputs larger than this are spilled to the object store (`output_ref`) instead of the jsonb column. */
export const OUTPUT_INLINE_MAX_BYTES = 256 * 1024;

export interface JournalCoordinates {
  session_id?: string | null;
  step_id?: string | null;
  attempt?: number | null;
  call_index?: number | null;
}

/**
 * Deterministic execution key. Journaled coordinates need a session + step; anything else (ad-hoc user/MCP
 * calls, connector syncs) gets a fresh `adhoc:<uid>` key and is therefore never replayed.
 */
export function executionKey(c: JournalCoordinates): string {
  if (c.session_id && c.step_id) return `${c.session_id}:${c.step_id}:${c.attempt ?? 1}:${c.call_index ?? 0}`;
  return `adhoc:${mintUid()}`;
}

export function isAdhocKey(key: string): boolean {
  return key.startsWith('adhoc:');
}

/** JSON with recursively sorted object keys (stable across producers). `undefined` members are dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value)) ?? 'null';
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sortDeep(x)));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortDeep(x);
    }
    return out;
  }
  return v;
}

export function inputHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

export type ExecutionStatus = 'running' | 'completed' | 'failed';

export interface ExecutionRow {
  execution_key: string;
  session_id: string | null;
  step_id: string | null;
  attempt: number | null;
  call_index: number | null;
  tool_uid: string;
  tool_commit: string | null;
  input_hash: string;
  status: ExecutionStatus;
  output: unknown;
  output_ref: string | null;
  error: string | null;
  cost_units: number;
  log_ref: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface BeginInput extends JournalCoordinates {
  execution_key: string;
  tool_uid: string;
  tool_commit: string | null;
  input_hash: string;
}

const COLS = 'execution_key, session_id, step_id, attempt, call_index, tool_uid, tool_commit, input_hash, status, output, output_ref, error, cost_units, log_ref, started_at, ended_at';

function rowOut(r: any): ExecutionRow {
  return {
    ...r,
    session_id: r.session_id ? String(r.session_id).trim() : null,
    tool_uid: String(r.tool_uid).trim(),
    cost_units: Number(r.cost_units ?? 0),
    started_at: r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at),
    ended_at: r.ended_at ? (r.ended_at instanceof Date ? r.ended_at.toISOString() : String(r.ended_at)) : null,
  };
}

export class ToolJournal {
  constructor(
    private db: Db,
    private objects: ObjectStore | null = null,
  ) {}

  async lookup(key: string): Promise<ExecutionRow | null> {
    const r = await this.db.query(`SELECT ${COLS} FROM tool_executions WHERE execution_key = $1`, [key]);
    return r.rows[0] ? rowOut(r.rows[0]) : null;
  }

  /** Insert (or reset a previously failed/abandoned row to) `running`. */
  async begin(b: BeginInput): Promise<void> {
    await this.db.query(
      `INSERT INTO tool_executions (execution_key, session_id, step_id, attempt, call_index, tool_uid, tool_commit, input_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running')
       ON CONFLICT (execution_key) DO UPDATE SET
         tool_uid = EXCLUDED.tool_uid, tool_commit = EXCLUDED.tool_commit, input_hash = EXCLUDED.input_hash,
         status = 'running', output = NULL, output_ref = NULL, error = NULL, cost_units = 0, log_ref = NULL,
         started_at = now(), ended_at = NULL`,
      [b.execution_key, b.session_id ?? null, b.step_id ?? null, b.attempt ?? null, b.call_index ?? null, b.tool_uid, b.tool_commit, b.input_hash],
    );
  }

  async complete(key: string, r: { output: unknown; cost_units: number; log_ref?: string | null }): Promise<void> {
    const json = JSON.stringify(r.output === undefined ? null : r.output);
    let inline: string | null = json;
    let ref: string | null = null;
    if (this.objects && Buffer.byteLength(json) > OUTPUT_INLINE_MAX_BYTES) {
      ref = await this.objects.put(json, 'application/json');
      inline = null;
    }
    await this.db.query(
      `UPDATE tool_executions SET status = 'completed', output = $2::jsonb, output_ref = $3, cost_units = $4, log_ref = $5, error = NULL, ended_at = now()
       WHERE execution_key = $1`,
      [key, inline, ref, r.cost_units, r.log_ref ?? null],
    );
  }

  async fail(key: string, r: { error: string; cost_units: number; log_ref?: string | null }): Promise<void> {
    await this.db.query(
      `UPDATE tool_executions SET status = 'failed', error = $2, cost_units = $3, log_ref = $4, ended_at = now() WHERE execution_key = $1`,
      [key, r.error.slice(0, 8000), r.cost_units, r.log_ref ?? null],
    );
  }

  /** The journaled output of a completed row (resolving `output_ref` from the object store). */
  async output(row: ExecutionRow): Promise<unknown> {
    if (row.output_ref) {
      if (!this.objects) throw new Error(`execution ${row.execution_key} output is in the object store but no store is configured`);
      return JSON.parse((await this.objects.get(row.output_ref)).toString('utf8'));
    }
    return row.output ?? null;
  }

  /** Sum of `cost_units` of completed executions in a session (per-run tool budget, [06] §4). */
  async sessionCostUnits(sessionId: string): Promise<number> {
    const r = await this.db.query<{ total: number | string | null }>(
      `SELECT COALESCE(SUM(cost_units), 0) AS total FROM tool_executions WHERE session_id = $1 AND status = 'completed'`,
      [sessionId],
    );
    return Number(r.rows[0]?.total ?? 0);
  }

  async list(sessionId: string): Promise<ExecutionRow[]> {
    const r = await this.db.query(`SELECT ${COLS} FROM tool_executions WHERE session_id = $1 ORDER BY started_at, execution_key`, [sessionId]);
    return r.rows.map(rowOut);
  }
}
