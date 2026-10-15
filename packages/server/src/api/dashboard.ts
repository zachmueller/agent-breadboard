import type { FastifyInstance } from 'fastify';
import type { Services } from '../core/services.js';
import { API_PREFIX } from '../app.js';
import { buildDashboard } from '../core/dashboard.js';
import { principalOf } from './util.js';

/** Breadboard dashboard health metrics ([10] §2); the aggregation lives in `core/dashboard.ts`. */
export async function register(app: FastifyInstance, services: Services): Promise<void> {
  app.get(`${API_PREFIX}/dashboard`, async (req) => buildDashboard(services, principalOf(req), req.log));
}
