import { describe, it, expect } from 'vitest';
import { trendLayout, valuesAt, snapTimes, nearestIndex, type TrendPoint } from './trendModel';

const pt = (id: string, at: string, variant: string, v: number | null, markers: string[] = [], gate: number | null = 0.7): TrendPoint => ({
  eval_run_id: id,
  created_at: at,
  variant,
  mean_aggregate: v,
  pass_rate: null,
  mean_session_cost_usd: null,
  circuit_commit: 'c',
  rubric_commit: 'r',
  judge_model_id: 'j',
  gate_min: gate,
  markers,
});

describe('trendLayout', () => {
  const pts = [pt('a', '2026-09-01T00:00:00Z', 'preset-default', 0.8), pt('b', '2026-09-02T00:00:00Z', 'small', 0.6), pt('c', '2026-09-03T00:00:00Z', 'preset-default', 0.7, ['circuit-commit']), pt('d', '2026-09-04T00:00:00Z', 'small', null, ['rubric'])];
  it('keeps slots in server variant order and drops unscored points from lines', () => {
    const l = trendLayout(pts, ['preset-default', 'small']);
    expect(l.series.map((s) => [s.variant, s.slot, s.points.length])).toEqual([
      ['preset-default', 0, 2],
      ['small', 1, 1],
    ]);
    expect(l.markers.map((m) => m.kinds)).toEqual([['circuit-commit'], ['rubric']]);
    expect(l.gate).toBe(0.7);
  });
  it('a filtered-out variant does not repaint survivors when the server order is passed', () => {
    const l = trendLayout(pts.filter((p) => p.variant === 'small'), ['preset-default', 'small']);
    expect(l.series.find((s) => s.variant === 'small')?.slot).toBe(1);
  });
  it('folds variants past the palette into overflow', () => {
    const many = Array.from({ length: 10 }, (_, i) => pt(String(i), '2026-09-01T00:00:00Z', `v${i}`, 0.5));
    const l = trendLayout(many);
    expect(l.series).toHaveLength(8);
    expect(l.overflow).toEqual(['v8', 'v9']);
  });
  it('reads every series at an X', () => {
    const l = trendLayout(pts);
    const times = snapTimes(l);
    expect(times).toHaveLength(3);
    const at = valuesAt(l, times[1]!);
    expect(at.map((x) => x.point?.eval_run_id ?? null)).toEqual(['a', 'b']);
    expect(nearestIndex(times, times[2]! + 1)).toBe(2);
  });
});
