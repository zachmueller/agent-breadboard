import { describe, it, expect } from 'vitest';
import { pivotResults, variantLabel } from './RunsPanel';
import { fmtDelta } from './AnalysisPanel';
import type { EvalResultRow } from '../../lib/configApi';

const row = (fixture_id: string, dimension: string, value: unknown, cost = 0): EvalResultRow => ({ fixture_id, scored_session: `S-${fixture_id}`, dimension, dim_type: dimension === '*' ? 'aggregate' : 'numeric', value, rationale: null, cost_usd: cost });

describe('eval helpers', () => {
  it('pivots result rows into fixture x dimension', () => {
    const p = pivotResults([row('f1', 'coverage', 7, 0.1), row('f1', '*', 0.8, 0.2), row('f2', 'grounded', true), row('f2', 'coverage', 3)]);
    expect(p.dims).toEqual(['coverage', 'grounded']);
    expect(p.fixtures.map((f) => f.fixture_id)).toEqual(['f1', 'f2']);
    expect(p.fixtures[0]!.aggregate?.value).toBe(0.8);
    expect(p.fixtures[0]!.cost).toBeCloseTo(0.3);
    expect(p.fixtures[1]!.cells.get('grounded')?.value).toBe(true);
    expect(p.fixtures[1]!.session).toBe('S-f2');
  });
  it('labels variants from the server label or the sorted overrides', () => {
    expect(variantLabel({ model_overrides: null, raw: { variant: 'large=opus' } } as any)).toBe('large=opus');
    expect(variantLabel({ model_overrides: {}, raw: {} } as any)).toBe('preset-default');
    expect(variantLabel({ model_overrides: { small: 'b', large: 'a' }, raw: {} } as any)).toBe('large=a,small=b');
  });
  it('formats signed deltas', () => {
    expect(fmtDelta(0.1234)).toBe('+0.12');
    expect(fmtDelta(-0.05, 1)).toBe('-0.1');
    expect(fmtDelta(null)).toBe('–');
  });
});
