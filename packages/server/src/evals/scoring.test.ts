import { describe, expect, it } from 'vitest';
import { mintUid, SCHEMA_TAGS, type Rubric } from '@breadboard/shared';
import { aggregateScore, buildAggregate, normalize, overridesKey, validateDimValue } from './scoring.js';

const rubric = (aggregate: Record<string, unknown>): Rubric =>
  ({
    schema: SCHEMA_TAGS.rubric,
    circuit: mintUid(),
    judge: { subagent: mintUid(), model_id: 'j', provider: 'bedrock' },
    dimensions: [
      { key: 'n', type: 'numeric', scale: { min: 0, max: 10 }, prompt: 'p' },
      { key: 'o', type: 'ordinal', levels: ['low', 'mid', 'high'], prompt: 'p' },
      { key: 'b', type: 'boolean', prompt: 'p' },
      { key: 'p', type: 'programmatic', tool: 'assert-exit' },
    ],
    aggregate: { method: 'weighted-mean', weights: {}, ...aggregate },
    required_for_merge: false,
  }) as Rubric;

describe('scoring', () => {
  const r = rubric({});
  const [n, o, b, p] = r.dimensions as [any, any, any, any];

  it('validates and coerces dimension values', () => {
    expect(validateDimValue(n, '7')).toBe(7);
    expect(() => validateDimValue(n, 11)).toThrow();
    expect(validateDimValue(o, 'mid')).toBe('mid');
    expect(() => validateDimValue(o, 'MID')).toThrow();
    expect(validateDimValue(b, 'false')).toBe(false);
    expect(() => validateDimValue(b, 1)).toThrow();
    expect(validateDimValue(p, true)).toMatchObject({ pass: true });
    expect(() => validateDimValue(p, 'yes')).toThrow();
  });

  it('normalizes to [0,1] with evenly spaced ordinal defaults', () => {
    expect(normalize(r, n, 2.5)).toBeCloseTo(0.25);
    expect(normalize(r, o, 'mid')).toBeCloseTo(0.5);
    expect(normalize(r, b, true)).toBe(1);
    expect(normalize(r, p, { pass: false, score: 0 })).toBe(0);
    expect(normalize(r, n, null)).toBeNull();
  });

  it('aggregates by weighted-mean / mean / min, excluding unscored dims', () => {
    const per = { n: 1, o: 0.5, b: 0, p: null };
    expect(aggregateScore(rubric({ weights: { n: 3 } }), per)).toBeCloseTo((3 + 0.5 + 0) / 5);
    expect(aggregateScore(rubric({ method: 'mean' }), per)).toBeCloseTo(0.5);
    expect(aggregateScore(rubric({ method: 'min' }), per)).toBe(0);
    expect(aggregateScore(r, { n: null })).toBeNull();
  });

  it('gates pass and forces failed sessions to 0', () => {
    const g = rubric({ gate: { min: 0.6 } });
    const ok = buildAggregate(g, { n: 8, o: 'high', b: true, p: { pass: true, score: 1 } }, { session_cost_usd: 0.2 });
    expect(ok.score).toBeCloseTo(0.95);
    expect(ok.pass).toBe(true);
    const failed = buildAggregate(g, { n: 8 }, { session_cost_usd: 0.2, failed: true, failure: 'x' });
    expect(failed).toMatchObject({ score: 0, pass: false, failed: true });
    expect(buildAggregate(r, { n: 8 }, { session_cost_usd: 0 }).pass).toBeNull();
  });

  it('keys model-override variants stably', () => {
    expect(overridesKey(null)).toBe('preset-default');
    expect(overridesKey({ small: 'b', large: 'a' })).toBe('large=a,small=b');
  });
});
