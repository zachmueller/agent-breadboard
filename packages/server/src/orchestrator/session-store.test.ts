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

describe('list paging', () => {
  it('pages by offset with a total, by cursor in either order without skipping same-millisecond rows, and filters a date window', async () => {
    const budget = { max_cost_usd: 0, max_tokens: 0, spent_usd: 0, spent_tokens: 0 };
    const by = { kind: 'user' as const, id: 'pager-test' };
    const made: string[] = [];
    for (let i = 0; i < 7; i++) made.push((await sessions.create({ kind: 'circuit-run', budget, created_by: by, state: 'completed' })).session_id);
    // Days 1..7 of January; the last three share one millisecond and differ only in microseconds.
    const at = ['2026-01-01T10:00:00Z', '2026-01-02T10:00:00Z', '2026-01-03T10:00:00Z', '2026-01-04T10:00:00Z', '2026-01-05 10:00:00.123001+00', '2026-01-05 10:00:00.123002+00', '2026-01-05 10:00:00.123003+00'];
    for (let i = 0; i < made.length; i++) await f.db.query(`UPDATE sessions SET created_at = $2::timestamptz WHERE session_id = $1`, [made[i], at[i]]);
    const newest = [...made].reverse();

    const p1 = await sessions.list({ created_by: by.id, offset: 0, limit: 3 });
    expect(p1.total).toBe(7);
    expect(p1.next_cursor).toBeNull();
    expect(p1.items.map((s) => s.session_id)).toEqual(newest.slice(0, 3));
    expect((await sessions.list({ created_by: by.id, offset: 6, limit: 3 })).items.map((s) => s.session_id)).toEqual(newest.slice(6));
    expect((await sessions.list({ created_by: by.id, offset: 0, limit: 2, order: 'asc' })).items.map((s) => s.session_id)).toEqual(made.slice(0, 2));

    for (const order of ['desc', 'asc'] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await sessions.list({ created_by: by.id, order, cursor, limit: 2 });
        seen.push(...page.items.map((s) => s.session_id));
        cursor = page.next_cursor;
      } while (cursor);
      expect(seen).toEqual(order === 'desc' ? newest : made);
    }

    const window = await sessions.list({ created_by: by.id, created_after: '2026-01-02T00:00:00Z', created_before: '2026-01-04T23:59:59.999Z', offset: 0 });
    expect(window.total).toBe(3);
    expect(window.items.map((s) => s.session_id)).toEqual([made[3], made[2], made[1]]);
  });

  it('sums cost including children for many sessions in one query', async () => {
    const budget = { max_cost_usd: 5, max_tokens: 1000, spent_usd: 0, spent_tokens: 0 };
    const by = f.memberPrincipal.actor;
    const a = await sessions.create({ kind: 'circuit-run', budget, created_by: by, state: 'running' });
    const kid = await sessions.create({ kind: 'circuit-run', budget, created_by: by, state: 'running', parent_session: a.session_id, parent_step_id: 's' });
    const b = await sessions.create({ kind: 'circuit-run', budget, created_by: by, state: 'running' });
    const turn = { step_id: 's', role: 'assistant' as const, username: null, content: [], model_id: 'm', tokens_in: 1, tokens_out: 1 };
    await sessions.recordTurn({ ...turn, session_id: a.session_id, cost_usd: 0.5 });
    await sessions.recordTurn({ ...turn, session_id: kid.session_id, cost_usd: 0.25 });
    const costs = await sessions.costsIncludingChildren([a.session_id, b.session_id, kid.session_id]);
    expect([costs.get(a.session_id), costs.get(b.session_id), costs.get(kid.session_id)]).toEqual([0.75, 0, 0.25]);
    expect(costs.get(a.session_id)).toBe(await sessions.costIncludingChildren(a.session_id));
    expect((await sessions.costsIncludingChildren([])).size).toBe(0);
  });
});
