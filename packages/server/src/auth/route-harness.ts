/**
 * Test-only: a minimal Fastify app wired like `app.ts` (cookie plugin, auth preHandler, error
 * handler) that registers only the events/auth/admin route modules over a partial `Services`.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { BreadboardError, zBreadboardConfig, type BreadboardConfig } from '@breadboard/shared';
import type { Foundation } from '../test/harness.js';
import type { CredentialBroker, Services } from '../core/services.js';
import { bearer } from '../api/util.js';
import { createAuthService, type AuthServiceImpl } from './service.js';
import { createEventBus, type EventBusImpl } from '../events/bus.js';

export const TEST_SIGNING_KEY = 'route-test-signing-key-0123456789';

const PUBLIC = new Set(['/api/v1/auth/login', '/api/v1/auth/oidc/start', '/api/v1/auth/oidc/callback', '/api/v1/auth/mode']);

export interface RouteHarness {
  app: FastifyInstance;
  auth: AuthServiceImpl;
  events: EventBusImpl;
  brokerCalls: Array<[string, unknown]>;
  setSettings(s: BreadboardConfig): void;
}

export function testSettings(extra: Record<string, unknown> = {}): BreadboardConfig {
  return zBreadboardConfig.parse({
    schema: 'breadboard/breadboard@v1',
    auth: { mode: 'local', local_users: [{ handle: 'zach', token: 'local-token-zach', admin: true, roles: ['reviewer'] }, { handle: 'robin', token: 'local-token-robin' }] },
    ...extra,
  });
}

export async function buildRouteHarness(f: Foundation, modules: Array<'auth' | 'admin' | 'events'>): Promise<RouteHarness> {
  let settings = testSettings();
  const settingsFn = async () => settings;
  const auth = createAuthService({ db: f.db, identity: f.identity, team_id: f.team_id, settings: settingsFn, signingKey: TEST_SIGNING_KEY, publicUrl: 'http://localhost:4000', log: f.log, sessions: () => null });
  const events = createEventBus({ db: f.db, log: f.log, settings: settingsFn });
  const brokerCalls: Array<[string, unknown]> = [];
  const broker: Partial<CredentialBroker> = {
    listCredentials: async () => [{ credential_id: 'cred_1', name: 'github', kind: 'token', created_at: new Date(0).toISOString() }],
    registerCredential: async (i) => (brokerCalls.push(['registerCredential', { name: i.name, kind: i.kind, by: i.by.actor.id }]), { credential_id: 'cred_2', name: i.name }),
    deleteCredential: async (name) => void brokerCalls.push(['deleteCredential', name]),
    listCapabilities: async () => [],
    defineCapability: async (i) => (brokerCalls.push(['defineCapability', { name: i.name, credential: i.credential, scope: i.scope }]), { capability_id: 'cap_1', name: i.name }),
    deleteCapability: async (name) => void brokerCalls.push(['deleteCapability', name]),
    audit: async (limit) => [{ limit }],
  };
  const services = {
    env: { ...f.env, TOKEN_SIGNING_KEY: TEST_SIGNING_KEY },
    log: f.log,
    db: f.db,
    team_id: f.team_id,
    identity: f.identity,
    auth,
    events,
    broker,
    config: { settings: settingsFn },
    sandbox: { kind: 'process', health: async () => ({ ok: true, detail: 'process runner', warm: {} }) },
    gateway: { providers: () => ['mock'], fallbackEvents: () => [] },
    dispatcher: { capacity: async () => ({ running: 0, max_concurrent_runs: 4, spend_last_hour_usd: 0, max_spend_usd_per_hour: 25, queued: 0 }) },
    connectors: { status: async () => { throw new Error('connectors offline'); } },
    publicUrl: 'http://localhost:4000',
  } as unknown as Services;

  const app = Fastify({ logger: false });
  app.decorateRequest('principal', null);
  await app.register(cookie);
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/v1')) return;
    if (PUBLIC.has(req.url.split('?')[0]!)) return;
    (req as any).principal = await auth.authenticate(bearer(req));
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof BreadboardError) return reply.status(err.status).send(err.toJSON());
    reply.status(err?.statusCode ?? 500).send({ error: { code: 'internal', message: String(err?.message ?? err) } });
  });
  for (const m of modules) {
    const mod = m === 'auth' ? await import('../api/auth.js') : m === 'admin' ? await import('../api/admin.js') : await import('../api/events.js');
    await mod.register(app, services);
  }
  await app.ready();
  return { app, auth, events, brokerCalls, setSettings: (s) => void (settings = s) };
}
