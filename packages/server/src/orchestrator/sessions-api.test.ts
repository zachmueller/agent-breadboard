import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { BreadboardError, SERVICE_ACTOR, mintUid } from '@breadboard/shared';
import type { Services } from '../core/services.js';
import type { Principal } from '../core/principal.js';
import { register } from '../api/sessions.js';
import { createKit, type Kit } from './testkit.js';

let k: Kit;
let app: FastifyInstance;
let sessionId: string;
let otherId: string;
const promoted: unknown[] = [];

function subagentFor(id: string): Principal {
  return { ...k.f.servicePrincipal, actor: { kind: 'subagent', id: mintUid(), session_id: id } as any, user: null, is_admin: false, scopes: null, session_id: id, visible_sessions: [id], token_kind: 'actor' as any } as Principal;
}

beforeAll(async () => {
  k = await createKit();
  const sa = mintUid();
  k.llm.set(sa, () => ({ exit: 'done', output: {} }));
  const c = k.config.add({ slug: 'api-circuit', exits: [{ name: 'done' }], entry: 'think', steps: [{ id: 'think', kind: 'llm', subagent: sa, prompt_inline: 'hi', output: { type: 'object' }, exits: [{ name: 'done', to: '$exit.done' }] }] });
  const s = await k.orch.enqueue({ circuit_uid: c.uid, input: {}, created_by: SERVICE_ACTOR('test') });
  await k.orch.run(s.session_id);
  sessionId = s.session_id;
  otherId = (await k.orch.enqueue({ circuit_uid: c.uid, input: {}, created_by: SERVICE_ACTOR('test') })).session_id;

  const services = {
    db: k.f.db,
    sessions: k.sessions,
    orchestrator: k.orch,
    dispatcher: k.dispatcher,
    toolbox: { executions: async () => [{ execution_key: 'ek' }] },
    evals: { promoteFixture: async (inp: unknown) => (promoted.push(inp), { fixture_id: 'fx_1', commit: 'abc' }) },
  } as unknown as Services;
  app = Fastify();
  app.decorateRequest('principal', null);
  app.addHook('preHandler', async (req) => {
    const as = req.headers['x-as'];
    (req as any).principal = as === 'subagent' ? subagentFor(sessionId) : k.f.adminPrincipal;
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof BreadboardError) return reply.status(err.status).send(err.toJSON());
    return reply.status(500).send({ error: { code: 'internal', message: String(err?.message) } });
  });
  await register(app, services);
});
afterAll(async () => {
  await app.close();
  await k.close();
});

describe('sessions REST', () => {
  it('lists, reads, pages events, and returns turns', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/sessions?state=completed' });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((s: any) => s.session_id)).toEqual([sessionId]);
    expect(list.json().items[0].cost_usd).toBeCloseTo(0.01, 6);
    expect(list.json().total).toBeUndefined();

    // Offset mode: a numbered page with the total; a date window and order are validated before SQL.
    const paged = await app.inject({ method: 'GET', url: '/api/v1/sessions?state=completed&offset=0&limit=1&order=asc&created_after=2000-01-01' });
    expect(paged.statusCode).toBe(200);
    expect(paged.json()).toMatchObject({ total: 1, next_cursor: null });
    expect(paged.json().items[0].cost_usd).toBeCloseTo(0.01, 6);
    expect((await app.inject({ method: 'GET', url: '/api/v1/sessions?state=completed&offset=0&created_before=2000-01-01' })).json()).toMatchObject({ items: [], total: 0 });
    for (const bad of ['created_after=yesterday', 'offset=-1', 'order=sideways']) {
      const r = await app.inject({ method: 'GET', url: `/api/v1/sessions?${bad}` });
      expect([bad, r.statusCode, r.json().error.code]).toEqual([bad, 400, 'validation-failed']);
    }

    const one = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}` });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ session_id: sessionId, state: 'completed' });

    const ev = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}/events?limit=2` });
    expect(ev.json().items).toHaveLength(2);
    expect(ev.json().next_cursor).toBe('2');
    const ev2 = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}/events?after_seq=2&limit=1000` });
    expect(ev2.json().items[0].seq).toBe(3);
    expect(ev2.json().next_cursor).toBeNull();

    const turns = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}/steps/${encodeURIComponent('think#1')}/turns` });
    expect(turns.json().items.map((t: any) => t.role)).toEqual(['user', 'assistant']);
    const none = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}/steps/${encodeURIComponent('think#2')}/turns` });
    expect(none.json().items).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}/turns` })).json().items).toHaveLength(2);
    expect((await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}/executions` })).json().items).toHaveLength(1);
    const cap = await app.inject({ method: 'GET', url: '/api/v1/dispatcher/capacity' });
    expect(cap.json()).toMatchObject({ max_concurrent_runs: 4, queued: 1 });
  });

  it('scopes subagent principals to their session family', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/sessions', headers: { 'x-as': 'subagent' } });
    expect(list.json().items.map((s: any) => s.session_id)).toEqual([sessionId]);
    const other = await app.inject({ method: 'GET', url: `/api/v1/sessions/${otherId}`, headers: { 'x-as': 'subagent' } });
    expect(other.statusCode).toBe(404);
  });

  it('actions: invalid state, cancel, promote-fixture', async () => {
    const retry = await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/retry`, payload: {} });
    expect(retry.statusCode).toBe(409);
    const route = await app.inject({ method: 'POST', url: `/api/v1/sessions/${otherId}/route`, payload: {} });
    expect(route.statusCode).toBe(400);
    const cancel = await app.inject({ method: 'POST', url: `/api/v1/sessions/${otherId}/cancel`, payload: { reason: 'nope' } });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().state).toBe('cancelled');
    const promote = await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/promote-fixture`, payload: { fixture_title: 'Golden' } });
    expect(promote.statusCode).toBe(201);
    expect(promoted[0]).toMatchObject({ session_id: sessionId, fixture_title: 'Golden' });
  });
});
