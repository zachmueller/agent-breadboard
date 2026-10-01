/**
 * Analysis views over the results store ([04] §6, §8): model-regression, cheapest-sufficient-model,
 * circuit-change regression, score trend, and the per-circuit / Breadboard-level dashboards.
 */
import type { Db } from '../db/index.js';
import { mean, overridesKey, round, type AggregateValue } from './scoring.js';

export type AnalysisView = 'model-regression' | 'cheapest-model' | 'circuit-regression' | 'trend' | 'dashboard';
export const ANALYSIS_VIEWS: readonly AnalysisView[] = ['model-regression', 'cheapest-model', 'circuit-regression', 'trend', 'dashboard'];

export interface AnalysisOptions {
  /** circuit-regression: base/head circuit commit (or `evr_` run id). */
  base?: string;
  head?: string;
  /** cheapest-model / model-regression: restrict to one circuit commit. */
  circuit_commit?: string;
  /** circuit-regression / trend: restrict to one model_overrides variant (default `preset-default` for circuit-regression). */
  variant?: string;
}

export interface FixtureStat {
  fixture_id: string;
  scored_session: string;
  score: number | null;
  pass: boolean | null;
  failed: boolean;
  session_cost_usd: number;
  per_dimension: Record<string, number | null>;
}

export interface RunStats {
  eval_run_id: string;
  circuit_uid: string;
  circuit_commit: string;
  rubric_commit: string;
  judge_model_id: string;
  model_overrides: Record<string, string> | null;
  variant: string;
  fixture_tags: string[] | null;
  proposal_id: string | null;
  created_at: string;
  gate_min: number | null;
  total_cost_usd: number;
  fixtures: FixtureStat[];
  /** dimension → value label → count (ordinal levels, booleans, programmatic pass/fail). */
  distributions: Record<string, Record<string, number>>;
}

export interface PooledStats {
  runs: number;
  fixtures: number;
  mean_aggregate: number | null;
  pass_rate: number | null;
  mean_session_cost_usd: number | null;
  per_dimension: Record<string, { mean: number | null; distribution?: Record<string, number> }>;
}

/** Completed runs (oldest → newest, latest `limit`) with fixture-level aggregates and session costs. */
export async function loadRunStats(db: Db, teamId: string, opts: { circuit?: string; limit?: number }): Promise<RunStats[]> {
  const params: unknown[] = [teamId];
  let where = `team_id=$1 AND status='completed'`;
  if (opts.circuit) {
    params.push(opts.circuit);
    where += ` AND circuit_uid=$2`;
  }
  params.push(opts.limit ?? 500);
  const runs = (await db.query(`SELECT * FROM eval_runs WHERE ${where} ORDER BY created_at DESC, eval_run_id DESC LIMIT $${params.length}`, params)).rows.reverse();
  if (runs.length === 0) return [];
  const ids = runs.map((r) => String(r.eval_run_id).trim());
  const results = (await db.query(`SELECT eval_run_id, fixture_id, scored_session, dimension, dim_type, value, cost_usd FROM eval_results WHERE eval_run_id = ANY($1::text[])`, [ids])).rows;
  // Session cost from turn rows (authoritative leaf, [02] §6), including sub-sessions; judge turns excluded.
  const costRows = (
    await db.query(
      `WITH RECURSIVE fam(root, sid) AS (
         SELECT DISTINCT scored_session::text, scored_session::text FROM eval_results WHERE dimension='*' AND eval_run_id = ANY($1::text[])
         UNION
         SELECT f.root, s.session_id::text FROM sessions s JOIN fam f ON s.parent_session::text = f.sid
       )
       SELECT f.root AS session_id, COALESCE(SUM(t.cost_usd), 0) AS cost
       FROM fam f JOIN session_turns t ON t.session_id::text = f.sid AND t.step_id <> 'eval-judge'
       GROUP BY f.root`,
      [ids],
    )
  ).rows;
  const turnCost = new Map(costRows.map((r) => [String(r.session_id).trim(), Number(r.cost)]));

  const byRun = new Map<string, typeof results>();
  for (const r of results) {
    const k = String(r.eval_run_id).trim();
    (byRun.get(k) ?? byRun.set(k, []).get(k)!).push(r);
  }
  return runs.map((run) => {
    const id = String(run.eval_run_id).trim();
    const rows = byRun.get(id) ?? [];
    const fixtures: FixtureStat[] = [];
    const distributions: Record<string, Record<string, number>> = {};
    let total = 0;
    for (const r of rows) {
      total += Number(r.cost_usd ?? 0);
      if (r.dimension === '*') {
        const v = (r.value ?? {}) as AggregateValue;
        const sid = String(r.scored_session).trim();
        const tc = turnCost.get(sid);
        fixtures.push({
          fixture_id: r.fixture_id,
          scored_session: sid,
          score: typeof v.score === 'number' ? v.score : null,
          pass: typeof v.pass === 'boolean' ? v.pass : null,
          failed: !!v.failed,
          session_cost_usd: tc && tc > 0 ? round(tc) : Number(v.session_cost_usd ?? 0),
          per_dimension: v.per_dimension ?? {},
        });
        continue;
      }
      const label = distributionLabel(r.dim_type, r.value);
      if (label !== null) {
        const d = (distributions[r.dimension] ??= {});
        d[label] = (d[label] ?? 0) + 1;
      }
    }
    fixtures.sort((a, b) => a.fixture_id.localeCompare(b.fixture_id));
    const summary = run.summary ?? {};
    return {
      eval_run_id: id,
      circuit_uid: String(run.circuit_uid).trim(),
      circuit_commit: run.circuit_commit,
      rubric_commit: run.rubric_commit,
      judge_model_id: run.judge_model_id,
      model_overrides: run.model_overrides ?? null,
      variant: overridesKey(run.model_overrides),
      fixture_tags: run.fixture_tags ?? null,
      proposal_id: run.proposal_id ? String(run.proposal_id).trim() : null,
      created_at: run.created_at instanceof Date ? run.created_at.toISOString() : String(run.created_at),
      gate_min: typeof summary.gate_min === 'number' ? summary.gate_min : null,
      total_cost_usd: round(total),
      fixtures,
      distributions,
    };
  });
}

function distributionLabel(type: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (type === 'ordinal' && typeof value === 'string') return value;
  if (type === 'boolean' && typeof value === 'boolean') return String(value);
  if (type === 'programmatic' && typeof value === 'object' && typeof (value as any).pass === 'boolean') return (value as any).pass ? 'pass' : 'fail';
  return null;
}

export function pool(runs: RunStats[]): PooledStats {
  const fixtures = runs.flatMap((r) => r.fixtures);
  const gate = runs.find((r) => r.gate_min !== null)?.gate_min ?? null;
  const keys = new Set<string>();
  for (const f of fixtures) for (const k of Object.keys(f.per_dimension)) keys.add(k);
  const per_dimension: PooledStats['per_dimension'] = {};
  for (const k of [...keys].sort()) {
    const dist: Record<string, number> = {};
    for (const r of runs) for (const [label, n] of Object.entries(r.distributions[k] ?? {})) dist[label] = (dist[label] ?? 0) + n;
    per_dimension[k] = { mean: mean(fixtures.map((f) => f.per_dimension[k])), ...(Object.keys(dist).length ? { distribution: dist } : {}) };
  }
  return {
    runs: runs.length,
    fixtures: fixtures.length,
    mean_aggregate: mean(fixtures.map((f) => f.score)),
    pass_rate: gate !== null && fixtures.length ? round(fixtures.filter((f) => f.pass === true).length / fixtures.length) : null,
    mean_session_cost_usd: mean(fixtures.map((f) => f.session_cost_usd)),
    per_dimension,
  };
}

function runMean(r: RunStats): number | null {
  return mean(r.fixtures.map((f) => f.score));
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    (m.get(k) ?? m.set(k, []).get(k)!).push(x);
  }
  return m;
}

function delta(a: number | null | undefined, b: number | null | undefined): number | null {
  return typeof a === 'number' && typeof b === 'number' ? round(a - b) : null;
}

function dimDeltas(head: PooledStats, base: PooledStats): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const k of new Set([...Object.keys(head.per_dimension), ...Object.keys(base.per_dimension)])) out[k] = delta(head.per_dimension[k]?.mean, base.per_dimension[k]?.mean);
  return out;
}

const baselineKey = (r: RunStats) => `${r.circuit_commit}|${r.rubric_commit}|${r.judge_model_id}`;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
export function modelRegression(runs: RunStats[], opts: AnalysisOptions = {}) {
  const scoped = opts.circuit_commit ? runs.filter((r) => r.circuit_commit === opts.circuit_commit) : runs;
  const groups = [...groupBy(scoped, baselineKey).values()].map((gr) => {
    const latest = gr[gr.length - 1]!;
    const variants = [...groupBy(gr, (r) => r.variant)].map(([variant, vr]) => ({
      variant,
      model_overrides: vr[0]!.model_overrides,
      ...pool(vr),
      history: vr.map((r) => ({ eval_run_id: r.eval_run_id, created_at: r.created_at, mean_aggregate: runMean(r) })),
    }));
    const baseline = variants.find((v) => v.variant === 'preset-default') ?? variants[0]!;
    const gate = latest.gate_min;
    return {
      circuit_commit: latest.circuit_commit,
      rubric_commit: latest.rubric_commit,
      judge_model_id: latest.judge_model_id,
      gate_min: gate,
      latest_at: latest.created_at,
      baseline: baseline.variant,
      variants: variants.map((v) => {
        const d = delta(v.mean_aggregate, baseline.mean_aggregate);
        return {
          ...v,
          delta_vs_baseline: { aggregate: d, per_dimension: dimDeltas(v, baseline) },
          regression: v.variant !== baseline.variant && d !== null && d < 0 && (gate === null || (v.mean_aggregate ?? 0) < gate),
        };
      }),
    };
  });
  groups.sort((a, b) => b.latest_at.localeCompare(a.latest_at));
  return { groups };
}

export function cheapestModel(runs: RunStats[], opts: AnalysisOptions = {}) {
  const scoped = opts.circuit_commit ? runs.filter((r) => r.circuit_commit === opts.circuit_commit) : runs;
  const latest = scoped[scoped.length - 1];
  if (!latest) return { baseline: null, gate_min: null, rows: [], cheapest_passing: null };
  // Comparable only under one circuit commit, rubric version, and judge ([04] §6, §10.1).
  const comparable = scoped.filter((r) => baselineKey(r) === baselineKey(latest));
  const gate = latest.gate_min;
  const rows = [...groupBy(comparable, (r) => r.variant)].map(([variant, vr]) => {
    const p = pool(vr);
    return {
      variant,
      label: variant === 'preset-default' ? 'preset default' : variant,
      model_overrides: vr[0]!.model_overrides,
      runs: p.runs,
      fixtures: p.fixtures,
      mean_aggregate: p.mean_aggregate,
      pass_rate: p.pass_rate,
      mean_session_cost_usd: p.mean_session_cost_usd,
      passes_gate: gate === null ? null : p.mean_aggregate !== null && p.mean_aggregate >= gate,
      latest_run: vr[vr.length - 1]!.eval_run_id,
    };
  });
  rows.sort((a, b) => (a.mean_session_cost_usd ?? Infinity) - (b.mean_session_cost_usd ?? Infinity) || (b.mean_aggregate ?? 0) - (a.mean_aggregate ?? 0));
  const cheapest = gate === null ? null : (rows.find((r) => r.passes_gate) ?? null);
  return {
    baseline: { circuit_commit: latest.circuit_commit, rubric_commit: latest.rubric_commit, judge_model_id: latest.judge_model_id },
    gate_min: gate,
    rows,
    cheapest_passing: cheapest ? { variant: cheapest.variant, model_overrides: cheapest.model_overrides, mean_aggregate: cheapest.mean_aggregate, mean_session_cost_usd: cheapest.mean_session_cost_usd } : null,
    ...(gate === null ? { note: 'rubric declares no aggregate gate; cheapest_passing requires gate.min' } : {}),
  };
}

export function circuitRegression(runs: RunStats[], opts: AnalysisOptions = {}) {
  const variant = opts.variant ?? 'preset-default';
  const pick = (sel: string | undefined, pool_: RunStats[]): RunStats | null => {
    if (!sel) return null;
    if (sel.startsWith('evr_')) return runs.find((r) => r.eval_run_id === sel) ?? null;
    const m = pool_.filter((r) => r.circuit_commit === sel || r.circuit_commit.startsWith(sel));
    return m[m.length - 1] ?? null;
  };
  const inVariant = runs.filter((r) => r.variant === variant);
  let head = pick(opts.head, inVariant);
  let base = pick(opts.base, inVariant);
  if (!head && !opts.head) head = inVariant[inVariant.length - 1] ?? null;
  if (head && !base && !opts.base) {
    // Previous distinct circuit commit; prefer one with the same rubric version + judge.
    const earlier = inVariant.filter((r) => r.circuit_commit !== head!.circuit_commit && r.created_at <= head!.created_at);
    base = [...earlier].reverse().find((r) => r.rubric_commit === head!.rubric_commit && r.judge_model_id === head!.judge_model_id) ?? earlier[earlier.length - 1] ?? null;
  }
  if (!head || !base) return { variant, base: base ? runSide(base) : null, head: head ? runSide(head) : null, comparable: false, delta: null, fixtures: [], regressions: [], note: 'need eval runs on two circuit commits' };
  const hp = pool([head]);
  const bp = pool([base]);
  const baseFx = new Map(base.fixtures.map((f) => [f.fixture_id, f]));
  const fixtures = head.fixtures
    .filter((f) => baseFx.has(f.fixture_id))
    .map((f) => {
      const b = baseFx.get(f.fixture_id)!;
      return { fixture_id: f.fixture_id, base_score: b.score, head_score: f.score, delta: delta(f.score, b.score), base_pass: b.pass, head_pass: f.pass, base_session: b.scored_session, head_session: f.scored_session };
    });
  const regressions = fixtures.filter((f) => (f.delta !== null && f.delta < 0) || (f.base_pass === true && f.head_pass === false));
  return {
    variant,
    base: runSide(base),
    head: runSide(head),
    comparable: base.rubric_commit === head.rubric_commit && base.judge_model_id === head.judge_model_id,
    rubric_changed: base.rubric_commit !== head.rubric_commit,
    judge_changed: base.judge_model_id !== head.judge_model_id,
    delta: { aggregate: delta(hp.mean_aggregate, bp.mean_aggregate), pass_rate: delta(hp.pass_rate, bp.pass_rate), per_dimension: dimDeltas(hp, bp), mean_session_cost_usd: delta(hp.mean_session_cost_usd, bp.mean_session_cost_usd) },
    fixtures,
    regressions,
  };
}

function runSide(r: RunStats) {
  const p = pool([r]);
  return { eval_run_id: r.eval_run_id, circuit_commit: r.circuit_commit, rubric_commit: r.rubric_commit, judge_model_id: r.judge_model_id, created_at: r.created_at, proposal_id: r.proposal_id, ...p };
}

export function trend(runs: RunStats[], opts: AnalysisOptions = {}) {
  const scoped = opts.variant ? runs.filter((r) => r.variant === opts.variant) : runs;
  const prevByVariant = new Map<string, RunStats>();
  const points = scoped.map((r) => {
    const prev = prevByVariant.get(r.variant);
    prevByVariant.set(r.variant, r);
    const markers: string[] = [];
    if (prev) {
      if (prev.circuit_commit !== r.circuit_commit) markers.push('circuit-commit');
      if (prev.rubric_commit !== r.rubric_commit) markers.push('rubric');
      if (prev.judge_model_id !== r.judge_model_id) markers.push('judge');
    }
    const p = pool([r]);
    return {
      eval_run_id: r.eval_run_id,
      created_at: r.created_at,
      variant: r.variant,
      mean_aggregate: p.mean_aggregate,
      pass_rate: p.pass_rate,
      mean_session_cost_usd: p.mean_session_cost_usd,
      circuit_commit: r.circuit_commit,
      rubric_commit: r.rubric_commit,
      judge_model_id: r.judge_model_id,
      gate_min: r.gate_min,
      markers,
    };
  });
  return { variants: [...new Set(scoped.map((r) => r.variant))], points };
}

/** Aggregate dropped below the gate vs the previous run on the same rubric version (same variant + judge). */
export function regressions(runs: RunStats[]) {
  const out: Array<Record<string, unknown>> = [];
  const prev = new Map<string, RunStats>();
  for (const r of runs) {
    const k = `${r.circuit_uid}|${r.rubric_commit}|${r.judge_model_id}|${r.variant}`;
    const p = prev.get(k);
    prev.set(k, r);
    if (!p || r.gate_min === null) continue;
    const cur = runMean(r);
    const before = runMean(p);
    if (cur === null || before === null) continue;
    if (before >= r.gate_min && cur < r.gate_min) {
      out.push({ circuit_uid: r.circuit_uid, eval_run_id: r.eval_run_id, previous_run_id: p.eval_run_id, rubric_commit: r.rubric_commit, circuit_commit: r.circuit_commit, previous_circuit_commit: p.circuit_commit, variant: r.variant, gate_min: r.gate_min, previous: before, current: cur, delta: round(cur - before), at: r.created_at });
    }
  }
  return out.reverse();
}

export function buildAnalysis(circuitUid: string, view: AnalysisView, runs: RunStats[], opts: AnalysisOptions = {}): Record<string, unknown> {
  const base = { circuit_uid: circuitUid, view, runs_considered: runs.length };
  switch (view) {
    case 'model-regression':
      return { ...base, ...modelRegression(runs, opts) };
    case 'cheapest-model':
      return { ...base, ...cheapestModel(runs, opts) };
    case 'circuit-regression':
      return { ...base, ...circuitRegression(runs, opts) };
    case 'trend':
      return { ...base, ...trend(runs, opts) };
    case 'dashboard':
      return {
        ...base,
        recent_runs: runs.slice(-10).reverse().map((r) => ({ eval_run_id: r.eval_run_id, created_at: r.created_at, variant: r.variant, circuit_commit: r.circuit_commit, ...pool([r]) })),
        regressions: regressions(runs),
        matrix: cheapestModel(runs, opts),
      };
  }
}

/** Breadboard-level eval dashboard ([04] §8): regressions + cost-vs-quality matrix per circuit. */
export function buildDashboard(runs: RunStats[]): Record<string, unknown> {
  const perCircuit = [...groupBy(runs, (r) => r.circuit_uid)].map(([circuit_uid, cr]) => {
    const m = cheapestModel(cr);
    const latest = cr[cr.length - 1]!;
    return { circuit_uid, latest_run_at: latest.created_at, latest_mean_aggregate: runMean(latest), gate_min: m.gate_min, rows: m.rows, cheapest_passing: m.cheapest_passing };
  });
  perCircuit.sort((a, b) => b.latest_run_at.localeCompare(a.latest_run_at));
  return { regressions: regressions(runs).slice(0, 20), matrix: perCircuit.slice(0, 20) };
}
