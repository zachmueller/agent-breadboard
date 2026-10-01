/** Intake task REST surface ([08] §2, [11] §3.2). */
import type { FastifyInstance } from 'fastify';
import type { Services } from '../core/services.js';
import { requireScope } from '../core/principal.js';
import { API_PREFIX } from '../app.js';
import { arrayParam, boolParam, intParam, principalOf, requireBody, requireField, strParam, withIdempotency } from './util.js';

type UidParams = { uid: string };

export async function register(app: FastifyInstance, services: Services): Promise<void> {
  const { tasks } = services;
  const read = (req: any) => {
    const p = principalOf(req);
    requireScope(p, 'tasks:read');
    return p;
  };
  const write = (req: any) => {
    const p = principalOf(req);
    requireScope(p, 'tasks:write');
    return p;
  };

  app.post(`${API_PREFIX}/tasks`, async (req, reply) => {
    const by = write(req);
    const body = requireBody(req);
    const title = requireField<string>(body, 'title');
    const text = typeof body.body === 'string' ? body.body : '';
    const draft = boolParam((req.query as any)?.draft) ?? body.draft === true;
    return withIdempotency(req, reply, services, async () => {
      const t = await tasks.create({ title, body: text, priority: body.priority, target_circuit: body.target_circuit ?? null, draft, tags: body.tags, budget: body.budget ?? null, by });
      reply.status(201);
      return t;
    });
  });

  app.get(`${API_PREFIX}/tasks`, async (req) => tasks.list((req.query ?? {}) as Record<string, unknown>, read(req)));

  app.get(`${API_PREFIX}/tasks/similar`, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    return { items: await tasks.similar(strParam(q.q) ?? '', read(req), intParam(q.limit, 5)) };
  });

  app.post<{ Params: UidParams }>(`${API_PREFIX}/tasks/:uid/accept`, async (req, reply) => {
    const by = write(req);
    return withIdempotency(req, reply, services, () => tasks.accept(req.params.uid, by));
  });

  app.post<{ Params: UidParams }>(`${API_PREFIX}/tasks/:uid/reject`, async (req, reply) => {
    const by = write(req);
    const reason = strParam((req.body as any)?.reason);
    return withIdempotency(req, reply, services, () => tasks.reject(req.params.uid, by, reason));
  });

  app.post<{ Params: UidParams }>(`${API_PREFIX}/tasks/:uid/promote`, async (req, reply) => {
    const by = write(req);
    const priority = strParam((req.body as any)?.priority);
    return withIdempotency(req, reply, services, () => tasks.promote(req.params.uid, by, priority));
  });

  app.post<{ Params: UidParams }>(`${API_PREFIX}/tasks/:uid/mark-reviewed`, async (req, reply) => {
    const by = write(req);
    return withIdempotency(req, reply, services, () => tasks.markReviewed(req.params.uid, by));
  });

  app.get<{ Params: UidParams }>(`${API_PREFIX}/tasks/:uid/sessions`, async (req) => {
    const by = read(req);
    await services.content.getNode(req.params.uid, by); // visibility check
    const q = (req.query ?? {}) as Record<string, unknown>;
    return services.sessions.list({ task: req.params.uid, state: arrayParam(q.state), cursor: strParam(q.cursor) ?? null, limit: intParam(q.limit) });
  });
}
