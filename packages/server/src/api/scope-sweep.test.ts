/**
 * Every mutating route refuses a read-only personal token ([12] §3) before touching anything: the full app
 * is built from the shipped seed, every registered route is collected, and each non-GET route under /api/v1
 * is called with a read-only `bbu_` token. Editor tokens are refused merges, gate verdicts and admin routes, and
 * an admin's full token closes the loop (propose → merge).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../core/env.js';
import { testDatabaseUrl } from '../test/harness.js';
import { silentLogger } from '../core/logger.js';
import { buildServices, stopServices, type BuiltServices } from '../core/build.js';
import { buildApp } from '../app.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const ADMIN = 'dev-admin-token-change-me';
const PUBLIC = new Set(['/api/v1/health', '/api/v1/auth/login', '/api/v1/auth/oidc/start', '/api/v1/auth/oidc/callback', '/api/v1/auth/mode', '/api/v1/auth/logout', '/api/v1/sync']);
/** POST routes that only read (their input needs a body) and the MCP transport (bound to its own protocol). */
const NOT_MUTATING = new Set(['/api/v1/config/validate', '/api/v1/mcp']);
/** Path parameters that a route resolves before anything else gets a value that exists. */
const PARAMS: Record<string, string> = { name: 'create_task' };

let services: BuiltServices;
let app: FastifyInstance;
let tmp: string;
let dropDb: () => Promise<void> = async () => undefined;
const routes: Array<{ method: string; url: string }> = [];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'bb-sweep-'));
  const testDb = await testDatabaseUrl();
  dropDb = testDb.drop;
  const env = loadEnv({
    DATABASE_URL: testDb.url,
    CONFIG_REPO_DIR: join(tmp, 'repo'),
    CONFIG_WORKTREE_CACHE_DIR: join(tmp, 'trees'),
    CONFIG_SEED_DIR: resolve(ROOT, 'config-seed'),
    OBJECT_STORE_DIR: join(tmp, 'objects'),
    MODEL_PROVIDER: 'mock',
    SANDBOX_RUNNER: 'process',
    PUBLIC_URL: 'http://127.0.0.1:4000',
    LOG_PRETTY: false,
    CONNECTORS_ENABLED: false,
  } as any);
  services = await buildServices({ env, log: silentLogger, root: ROOT, startSandbox: false });
  app = await buildApp(services, {
    onRoute: (r) => {
      for (const m of Array.isArray(r.method) ? r.method : [r.method]) routes.push({ method: m, url: r.url });
    },
  });
  await services.auth.syncLocalUsers(); // the seed's dev tokens sign in as real users rows
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (services) await stopServices(services);
  await dropDb();
  rmSync(tmp, { recursive: true, force: true });
});

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('read-only personal tokens', () => {
  let readOnly: string;

  it('are minted through the API by a signed-in user', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/me/tokens', headers: bearer(ADMIN), payload: { name: 'sweep' } });
    expect(r.statusCode, r.body).toBe(201);
    readOnly = r.json().secret;
    expect(readOnly).toMatch(/^bbu_/);
    expect(r.json().mcp_url).toBe('http://127.0.0.1:4000/api/v1/mcp');
  });

  it('are refused by every mutating route, with the scope check first', async () => {
    const mutating = routes.filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && r.url.startsWith('/api/v1') && !PUBLIC.has(r.url) && !NOT_MUTATING.has(r.url));
    expect(mutating.length).toBeGreaterThan(30);
    const failures: string[] = [];
    for (const r of mutating) {
      const url = r.url.replace(/:([A-Za-z_]+)/g, (_m, p: string) => PARAMS[p] ?? 'x').replace(/\*/g, 'x');
      const res = await app.inject({ method: r.method as any, url, headers: { ...bearer(readOnly), 'content-type': 'application/json' }, payload: '{}' });
      if (res.statusCode !== 403) failures.push(`${r.method} ${r.url} → ${res.statusCode} ${res.body.slice(0, 160)}`);
    }
    expect(failures).toEqual([]);
  });

  it('can still read, but not as an admin', async () => {
    for (const url of ['/api/v1/me', '/api/v1/sessions', '/api/v1/nodes', '/api/v1/tasks', '/api/v1/config/tree', '/api/v1/knowledge/domains', '/api/v1/evals/runs', '/api/v1/review-queue', '/api/v1/dashboard', '/api/v1/events/recent', '/api/v1/primitives']) {
      const res = await app.inject({ method: 'GET', url, headers: bearer(readOnly) });
      expect(res.statusCode, url).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(readOnly) })).json()).toMatchObject({ user: { handle: 'admin' }, token_kind: 'personal', is_admin: true });
    for (const url of ['/api/v1/admin/users', '/api/v1/admin/service-tokens', '/api/v1/webhooks/deliveries']) {
      expect((await app.inject({ method: 'GET', url, headers: bearer(readOnly) })).statusCode, url).toBe(403);
    }
    // Read primitives work over the sandbox API too; write primitives do not.
    expect((await app.inject({ method: 'POST', url: '/api/v1/primitives/whoami', headers: bearer(readOnly), payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/primitives/search_config', headers: bearer(readOnly), payload: { q: 'lit' } })).statusCode).toBe(200);
  });

  it('open an MCP connection, where edge identity is refused', async () => {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sweep', version: '1' } } };
    const ok = await app.inject({ method: 'POST', url: '/api/v1/mcp', headers: { ...bearer(readOnly), 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, payload: init });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.headers['mcp-session-id']).toBeTruthy();
    await app.inject({ method: 'DELETE', url: '/api/v1/mcp', headers: { ...bearer(readOnly), 'mcp-session-id': String(ok.headers['mcp-session-id']) } });
  });
});

describe('editor personal tokens', () => {
  let editor: string;
  /** What only a full (admin) token or a browser sign-in may do: merges, direct commits, gate verdicts, admin. */
  const FULL_ONLY = ['/api/v1/config/proposals/x/merge', '/api/v1/config/commit', '/api/v1/config/revert', '/api/v1/nodes/x/gate-verdict', '/api/v1/admin/users', '/api/v1/admin/service-tokens', '/api/v1/me/tokens'];

  it("are minted by an admin, and are a member's writes without the full tier", async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/me/tokens', headers: bearer(ADMIN), payload: { name: 'sweep-editor', access: 'editor' } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().access).toBe('editor');
    editor = r.json().secret;
  });

  it('are refused merges, direct commits, gate verdicts and admin routes, with the scope check first', async () => {
    expect(routes.some((r) => r.method === 'POST' && r.url === '/api/v1/config/proposals/:id/merge')).toBe(true);
    const failures: string[] = [];
    for (const url of FULL_ONLY) {
      const res = await app.inject({ method: 'POST', url, headers: { ...bearer(editor), 'content-type': 'application/json' }, payload: '{}' });
      if (res.statusCode !== 403) failures.push(`POST ${url} → ${res.statusCode} ${res.body.slice(0, 160)}`);
    }
    expect(failures).toEqual([]);
  });

  it('pass the scope check on everyday writes', async () => {
    // Past the scope check, each route fails on its (empty) input instead.
    for (const url of ['/api/v1/tasks', '/api/v1/config/proposals', '/api/v1/config/proposals/x/discard', '/api/v1/evals/runs', '/api/v1/primitives/create_note']) {
      const res = await app.inject({ method: 'POST', url, headers: { ...bearer(editor), 'content-type': 'application/json' }, payload: '{}' });
      expect(res.statusCode, `${url} ${res.body}`).not.toBe(403);
    }
  });
});

describe("an admin's full personal token", () => {
  it('proposes and merges through the primitives, and main advances', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/me/tokens', headers: bearer(ADMIN), payload: { name: 'sweep-full', access: 'full' } });
    expect(r.statusCode, r.body).toBe(201);
    const full = r.json().secret as string;
    const call = (name: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/v1/primitives/${name}`, headers: bearer(full), payload: payload as any });
    const before = await services.config.mainCommit();
    const text = readFileSync(resolve(ROOT, 'config-seed/tenets.md'), 'utf8');
    const proposed = await call('propose_config_change', { changes: [{ path: 'tenets.md', content: `${text}\n<!-- sweep -->\n` }], message: 'sweep: touch tenets' });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const id = proposed.json().proposal_id as string;
    const merged = await call('merge_proposal', { proposal_id: id });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(merged.json()).toMatchObject({ proposal_id: id, status: 'merged' });
    expect(merged.json().diff).toBeUndefined();
    expect(await services.config.mainCommit()).not.toBe(before);
  });
});
