import type { FastifyInstance } from 'fastify';
import { notFound, validationFailed, type SessionRecord } from '@breadboard/shared';
import type { Services } from '../core/services.js';
import { canSeeSession, requireScope, type Principal } from '../core/principal.js';
import { API_PREFIX } from '../app.js';
import { arrayParam, intParam, principalOf, requireBody, requireField, strParam, withIdempotency } from './util.js';

const STATES = ['queued', 'running', 'suspended-gate', 'suspended-error', 'completed', 'cancelled'];
const KINDS = ['circuit-run', 'intake', 'conversation', 'eval-run'];

/** Sessions REST surface ([11] §3 Sessions, [02] §7). Users see all sessions; subagent/code-step principals see only their session family. */
export async function register(app: FastifyInstance, services: Services): Promise<void> {
  const P = `${API_PREFIX}/sessions`;

  /** Visibility failures read as not-found so session ids outside the family do not leak. */
  const visible = async (by: Principal, id: string): Promise<SessionRecord> => {
    if (!canSeeSession(by, id)) throw notFound('session', id);
    const s = await services.sessions.get(id);
    if (!s) throw notFound('session', id);
    return s;
  };
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get(P, async (req) => {
    const by = principalOf(req);
    requireScope(by, 'sessions:read');
    const q = req.query as Record<string, unknown>;
    const state = arrayParam(q.state);
    const kind = arrayParam(q.kind);
    if (state?.some((s) => !STATES.includes(s))) throw validationFailed(`state must be one of ${STATES.join(', ')}`);
    if (kind?.some((k) => !KINDS.includes(k))) throw validationFailed(`kind must be one of ${KINDS.join(', ')}`);
    const limit = Math.min(Math.max(intParam(q.limit, 50) ?? 50, 1), 200);
    const page = await services.sessions.list({
      state,
      kind,
      circuit: strParam(q.circuit),
      task: strParam(q.task),
      parent: strParam(q.parent),
      created_after: strParam(q.created_after),
      created_before: strParam(q.created_before),
      cursor: strParam(q.cursor) ?? null,
      limit,
    });
    const items = page.items.filter((s) => canSeeSession(by, s.session_id));
    const withCost = await Promise.all(items.map(async (s) => ({ ...s, cost_usd: await services.sessions.costIncludingChildren(s.session_id) })));
    return { items: withCost, next_cursor: page.next_cursor ?? null };
  });

  app.get(`${P}/:id`, async (req) => {
    const by = principalOf(req);
    requireScope(by, 'sessions:read');
    const s = await visible(by, idOf(req));
    return services.sessions.summary(s.session_id);
  });

  app.get(`${P}/:id/events`, async (req) => {
    const by = principalOf(req);
    requireScope(by, 'sessions:read');
    const s = await visible(by, idOf(req));
    const q = req.query as Record<string, unknown>;
    const after = Math.max(intParam(q.after_seq, intParam(q.cursor, 0)) ?? 0, 0);
    const limit = Math.min(Math.max(intParam(q.limit, 500) ?? 500, 1), 5000);
    const items = await services.sessions.events(s.session_id, after, limit);
    return { items, next_cursor: items.length === limit ? String(items[items.length - 1]!.seq) : null };
  });

  app.get(`${P}/:id/turns`, async (req) => {
    const by = principalOf(req);
    requireScope(by, 'sessions:read');
    const s = await visible(by, idOf(req));
    const limit = intParam((req.query as Record<string, unknown>).limit);
    const items = await services.sessions.turns(s.session_id);
    return { items: limit && limit > 0 ? items.slice(-limit) : items };
  });

  app.get(`${P}/:id/steps/:step/turns`, async (req) => {
    const by = principalOf(req);
    requireScope(by, 'sessions:read');
    const s = await visible(by, idOf(req));
    const q = req.query as Record<string, unknown>;
    const raw = decodeURIComponent((req.params as { step: string }).step);
    // `name#n` addresses one attempt; a plain name returns all attempts (`?attempt=` also accepted).
    const m = /^(.+)#(\d+)$/.exec(raw);
    const stepId = m ? m[1]! : raw;
    const attempt = m ? Number(m[2]) : intParam(q.attempt);
    const items = await services.sessions.turns(s.session_id, stepId, attempt);
    const limit = intParam(q.limit);
    return { items: limit && limit > 0 ? items.slice(-limit) : items };
  });

  app.get(`${P}/:id/executions`, async (req) => {
    const by = principalOf(req);
    requireScope(by, 'sessions:read');
    const s = await visible(by, idOf(req));
    return { items: await services.toolbox.executions(s.session_id) };
  });

  app.post(`${P}/:id/retry`, async (req, reply) => {
    const by = principalOf(req);
    requireScope(by, 'sessions:write');
    const s = await visible(by, idOf(req));
    return withIdempotency(req, reply, services, () => services.orchestrator.retry(s.session_id, by));
  });

  app.post(`${P}/:id/cancel`, async (req, reply) => {
    const by = principalOf(req);
    requireScope(by, 'sessions:write');
    const s = await visible(by, idOf(req));
    const body = (req.body ?? {}) as { reason?: unknown };
    if (body.reason != null && typeof body.reason !== 'string') throw validationFailed('reason must be a string');
    return withIdempotency(req, reply, services, () => services.orchestrator.cancel(s.session_id, by, (body.reason as string | undefined) ?? undefined));
  });

  app.post(`${P}/:id/resume`, async (req, reply) => {
    const by = principalOf(req);
    requireScope(by, 'sessions:write');
    const s = await visible(by, idOf(req));
    const body = (req.body ?? {}) as { budget?: Record<string, unknown> };
    const b = body.budget;
    if (b != null && (typeof b !== 'object' || Array.isArray(b))) throw validationFailed('budget must be an object {max_cost_usd?, max_tokens?}');
    const budget: { max_cost_usd?: number; max_tokens?: number } = {};
    for (const k of ['max_cost_usd', 'max_tokens'] as const) {
      if (b?.[k] == null) continue;
      if (typeof b[k] !== 'number' || !Number.isFinite(b[k] as number)) throw validationFailed(`budget.${k} must be a number`);
      budget[k] = b[k] as number;
    }
    return withIdempotency(req, reply, services, () => services.orchestrator.resume(s.session_id, by, { budget }));
  });

  app.post(`${P}/:id/route`, async (req, reply) => {
    const by = principalOf(req);
    requireScope(by, 'sessions:write');
    const s = await visible(by, idOf(req));
    const body = requireBody(req);
    const exit = requireField<string>(body, 'exit');
    return withIdempotency(req, reply, services, () => services.orchestrator.manualRoute(s.session_id, exit, body.output ?? {}, by));
  });

  app.post(`${P}/:id/promote-fixture`, async (req, reply) => {
    const by = principalOf(req);
    requireScope(by, 'sessions:write');
    const s = await visible(by, idOf(req));
    const body = requireBody(req);
    const fixture_title = requireField<string>(body, 'fixture_title');
    const tags = Array.isArray(body.tags) ? body.tags.map(String) : undefined;
    const notes = typeof body.notes === 'string' ? body.notes : undefined;
    return withIdempotency(req, reply, services, async () => {
      const out = await services.evals.promoteFixture({ session_id: s.session_id, fixture_title, tags, notes, by });
      reply.status(201);
      return out;
    });
  });

  app.get(`${API_PREFIX}/dispatcher/capacity`, async (req) => {
    requireScope(principalOf(req), 'sessions:read');
    return services.dispatcher.capacity();
  });
}
