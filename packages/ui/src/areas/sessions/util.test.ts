import { describe, expect, it } from 'vitest';
import type { StepSummaryDto } from '@breadboard/shared';
import { circuitSteps, groupSteps } from './util';

const step = (step_id: string, attempt = 1, status: StepSummaryDto['status'] = 'exited'): StepSummaryDto => ({
  step_id,
  attempt,
  status,
  exit_name: status === 'exited' ? 'ok' : null,
  cost_usd: 0,
  tokens_in: 0,
  tokens_out: 0,
  started_at: null,
  ended_at: null,
});

describe('groupSteps', () => {
  it('folds retries into one entry and counts loop visits', () => {
    const g = groupSteps([step('draft'), step('review', 1, 'failed'), step('review', 2), step('draft'), step('review')]);
    expect(g.map((x) => [x.step_id, x.visit, x.attempts.length])).toEqual([
      ['draft', 1, 1],
      ['review', 1, 2],
      ['draft', 2, 1],
      ['review', 2, 1],
    ]);
    expect(g[1]!.latest.attempt).toBe(2);
  });
});

describe('circuitSteps', () => {
  it('indexes steps by id and ignores malformed entries', () => {
    const m = circuitSteps({ steps: [{ id: 'a', kind: 'llm', subagent: 'writer', exits: [{ name: 'done' }] }, { kind: 'code' }, { id: 'g', kind: 'gate' }] });
    expect([...m.keys()]).toEqual(['a', 'g']);
    expect(m.get('a')).toMatchObject({ kind: 'llm', subagent: 'writer' });
    expect(circuitSteps(null).size).toBe(0);
  });
});
