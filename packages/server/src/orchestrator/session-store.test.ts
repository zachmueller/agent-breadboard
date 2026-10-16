import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFoundation, type Foundation } from '../test/harness.js';
import { createSessionStore, type PgSessionStore } from './session-store.js';

let f: Foundation;
let sessions: PgSessionStore;

beforeAll(async () => {
  f = await createFoundation();
  sessions = createSessionStore({ db: f.db, team_id: f.team_id });
});

afterAll(async () => {
  await f?.close();
});

describe('prompt-cache token accounting', () => {
  it('stores cache reads/writes per turn, counts them in budgets and tree totals, and sums them in summaries', async () => {
    const budget = { max_cost_usd: 5, max_tokens: 100_000, spent_usd: 0, spent_tokens: 0 };
    const parent = await sessions.create({ kind: 'circuit-run', budget, created_by: f.memberPrincipal.actor, state: 'running' });
    const child = await sessions.create({ kind: 'circuit-run', budget, created_by: f.memberPrincipal.actor, state: 'running', parent_session: parent.session_id, parent_step_id: 'sub' });
    const base = { step_id: 'think', role: 'assistant' as const, username: null, content: [{ type: 'text', text: 'x' }], model_id: 'm' };
    const t = await sessions.recordTurn({ ...base, session_id: parent.session_id, tokens_in: 10, tokens_out: 20, tokens_cache_read: 3000, tokens_cache_write: 400, cost_usd: 0.01 });
    expect(t).toMatchObject({ tokens_in: 10, tokens_out: 20, tokens_cache_read: 3000, tokens_cache_write: 400 });
    await sessions.recordTurn({ ...base, session_id: child.session_id, tokens_in: 1, tokens_out: 2, tokens_cache_read: 100, cost_usd: 0.001 });

    // Budgets count every token the model processed, cached or not.
    expect((await sessions.mustGet(parent.session_id)).budget.spent_tokens).toBe(3430);
    expect(await sessions.cost(parent.session_id)).toEqual({ cost_usd: 0.01, tokens_in: 10, tokens_out: 20, tokens_cache_read: 3000, tokens_cache_write: 400 });
    expect((await sessions.treeCost(parent.session_id)).tokens).toBe(3430 + 103);

    await sessions.upsertCheckpoint({ session_id: parent.session_id, step_id: 'think', attempt: 1, status: 'exited', ambient: {}, cost_usd: 0.01, tokens_in: 10, tokens_out: 20, tokens_cache_read: 3000, tokens_cache_write: 400, ended: true });
    const summary = await sessions.summary(parent.session_id);
    expect(summary).toMatchObject({ tokens_in: 10, tokens_out: 20, tokens_cache_read: 3000, tokens_cache_write: 400 });
    expect(summary.steps[0]).toMatchObject({ step_id: 'think', tokens_cache_read: 3000, tokens_cache_write: 400 });

    // Turns without cache usage keep null columns.
    const plain = await sessions.recordTurn({ ...base, session_id: child.session_id, tokens_in: 5, tokens_out: 5, cost_usd: 0 });
    expect(plain).toMatchObject({ tokens_cache_read: null, tokens_cache_write: null });
  });
});

describe('countByState', () => {
  it('counts every kind in a state, or only the given kinds', async () => {
    const budget = { max_cost_usd: 0, max_tokens: 0, spent_usd: 0, spent_tokens: 0 };
    const [all, runs] = await Promise.all([sessions.countByState('suspended-error'), sessions.countByState('suspended-error', ['circuit-run', 'eval-run'])]);
    for (const kind of ['circuit-run', 'eval-run', 'conversation', 'intake'] as const) await sessions.create({ kind, budget, created_by: f.memberPrincipal.actor, state: 'suspended-error' });
    expect(await sessions.countByState('suspended-error')).toBe(all + 4);
    expect(await sessions.countByState('suspended-error', ['circuit-run', 'eval-run'])).toBe(runs + 2);
    expect(await sessions.countByState('suspended-error', [])).toBe(all + 4);
  });
});
