import {
  mintSessionId,
  mintTurnId,
  notFound,
  validationFailed,
  type Actor,
  type Page,
  type SessionBudget,
  type SessionEvent,
  type SessionKind,
  type SessionRecord,
  type SessionSummaryDto,
  type StepSummaryDto,
  type Turn,
} from '@breadboard/shared';
import type { Db, Queryable } from '../db/index.js';
import type { CreateSessionInput, SessionCost, SessionFilter, SessionStore } from '../core/services.js';
import { clampLimit, decodeCursor, encodeCursor } from '../content/cursor.js';
import { toIso } from '../content/nodes.js';

/**
 * Session records as stored. Extends the shared `SessionRecord` with the columns the orchestrator needs
 * to (re)run a session: the circuit input, eval model overrides, and the creating actor.
 */
export type SessionRow = SessionRecord & {
  input: unknown;
  model_overrides: Record<string, string> | null;
  created_by: Actor;
  updated_at: string;
};

const SESSION_COLS = `session_id, team_id, kind, circuit_uid, circuit_slug, config_commit, task_uid, parent_session, parent_step_id, state, state_detail, budget, priority, input, model_overrides, created_by, created_at, started_at, ended_at, updated_at`;

const PRIORITY_ORDER = `CASE priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 WHEN 'p3' THEN 3 ELSE 4 END`;

function trimChar(v: unknown): string | null {
  return typeof v === 'string' ? v.trim() : v == null ? null : String(v);
}

function rowToSession(r: any): SessionRow {
  return {
    session_id: trimChar(r.session_id)!,
    team_id: trimChar(r.team_id)!,
    kind: r.kind,
    circuit_uid: trimChar(r.circuit_uid),
    circuit_slug: r.circuit_slug ?? null,
    config_commit: r.config_commit ?? null,
    task_uid: trimChar(r.task_uid),
    parent_session: trimChar(r.parent_session),
    parent_step_id: r.parent_step_id ?? null,
    state: r.state,
    state_detail: r.state_detail ?? {},
    budget: normalizeBudget(r.budget),
    priority: r.priority ?? null,
    input: r.input ?? null,
    model_overrides: r.model_overrides ?? null,
    created_by: r.created_by,
    created_at: toIso(r.created_at),
    started_at: r.started_at ? toIso(r.started_at) : null,
    ended_at: r.ended_at ? toIso(r.ended_at) : null,
    updated_at: toIso(r.updated_at),
  };
}

function normalizeBudget(b: any): SessionBudget {
  return {
    max_cost_usd: Number(b?.max_cost_usd ?? 0),
    max_tokens: Number(b?.max_tokens ?? 0),
    spent_usd: Number(b?.spent_usd ?? 0),
    spent_tokens: Number(b?.spent_tokens ?? 0),
  };
}

function rowToEvent(r: any): SessionEvent {
  return {
    session_id: trimChar(r.session_id)!,
    seq: Number(r.seq),
    event_type: r.event_type,
    step_id: r.step_id ?? null,
    payload: r.payload ?? {},
    created_at: toIso(r.created_at),
  };
}

function rowToTurn(r: any): Turn & { attempt: number; latency_ms: number | null; fallback_from: string | null } {
  return {
    turn_id: trimChar(r.turn_id)!,
    session_id: trimChar(r.session_id)!,
    step_id: r.step_id,
    role: r.role,
    username: r.username ?? null,
    content: r.content,
    model_id: r.model_id ?? null,
    tokens_in: r.tokens_in == null ? null : Number(r.tokens_in),
    tokens_out: r.tokens_out == null ? null : Number(r.tokens_out),
    tokens_cache_read: r.tokens_cache_read == null ? null : Number(r.tokens_cache_read),
    tokens_cache_write: r.tokens_cache_write == null ? null : Number(r.tokens_cache_write),
    cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
    created_at: toIso(r.created_at),
    attempt: Number(r.attempt ?? 1),
    latency_ms: r.latency_ms ?? null,
    fallback_from: r.fallback_from ?? null,
  };
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

/**
 * Postgres session store ([02] §4): sessions, the append-only event log (authoritative), and the derived
 * `step_checkpoints` / `session_turns` projections. Cost is authoritative only at the turn leaf ([02] §6).
 */
export class PgSessionStore implements SessionStore {
  constructor(
    private db: Db,
    private teamId: string,
  ) {}

  async create(input: CreateSessionInput): Promise<SessionRow> {
    const id = mintSessionId();
    const budget: SessionBudget = {
      max_cost_usd: Number(input.budget.max_cost_usd),
      max_tokens: Number(input.budget.max_tokens),
      spent_usd: Number(input.budget.spent_usd ?? 0),
      spent_tokens: Number(input.budget.spent_tokens ?? 0),
    };
    const r = await this.db.query(
      `INSERT INTO sessions (session_id, team_id, kind, circuit_uid, circuit_slug, config_commit, task_uid, parent_session, parent_step_id, state, state_detail, budget, priority, input, model_overrides, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING ${SESSION_COLS}`,
      [
        id,
        this.teamId,
        input.kind,
        input.circuit_uid ?? null,
        input.circuit_slug ?? null,
        input.config_commit ?? null,
        input.task_uid ?? null,
        input.parent_session ?? null,
        input.parent_step_id ?? null,
        input.state ?? 'queued',
        JSON.stringify(input.state_detail ?? {}),
        JSON.stringify(budget),
        input.priority ?? 'p2',
        json(input.input ?? null),
        json(input.model_overrides ?? null),
        JSON.stringify(input.created_by),
      ],
    );
    return rowToSession(r.rows[0]);
  }

  async get(id: string): Promise<SessionRow | null> {
    if (typeof id !== 'string' || !id.startsWith('ses_')) return null;
    const r = await this.db.query(`SELECT ${SESSION_COLS} FROM sessions WHERE session_id = $1 AND team_id = $2`, [id, this.teamId]);
    return r.rows[0] ? rowToSession(r.rows[0]) : null;
  }

  async mustGet(id: string): Promise<SessionRow> {
    const s = await this.get(id);
    if (!s) throw notFound('session', id);
    return s;
  }

  async list(f: SessionFilter): Promise<Page<SessionRow>> {
    const where: string[] = ['team_id = $1'];
    const params: unknown[] = [this.teamId];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (f.state?.length) where.push(`state = ANY(${p(f.state)}::text[])`);
    if (f.kind?.length) where.push(`kind = ANY(${p(f.kind)}::text[])`);
    if (f.circuit) where.push(`(circuit_uid = ${p(f.circuit)} OR circuit_slug = ${p(f.circuit)})`);
    if (f.task) where.push(`task_uid = ${p(f.task)}`);
    if (f.parent) where.push(`parent_session = ${p(f.parent)}`);
    if (f.created_by) {
      const who = p(f.created_by);
      where.push(`(created_by->>'id' = ${who} OR state_detail->'started_by'->>'id' = ${who})`);
    }
    if (f.definition) where.push(`state_detail->'context'->>'definition_uid' = ${p(f.definition)}`);
    if (f.proposal) where.push(`state_detail->>'proposal_id' = ${p(f.proposal)}`);
    if (f.created_after) where.push(`created_at >= ${p(f.created_after)}::timestamptz`);
    if (f.created_before) where.push(`created_at <= ${p(f.created_before)}::timestamptz`);
    const asc = f.order === 'asc';
    const dir = asc ? 'ASC' : 'DESC';
    const limit = clampLimit(f.limit);
    // Offset mode ([11] §2): numbered pages with a total over the same filters.
    if (f.offset !== undefined && f.offset !== null) {
      const offset = Math.max(0, Math.floor(Number(f.offset) || 0));
      const cond = where.join(' AND ');
      const [rows, count] = await Promise.all([
        this.db.query(`SELECT ${SESSION_COLS} FROM sessions WHERE ${cond} ORDER BY created_at ${dir}, session_id ${dir} LIMIT ${limit} OFFSET ${offset}`, params),
        this.db.query(`SELECT count(*)::int AS n FROM sessions WHERE ${cond}`, params),
      ]);
      return { items: rows.rows.map(rowToSession), next_cursor: null, total: Number(count.rows[0]?.n ?? 0) };
    }
    const cur = decodeCursor(f.cursor);
    if (cur) where.push(`(created_at, session_id) ${asc ? '>' : '<'} (${p(cur.created_at)}::timestamptz, ${p(cur.key)})`);
    // The cursor keeps created_at at full (microsecond) precision; an ISO string would drop rows sharing a millisecond.
    const r = await this.db.query(
      `SELECT ${SESSION_COLS}, created_at::text AS cursor_ts FROM sessions WHERE ${where.join(' AND ')} ORDER BY created_at ${dir}, session_id ${dir} LIMIT ${limit + 1}`,
      params,
    );
    const page = r.rows.slice(0, limit);
    const items = page.map(rowToSession);
    const last = page[page.length - 1];
    const next_cursor = r.rows.length > limit && last ? encodeCursor({ created_at: String(last.cursor_ts), key: String(last.session_id) }) : null;
    return { items, next_cursor };
  }

  async update(id: string, patch: Partial<Pick<SessionRecord, 'state' | 'state_detail' | 'budget' | 'config_commit' | 'started_at' | 'ended_at' | 'priority' | 'circuit_slug'>>): Promise<SessionRow> {
    const sets: string[] = [];
    const params: unknown[] = [id, this.teamId];
    const set = (col: string, v: unknown, cast = '') => {
      params.push(v);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (patch.state !== undefined) set('state', patch.state);
    if (patch.state_detail !== undefined) set('state_detail', JSON.stringify(patch.state_detail ?? {}), '::jsonb');
    if (patch.budget !== undefined) set('budget', JSON.stringify(normalizeBudget(patch.budget)), '::jsonb');
    if (patch.config_commit !== undefined) set('config_commit', patch.config_commit);
    if (patch.started_at !== undefined) set('started_at', patch.started_at, '::timestamptz');
    if (patch.ended_at !== undefined) set('ended_at', patch.ended_at, '::timestamptz');
    if (patch.priority !== undefined) set('priority', patch.priority ?? 'p2');
    if (patch.circuit_slug !== undefined) set('circuit_slug', patch.circuit_slug);
    sets.push('updated_at = now()');
    const r = await this.db.query(`UPDATE sessions SET ${sets.join(', ')} WHERE session_id = $1 AND team_id = $2 RETURNING ${SESSION_COLS}`, params);
    if (!r.rows[0]) throw notFound('session', id);
    return rowToSession(r.rows[0]);
  }

  /** Per-session monotonic `seq`, assigned under a row lock on the session ([02] §4). */
  async appendEvent(id: string, type: SessionEvent['event_type'], payload: Record<string, unknown>, stepId: string | null = null): Promise<SessionEvent> {
    return this.db.transaction((tx) => this.appendEventTx(tx, id, type, payload, stepId));
  }

  private async appendEventTx(tx: Queryable, id: string, type: SessionEvent['event_type'], payload: Record<string, unknown>, stepId: string | null): Promise<SessionEvent> {
    const lock = await tx.query(`SELECT session_id FROM sessions WHERE session_id = $1 FOR UPDATE`, [id]);
    if (!lock.rows[0]) throw notFound('session', id);
    const next = await tx.query<{ s: number }>(`SELECT coalesce(max(seq), 0) + 1 AS s FROM session_events WHERE session_id = $1`, [id]);
    const seq = Number(next.rows[0]!.s);
    const r = await tx.query(`INSERT INTO session_events (session_id, seq, event_type, step_id, payload) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [id, seq, type, stepId, JSON.stringify(payload ?? {})]);
    return rowToEvent(r.rows[0]);
  }

  async events(id: string, afterSeq = 0, limit = 1000): Promise<SessionEvent[]> {
    const lim = clampLimit(limit, 1000, 10_000);
    const r = await this.db.query(`SELECT * FROM session_events WHERE session_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT ${lim}`, [id, afterSeq ?? 0]);
    return r.rows.map(rowToEvent);
  }

  /**
   * The `turn` event is authoritative; the `session_turns` row is its projection ([02] §4). Both are written
   * in one transaction, and the session's `budget.spent_*` running counters (own spend only) advance with it.
   */
  async recordTurn(t: Omit<Turn, 'turn_id' | 'created_at'> & { attempt?: number; latency_ms?: number | null; fallback_from?: string | null }): Promise<Turn> {
    const turnId = mintTurnId();
    const attempt = t.attempt ?? 1;
    const cost = t.cost_usd == null ? null : Number(t.cost_usd);
    const tokIn = t.tokens_in == null ? null : Number(t.tokens_in);
    const tokOut = t.tokens_out == null ? null : Number(t.tokens_out);
    const cacheRead = t.tokens_cache_read ? Number(t.tokens_cache_read) : null;
    const cacheWrite = t.tokens_cache_write ? Number(t.tokens_cache_write) : null;
    const tokens = (tokIn ?? 0) + (tokOut ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
    return this.db.transaction(async (tx) => {
      await this.appendEventTx(
        tx,
        t.session_id,
        'turn',
        {
          turn_id: turnId,
          attempt,
          role: t.role,
          username: t.username ?? null,
          content: t.content ?? null,
          model_id: t.model_id ?? null,
          tokens_in: tokIn,
          tokens_out: tokOut,
          ...(cacheRead ? { tokens_cache_read: cacheRead } : {}),
          ...(cacheWrite ? { tokens_cache_write: cacheWrite } : {}),
          cost_usd: cost,
          latency_ms: t.latency_ms ?? null,
          fallback_from: t.fallback_from ?? null,
        },
        t.step_id,
      );
      const r = await tx.query(
        `INSERT INTO session_turns (turn_id, session_id, step_id, attempt, role, username, content, model_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, cost_usd, latency_ms, fallback_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [turnId, t.session_id, t.step_id, attempt, t.role, t.username ?? null, JSON.stringify(t.content ?? null), t.model_id ?? null, tokIn, tokOut, cacheRead, cacheWrite, cost, t.latency_ms == null ? null : Math.round(t.latency_ms), t.fallback_from ?? null],
      );
      if (cost || tokens) {
        await tx.query(
          `UPDATE sessions SET budget = budget || jsonb_build_object(
             'spent_usd', coalesce((budget->>'spent_usd')::numeric, 0) + $2::numeric,
             'spent_tokens', coalesce((budget->>'spent_tokens')::numeric, 0) + $3::numeric), updated_at = now()
           WHERE session_id = $1`,
          [t.session_id, cost ?? 0, tokens],
        );
      }
      return rowToTurn(r.rows[0]);
    });
  }

  async turns(id: string, stepId?: string, attempt?: number): Promise<Turn[]> {
    const where = ['session_id = $1'];
    const params: unknown[] = [id];
    if (stepId) {
      params.push(stepId);
      where.push(`step_id = $${params.length}`);
    }
    if (attempt != null) {
      params.push(attempt);
      where.push(`attempt = $${params.length}`);
    }
    const r = await this.db.query(`SELECT * FROM session_turns WHERE ${where.join(' AND ')} ORDER BY created_at ASC, turn_id ASC`, params);
    return r.rows.map(rowToTurn);
  }

  async upsertCheckpoint(cp: Parameters<SessionStore['upsertCheckpoint']>[0]): Promise<void> {
    await this.db.query(
      `INSERT INTO step_checkpoints (session_id, step_id, attempt, status, exit_name, output, ambient, cost_usd, tokens_in, tokens_out, visit, kind, child_session_id, error, ended_at, tokens_cache_read, tokens_cache_write)
       VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8::numeric,0),coalesce($9::bigint,0),coalesce($10::bigint,0),coalesce($11::integer,1),$12,$13,$14, CASE WHEN $15::boolean THEN now() ELSE NULL END, coalesce($16::bigint,0), coalesce($17::bigint,0))
       ON CONFLICT (session_id, step_id, attempt) DO UPDATE SET
         status = EXCLUDED.status,
         exit_name = coalesce(EXCLUDED.exit_name, step_checkpoints.exit_name),
         output = coalesce(EXCLUDED.output, step_checkpoints.output),
         ambient = EXCLUDED.ambient,
         cost_usd = coalesce($8::numeric, step_checkpoints.cost_usd),
         tokens_in = coalesce($9::bigint, step_checkpoints.tokens_in),
         tokens_out = coalesce($10::bigint, step_checkpoints.tokens_out),
         tokens_cache_read = coalesce($16::bigint, step_checkpoints.tokens_cache_read),
         tokens_cache_write = coalesce($17::bigint, step_checkpoints.tokens_cache_write),
         visit = coalesce($11::integer, step_checkpoints.visit),
         kind = coalesce(EXCLUDED.kind, step_checkpoints.kind),
         child_session_id = coalesce(EXCLUDED.child_session_id, step_checkpoints.child_session_id),
         error = CASE WHEN EXCLUDED.status = 'failed' THEN coalesce(EXCLUDED.error, step_checkpoints.error) ELSE EXCLUDED.error END,
         ended_at = CASE WHEN $15::boolean THEN now() ELSE step_checkpoints.ended_at END`,
      [
        cp.session_id,
        cp.step_id,
        cp.attempt,
        cp.status,
        cp.exit_name ?? null,
        cp.output === undefined ? null : JSON.stringify(cp.output),
        JSON.stringify(cp.ambient ?? {}),
        cp.cost_usd ?? null,
        cp.tokens_in ?? null,
        cp.tokens_out ?? null,
        cp.visit ?? null,
        cp.kind ?? null,
        cp.child_session_id ?? null,
        cp.error ?? null,
        !!cp.ended,
        cp.tokens_cache_read ?? null,
        cp.tokens_cache_write ?? null,
      ],
    );
  }

  /** Checkpoint rows in execution order. */
  async checkpoints(id: string): Promise<Array<Record<string, any>>> {
    const r = await this.db.query(`SELECT * FROM step_checkpoints WHERE session_id = $1 ORDER BY created_at ASC, step_id ASC, attempt ASC`, [id]);
    return r.rows.map((row: any) => ({
      ...row,
      session_id: trimChar(row.session_id),
      child_session_id: trimChar(row.child_session_id),
      cost_usd: Number(row.cost_usd ?? 0),
      tokens_in: Number(row.tokens_in ?? 0),
      tokens_out: Number(row.tokens_out ?? 0),
      tokens_cache_read: Number(row.tokens_cache_read ?? 0),
      tokens_cache_write: Number(row.tokens_cache_write ?? 0),
      created_at: toIso(row.created_at),
      ended_at: row.ended_at ? toIso(row.ended_at) : null,
    }));
  }

  async cost(id: string): Promise<SessionCost> {
    const r = await this.db.query(
      `SELECT coalesce(sum(cost_usd),0) AS c, coalesce(sum(tokens_in),0) AS i, coalesce(sum(tokens_out),0) AS o,
              coalesce(sum(tokens_cache_read),0) AS cr, coalesce(sum(tokens_cache_write),0) AS cw
       FROM session_turns WHERE session_id = $1`,
      [id],
    );
    const row = r.rows[0] ?? {};
    return { cost_usd: Number(row.c ?? 0), tokens_in: Number(row.i ?? 0), tokens_out: Number(row.o ?? 0), tokens_cache_read: Number(row.cr ?? 0), tokens_cache_write: Number(row.cw ?? 0) };
  }

  /** Walks the session tree at query time — never stored ([02] §6). */
  async costIncludingChildren(id: string): Promise<number> {
    return (await this.treeCost(id)).cost_usd;
  }

  /** `costIncludingChildren` for many sessions in one tree walk (list pages). */
  async costsIncludingChildren(ids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>(ids.map((id) => [id, 0]));
    if (!ids.length) return out;
    const r = await this.db.query(
      `WITH RECURSIVE tree AS (
         SELECT session_id AS root, session_id FROM sessions WHERE session_id = ANY($1::text[])
         UNION SELECT t.root, s.session_id FROM sessions s JOIN tree t ON s.parent_session = t.session_id
       )
       SELECT t.root, coalesce(sum(st.cost_usd),0) AS c
       FROM tree t LEFT JOIN session_turns st ON st.session_id = t.session_id GROUP BY t.root`,
      [ids],
    );
    for (const row of r.rows) out.set(String(row.root).trim(), Number(row.c ?? 0));
    return out;
  }

  /** Cost + tokens over a session and all its descendants (query-time tree walk). */
  async treeCost(id: string): Promise<{ cost_usd: number; tokens: number }> {
    const r = await this.db.query(
      `WITH RECURSIVE tree AS (
         SELECT session_id FROM sessions WHERE session_id = $1
         UNION SELECT s.session_id FROM sessions s JOIN tree t ON s.parent_session = t.session_id
       )
       SELECT coalesce(sum(cost_usd),0) AS c,
              coalesce(sum(coalesce(tokens_in,0) + coalesce(tokens_out,0) + coalesce(tokens_cache_read,0) + coalesce(tokens_cache_write,0)),0) AS t
       FROM session_turns WHERE session_id IN (SELECT session_id FROM tree)`,
      [id],
    );
    return { cost_usd: Number(r.rows[0]?.c ?? 0), tokens: Number(r.rows[0]?.t ?? 0) };
  }

  async children(id: string): Promise<SessionRow[]> {
    const r = await this.db.query(`SELECT ${SESSION_COLS} FROM sessions WHERE parent_session = $1 AND team_id = $2 ORDER BY created_at ASC, session_id ASC`, [id, this.teamId]);
    return r.rows.map(rowToSession);
  }

  async spendSince(iso: string): Promise<number> {
    const r = await this.db.query(
      `SELECT coalesce(sum(t.cost_usd),0) AS c FROM session_turns t JOIN sessions s ON s.session_id = t.session_id
       WHERE s.team_id = $1 AND t.created_at >= $2::timestamptz AND t.cost_usd IS NOT NULL`,
      [this.teamId, iso],
    );
    return Number(r.rows[0]?.c ?? 0);
  }

  async countByState(state: string, kinds?: SessionKind[]): Promise<number> {
    const r = kinds?.length
      ? await this.db.query(`SELECT count(*)::int AS c FROM sessions WHERE team_id = $1 AND state = $2 AND kind = ANY($3::text[])`, [this.teamId, state, kinds])
      : await this.db.query(`SELECT count(*)::int AS c FROM sessions WHERE team_id = $1 AND state = $2`, [this.teamId, state]);
    return Number(r.rows[0]?.c ?? 0);
  }

  async summary(id: string): Promise<SessionSummaryDto> {
    const s = await this.mustGet(id);
    const [cps, kids, cost, total] = await Promise.all([this.checkpoints(id), this.children(id), this.cost(id), this.costIncludingChildren(id)]);
    const steps: StepSummaryDto[] = cps.map((c) => ({
      step_id: c.step_id,
      attempt: Number(c.attempt),
      status: c.status,
      exit_name: c.exit_name ?? null,
      kind: c.kind ?? undefined,
      cost_usd: c.cost_usd,
      tokens_in: c.tokens_in,
      tokens_out: c.tokens_out,
      tokens_cache_read: c.tokens_cache_read,
      tokens_cache_write: c.tokens_cache_write,
      started_at: c.created_at ?? null,
      ended_at: c.ended_at ?? null,
      child_session_id: c.child_session_id ?? null,
      error: c.error ?? null,
    }));
    return {
      ...s,
      cost_usd: cost.cost_usd,
      tokens_in: cost.tokens_in,
      tokens_out: cost.tokens_out,
      tokens_cache_read: cost.tokens_cache_read,
      tokens_cache_write: cost.tokens_cache_write,
      cost_usd_including_children: total,
      children: kids.map((k) => ({ session_id: k.session_id, kind: k.kind, circuit_uid: k.circuit_uid, state: k.state, parent_step_id: k.parent_step_id })),
      steps,
    };
  }

  async nextQueued(limit: number): Promise<SessionRow[]> {
    const lim = clampLimit(limit, 50, 1000);
    const r = await this.db.query(`SELECT ${SESSION_COLS} FROM sessions WHERE team_id = $1 AND state = 'queued' ORDER BY ${PRIORITY_ORDER} ASC, created_at ASC, session_id ASC LIMIT ${lim}`, [this.teamId]);
    return r.rows.map(rowToSession);
  }

  async running(): Promise<SessionRow[]> {
    const r = await this.db.query(`SELECT ${SESSION_COLS} FROM sessions WHERE team_id = $1 AND state = 'running' ORDER BY created_at ASC`, [this.teamId]);
    return r.rows.map(rowToSession);
  }

  /** The session itself plus all ancestors and descendants. */
  async family(id: string): Promise<string[]> {
    const r = await this.db.query(
      `WITH RECURSIVE up AS (
         SELECT session_id, parent_session FROM sessions WHERE session_id = $1
         UNION SELECT s.session_id, s.parent_session FROM sessions s JOIN up u ON s.session_id = u.parent_session
       ), down AS (
         SELECT session_id FROM sessions WHERE session_id = $1
         UNION SELECT s.session_id FROM sessions s JOIN down d ON s.parent_session = d.session_id
       )
       SELECT session_id FROM up UNION SELECT session_id FROM down`,
      [id],
    );
    const ids = r.rows.map((row: any) => trimChar(row.session_id)!);
    if (ids.length === 0) return [];
    return [id, ...ids.filter((x) => x !== id)];
  }
}

export function createSessionStore(deps: { db: Db; team_id: string }): PgSessionStore {
  if (!deps.team_id) throw validationFailed('team_id required');
  return new PgSessionStore(deps.db, deps.team_id);
}
