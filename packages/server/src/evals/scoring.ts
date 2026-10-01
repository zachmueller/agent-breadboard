/**
 * Pure rubric math ([04] §2): dimension value validation, normalization to [0,1], and aggregation.
 * Shared by the in-run scorer, the `record_score` MCP path, and the analysis views.
 */
import { validationFailed, type Rubric, type RubricDimension } from '@breadboard/shared';

/** Stored programmatic value shape ([04] §4.1 `{score, detail}`). */
export interface ProgrammaticValue {
  pass: boolean;
  score: number;
  detail?: unknown;
}

/** A dimension value as persisted; `null` = skipped (failed session, judge omission, invalid value). */
export type DimValue = number | string | boolean | ProgrammaticValue | null;

export interface AggregateValue {
  score: number | null;
  pass: boolean | null;
  per_dimension: Record<string, number | null>;
  session_cost_usd: number;
  /** The scored session did not complete (suspended/cancelled/timeout). */
  failed?: boolean;
  failure?: string;
  /** Human gate reviews of the scored session (eval sessions gate like production). */
  gates?: Array<{ step_id: string; exit: string; verdicts: Array<{ verdict: string; comment: string | null; by: unknown; at: string }> }>;
}

/**
 * Validate a raw value against its dimension type. Returns the canonical stored value or throws `validation-failed`.
 * numeric: finite number within scale; ordinal: one of `levels`; boolean: boolean; programmatic: boolean or `{pass}`.
 */
export function validateDimValue(dim: RubricDimension, value: unknown): Exclude<DimValue, null> {
  switch (dim.type) {
    case 'numeric': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw validationFailed(`dimension '${dim.key}' expects a number`, { dimension: dim.key, value });
      if (n < dim.scale.min || n > dim.scale.max) throw validationFailed(`dimension '${dim.key}' value ${n} outside scale [${dim.scale.min}, ${dim.scale.max}]`, { dimension: dim.key, value });
      return n;
    }
    case 'ordinal': {
      if (typeof value !== 'string' || !dim.levels.includes(value)) throw validationFailed(`dimension '${dim.key}' expects one of ${dim.levels.join(', ')}`, { dimension: dim.key, value });
      return value;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      throw validationFailed(`dimension '${dim.key}' expects a boolean`, { dimension: dim.key, value });
    }
    case 'programmatic': {
      if (typeof value === 'boolean') return { pass: value, score: value ? 1 : 0 };
      if (value && typeof value === 'object' && typeof (value as any).pass === 'boolean') {
        const pass = (value as any).pass as boolean;
        return { pass, score: pass ? 1 : 0, ...((value as any).detail !== undefined ? { detail: (value as any).detail } : {}) };
      }
      throw validationFailed(`dimension '${dim.key}' (programmatic) expects a boolean or {pass: boolean}`, { dimension: dim.key, value });
    }
  }
}

/** Normalize a stored value to [0,1]; null when skipped/unmappable. */
export function normalize(rubric: Rubric, dim: RubricDimension, value: DimValue): number | null {
  if (value === null || value === undefined) return null;
  switch (dim.type) {
    case 'numeric': {
      if (typeof value !== 'number') return null;
      const span = dim.scale.max - dim.scale.min;
      if (span <= 0) return value >= dim.scale.max ? 1 : 0;
      return clamp01((value - dim.scale.min) / span);
    }
    case 'boolean':
      return typeof value === 'boolean' ? (value ? 1 : 0) : null;
    case 'ordinal': {
      if (typeof value !== 'string') return null;
      const mapped = rubric.aggregate?.ordinal_map?.[dim.key]?.[value];
      if (typeof mapped === 'number') return clamp01(mapped);
      const idx = dim.levels.indexOf(value);
      if (idx < 0) return null;
      return dim.levels.length <= 1 ? 1 : idx / (dim.levels.length - 1);
    }
    case 'programmatic':
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (value && typeof value === 'object' && 'pass' in value) return value.pass ? 1 : 0;
      return null;
  }
}

/** Aggregate normalized per-dimension scores by the rubric's method; skipped (null) dims are excluded. */
export function aggregateScore(rubric: Rubric, perDim: Record<string, number | null>): number | null {
  const method = rubric.aggregate?.method ?? 'weighted-mean';
  const weights = rubric.aggregate?.weights ?? {};
  const entries = Object.entries(perDim).filter((e): e is [string, number] => typeof e[1] === 'number');
  if (entries.length === 0) return null;
  if (method === 'min') return Math.min(...entries.map(([, v]) => v));
  if (method === 'mean') return entries.reduce((s, [, v]) => s + v, 0) / entries.length;
  let num = 0;
  let den = 0;
  for (const [k, v] of entries) {
    const w = weights[k] ?? 1;
    num += w * v;
    den += w;
  }
  return den > 0 ? num / den : null;
}

/** Build the `*` aggregate row value from stored per-dimension values. */
export function buildAggregate(rubric: Rubric, values: Record<string, DimValue>, opts: { session_cost_usd: number; failed?: boolean; failure?: string }): AggregateValue {
  const per_dimension: Record<string, number | null> = {};
  for (const dim of rubric.dimensions) per_dimension[dim.key] = normalize(rubric, dim, values[dim.key] ?? null);
  // A session that never produced an output cannot pass: its aggregate is 0 regardless of skipped judge dims.
  const raw = aggregateScore(rubric, per_dimension);
  const score = opts.failed ? 0 : raw === null ? null : round(raw);
  const gate = rubric.aggregate?.gate;
  const pass = gate ? score !== null && score >= gate.min : null;
  return {
    score,
    pass,
    per_dimension,
    session_cost_usd: round(opts.session_cost_usd),
    ...(opts.failed ? { failed: true, failure: opts.failure ?? 'session did not complete' } : {}),
  };
}

export function mean(xs: Array<number | null | undefined>): number | null {
  const ns = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return ns.length ? round(ns.reduce((a, b) => a + b, 0) / ns.length) : null;
}

export function round(n: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Stable label for a model_overrides set ("preset default" when none). */
export function overridesKey(o: Record<string, string> | null | undefined): string {
  if (!o || Object.keys(o).length === 0) return 'preset-default';
  return Object.keys(o)
    .sort()
    .map((k) => `${k}=${o[k]}`)
    .join(',');
}
