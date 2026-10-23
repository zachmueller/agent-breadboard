/**
 * Content-plane REST surface ([11] §3.1, [09]): nodes, revisions, edges, lineage, comments,
 * need-input, gate verdicts, the review queue, and the need-input health metric.
 */
import type { FastifyInstance } from 'fastify';
import { validationFailed } from '@breadboard/shared';
import type { Services } from '../core/services.js';
import { requireScope } from '../core/principal.js';
import { GATE_VERDICT_SCOPE } from '../identity/identity.js';
import { API_PREFIX } from '../app.js';
import { arrayParam, intParam, principalOf, requireBody, requireField, strParam, withIdempotency } from './util.js';

type UidParams = { uid: string };

function revParam(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw validationFailed('revision must be a positive integer');
  return n;
}

export async function register(app: FastifyInstance, services: Services): Promise<void> {
  const { content } = services;
  const read = (req: any) => {
    const p = principalOf(req);
    requireScope(p, 'nodes:read');
    return p;
  };
  const write = (req: any) => {
    const p = principalOf(req);
    requireScope(p, 'nodes:write');
    return p;
  };

  // --- nodes -----------------------------------------------------------------
  app.get(`${API_PREFIX}/nodes`, async (req) => content.listNodes((req.query ?? {}) as Record<string, unknown>, read(req)));

  app.post(`${API_PREFIX}/nodes`, async (req, reply) => {
    const by = write(req);
    const body = requireBody(req);
    const type = requireField<string>(body, 'type');
    return withIdempotency(req, reply, services, async () => {
      const node = await content.createNode({
        type,
        title: body.title,
        properties: body.properties,
        body: body.body,
        tags: body.tags,
        scope: body.scope,
        crdt: body.crdt,
        derived_from: body.derived_from,
        by,
      });
      reply.status(201);
      return node;
    });
  });

  app.get<{ Params: UidParams }>(`${API_PREFIX}/nodes/:uid`, async (req) => content.getNode(req.params.uid, read(req)));

  app.patch<{ Params: UidParams }>(`${API_PREFIX}/nodes/:uid`, async (req) => content.patchNode(req.params.uid, requireBody(req), write(req)));

  app.delete<{ Params: UidParams }>(`${API_PREFIX}/nodes/:uid`, async (req, reply) => {
    await content.deleteNode(req.params.uid, write(req));
    reply.status(204);
    return null;
  });

  // --- revisions ---------------------------------------------------------------
  app.get<{ Params: UidParams }>(`${API_PREFIX}/nodes/:uid/revisions`, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const items = await content.revisions(req.params.uid, read(req), { limit: intParam(q.limit), before: intParam(q.before) });
    return { items, next_cursor: null };
  });

  app.get<{ Params: UidParams & { rev: string } }>(`${API_PREFIX}/nodes/:uid/revisions/:rev`, async (req) => content.revision(req.params.uid, revParam(req.params.rev), read(req)));

  /** Explicit publish: cut a `publish` revision of the current head ([01] §3.3). */
  app.post<{ Params: UidParams }>(`${API_PREFIX}/nodes/:uid/revisions`, async (req, reply) => {
    const by = write(req);
    return withIdempotency(req, reply, services, async () => {
      const node = await content.getNode(req.params.uid, by);
      if (node.tags.includes('read-only') && by.actor.kind !== 'service') throw validationFailed('read-only nodes are revised by their connector');
      const rev = await content.cutRevision(req.params.uid, ['publish'], by.actor);
      reply.status(201);
      return rev;
    });
  });

  // --- edges / lineage --------------------------------------------------------------
  app.get<{ Params: UidParams }>(`${API_PREFIX}/nodes/:uid/edges`, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const direction = (strParam(q.direction) ?? 'both') as 'in' | 'out' | 'both';
    const items = await content.edges(req.params.uid, read(req), { direction, type: arrayParam(q.type) });
    return { items, next_cursor: null };
  });

  app.get<{ Params: UidParams }>(`${API_PREFIX}/nodes/:uid/lineage`, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const direction = (strParam(q.direction) ?? 'up') as 'up' | 'down';
    return content.lineage(req.params.uid, direction, intParam(q.depth, 10)!, read(req));
  });

  app.post(`${API_PREFIX}/edges`, async (req, reply) => {
    const by = write(req);
    const body = requireBody(req);
    const type = requireField<string>(body, 'type');
    const src = requireField<string>(body, 'src');
    const dst = requireField<string>(body, 'dst');
    return withIdempotency(req, reply, services, async () => {
      const edge = await content.emitEdge({ type, src, dst, dst_revision: body.dst_revision ?? null, properties: body.properties, by });
      reply.status(201);
      return edge;
    });
  });

  app.delete<{ Params: { id: string } }>(`${API_PREFIX}/edges/:id`, async (req) => content.retractEdge(Number(req.params.id), write(req)));

  // --- comments ([09] §4) --------------------------------------------------------------
  app.post<{ Params: UidParams }>(`${API_PREFIX}/nodes/:uid/comments`, async (req, reply) => {
    const by = write(req);
    const body = requireBody(req);
    const text = requireField<string>(body, 'body');
    const anchor = body.anchor && typeof body.anchor === 'object' ? { revision: body.anchor.revision ?? null, quote: requireField<string>(body.anchor, 'quote'), context: body.anchor.context ?? null } : null;
    return withIdempotency(req, reply, services, async () => {
      const c = await content.addComment({ target: req.params.uid, body: text, anchor, by });
      reply.status(201);
      return c;
    });
  });

  app.get<{ Params: UidParams }>(`${API_PREFIX}/nodes/:uid/comments`, async (req) => ({ items: await content.comments(req.params.uid, read(req)), next_cursor: null }));

  // --- need-input ([09] §3) -------------------------------------------------------------
  app.post<{ Params: UidParams }>(`${API_PREFIX}/nodes/:uid/need-input`, async (req, reply) => {
    const by = write(req);
    const body = (req.body ?? {}) as Record<string, any>;
    return withIdempotency(req, reply, services, async () => {
      const r = await content.tagNeedInput({ uid: req.params.uid, role: body.role ?? null, username: body.username ?? null, prompt: body.prompt ?? null, by });
      reply.status(201);
      return r;
    });
  });

  app.post<{ Params: UidParams & { request_id: string } }>(`${API_PREFIX}/nodes/:uid/need-input/:request_id/resolve`, async (req, reply) => {
    const by = write(req);
    const body = (req.body ?? {}) as Record<string, any>;
    return withIdempotency(req, reply, services, () => content.resolveNeedInput({ uid: req.params.uid, request_id: req.params.request_id, verdict: body.verdict ?? null, comment: body.comment ?? null, by }));
  });

  // --- gate verdicts ([02] §5.4) -----------------------------------------------------------
  app.post<{ Params: UidParams }>(`${API_PREFIX}/nodes/:uid/gate-verdict`, async (req, reply) => {
    const by = write(req);
    requireScope(by, GATE_VERDICT_SCOPE);
    const body = requireBody(req);
    const request_id = requireField<string>(body, 'request_id');
    const verdict = requireField<string>(body, 'verdict');
    if (verdict !== 'approve' && verdict !== 'request-changes') throw validationFailed("verdict must be 'approve' or 'request-changes'");
    return withIdempotency(req, reply, services, () => services.orchestrator.gateVerdict({ node_uid: req.params.uid, request_id, verdict, comment: body.comment ?? null, edits: body.edits, by }));
  });

  // --- review queue / health ------------------------------------------------------------------
  app.get(`${API_PREFIX}/review-queue`, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    return { items: await content.reviewQueue(read(req), { limit: intParam(q.limit) }), next_cursor: null };
  });

  app.get(`${API_PREFIX}/review-queue/count`, async (req) => ({ count: await content.reviewCount(read(req)) }));

  app.get(`${API_PREFIX}/health/need-input`, async (req) => {
    read(req);
    const q = (req.query ?? {}) as Record<string, unknown>;
    return content.healthMetric({ days: intParam(q.days, 30) });
  });
}
