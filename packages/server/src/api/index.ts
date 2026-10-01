import type { FastifyInstance } from 'fastify';
import type { Services } from '../core/services.js';
import { API_PREFIX } from '../app.js';

/**
 * Route registration. Each API module exports `register(app, services)` and mounts under /api/v1.
 * Modules are added here as subsystems land; a missing module file is a build error, not a runtime one.
 */
export async function registerRoutes(app: FastifyInstance, services: Services): Promise<void> {
  app.get(`${API_PREFIX}/health`, async () => ({ ok: true, name: 'agent-breadboard', version: '0.1.0', db: services.db.kind, provider: services.gateway.providers(), sandbox: services.sandbox.kind }));

  const modules = await Promise.all([
    import('./auth.js'),
    import('./nodes.js'),
    import('./knowledge.js'),
    import('./tasks.js'),
    import('./sessions.js'),
    import('./config.js'),
    import('./evals.js'),
    import('./events.js'),
    import('./primitives.js'),
    import('./admin.js'),
    import('./conversations.js'),
    import('./dashboard.js'),
    import('../mcp/http.js'),
  ]);
  for (const m of modules) await m.register(app, services);
  await services.sync.register(app);
}
