import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BreadboardError } from '@breadboard/shared';
import type { Services } from './core/services.js';
import { authenticateRequest } from './api/util.js';
import { registerRoutes } from './api/index.js';

export const API_PREFIX = '/api/v1';

/** Paths that don't require authentication. */
const PUBLIC_PATHS = new Set([`${API_PREFIX}/health`, `${API_PREFIX}/auth/login`, `${API_PREFIX}/auth/oidc/start`, `${API_PREFIX}/auth/oidc/callback`, `${API_PREFIX}/auth/mode`, `${API_PREFIX}/auth/logout`, `${API_PREFIX}/sync`]);

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: services.log as any,
    bodyLimit: 32 * 1024 * 1024,
    trustProxy: true,
    disableRequestLogging: services.env.NODE_ENV !== 'development',
  });
  app.decorateRequest('principal', null);
  app.decorate('services', services);

  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 64 * 1024 * 1024 } });

  // Authentication: every /api request resolves to a Principal ([11] §2).
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith(API_PREFIX)) return;
    const path = req.url.split('?')[0]!;
    if (PUBLIC_PATHS.has(path)) return;
    (req as any).principal = await authenticateRequest(services.auth, req);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof BreadboardError) {
      reply.status(err.status).send(err.toJSON());
      return;
    }
    if (err?.validation) {
      reply.status(400).send({ error: { code: 'validation-failed', message: err.message, detail: err.validation } });
      return;
    }
    if (err?.statusCode && err.statusCode < 500) {
      reply.status(err.statusCode).send({ error: { code: err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ? 'validation-failed' : 'bad-request', message: err.message } });
      return;
    }
    req.log.error({ err }, 'unhandled error');
    reply.status(500).send({ error: { code: 'internal', message: services.env.NODE_ENV === 'production' ? 'internal error' : String(err?.message ?? err) } });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith(API_PREFIX)) {
      reply.status(404).send({ error: { code: 'not-found', message: `no route ${req.method} ${req.url}` } });
      return;
    }
    // SPA fallback
    const ui = uiDir(services);
    if (ui) return (reply as any).sendFile('index.html');
    reply.status(404).send({ error: { code: 'not-found', message: 'UI not built; run `npm run build -w @breadboard/ui`' } });
  });

  await registerRoutes(app, services);

  const ui = uiDir(services);
  if (ui) {
    await app.register(fastifyStatic, { root: ui, prefix: '/', wildcard: false, index: ['index.html'] });
  }

  return app;
}

function uiDir(services: Services): string | null {
  const candidates = [services.env.UI_DIST_DIR, resolve(process.cwd(), 'packages/ui/dist'), resolve(process.cwd(), '../ui/dist'), resolve(process.cwd(), 'ui')].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(resolve(c, 'index.html'))) return resolve(c);
  return null;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: import('./core/principal.js').Principal | null;
  }
  interface FastifyInstance {
    services: Services;
  }
}
