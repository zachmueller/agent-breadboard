import type { FastifyInstance } from 'fastify';
import type { Services } from '../core/services.js';
import { API_PREFIX } from '../app.js';
import { principalOf } from './util.js';

/** Breadboard dashboard health metrics ([10] §2): need-input rate, capacity/spend, session states, evals, gateway, connectors. */
export async function register(app: FastifyInstance, services: Services): Promise<void> {
  app.get(`${API_PREFIX}/dashboard`, async (req) => {
    const by = principalOf(req);
    // Each panel degrades independently so one failing subsystem doesn't blank the dashboard.
    const safe = async <T>(name: string, fn: () => Promise<T> | T, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        req.log.warn({ err, panel: name }, 'dashboard panel failed');
        return fallback;
      }
    };
    const count = (state: string) => safe(`sessions.${state}`, () => services.sessions.countByState(state), 0);
    const [need_input, capacity, gated, suspended_error, running, queued, evals, gateway_fallbacks, connectors, review_count] = await Promise.all([
      safe('need_input', () => services.content.healthMetric({ days: 30 }), null),
      safe('capacity', () => services.dispatcher.capacity(), null),
      count('suspended-gate'),
      count('suspended-error'),
      count('running'),
      count('queued'),
      safe('evals', () => services.evals.dashboard(), null),
      safe('gateway_fallbacks', () => services.gateway.fallbackEvents().slice(-20), []),
      safe('connectors', () => services.connectors.status(), []),
      safe('review_count', () => services.content.reviewCount(by), 0),
    ]);
    return { need_input, capacity, sessions: { gated, suspended_error, running, queued }, evals, gateway_fallbacks, connectors, review_count };
  });
}
