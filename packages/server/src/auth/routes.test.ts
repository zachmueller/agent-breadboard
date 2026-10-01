import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFoundation, type Foundation } from '../test/harness.js';
import { buildRouteHarness, testSettings, type RouteHarness } from './route-harness.js';

describe('auth + admin routes', () => {
  let f: Foundation;
  let h: RouteHarness;
  let adminTok: string;
  let memberTok: string;

  beforeAll(async () => {
    f = await createFoundation();
    h = await buildRouteHarness(f, ['auth', 'admin', 'events']);
    adminTok = await h.auth.mintUserToken(f.admin);
    memberTok = await h.auth.mintUserToken(f.member);
  });
  afterAll(async () => {
    await h.app.close();
    await f.close();
  });

  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  it('GET /auth/mode is public', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/api/v1/auth/mode' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ mode: 'local', oidc_enabled: false, local_banner: true });
  });

  it('POST /auth/login sets the session cookie; /me resolves it; logout clears it', async () => {
    const bad = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { token: 'nope-nope' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('unauthorized');
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {} })).statusCode).toBe(400);

    const r = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { token: 'local-token-zach' } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.user).toMatchObject({ handle: 'zach', is_admin: true });
    const cookie = r.cookies.find((c) => c.name === 'bb_session')!;
    expect(cookie).toMatchObject({ value: body.session_token, httpOnly: true, sameSite: 'Lax', path: '/' });

    const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', cookies: { bb_session: cookie.value } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { handle: 'zach' }, roles: ['reviewer'], is_admin: true, actor: { kind: 'user', handle: 'zach' }, scopes: null });

    const out = await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout', cookies: { bb_session: cookie.value } });
    expect(out.statusCode).toBe(200);
    expect(out.cookies.find((c) => c.name === 'bb_session')!.value).toBe('');

    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(401);
  });

  it('token login is refused outside local mode', async () => {
    h.setSettings(testSettings({ auth: { mode: 'oidc', oidc: { issuer: 'https://idp.example.com', client_id: 'x' } } }));
    try {
      const mode = await h.app.inject({ method: 'GET', url: '/api/v1/auth/mode' });
      expect(mode.json()).toEqual({ mode: 'oidc', oidc_enabled: true, local_banner: false });
      const r = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { token: 'local-token-zach' } });
      expect(r.statusCode).toBe(403);
      const cb = await h.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/callback?code=x&state=y' });
      expect(cb.statusCode).toBe(401); // no state cookie
    } finally {
      h.setSettings(testSettings());
    }
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' })).statusCode).toBe(404); // OIDC not configured
  });

  it('admin routes are admin-only', async () => {
    for (const url of ['/api/v1/admin/users', '/api/v1/admin/roles', '/api/v1/admin/service-tokens', '/api/v1/admin/broker/credentials', '/api/v1/admin/health/detail', '/api/v1/webhooks/deliveries']) {
      const r = await h.app.inject({ method: 'GET', url, headers: bearer(memberTok) });
      expect(r.statusCode, url).toBe(403);
      expect((await h.app.inject({ method: 'GET', url, headers: bearer(adminTok) })).statusCode, url).toBe(200);
    }
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: bearer(memberTok), payload: { handle: 'x' } })).statusCode).toBe(403);
  });

  it('users: create, list, deactivate', async () => {
    const c = await h.app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: bearer(adminTok), payload: { handle: 'newbie', display_name: 'New Bie', is_admin: false } });
    expect(c.statusCode).toBe(201);
    const user = c.json();
    expect(user).toMatchObject({ handle: 'newbie', display_name: 'New Bie', is_admin: false, deactivated_at: null });
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: bearer(adminTok), payload: { handle: 'bad handle!' } })).statusCode).toBe(400);

    const list = (await h.app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: bearer(adminTok) })).json();
    expect(list.items.map((u: any) => u.handle)).toContain('newbie');

    const tok = await h.auth.mintUserToken(user);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(tok) })).statusCode).toBe(200);
    const d = await h.app.inject({ method: 'POST', url: `/api/v1/admin/users/${user.user_id}/deactivate`, headers: bearer(adminTok) });
    expect(d.statusCode).toBe(200);
    expect(d.json().deactivated_at).not.toBeNull();
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(tok) })).statusCode).toBe(401); // cache invalidated
    expect((await h.app.inject({ method: 'POST', url: `/api/v1/admin/users/${f.admin.user_id}/deactivate`, headers: bearer(adminTok) })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/admin/users/NOPE/deactivate', headers: bearer(adminTok) })).statusCode).toBe(404);
  });

  it('roles: create, membership, public read-only list, delete', async () => {
    const c = await h.app.inject({ method: 'POST', url: '/api/v1/admin/roles', headers: bearer(adminTok), payload: { slug: 'legal', description: 'Legal reviewers' } });
    expect(c.statusCode).toBe(201);
    expect(c.json()).toMatchObject({ slug: 'legal', description: 'Legal reviewers', members: [] });
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/admin/roles', headers: bearer(adminTok), payload: { slug: 'Not A Slug' } })).statusCode).toBe(400);

    const m = await h.app.inject({ method: 'POST', url: '/api/v1/admin/roles/legal/members', headers: bearer(adminTok), payload: { user_id: f.member.user_id, member: true } });
    expect(m.statusCode).toBe(200);
    expect(m.json().members).toEqual([{ user_id: f.member.user_id, handle: 'member', display_name: 'Member' }]);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(memberTok) })).json().roles.sort()).toEqual(['legal', 'scientist']);

    const pub = await h.app.inject({ method: 'GET', url: '/api/v1/roles', headers: bearer(memberTok) });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().items).toEqual(expect.arrayContaining([{ slug: 'legal', description: 'Legal reviewers', members: ['member'] }, { slug: 'scientist', description: '', members: ['member'] }]));

    await h.app.inject({ method: 'POST', url: '/api/v1/admin/roles/legal/members', headers: bearer(adminTok), payload: { user_id: f.member.user_id, member: false } });
    const admin = (await h.app.inject({ method: 'GET', url: '/api/v1/admin/roles', headers: bearer(adminTok) })).json();
    expect(admin.items.find((r: any) => r.slug === 'legal').members).toEqual([]);

    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/admin/roles/legal', headers: bearer(adminTok) })).statusCode).toBe(204);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/admin/roles/legal', headers: bearer(adminTok) })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/admin/roles/legal/members', headers: bearer(adminTok), payload: { user_id: f.member.user_id } })).statusCode).toBe(404);
  });

  it('service tokens: scopes, issue (one-time secret), use, revoke', async () => {
    const scopes = (await h.app.inject({ method: 'GET', url: '/api/v1/admin/service-tokens/scopes', headers: bearer(adminTok) })).json();
    expect(scopes.scopes).toContain('events:read');

    const bad = await h.app.inject({ method: 'POST', url: '/api/v1/admin/service-tokens', headers: bearer(adminTok), payload: { name: 'x', scopes: ['bogus:scope'] } });
    expect(bad.statusCode).toBe(400);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/admin/service-tokens', headers: bearer(adminTok), payload: { name: 'x', scopes: [], expires_at: '2000-01-01T00:00:00Z' } })).statusCode).toBe(400);

    const c = await h.app.inject({ method: 'POST', url: '/api/v1/admin/service-tokens', headers: bearer(adminTok), payload: { name: 'pipeline', scopes: ['events:read'] } });
    expect(c.statusCode).toBe(201);
    const tok = c.json();
    expect(tok.secret).toMatch(/^bbs_/);
    expect(tok).toMatchObject({ name: 'pipeline', scopes: ['events:read'], created_by: { kind: 'user', id: f.admin.user_id } });
    const listed = (await h.app.inject({ method: 'GET', url: '/api/v1/admin/service-tokens', headers: bearer(adminTok) })).json().items;
    expect(listed.find((t: any) => t.token_id === tok.token_id)).not.toHaveProperty('secret');
    expect(JSON.stringify(listed)).not.toContain('token_hash');

    const me = (await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(tok.secret) })).json();
    expect(me).toMatchObject({ user: null, actor: { kind: 'service', id: 'pipeline' }, scopes: ['events:read'], is_admin: false });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/events/recent', headers: bearer(tok.secret) })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: bearer(tok.secret) })).statusCode).toBe(403);

    const noEvents = (await h.app.inject({ method: 'POST', url: '/api/v1/admin/service-tokens', headers: bearer(adminTok), payload: { name: 'tasks-only', scopes: ['tasks:write'] } })).json();
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/events/recent', headers: bearer(noEvents.secret) })).statusCode).toBe(403);

    const rv = await h.app.inject({ method: 'POST', url: `/api/v1/admin/service-tokens/${tok.token_id}/revoke`, headers: bearer(adminTok) });
    expect(rv.statusCode).toBe(200);
    expect(rv.json().revoked_at).not.toBeNull();
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(tok.secret) })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/admin/service-tokens/tok_nope/revoke', headers: bearer(adminTok) })).statusCode).toBe(404);

    const adminSvc = (await h.app.inject({ method: 'POST', url: '/api/v1/admin/service-tokens', headers: bearer(adminTok), payload: { name: 'ops', scopes: ['admin'] } })).json();
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: bearer(adminSvc.secret) })).statusCode).toBe(200);
  });

  it('broker routes delegate to the broker with validation', async () => {
    const auth = bearer(adminTok);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/admin/broker/credentials', headers: auth })).json().items[0].name).toBe('github');
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/admin/broker/credentials', headers: auth, payload: { name: 'gh', kind: 'token', secret: 42 } })).statusCode).toBe(400);
    const c = await h.app.inject({ method: 'POST', url: '/api/v1/admin/broker/credentials', headers: auth, payload: { name: 'gh', kind: 'token', secret: { token: 'abc' } } });
    expect(c.statusCode).toBe(201);
    expect(JSON.stringify(c.json())).not.toContain('abc');
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/admin/broker/credentials/gh', headers: auth })).statusCode).toBe(204);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/admin/broker/capabilities', headers: auth, payload: { name: 'gh-api', scope: { hosts: [] } } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/admin/broker/capabilities', headers: auth, payload: { name: 'gh-api', credential: 'gh', scope: { hosts: ['api.github.com'], methods: ['GET'] } } })).statusCode).toBe(201);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/admin/broker/capabilities/gh-api', headers: auth })).statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/admin/broker/audit?limit=7', headers: auth })).json().items).toEqual([{ limit: 7 }]);
    expect(h.brokerCalls).toEqual([
      ['registerCredential', { name: 'gh', kind: 'token', by: f.admin.user_id }],
      ['deleteCredential', 'gh'],
      ['defineCapability', { name: 'gh-api', credential: 'gh', scope: { hosts: ['api.github.com'], methods: ['GET'] } }],
      ['deleteCapability', 'gh-api'],
    ]);
  });

  it('health detail aggregates subsystems and tolerates failures', async () => {
    const r = (await h.app.inject({ method: 'GET', url: '/api/v1/admin/health/detail', headers: bearer(adminTok) })).json();
    expect(r.sandbox).toMatchObject({ kind: 'process', ok: true });
    expect(r.gateway).toEqual({ providers: ['mock'], fallback_events: [] });
    expect(r.dispatcher).toMatchObject({ max_concurrent_runs: 4 });
    expect(r.connectors).toEqual({ error: 'connectors offline' });
  });
});
