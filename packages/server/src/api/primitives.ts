/**
 * Primitives over REST ([06] §7): the endpoint sandboxed tool code's `ctx` calls. The actor token carries
 * the execution key (and the caller's grants); composition depth travels in `x-breadboard-depth`.
 */
import type { FastifyInstance } from 'fastify';
import type { Services } from '../core/services.js';
import { API_PREFIX } from '../app.js';
import { principalOf } from './util.js';

export async function register(app: FastifyInstance, services: Services): Promise<void> {
  app.get(`${API_PREFIX}/primitives`, async (req) => {
    const p = principalOf(req);
    return { items: services.primitives.specsFor(p) };
  });

  app.post<{ Params: { name: string } }>(`${API_PREFIX}/primitives/:name`, async (req) => {
    const p = principalOf(req);
    const depthHeader = req.headers['x-breadboard-depth'];
    const depth = Number(Array.isArray(depthHeader) ? depthHeader[0] : (depthHeader ?? 0));
    const out = await services.primitives.call(req.params.name, req.body ?? {}, p, {
      session_id: p.session_id,
      step_id: p.actor.step_id ?? null,
      depth: Number.isFinite(depth) && depth >= 0 ? depth : 0,
    });
    // Fastify serializes `undefined` as an empty body; keep the wire JSON.
    return out === undefined ? null : out;
  });
}
