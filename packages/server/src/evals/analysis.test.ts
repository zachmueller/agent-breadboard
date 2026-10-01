import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintEvalRunId, mintSessionId, mintUid } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import { loadRunStats, buildDashboard } from './analysis.js';
import { createEvalService, type EvalServiceImpl } from './service.js';

const CIRCUIT = mintUid();
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const R1 = '1'.repeat(40);
const JUDGE = 'judge-1';

interface SeedRun {
  commit: string;
  rubric?: string;
  judge?: string;
  overrides?: Record<string, string> | null;
  at: string;
  scores: number[];
  cost: number;
  gate?: number | null;
  status?: string;
}

async function seed(f: Foundation, r: SeedRun): Promise<string> {
  const id = mintEvalRunId();
  const gate = r.gate === undefined ? 0.7 : r.gate;
  await f.db.query(
    `INSERT INTO eval_runs (eval_run_id, team_id, circuit_uid, circuit_commit, rubric_commit, model_overrides, judge_model_id, status, summary, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, f.team_id, CIRCUIT, r.commit, r.rubric ?? R1, r.overrides ? JSON.stringify(r.overrides) : null, r.judge ?? JUDGE, r.status ?? 'completed', JSON.stringify({ gate_min: gate }), JSON.stringify({ kind: 'user', id: 'u' }), r.at],
  );
  for (const [i, score] of r.scores.entries()) {
    const sid = mintSessionId();
    const fx = `fx-${i}`;
    const pass = gate === null ? null : score >= gate;
    await f.db.query(`INSERT INTO eval_results (eval_run_id, fixture_id, scored_session, dimension, dim_type, value, cost_usd) VALUES ($1,$2,$3,'*','aggregate',$4,$5)`, [
      id,
      fx,
      sid,
      JSON.stringify({ score, pass, per_dimension: { quality: score }, session_cost_usd: r.cost }),
      r.cost,
    ]);
    await f.db.query(`INSERT INTO eval_results (eval_run_id, fixture_id, scored_session, dimension, dim_type, value, cost_usd) VALUES ($1,$2,$3,'tone','ordinal',$4,0)`, [id, fx, sid, JSON.stringify(score > 0.7 ? 'good' : 'ok')]);
  }
  return id;
}

describe('eval analysis views', () => {
  let f: Foundation;
  let svc: EvalServiceImpl;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    f = await createFoundation();
    svc = createEvalService({ db: f.db, team_id: f.team_id, log: f.log } as any);
    ids.r1 = await seed(f, { commit: A, at: '2026-09-01T00:00:00Z', scores: [0.8, 0.9], cost: 0.1 });
    ids.r2 = await seed(f, { commit: A, overrides: { medium: 'cheap-model' }, at: '2026-09-02T00:00:00Z', scores: [0.75, 0.72], cost: 0.02 });
    ids.r3 = await seed(f, { commit: A, overrides: { medium: 'tiny-model' }, at: '2026-09-03T00:00:00Z', scores: [0.5, 0.6], cost: 0.005 });
    ids.r4 = await seed(f, { commit: B, at: '2026-09-04T00:00:00Z', scores: [0.6, 0.65], cost: 0.1 });
    ids.running = await seed(f, { commit: B, at: '2026-09-05T00:00:00Z', scores: [0.1], cost: 0.1, status: 'running' });
  });
  afterEach(async () => f.close());

  it('loads completed runs oldest → newest with costs and distributions', async () => {
    const runs = await loadRunStats(f.db, f.team_id, { circuit: CIRCUIT });
    expect(runs.map((r) => r.eval_run_id)).toEqual([ids.r1, ids.r2, ids.r3, ids.r4]);
    expect(runs[1]!.variant).toBe('medium=cheap-model');
    expect(runs[0]!.fixtures[0]!.session_cost_usd).toBeCloseTo(0.1); // falls back to the aggregate's recorded session cost
    expect(runs[0]!.distributions.tone).toEqual({ good: 2 });
    expect(runs[0]!.total_cost_usd).toBeCloseTo(0.2);
  });

  it('trend marks circuit-commit changes per variant', async () => {
    const t = (await svc.analysis(CIRCUIT, 'trend')) as any;
    expect(t.points).toHaveLength(4);
    expect(t.points[0].mean_aggregate).toBeCloseTo(0.85);
    expect(t.points[3].markers).toEqual(['circuit-commit']);
    expect(t.points[1].markers).toEqual([]); // first run of its variant
    expect(t.variants).toEqual(['preset-default', 'medium=cheap-model', 'medium=tiny-model']);
  });

  it('cheapest-model picks the cheapest variant that clears the gate', async () => {
    const latest = (await svc.analysis(CIRCUIT, 'cheapest-model')) as any;
    expect(latest.rows.map((r: any) => r.variant)).toEqual(['preset-default']); // latest commit B only has the default
    const m = (await svc.analysis(CIRCUIT, 'cheapest-model', { circuit_commit: A })) as any;
    expect(m.rows.map((r: any) => r.variant)).toEqual(['medium=tiny-model', 'medium=cheap-model', 'preset-default']);
    expect(m.rows.map((r: any) => r.passes_gate)).toEqual([false, true, true]);
    expect(m.cheapest_passing).toMatchObject({ variant: 'medium=cheap-model', model_overrides: { medium: 'cheap-model' } });
    expect(m.cheapest_passing.mean_aggregate).toBeCloseTo(0.735);
  });

  it('model-regression compares variants against the preset default under one baseline', async () => {
    const m = (await svc.analysis(CIRCUIT, 'model-regression')) as any;
    expect(m.groups).toHaveLength(2);
    const groupA = m.groups.find((g: any) => g.circuit_commit === A);
    expect(groupA.baseline).toBe('preset-default');
    const v = Object.fromEntries(groupA.variants.map((x: any) => [x.variant, x]));
    expect(v['medium=tiny-model'].regression).toBe(true);
    expect(v['medium=cheap-model'].regression).toBe(false);
    expect(v['medium=tiny-model'].delta_vs_baseline.aggregate).toBeCloseTo(-0.3);
  });

  it('circuit-regression diffs the latest commit against the previous one per fixture', async () => {
    const c = (await svc.analysis(CIRCUIT, 'circuit-regression')) as any;
    expect(c.head.eval_run_id).toBe(ids.r4);
    expect(c.base.eval_run_id).toBe(ids.r1);
    expect(c.comparable).toBe(true);
    expect(c.delta.aggregate).toBeCloseTo(-0.225);
    expect(c.regressions.map((r: any) => r.fixture_id)).toEqual(['fx-0', 'fx-1']);
    const explicit = (await svc.analysis(CIRCUIT, 'circuit-regression', { base: ids.r4, head: ids.r1 })) as any;
    expect(explicit.delta.aggregate).toBeCloseTo(0.225);
    expect(explicit.regressions).toEqual([]);
  });

  it('dashboard surfaces gate regressions and the per-circuit matrix', async () => {
    const d = (await svc.analysis(CIRCUIT, 'dashboard')) as any;
    expect(d.regressions).toHaveLength(1);
    expect(d.regressions[0]).toMatchObject({ eval_run_id: ids.r4, previous_run_id: ids.r1, gate_min: 0.7 });
    const all = buildDashboard(await loadRunStats(f.db, f.team_id, {}));
    expect((all.matrix as any[])[0].circuit_uid).toBe(CIRCUIT);
    const board = (await svc.dashboard()) as any;
    expect(board.running).toBe(1);
    expect(board.regressions).toHaveLength(1);
    expect(board.recent_runs).toHaveLength(5);
  });

  it('changing the rubric version breaks regression comparability', async () => {
    await seed(f, { commit: B, rubric: '2'.repeat(40), at: '2026-09-06T00:00:00Z', scores: [0.9, 0.9], cost: 0.1 });
    const c = (await svc.analysis(CIRCUIT, 'circuit-regression', { base: A })) as any;
    expect(c.rubric_changed).toBe(true);
    expect(c.comparable).toBe(false);
    const t = (await svc.analysis(CIRCUIT, 'trend', { variant: 'preset-default' })) as any;
    expect(t.points.at(-1).markers).toEqual(['rubric']);
  });
});
