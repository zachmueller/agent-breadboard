import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFoundation, type Foundation } from '../test/harness.js';
import { createSessionStore } from '../orchestrator/session-store.js';
import { buildDashboard, type DashboardServices } from './dashboard.js';

let f: Foundation;

beforeAll(async () => {
  f = await createFoundation();
});

afterAll(async () => {
  await f?.close();
});

describe('dashboard session tiles', () => {
  it('Running counts circuit and eval runs, not open chats or MCP connections', async () => {
    const sessions = createSessionStore({ db: f.db, team_id: f.team_id });
    const budget = { max_cost_usd: 0, max_tokens: 0, spent_usd: 0, spent_tokens: 0 };
    const by = f.memberPrincipal.actor;
    await sessions.create({ kind: 'circuit-run', budget, created_by: by, state: 'running' });
    await sessions.create({ kind: 'eval-run', budget, created_by: by, state: 'running' });
    await sessions.create({ kind: 'conversation', budget, created_by: by, state: 'running', state_detail: { mcp: true, external: true } });
    await sessions.create({ kind: 'conversation', budget, created_by: by, state: 'running', state_detail: { title: 'Designer: lit-review' } });
    await sessions.create({ kind: 'intake', budget, created_by: by, state: 'running' });
    // The other panels' services are absent; each degrades on its own.
    const d = await buildDashboard({ sessions } as unknown as DashboardServices, f.memberPrincipal, { warn: () => undefined });
    expect(d.sessions).toEqual({ gated: 0, suspended_error: 0, running: 2, queued: 0 });
  });
});
