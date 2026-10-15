/**
 * Breadboard dashboard health metrics ([10] §2): need-input rate, capacity/spend, session states, evals,
 * gateway fallbacks, connectors, the caller's review count. Served by `GET /dashboard` and folded into the
 * MCP `get_breadboard_overview` tool. Each panel degrades independently so one failing subsystem doesn't
 * blank the rest.
 */
import type { Principal } from './principal.js';
import type { ConnectorScheduler, ContentService, Dispatcher, EvalService, ModelGateway, SessionStore } from './services.js';

export interface DashboardServices {
  content: Pick<ContentService, 'healthMetric' | 'reviewCount'>;
  dispatcher: Pick<Dispatcher, 'capacity'>;
  sessions: Pick<SessionStore, 'countByState'>;
  evals: Pick<EvalService, 'dashboard'>;
  gateway: Pick<ModelGateway, 'fallbackEvents'>;
  connectors: Pick<ConnectorScheduler, 'status'>;
}

export interface Dashboard {
  need_input: Awaited<ReturnType<ContentService['healthMetric']>> | null;
  capacity: Awaited<ReturnType<Dispatcher['capacity']>> | null;
  sessions: { gated: number; suspended_error: number; running: number; queued: number };
  evals: Record<string, unknown> | null;
  gateway_fallbacks: ReturnType<ModelGateway['fallbackEvents']>;
  connectors: Awaited<ReturnType<ConnectorScheduler['status']>>;
  review_count: number;
}

export async function buildDashboard(services: DashboardServices, by: Principal, log: { warn(obj: unknown, msg?: string): void }): Promise<Dashboard> {
  const safe = async <T>(name: string, fn: () => Promise<T> | T, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      log.warn({ err, panel: name }, 'dashboard panel failed');
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
}
