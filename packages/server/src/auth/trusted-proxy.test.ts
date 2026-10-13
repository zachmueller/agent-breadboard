// Trusted proxy ([12] §3): requests that carry the proxy's shared secret sign in as one configured user.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BreadboardError } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import { trustedProxyConfig, trustedProxyProblems, type Env } from '../core/env.js';
import { buildRouteHarness, type RouteHarness } from './route-harness.js';

const SECRET = 'p'.repeat(40);
const HEADER = 'x-breadboard-proxy-auth';
const proxy = { header: HEADER, secret: SECRET, user: 'operator' };
const env = (over: Partial<Env>) => ({ BREADBOARD_TRUSTED_PROXY_HEADER: HEADER, ...over }) as Env;

describe('trusted-proxy configuration', () => {
  it('is off by default and needs both the secret and the user', () => {
    expect(trustedProxyConfig(env({}))).toBeNull();
    expect(trustedProxyConfig(env({ BREADBOARD_TRUSTED_PROXY_SECRET: SECRET, BREADBOARD_TRUSTED_PROXY_USER: ' operator ' }))).toEqual(proxy);
    expect(trustedProxyProblems(env({ BREADBOARD_TRUSTED_PROXY_SECRET: SECRET }))).toEqual([expect.stringMatching(/without BREADBOARD_TRUSTED_PROXY_USER/)]);
    expect(trustedProxyProblems(env({ BREADBOARD_TRUSTED_PROXY_USER: 'operator' }))).toEqual([expect.stringMatching(/without BREADBOARD_TRUSTED_PROXY_SECRET/)]);
  });

  it('refuses a weak secret or a header that carries other meanings, in every environment', () => {
    for (const weak of ['short', 'x-proxy-secret-change-me']) {
      expect(() => trustedProxyConfig(env({ BREADBOARD_TRUSTED_PROXY_SECRET: weak, BREADBOARD_TRUSTED_PROXY_USER: 'operator' }))).toThrow(/at least 32 random characters/);
    }
    for (const header of ['Authorization', 'cookie', 'x-forwarded-for', 'bad header']) {
      expect(trustedProxyProblems(env({ BREADBOARD_TRUSTED_PROXY_SECRET: SECRET, BREADBOARD_TRUSTED_PROXY_USER: 'operator', BREADBOARD_TRUSTED_PROXY_HEADER: header }))).toEqual([expect.stringMatching(/dedicated header name/)]);
    }
    expect(trustedProxyConfig(env({ BREADBOARD_TRUSTED_PROXY_SECRET: SECRET, BREADBOARD_TRUSTED_PROXY_USER: 'operator', BREADBOARD_TRUSTED_PROXY_HEADER: 'X-Edge-Auth' }))?.header).toBe('x-edge-auth');
  });
});

describe('trusted proxy: request authentication', () => {
  let f: Foundation;
  let h: RouteHarness;
  let memberTok: string;

  beforeAll(async () => {
    f = await createFoundation();
    h = await buildRouteHarness(f, ['auth', 'admin'], { trustedProxy: proxy });
    memberTok = await h.auth.mintUserToken(f.member);
  });
  afterAll(async () => {
    await h.app.close();
    await f.close();
  });

  const me = (headers: Record<string, string>) => h.app.inject({ method: 'GET', url: '/api/v1/me', headers });

  it('signs a proxied request in as the configured user, created as an admin on first use', async () => {
    expect(await f.identity.getUserByHandle(f.team_id, 'operator')).toBeNull();
    const r = await me({ [HEADER]: SECRET });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ user: { handle: 'operator', is_admin: true }, is_admin: true, token_kind: 'proxy', actor: { kind: 'user' } });
    // The same user every time: one row, not one per request.
    expect((await me({ [HEADER]: SECRET })).json().user.user_id).toBe(r.json().user.user_id);
    expect((await f.identity.listUsers(f.team_id)).filter((u) => u.handle === 'operator')).toHaveLength(1);
    // Admin routes work as the proxy user.
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: { [HEADER]: SECRET } })).statusCode).toBe(200);
  });

  it('gives no trust without the exact secret', async () => {
    expect((await me({})).statusCode).toBe(401);
    expect((await me({ [HEADER]: 'wrong' })).statusCode).toBe(401);
    expect((await me({ [HEADER]: `${SECRET}x` })).statusCode).toBe(401);
    expect((await me({ 'x-other-header': SECRET })).statusCode).toBe(401);
    // A header sent twice (e.g. a client-supplied copy next to the proxy's) is never a match.
    const twice = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { [HEADER]: [SECRET, SECRET] as unknown as string } });
    expect(twice.statusCode).toBe(401);
  });

  it('gives no trust to a request another site made (the proxy secret rides on ambient cookies)', async () => {
    const host = 'bb.example.com';
    expect((await me({ host, origin: `https://${host}`, [HEADER]: SECRET })).statusCode).toBe(200);
    expect((await me({ host, origin: 'https://evil.example.com', [HEADER]: SECRET })).statusCode).toBe(401);
    expect((await me({ host, origin: 'null', [HEADER]: SECRET })).statusCode).toBe(401);
  });

  it('lets an explicit credential win, and falls back to the proxy user when it is stale', async () => {
    expect((await me({ authorization: `Bearer ${memberTok}`, [HEADER]: SECRET })).json().user.handle).toBe(f.member.handle);
    expect((await me({ authorization: 'Bearer stale-or-revoked', [HEADER]: SECRET })).json()).toMatchObject({ user: { handle: 'operator' }, token_kind: 'proxy' });
    expect((await me({ cookie: 'bb_session=expired.jwt.value', [HEADER]: SECRET })).json().user.handle).toBe('operator');
    expect((await me({ authorization: 'Bearer stale-or-revoked' })).statusCode).toBe(401); // no proxy, no fallback
  });

  it('stops when the proxy user is deactivated', async () => {
    const row = await f.identity.getUserByHandle(f.team_id, 'operator');
    await f.identity.deactivateUser(row!.user_id);
    h.auth.invalidate();
    const r = await me({ [HEADER]: SECRET });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toMatch(/trusted-proxy user is deactivated/);
    await expect(h.auth.proxyPrincipal({ [HEADER]: SECRET })).rejects.toBeInstanceOf(BreadboardError);
  });

  it('counts as an admin sign-in path, so the bootstrap token can be turned off', async () => {
    const f2 = await createFoundation();
    const h2 = await buildRouteHarness(f2, ['auth'], { trustedProxy: proxy, bootstrapAdminToken: null });
    expect(await h2.auth.adminSignInPaths()).toContain('trusted proxy user operator');
    await h2.app.close();
    await f2.close();
  });
});
