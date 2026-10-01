/**
 * Evals service ([04]): eval runs as `eval-run` Sessions, programmatic + judge scoring, the results store,
 * the analysis views, and fixture promotion from production Sessions.
 */
import { parseDocument, stringify as toYaml } from 'yaml';
import {
  BreadboardError,
  grantDenied,
  invalidState,
  isUid,
  mintEvalRunId,
  mintUid,
  notFound,
  uniqueLinkTargets,
  validateAgainst,
  validationFailed,
  SCHEMA_TAGS,
  type Circuit,
  type Fixture,
  type Rubric,
  type RubricDimension,
  type SessionEvent,
  type SessionRecord,
} from '@breadboard/shared';
import type { Db } from '../db/index.js';
import type { Logger } from '../core/logger.js';
import { servicePrincipal, type Principal } from '../core/principal.js';
import type { ChatMessage, ConfigService, ContentService, EvalService, EventBus, Orchestrator, SessionStore, SubagentRuntime, ToolSpec, Toolbox } from '../core/services.js';
import { buildAggregate, mean, overridesKey, round, validateDimValue, type AggregateValue, type DimValue, type ProgrammaticValue } from './scoring.js';
import { buildAnalysis, buildDashboard, loadRunStats, type AnalysisOptions, type AnalysisView } from './analysis.js';

export const JUDGE_STEP_ID = 'eval-judge';
export const RECORD_SCORES_TOOL = 'breadboard_record_scores';
const DEFAULT_CONCURRENCY = 3;
const ARTIFACT_BODY_CAP = 8_000;
const ARTIFACTS_TOTAL_CAP = 40_000;
const JSON_CAP = 20_000;

export const rubricPath = (circuitUid: string) => `circuits/${circuitUid}/rubric.yaml`;
export const fixturesPath = (circuitUid: string) => `circuits/${circuitUid}/fixtures.yaml`;

export interface EvalServiceDeps {
  db: Db;
  team_id: string;
  config: ConfigService;
  orchestrator: Orchestrator;
  sessions: SessionStore;
  subagents: SubagentRuntime;
  toolbox: Toolbox;
  content: ContentService;
  events: EventBus;
  log: Logger;
  /** Fixtures awaited/scored concurrently (default 3). */
  concurrency?: number;
  /** Per-session wait timeout passed to `orchestrator.waitFor`. */
  wait_timeout_ms?: number;
  /** How often a fixture session parked at a hard gate is re-checked (default 5 s). */
  gate_poll_ms?: number;
}

const GATE_POLL_MS = 5_000;

export interface EvalRunRow {
  eval_run_id: string;
  team_id: string;
  circuit_uid: string;
  circuit_commit: string;
  rubric_commit: string;
  model_overrides: Record<string, string> | null;
  judge_model_id: string;
  fixture_tags: string[] | null;
  proposal_id: string | null;
  status: 'running' | 'completed' | 'failed';
  summary: Record<string, any>;
  created_by: unknown;
  created_at: string;
  ended_at: string | null;
}

interface RunCtx {
  run_id: string;
  circuit_uid: string;
  circuit: Circuit;
  commit: string;
  rubric: Rubric;
  fixtures: Fixture[];
  model_overrides: Record<string, string> | null;
  by: Principal;
}

/** Outcome of a scored session: the `session-completed` payload, or a failure record. */
export type SessionOutcome =
  | { completed: true; exit: string | null; output: unknown }
  | { completed: false; state: string; reason: string };

interface ScoredDim {
  dim: RubricDimension;
  value: DimValue;
  rationale: string | null;
  cost_usd: number;
}

interface InlinedArtifact {
  uid: string;
  revision_id: number | null;
  title: string | null;
  body: string | null;
  missing: boolean;
}

export class EvalServiceImpl implements EvalService {
  private readonly svc: Principal;
  private readonly inflight = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(private readonly d: EvalServiceDeps) {
    this.svc = servicePrincipal(d.team_id, 'evals');
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------
  async startRun(input: Parameters<EvalService['startRun']>[0]): Promise<Record<string, unknown>> {
    const { by } = input;
    if (by.grants && !by.grants.circuits.execute.has(input.circuit)) throw grantDenied(`subagent may not execute circuit ${input.circuit}`);
    let ref = input.ref ?? null;
    if (!ref && input.proposal_id) ref = (await this.d.config.getProposal(input.proposal_id)).head_commit;

    const loaded = await this.d.config.circuit(input.circuit, ref ?? undefined);
    const commit = loaded.commit;
    const rubric = loaded.rubric ?? (await this.d.config.rubric(input.circuit, commit));
    if (!rubric) throw validationFailed(`circuit ${input.circuit} has no rubric.yaml at ${commit.slice(0, 12)}`);
    const manifest = loaded.fixtures ?? (await this.d.config.fixtures(input.circuit, commit));
    const tags = (input.fixture_tags ?? []).filter(Boolean);
    const fixtures = (manifest?.fixtures ?? []).filter((f) => !f.retired && (tags.length === 0 || (f.tags ?? []).some((t) => tags.includes(t))));
    if (fixtures.length === 0) throw validationFailed(`circuit ${input.circuit} has no active fixtures${tags.length ? ` tagged ${tags.join(', ')}` : ''} at ${commit.slice(0, 12)}`);

    const rubricCommit = await this.lastTouching(rubricPath(input.circuit), commit);
    const model_overrides = input.model_overrides && Object.keys(input.model_overrides).length ? input.model_overrides : null;
    const id = mintEvalRunId();
    await this.d.db.query(
      `INSERT INTO eval_runs (eval_run_id, team_id, circuit_uid, circuit_commit, rubric_commit, model_overrides, judge_model_id, fixture_tags, proposal_id, status, summary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',$10,$11)`,
      [
        id,
        this.d.team_id,
        input.circuit,
        commit,
        rubricCommit,
        model_overrides ? JSON.stringify(model_overrides) : null,
        rubric.judge.model_id,
        tags.length ? tags : null,
        input.proposal_id ?? null,
        JSON.stringify({ fixtures: fixtures.length, gate_min: rubric.aggregate?.gate?.min ?? null, variant: overridesKey(model_overrides) }),
        JSON.stringify(by.actor),
      ],
    );
    if (input.proposal_id) await this.d.config.attachEvalRun(input.proposal_id, id);

    const ctx: RunCtx = { run_id: id, circuit_uid: input.circuit, circuit: loaded.circuit, commit, rubric, fixtures, model_overrides, by };
    const job = this.track(id, this.execute(ctx));
    if (input.wait === false) {
      job.catch(() => undefined);
      return this.getRun(id);
    }
    await job;
    return this.getRun(id);
  }

  /** Await a background run (tests, graceful shutdown). */
  async settle(evalRunId: string): Promise<void> {
    await this.inflight.get(evalRunId)?.catch(() => undefined);
  }

  private track(id: string, job: Promise<void>): Promise<void> {
    const tracked = job.finally(() => this.inflight.delete(id));
    this.inflight.set(id, tracked);
    return tracked;
  }

  /**
   * Re-attach to runs still `running` after a restart. A fixture session can wait on a hard gate for days, so a
   * run outlives the process that started it; unscored fixtures resume waiting, scored ones are kept.
   */
  async recover(): Promise<number> {
    const rows = await this.d.db.query<EvalRunRow>(`SELECT * FROM eval_runs WHERE team_id=$1 AND status='running' ORDER BY created_at`, [this.d.team_id]);
    let n = 0;
    for (const row of rows.rows) {
      const id = String(row.eval_run_id).trim();
      if (this.inflight.has(id)) continue;
      const sessions = ((row.summary ?? {}).sessions ?? {}) as Record<string, string>;
      const resume = async () => {
        const loaded = await this.d.config.circuit(row.circuit_uid, row.circuit_commit);
        const rubric = loaded.rubric ?? (await this.d.config.rubric(row.circuit_uid, row.circuit_commit));
        const manifest = loaded.fixtures ?? (await this.d.config.fixtures(row.circuit_uid, row.circuit_commit));
        if (!rubric) throw new Error(`rubric missing at ${row.circuit_commit.slice(0, 12)}`);
        const done = new Set(
          (await this.d.db.query<{ fixture_id: string }>(`SELECT fixture_id FROM eval_results WHERE eval_run_id=$1 AND dimension='*'`, [id])).rows.map((r) => r.fixture_id),
        );
        const fixtures = (manifest?.fixtures ?? []).filter((f) => sessions[f.fixture_id]);
        const ctx: RunCtx = { run_id: id, circuit_uid: row.circuit_uid, circuit: loaded.circuit, commit: row.circuit_commit, rubric, fixtures, model_overrides: row.model_overrides, by: this.svc };
        const errors: Array<{ fixture_id: string; error: string }> = [];
        const queued = fixtures.filter((f) => !done.has(f.fixture_id)).map((fixture) => ({ fixture, session_id: sessions[fixture.fixture_id]! }));
        await this.scoreQueued(ctx, queued, errors);
        await this.finish(ctx, errors);
      };
      void this.track(
        id,
        resume().catch(async (e) => {
          this.d.log.error({ err: e, eval_run_id: id }, 'eval run recovery failed');
          await this.mergeSummary(id, { errors: [{ fixture_id: '*', error: `recovery failed: ${errMsg(e)}` }] }).catch(() => undefined);
          await this.d.db.query(`UPDATE eval_runs SET status='failed', ended_at=now() WHERE eval_run_id=$1`, [id]).catch(() => undefined);
        }),
      );
      n++;
    }
    return n;
  }

  /** Stop waiting on gated fixtures (shutdown); their runs stay `running` and resume via `recover()`. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Eval sessions gate like production: a hard gate waits for its human reviewers, so `suspended-gate` is not an
   * outcome. The fixture is scored once the session moves past it (or the wait times out).
   */
  private async awaitSettled(sessionId: string): Promise<SessionRecord> {
    const deadline = this.d.wait_timeout_ms ? Date.now() + this.d.wait_timeout_ms : Infinity;
    for (;;) {
      const left = Number.isFinite(deadline) ? Math.max(1, deadline - Date.now()) : undefined;
      const s = await this.d.orchestrator.waitFor(sessionId, left);
      if (s.state !== 'suspended-gate' || Date.now() >= deadline) return s;
      if (this.stopped) throw new Error('eval service stopped while the session waits on a gate');
      await new Promise((r) => setTimeout(r, this.d.gate_poll_ms ?? GATE_POLL_MS).unref?.());
    }
  }

  private async execute(ctx: RunCtx): Promise<void> {
    const errors: Array<{ fixture_id: string; error: string }> = [];
    try {
      const sessions: Record<string, string> = {};
      const queued: Array<{ fixture: Fixture; session_id: string }> = [];
      for (const fixture of ctx.fixtures) {
        try {
          const s = await this.d.orchestrator.enqueue({
            circuit_uid: ctx.circuit_uid,
            input: fixture.input,
            kind: 'eval-run',
            config_ref: ctx.commit,
            model_overrides: ctx.model_overrides,
            pinned_context: fixture.pinned_context ?? null,
            created_by: ctx.by.actor,
          });
          sessions[fixture.fixture_id] = s.session_id;
          queued.push({ fixture, session_id: s.session_id });
        } catch (e) {
          errors.push({ fixture_id: fixture.fixture_id, error: `enqueue failed: ${errMsg(e)}` });
        }
      }
      await this.mergeSummary(ctx.run_id, { sessions });
      await this.scoreQueued(ctx, queued, errors);
      await this.finish(ctx, errors);
    } catch (e) {
      this.d.log.error({ err: e, eval_run_id: ctx.run_id }, 'eval run failed');
      await this.mergeSummary(ctx.run_id, { errors: [...errors, { fixture_id: '*', error: errMsg(e) }] }).catch(() => undefined);
      await this.d.db.query(`UPDATE eval_runs SET status='failed', ended_at=now() WHERE eval_run_id=$1`, [ctx.run_id]).catch(() => undefined);
      await this.publishCompleted(ctx.run_id, ctx.circuit_uid, 'failed', {}).catch(() => undefined);
      throw e;
    }
  }

  private async scoreQueued(ctx: RunCtx, queued: Array<{ fixture: Fixture; session_id: string }>, errors: Array<{ fixture_id: string; error: string }>): Promise<void> {
    await pool(queued, this.d.concurrency ?? DEFAULT_CONCURRENCY, async ({ fixture, session_id }) => {
      try {
        let session: SessionRecord;
        try {
          session = await this.awaitSettled(session_id);
        } catch (e) {
          if (this.stopped) throw e; // left unscored; recover() resumes it
          session = (await this.d.sessions.get(session_id)) ?? ({ session_id, state: 'running', state_detail: {} } as unknown as SessionRecord);
          (session as any).__wait_error = errMsg(e);
        }
        await this.scoreFixture(ctx, fixture, session);
      } catch (e) {
        if (this.stopped) return;
        this.d.log.warn({ err: e, eval_run_id: ctx.run_id, fixture_id: fixture.fixture_id }, 'eval fixture scoring failed');
        errors.push({ fixture_id: fixture.fixture_id, error: errMsg(e) });
      }
    });
  }

  private async finish(ctx: RunCtx, errors: Array<{ fixture_id: string; error: string }>): Promise<void> {
    if (this.stopped) return; // still running: recover() picks it up on the next start
    const summary = await this.recomputeSummary(ctx.run_id, ctx.rubric, { errors });
    const status = summary.scored > 0 ? 'completed' : 'failed';
    await this.d.db.query(`UPDATE eval_runs SET status=$2, ended_at=now() WHERE eval_run_id=$1`, [ctx.run_id, status]);
    await this.publishCompleted(ctx.run_id, ctx.circuit_uid, status, summary);
  }

  private async publishCompleted(id: string, circuit: string, status: string, summary: Record<string, any>): Promise<void> {
    await this.d.events.publish('eval.run-completed', { eval_run_id: id, circuit_uid: circuit, status, mean_aggregate: summary.mean_aggregate ?? null, pass_rate: summary.pass_rate ?? null });
  }

  // -------------------------------------------------------------------------
  // Scoring
  // -------------------------------------------------------------------------
  private async scoreFixture(ctx: RunCtx, fixture: Fixture, session: SessionRecord): Promise<void> {
    const outcome = await this.outcomeOf(session);
    // Session cost first: judge turns are recorded onto the scored session under `eval-judge` afterwards.
    const sessionCost = await this.d.sessions.costIncludingChildren(session.session_id).catch(async () => (await this.d.sessions.cost(session.session_id)).cost_usd);

    const scored: ScoredDim[] = [];
    const judgeDims = ctx.rubric.dimensions.filter((d) => d.type !== 'programmatic');
    for (const dim of ctx.rubric.dimensions) {
      if (dim.type !== 'programmatic') continue;
      const r = await this.scoreProgrammatic(ctx, dim, fixture, session.session_id, outcome);
      scored.push({ dim, value: r, rationale: typeof r.detail === 'string' ? r.detail : null, cost_usd: 0 });
    }
    if (judgeDims.length) {
      if (!outcome.completed) {
        for (const dim of judgeDims) scored.push({ dim, value: null, rationale: `skipped: scored session did not complete (${outcome.state}: ${outcome.reason})`, cost_usd: 0 });
      } else {
        scored.push(...(await this.runJudge(ctx, judgeDims, fixture, session.session_id, outcome)));
      }
    }

    for (const s of scored) await this.upsertResult(ctx.run_id, fixture.fixture_id, session.session_id, s.dim.key, s.dim.type, s.value, s.rationale, s.cost_usd);
    const values = Object.fromEntries(scored.map((s) => [s.dim.key, s.value]));
    const agg = buildAggregate(ctx.rubric, values, { session_cost_usd: sessionCost, failed: !outcome.completed, failure: outcome.completed ? undefined : `${outcome.state}: ${outcome.reason}` });
    const gates = await this.gateVerdicts(session.session_id);
    await this.upsertResult(ctx.run_id, fixture.fixture_id, session.session_id, '*', 'aggregate', gates.length ? { ...agg, gates } : agg, null, sessionCost);
  }

  /** The human reviews the scored session passed through, in order (each gate visit with its verdicts). */
  private async gateVerdicts(sessionId: string): Promise<NonNullable<AggregateValue['gates']>> {
    return (await this.allEvents(sessionId))
      .filter((e) => e.event_type === 'gate-resolved')
      .map((e) => {
        const p = e.payload as { step_id: string; exit: string; verdicts?: Array<Record<string, any>> };
        return { step_id: p.step_id, exit: p.exit, verdicts: (p.verdicts ?? []).map((v) => ({ verdict: v.verdict, comment: v.comment ?? null, by: v.by, at: v.at })) };
      });
  }

  /** The circuit output = the `session-completed` payload `{exit, output}`, or a failure record. */
  async outcomeOf(session: SessionRecord): Promise<SessionOutcome> {
    const waitError = (session as any).__wait_error as string | undefined;
    if (session.state === 'completed') {
      const events = await this.allEvents(session.session_id);
      const done = [...events].reverse().find((e) => e.event_type === 'session-completed');
      if (done) return { completed: true, exit: (done.payload.exit as string | undefined) ?? null, output: done.payload.output ?? null };
      return { completed: false, state: 'completed', reason: 'no session-completed event recorded' };
    }
    const detail = session.state_detail ?? {};
    const reason = waitError ?? String(detail.reason ?? detail.error ?? detail.message ?? session.state);
    return { completed: false, state: session.state, reason };
  }

  private async scoreProgrammatic(ctx: RunCtx, dim: Extract<RubricDimension, { type: 'programmatic' }>, fixture: Fixture, sessionId: string, outcome: SessionOutcome): Promise<ProgrammaticValue> {
    const fail = (detail: unknown): ProgrammaticValue => ({ pass: false, score: 0, detail });
    const ok = (pass: boolean, detail?: unknown): ProgrammaticValue => ({ pass, score: pass ? 1 : 0, ...(detail !== undefined ? { detail } : {}) });
    if (!outcome.completed) return fail(`session did not complete (${outcome.state}: ${outcome.reason})`);
    const settings = dim.settings ?? {};
    try {
      switch (dim.tool) {
        case 'assert-output-schema': {
          const exitDef = ctx.circuit.exits.find((x) => x.name === outcome.exit);
          if (!exitDef) return fail(`exit '${outcome.exit}' is not a declared circuit exit`);
          if (!exitDef.output) return ok(true, `exit '${exitDef.name}' declares no output schema`);
          const r = validateAgainst(exitDef.output, outcome.output);
          return ok(r.ok, r.ok ? undefined : { errors: r.errors });
        }
        case 'assert-exit': {
          const allowed: string[] = Array.isArray(settings.allowed) ? settings.allowed.map(String) : typeof settings.expected === 'string' ? [settings.expected] : [];
          if (allowed.length === 0) return ok(outcome.exit !== null, { exit: outcome.exit });
          return ok(outcome.exit !== null && allowed.includes(outcome.exit), { exit: outcome.exit, allowed });
        }
        case 'assert-citations-exist': {
          const artifacts = await this.inlineArtifacts(outcome.output);
          const texts = [safeJson(outcome.output), ...artifacts.map((a) => a.body ?? '')];
          const targets = new Set(texts.flatMap((t) => uniqueLinkTargets(t)));
          const missing = artifacts.filter((a) => a.missing).map((a) => a.uid);
          for (const uid of targets) {
            if (missing.includes(uid)) continue;
            if (!(await this.nodeExists(uid))) missing.push(uid);
          }
          return ok(missing.length === 0, { checked: targets.size, missing });
        }
        default: {
          if (!isUid(dim.tool)) return fail(`unknown assertion '${dim.tool}' (expected a built-in or a tool extension UID)`);
          const res = await this.d.toolbox.invoke({
            tool_uid: dim.tool,
            commit: ctx.commit,
            // The assertion-tool contract (seed tools/assert-*): the exit taken and the terminal output, side by side.
            input: { fixture, exit: outcome.exit, output: outcome.output, session_id: sessionId, circuit_uid: ctx.circuit_uid },
            settings,
            principal: this.svc,
            ambient: { invocation: 'eval', session_id: sessionId, step_id: `eval:${dim.key}`, attempt: 1, settings },
            session_id: sessionId,
            step_id: `eval:${dim.key}`,
            attempt: 1,
            call_index: 0,
          });
          const out = res.output as any;
          if (!out || typeof out.pass !== 'boolean') return fail({ error: 'assertion tool must return {pass: boolean, detail?}', output: out });
          return ok(out.pass, out.detail);
        }
      }
    } catch (e) {
      return fail({ error: errMsg(e) });
    }
  }

  private async runJudge(ctx: RunCtx, dims: RubricDimension[], fixture: Fixture, sessionId: string, outcome: Extract<SessionOutcome, { completed: true }>): Promise<ScoredDim[]> {
    const skipAll = (why: string): ScoredDim[] => dims.map((dim) => ({ dim, value: null, rationale: why, cost_usd: 0 }));
    let result;
    try {
      const judge = await this.d.subagents.resolve(ctx.rubric.judge.subagent, ctx.commit, { session_id: sessionId });
      const artifacts = await this.inlineArtifacts(outcome.output);
      const prompt = judgePrompt(ctx.circuit, fixture, outcome, artifacts, dims);
      const tool = recordScoresTool(dims);
      const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
      result = await this.d.subagents.runConversation({
        subagent: judge,
        principal: this.d.subagents.principalFor(judge, sessionId, JUDGE_STEP_ID, [sessionId]),
        messages,
        extra_tools: [tool],
        force_tool: RECORD_SCORES_TOOL,
        terminal_tools: [RECORD_SCORES_TOOL],
        max_turns: 8,
        // Judge pinned to the rubric's explicit model id, never a tier ([04] §10.1).
        model_overrides: { [judge.model_preset]: ctx.rubric.judge.model_id },
        session_id: sessionId,
        step_id: JUDGE_STEP_ID,
        attempt: 1,
        hooks: {
          onTurn: async (t) => {
            await this.d.sessions.recordTurn({
              session_id: sessionId,
              step_id: JUDGE_STEP_ID,
              attempt: 1,
              role: t.role,
              username: null,
              content: t.content,
              model_id: t.model_id ?? null,
              tokens_in: t.usage?.input_tokens ?? null,
              tokens_out: t.usage?.output_tokens ?? null,
              cost_usd: t.cost_usd ?? null,
              latency_ms: t.latency_ms ?? null,
              fallback_from: t.fallback_from ?? null,
            });
          },
        },
      });
    } catch (e) {
      return skipAll(`judge failed: ${errMsg(e)}`);
    }
    const share = dims.length ? round(result.cost_usd / dims.length) : 0;
    const call = result.terminal_call;
    if (!call || call.name !== RECORD_SCORES_TOOL) return dims.map((dim) => ({ dim, value: null, rationale: `judge did not call ${RECORD_SCORES_TOOL}`, cost_usd: share }));
    const scores: any[] = Array.isArray((call.input as any)?.scores) ? (call.input as any).scores : [];
    return dims.map((dim) => {
      const entry = scores.find((s) => s && s.dimension === dim.key);
      if (!entry) return { dim, value: null, rationale: 'judge did not score this dimension', cost_usd: share };
      try {
        return { dim, value: validateDimValue(dim, entry.value), rationale: typeof entry.rationale === 'string' ? entry.rationale : null, cost_usd: share };
      } catch (e) {
        return { dim, value: null, rationale: `invalid judge value ${JSON.stringify(entry.value)}: ${errMsg(e)}`, cost_usd: share };
      }
    });
  }

  /** Artifact refs (`{uid, revision_id?}`) found anywhere in the output, with bodies inlined (capped). */
  private async inlineArtifacts(output: unknown): Promise<InlinedArtifact[]> {
    const refs = collectRefs(output);
    const out: InlinedArtifact[] = [];
    let total = 0;
    for (const ref of refs) {
      try {
        const node = await this.d.content.getNode(ref.uid, this.svc);
        let body: string | null = node.body_text ?? (node.body != null ? safeJson(node.body) : null);
        if (ref.revision_id !== null) {
          try {
            const rev = await this.d.content.revision(ref.uid, ref.revision_id, this.svc);
            body = rev.body_text ?? (rev.body != null ? safeJson(rev.body) : body);
          } catch {
            /* fall back to head */
          }
        }
        if (body !== null) {
          const room = Math.max(0, ARTIFACTS_TOTAL_CAP - total);
          body = cap(body, Math.min(ARTIFACT_BODY_CAP, room));
          total += body.length;
        }
        out.push({ uid: ref.uid, revision_id: ref.revision_id, title: node.title, body, missing: false });
      } catch (e) {
        if (e instanceof BreadboardError && e.code !== 'not-found' && e.code !== 'note-not-found') throw e;
        out.push({ uid: ref.uid, revision_id: ref.revision_id, title: null, body: null, missing: true });
      }
    }
    return out;
  }

  private async nodeExists(uid: string): Promise<boolean> {
    try {
      await this.d.content.getNode(uid, this.svc);
      return true;
    } catch (e) {
      if (e instanceof BreadboardError && (e.code === 'not-found' || e.code === 'note-not-found')) return false;
      throw e;
    }
  }

  private async upsertResult(runId: string, fixtureId: string, sessionId: string, dimension: string, dimType: string, value: DimValue | AggregateValue, rationale: string | null, cost: number): Promise<void> {
    await this.d.db.query(
      `INSERT INTO eval_results (eval_run_id, fixture_id, scored_session, dimension, dim_type, value, rationale, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (eval_run_id, fixture_id, dimension) DO UPDATE SET value=EXCLUDED.value, rationale=EXCLUDED.rationale, cost_usd=EXCLUDED.cost_usd, dim_type=EXCLUDED.dim_type, created_at=now()`,
      [runId, fixtureId, sessionId, dimension, dimType, JSON.stringify(value ?? null), rationale, cost],
    );
  }

  private async mergeSummary(runId: string, patch: Record<string, unknown>): Promise<void> {
    await this.d.db.query(`UPDATE eval_runs SET summary = summary || $2::jsonb WHERE eval_run_id=$1`, [runId, JSON.stringify(patch)]);
  }

  /** Recompute `eval_runs.summary` from the results store (in-run and after `record_score`). */
  private async recomputeSummary(runId: string, rubric: Rubric, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const rows = (await this.d.db.query(`SELECT fixture_id, dimension, value, cost_usd FROM eval_results WHERE eval_run_id=$1`, [runId])).rows;
    const aggs = rows.filter((r) => r.dimension === '*').map((r) => r.value as AggregateValue);
    const gate = rubric.aggregate?.gate;
    const per_dimension_means: Record<string, number | null> = {};
    for (const dim of rubric.dimensions) per_dimension_means[dim.key] = mean(aggs.map((a) => a.per_dimension?.[dim.key]));
    const summary = {
      scored: aggs.length,
      mean_aggregate: mean(aggs.map((a) => a.score)),
      pass_rate: gate && aggs.length ? round(aggs.filter((a) => a.pass === true).length / aggs.length) : null,
      total_cost_usd: round(rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0)),
      per_dimension_means,
      gate_min: gate?.min ?? null,
      ...extra,
    };
    await this.mergeSummary(runId, summary);
    return summary;
  }

  // -------------------------------------------------------------------------
  // Judge MCP path ([04] §5)
  // -------------------------------------------------------------------------
  async recordScore(input: Parameters<EvalService['recordScore']>[0]): Promise<void> {
    const run = await this.mustGetRunRow(input.eval_run_id);
    const rubric = await this.d.config.rubric(run.circuit_uid, run.circuit_commit);
    if (!rubric) throw validationFailed(`circuit ${run.circuit_uid} has no rubric at ${run.circuit_commit.slice(0, 12)}`);
    if (input.by.actor.kind === 'subagent' && input.by.actor.id !== rubric.judge.subagent) throw grantDenied('only the rubric judge subagent may record scores');
    if (input.dimension === '*') throw validationFailed("the aggregate row '*' is computed, not recorded");
    const dim = rubric.dimensions.find((d) => d.key === input.dimension);
    if (!dim) throw validationFailed(`rubric has no dimension '${input.dimension}'`, { dimensions: rubric.dimensions.map((d) => d.key) });
    const value = validateDimValue(dim, input.value);
    const sessionId = await this.sessionForFixture(run, input.fixture_id);
    await this.upsertResult(run.eval_run_id, input.fixture_id, sessionId, dim.key, dim.type, value, input.rationale ?? null, 0);

    // Refresh the fixture's aggregate row and the run summary.
    const rows = (await this.d.db.query(`SELECT dimension, value, cost_usd FROM eval_results WHERE eval_run_id=$1 AND fixture_id=$2`, [run.eval_run_id, input.fixture_id])).rows;
    const prev = rows.find((r) => r.dimension === '*')?.value as AggregateValue | undefined;
    const values: Record<string, DimValue> = {};
    for (const r of rows) if (r.dimension !== '*') values[r.dimension] = r.value as DimValue;
    let sessionCost = prev?.session_cost_usd;
    if (sessionCost === undefined) sessionCost = await this.d.sessions.costIncludingChildren(sessionId).catch(() => 0);
    const agg = buildAggregate(rubric, values, { session_cost_usd: sessionCost, failed: prev?.failed, failure: prev?.failure });
    await this.upsertResult(run.eval_run_id, input.fixture_id, sessionId, '*', 'aggregate', prev?.gates ? { ...agg, gates: prev.gates } : agg, null, sessionCost);
    await this.recomputeSummary(run.eval_run_id, rubric);
  }

  async getFixtureOutput(evalRunId: string, fixtureId: string): Promise<unknown> {
    const run = await this.mustGetRunRow(evalRunId);
    const sessionId = await this.sessionForFixture(run, fixtureId);
    const session = await this.d.sessions.get(sessionId);
    if (!session) throw notFound('session', sessionId);
    const outcome = await this.outcomeOf(session);
    const manifest = await this.d.config.fixtures(run.circuit_uid, run.circuit_commit).catch(() => null);
    const fixture = manifest?.fixtures.find((f) => f.fixture_id === fixtureId) ?? null;
    const artifacts = outcome.completed ? await this.inlineArtifacts(outcome.output) : [];
    return { eval_run_id: evalRunId, fixture_id: fixtureId, session_id: sessionId, state: session.state, input: fixture?.input ?? null, ...outcome, artifacts };
  }

  private async sessionForFixture(run: EvalRunRow, fixtureId: string): Promise<string> {
    const fromSummary = run.summary?.sessions?.[fixtureId];
    if (typeof fromSummary === 'string') return fromSummary;
    const r = await this.d.db.query(`SELECT scored_session FROM eval_results WHERE eval_run_id=$1 AND fixture_id=$2 LIMIT 1`, [run.eval_run_id, fixtureId]);
    if (!r.rows[0]) throw notFound('fixture in eval run', fixtureId);
    return String(r.rows[0].scored_session).trim();
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------
  private async getRunRow(id: string): Promise<EvalRunRow | null> {
    const r = await this.d.db.query(`SELECT * FROM eval_runs WHERE eval_run_id=$1 AND team_id=$2`, [id, this.d.team_id]);
    return r.rows[0] ? runRow(r.rows[0]) : null;
  }

  private async mustGetRunRow(id: string): Promise<EvalRunRow> {
    const run = await this.getRunRow(id);
    if (!run) throw notFound('eval run', id);
    return run;
  }

  async getRun(id: string): Promise<Record<string, unknown>> {
    const run = await this.mustGetRunRow(id);
    const rows = (await this.d.db.query(`SELECT * FROM eval_results WHERE eval_run_id=$1 ORDER BY fixture_id, dimension`, [id])).rows;
    const byFixture = new Map<string, { fixture_id: string; scored_session: string; aggregate: AggregateValue | null; cost_usd: number; dimensions: Array<Record<string, unknown>> }>();
    for (const r of rows) {
      const fid = r.fixture_id as string;
      let g = byFixture.get(fid);
      if (!g) {
        g = { fixture_id: fid, scored_session: String(r.scored_session).trim(), aggregate: null, cost_usd: 0, dimensions: [] };
        byFixture.set(fid, g);
      }
      g.cost_usd = round(g.cost_usd + Number(r.cost_usd ?? 0));
      if (r.dimension === '*') g.aggregate = r.value as AggregateValue;
      else g.dimensions.push({ dimension: r.dimension, type: r.dim_type, value: r.value, rationale: r.rationale, cost_usd: Number(r.cost_usd ?? 0) });
    }
    return { ...run, variant: overridesKey(run.model_overrides), results: [...byFixture.values()] };
  }

  async listRuns(opts: { circuit?: string; limit?: number; status?: string } = {}): Promise<Array<Record<string, unknown>>> {
    const params: unknown[] = [this.d.team_id];
    let where = 'team_id=$1';
    if (opts.circuit) {
      params.push(opts.circuit);
      where += ` AND circuit_uid=$${params.length}`;
    }
    if (opts.status) {
      params.push(opts.status);
      where += ` AND status=$${params.length}`;
    }
    params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
    const r = await this.d.db.query(`SELECT * FROM eval_runs WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return r.rows.map((row) => {
      const run = runRow(row);
      return { ...run, variant: overridesKey(run.model_overrides) };
    });
  }

  // -------------------------------------------------------------------------
  // Analysis ([04] §6, §8)
  // -------------------------------------------------------------------------
  /** `opts` (base/head/circuit_commit/variant) is an optional extension over the `EvalService` interface. */
  async analysis(circuitUid: string, view: AnalysisView, opts: AnalysisOptions = {}): Promise<Record<string, unknown>> {
    const runs = await loadRunStats(this.d.db, this.d.team_id, { circuit: circuitUid });
    return buildAnalysis(circuitUid, view, runs, opts);
  }

  async dashboard(): Promise<Record<string, unknown>> {
    const runs = await loadRunStats(this.d.db, this.d.team_id, {});
    const recent = await this.listRuns({ limit: 10 });
    const running = await this.d.db.query(`SELECT count(*)::int AS n FROM eval_runs WHERE team_id=$1 AND status='running'`, [this.d.team_id]);
    return { ...buildDashboard(runs), recent_runs: recent.map(recentRunView), running: Number(running.rows[0]?.n ?? 0) };
  }

  // -------------------------------------------------------------------------
  // Fixture promotion ([04] §3)
  // -------------------------------------------------------------------------
  async promoteFixture(input: Parameters<EvalService['promoteFixture']>[0]): Promise<{ fixture_id: string; commit: string }> {
    if (input.by.grants) throw grantDenied('fixture promotion requires human confirmation (user principal)');
    if (!input.fixture_title?.trim()) throw validationFailed('fixture_title is required');
    const session = await this.d.sessions.get(input.session_id);
    if (!session) throw notFound('session', input.session_id);
    if (session.kind !== 'circuit-run' && session.kind !== 'eval-run') throw invalidState(`only circuit-run/eval-run sessions can be promoted (got ${session.kind})`);
    if (!session.circuit_uid) throw invalidState('session has no circuit');
    const events = await this.allEvents(session.session_id);
    const started = events.find((e) => e.event_type === 'session-started');
    const sessionInput = (session as any).input ?? started?.payload?.input;
    if (sessionInput === undefined || sessionInput === null) throw invalidState('session has no recorded circuit input');

    const pinned = new Map<string, number>();
    for (const e of events) {
      if (e.event_type !== 'knowledge-injected' && e.event_type !== 'config-resolved') continue;
      for (const ref of collectRefs(e.payload, true)) if (ref.revision_id !== null) pinned.set(ref.uid, Math.max(pinned.get(ref.uid) ?? 0, ref.revision_id));
    }
    for (const ref of ((session as any).pinned_context ?? (started?.payload?.pinned_context as any[]) ?? []) as Array<{ uid: string; revision_id: number }>) {
      if (isUid(ref?.uid) && Number.isInteger(ref?.revision_id)) pinned.set(ref.uid, Math.max(pinned.get(ref.uid) ?? 0, ref.revision_id));
    }

    const fixture_id = `fx-${mintUid().slice(0, 8).toLowerCase()}`;
    const entry: Record<string, unknown> = {
      fixture_id,
      title: input.fixture_title.trim(),
      source_session_id: session.session_id,
      input: sessionInput,
      ...(pinned.size ? { pinned_context: [...pinned].map(([uid, revision_id]) => ({ uid, revision_id })) } : {}),
      tags: input.tags ?? [],
      ...(input.notes ? { notes: input.notes } : {}),
    };

    const circuit = session.circuit_uid;
    const path = fixturesPath(circuit);
    let raw: string | null = null;
    try {
      const def = await this.d.config.definition(path, 'main');
      raw = def.raw ?? null;
    } catch (e) {
      if (!(e instanceof BreadboardError && e.code === 'not-found')) {
        // Fall back to the parsed manifest when the definition reader can't serve this path.
        const parsed = await this.d.config.fixtures(circuit, 'main').catch(() => null);
        raw = parsed ? toYaml(parsed) : null;
      }
    }
    let content: string;
    if (raw && raw.trim()) {
      const doc = parseDocument(raw);
      if (doc.errors.length) throw validationFailed(`existing ${path} does not parse: ${doc.errors[0]!.message}`);
      if (doc.hasIn(['fixtures']) && doc.getIn(['fixtures'])) doc.addIn(['fixtures'], doc.createNode(entry));
      else doc.setIn(['fixtures'], doc.createNode([entry]));
      content = doc.toString();
    } else {
      content = toYaml({ schema: SCHEMA_TAGS.fixtures, circuit, fixtures: [entry] });
    }
    const res = await this.d.config.commitDirect({
      changes: [{ path, content }],
      message: `Promote session ${session.session_id} to fixture ${fixture_id}: ${input.fixture_title.trim()}`,
      by: input.by,
    });
    if (!res.validation.ok) throw validationFailed('fixture manifest failed validation', res.validation.errors);
    return { fixture_id, commit: res.commit };
  }

  // -------------------------------------------------------------------------
  private async allEvents(sessionId: string): Promise<SessionEvent[]> {
    const out: SessionEvent[] = [];
    let after = 0;
    for (let i = 0; i < 100; i++) {
      const batch = await this.d.sessions.events(sessionId, after, 1000);
      out.push(...batch);
      if (batch.length < 1000) break;
      after = batch[batch.length - 1]!.seq;
    }
    return out;
  }

  /** The last commit at or before `commit` that touched `path` (rubric version identity); falls back to `commit`. */
  private async lastTouching(path: string, commit: string): Promise<string> {
    try {
      const h = await this.d.config.history({ path, ref: commit, limit: 1 });
      return h[0]?.commit ?? commit;
    } catch {
      return commit;
    }
  }
}

export function createEvalService(deps: EvalServiceDeps): EvalServiceImpl {
  return new EvalServiceImpl(deps);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function runRow(r: Record<string, any>): EvalRunRow {
  return {
    eval_run_id: String(r.eval_run_id).trim(),
    team_id: String(r.team_id).trim(),
    circuit_uid: String(r.circuit_uid).trim(),
    circuit_commit: r.circuit_commit,
    rubric_commit: r.rubric_commit,
    model_overrides: r.model_overrides ?? null,
    judge_model_id: r.judge_model_id,
    fixture_tags: r.fixture_tags ?? null,
    proposal_id: r.proposal_id ? String(r.proposal_id).trim() : null,
    status: r.status,
    summary: r.summary ?? {},
    created_by: r.created_by,
    created_at: iso(r.created_at)!,
    ended_at: iso(r.ended_at),
  };
}

export function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function recentRunView(r: Record<string, any>) {
  return {
    eval_run_id: r.eval_run_id,
    circuit_uid: r.circuit_uid,
    status: r.status,
    created_at: r.created_at,
    ended_at: r.ended_at,
    variant: r.variant,
    proposal_id: r.proposal_id,
    mean_aggregate: r.summary?.mean_aggregate ?? null,
    pass_rate: r.summary?.pass_rate ?? null,
    total_cost_usd: r.summary?.total_cost_usd ?? null,
  };
}

/** Find `{uid, revision_id?}` references anywhere in a JSON value. `requireRevision` limits to revision-pinned refs. */
export function collectRefs(value: unknown, requireRevision = false): Array<{ uid: string; revision_id: number | null }> {
  const seen = new Map<string, number | null>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    if (isUid(o.uid)) {
      const rev = Number.isInteger(o.revision_id) ? (o.revision_id as number) : null;
      if (!requireRevision || rev !== null) {
        const prev = seen.get(o.uid as string);
        seen.set(o.uid as string, prev === undefined ? rev : prev === null ? rev : rev === null ? prev : Math.max(prev, rev));
      }
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(value, 0);
  return [...seen].map(([uid, revision_id]) => ({ uid, revision_id }));
}

export function recordScoresTool(dims: RubricDimension[]): ToolSpec {
  return {
    name: RECORD_SCORES_TOOL,
    description: 'Record your score for every rubric dimension in one call. Each entry: the dimension key, a value of the dimension type, and a brief rationale.',
    input_schema: {
      type: 'object',
      required: ['scores'],
      additionalProperties: false,
      properties: {
        scores: {
          type: 'array',
          minItems: dims.length,
          items: {
            type: 'object',
            required: ['dimension', 'value', 'rationale'],
            additionalProperties: false,
            properties: {
              dimension: { type: 'string', enum: dims.map((d) => d.key) },
              value: { type: ['number', 'string', 'boolean'] },
              rationale: { type: 'string' },
            },
          },
        },
      },
    },
  };
}

function describeDim(d: RubricDimension): string {
  switch (d.type) {
    case 'numeric':
      return `\`${d.key}\` (numeric, a number from ${d.scale.min} to ${d.scale.max})`;
    case 'ordinal':
      return `\`${d.key}\` (ordinal, exactly one of: ${d.levels.join(', ')})`;
    case 'boolean':
      return `\`${d.key}\` (boolean, true or false)`;
    default:
      return `\`${d.key}\``;
  }
}

export function judgePrompt(circuit: Circuit, fixture: Fixture, outcome: { exit: string | null; output: unknown }, artifacts: InlinedArtifact[], dims: RubricDimension[]): string {
  const parts: string[] = [];
  parts.push(`You are grading one output of the circuit "${circuit.title}" (${circuit.uid}) against its rubric.`);
  if (circuit.description) parts.push(`Circuit purpose: ${circuit.description}`);
  parts.push(`## Fixture input (${fixture.fixture_id}: ${fixture.title})\n\`\`\`json\n${cap(safeJson(fixture.input, 2), JSON_CAP)}\n\`\`\``);
  parts.push(`## Circuit output\nExit taken: \`${outcome.exit ?? '(none)'}\`\n\`\`\`json\n${cap(safeJson(outcome.output, 2), JSON_CAP)}\n\`\`\``);
  if (artifacts.length) {
    const a = artifacts.map((x) => `### [[${x.uid}|${x.title ?? 'untitled'}]]${x.revision_id !== null ? ` (revision ${x.revision_id})` : ''}\n${x.missing ? '(artifact not found)' : (x.body ?? '(empty)')}`);
    parts.push(`## Referenced artifacts\n${a.join('\n\n')}`);
  }
  const dl = dims.map((d) => `- ${describeDim(d)}: ${'prompt' in d ? d.prompt.trim() : ''}`);
  parts.push(`## Dimensions to score\n${dl.join('\n')}`);
  parts.push(`Call \`${RECORD_SCORES_TOOL}\` exactly once with one entry per dimension above ({dimension, value, rationale}). Keep each rationale brief and specific to this output.`);
  return parts.join('\n\n');
}

function safeJson(v: unknown, indent?: number): string {
  try {
    return JSON.stringify(v ?? null, null, indent) ?? 'null';
  } catch {
    return String(v);
  }
}

function cap(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n))}\n…[truncated ${s.length - n} chars]`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
