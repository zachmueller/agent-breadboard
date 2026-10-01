/** Pure geometry for the eval score trend chart ([04] §6): series by variant, time scale, change markers. */

export interface TrendPoint {
  eval_run_id: string;
  created_at: string;
  variant: string;
  mean_aggregate: number | null;
  pass_rate: number | null;
  mean_session_cost_usd: number | null;
  circuit_commit: string;
  rubric_commit: string;
  judge_model_id: string;
  gate_min: number | null;
  markers: string[];
}

/** Reference categorical palette, fixed order; light / dark steps validated as sets (adjacent pairs). */
export const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
export const MAX_SERIES = SERIES_LIGHT.length;

export const MARKER_LABEL: Record<string, { short: string; long: string }> = {
  'circuit-commit': { short: 'C', long: 'circuit changed' },
  rubric: { short: 'R', long: 'rubric changed' },
  judge: { short: 'J', long: 'judge model changed' },
};

export interface TrendSeries {
  variant: string;
  slot: number;
  points: Array<TrendPoint & { t: number; v: number }>;
}

export interface TrendLayout {
  series: TrendSeries[];
  /** Variants beyond the palette (table only). */
  overflow: string[];
  t0: number;
  t1: number;
  /** One entry per distinct time with ≥1 change marker; kinds merged across variants. */
  markers: Array<{ t: number; kinds: string[]; runs: string[] }>;
  gate: number | null;
}

/**
 * Variants keep a stable slot from the server's `variants` order (first-seen), so filtering never
 * repaints a survivor. Points with no score are dropped from lines (the table still lists them).
 */
export function trendLayout(points: TrendPoint[], variants?: string[]): TrendLayout {
  const order = [...new Set([...(variants ?? []), ...points.map((p) => p.variant)])];
  const kept = order.slice(0, MAX_SERIES);
  const series: TrendSeries[] = kept.map((variant, slot) => ({
    variant,
    slot,
    points: points
      .filter((p) => p.variant === variant && typeof p.mean_aggregate === 'number')
      .map((p) => ({ ...p, t: Date.parse(p.created_at), v: p.mean_aggregate as number }))
      .filter((p) => Number.isFinite(p.t))
      .sort((a, b) => a.t - b.t),
  }));
  const ts = series.flatMap((s) => s.points.map((p) => p.t));
  let t0 = ts.length ? Math.min(...ts) : 0;
  let t1 = ts.length ? Math.max(...ts) : 1;
  if (t1 === t0) {
    t0 -= 3600_000;
    t1 += 3600_000;
  }
  const byT = new Map<number, { kinds: Set<string>; runs: string[] }>();
  for (const p of points) {
    if (!p.markers?.length || !kept.includes(p.variant)) continue;
    const t = Date.parse(p.created_at);
    if (!Number.isFinite(t)) continue;
    const m = byT.get(t) ?? { kinds: new Set<string>(), runs: [] };
    p.markers.forEach((k) => m.kinds.add(k));
    m.runs.push(p.eval_run_id);
    byT.set(t, m);
  }
  const gates = points.map((p) => p.gate_min).filter((g): g is number => typeof g === 'number');
  return {
    series,
    overflow: order.slice(MAX_SERIES),
    t0,
    t1,
    markers: [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, m]) => ({ t, kinds: [...m.kinds], runs: m.runs })),
    gate: gates.length ? gates[gates.length - 1]! : null,
  };
}

/** Latest point per series at or before `t` (the tooltip's "every series at this X" readout). */
export function valuesAt(layout: TrendLayout, t: number): Array<{ series: TrendSeries; point: TrendSeries['points'][number] | null }> {
  return layout.series.map((s) => {
    let best: TrendSeries['points'][number] | null = null;
    for (const p of s.points) if (p.t <= t) best = p;
    return { series: s, point: best };
  });
}

/** Distinct run times, ascending — crosshair snap positions. */
export function snapTimes(layout: TrendLayout): number[] {
  return [...new Set(layout.series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
}

export function nearestIndex(sorted: number[], t: number): number {
  if (!sorted.length) return -1;
  let best = 0;
  for (let i = 1; i < sorted.length; i++) if (Math.abs(sorted[i]! - t) < Math.abs(sorted[best]! - t)) best = i;
  return best;
}
