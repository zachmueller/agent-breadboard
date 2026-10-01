import type { FastifyInstance } from 'fastify';
import { validationFailed } from '@breadboard/shared';
import type { Services } from '../core/services.js';
import { requireScope, requireUser } from '../core/principal.js';
import { API_PREFIX } from '../app.js';
import { intParam, principalOf, requireBody, requireField, strParam, withIdempotency } from './util.js';

const KINDS = ['intake', 'conversation'] as const;
type Kind = (typeof KINDS)[number];

function kindOf(v: unknown, required: boolean): Kind | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw validationFailed("field 'kind' is required");
    return undefined;
  }
  if (!KINDS.includes(v as Kind)) throw validationFailed(`kind must be one of ${KINDS.join(', ')}`);
  return v as Kind;
}

function objectOrUndefined(v: unknown, field: string): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw validationFailed(`${field} must be an object`);
  return v as Record<string, unknown>;
}

/** Intake idea-shaping + designer chat conversations ([08] §4, §7.1; [10] §4). */
export async function register(app: FastifyInstance, services: Services): Promise<void> {
  const P = `${API_PREFIX}/conversations`;

  app.post(P, async (req, reply) => {
    const by = principalOf(req);
    requireScope(by, 'sessions:write');
    requireUser(by);
    const body = requireBody(req);
    const kind = kindOf(body.kind, true)!;
    return withIdempotency(req, reply, services, async () => {
      const session = await services.conversations.start({
        kind,
        subagent_uid: typeof body.subagent_uid === 'string' ? body.subagent_uid : null,
        context: objectOrUndefined(body.context, 'context'),
        title: typeof body.title === 'string' ? body.title : undefined,
        by,
      });
      reply.status(201);
      return session;
    });
  });

  app.get(P, async (req) => {
    const by = principalOf(req);
    requireScope(by, 'sessions:read');
    const q = req.query as Record<string, unknown>;
    const items = await services.conversations.list({ kind: kindOf(strParam(q.kind), false), limit: intParam(q.limit, 50), by });
    return { items, next_cursor: null };
  });

  app.get(`${P}/:id`, async (req) => {
    const by = principalOf(req);
    requireScope(by, 'sessions:read');
    const { id } = req.params as { id: string };
    const turns = await services.conversations.turns(id, by); // access check + kind check
    const [session, draft_task] = await Promise.all([services.sessions.mustGet(id), services.conversations.draftTask(id)]);
    return { session, turns, draft_task };
  });

  app.post(`${P}/:id/messages`, async (req, reply) => {
    const by = principalOf(req);
    requireScope(by, 'sessions:write');
    const body = requireBody(req);
    const text = requireField<string>(body, 'text');
    if (typeof text !== 'string' || !text.trim()) throw validationFailed("field 'text' must be a non-empty string");
    const { id } = req.params as { id: string };
    return withIdempotency(req, reply, services, async () => {
      const out = await services.conversations.post({ session_id: id, text, context: objectOrUndefined(body.context, 'context'), by });
      return { turns: out.turns, draft_task: out.draft_task ?? null, proposals: out.proposals ?? [] };
    });
  });

  app.get(`${P}/:id/draft-task`, async (req) => {
    const by = principalOf(req);
    requireScope(by, 'sessions:read');
    const { id } = req.params as { id: string };
    await services.conversations.turns(id, by); // access check
    return { draft_task: await services.conversations.draftTask(id) };
  });
}
