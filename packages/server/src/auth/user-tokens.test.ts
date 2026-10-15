// Personal access tokens ([12] §3): minted from a browser session, resolve to the user, optionally read-only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFoundation, type Foundation } from '../test/harness.js';
import { READ_ONLY_SCOPES } from '../identity/identity.js';
import { buildRouteHarness, type RouteHarness } from './route-harness.js';

const PROXY_SECRET = 'p'.repeat(40);
const PROXY_HEADER = 'x-breadboard-proxy-auth';

describe('personal access tokens', () => {
  let f: Foundation;
  let h: RouteHarness;
  let adminTok: string;
  let memberTok: string;

  beforeAll(async () => {
    f = await createFoundation();
    h = await buildRouteHarness(f, ['auth', 'admin'], { trustedProxy: { header: PROXY_HEADER, secret: PROXY_SECRET, user: 'operator' } });
    adminTok = await h.auth.mintUserToken(f.admin);
    memberTok = await h.auth.mintUserToken(f.member);
  });
  afterAll(async () => {
    await h.app.close();
    await f.close();
  });

  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const mint = (headers: Record<string, string>, payload: unknown) => h.app.inject({ method: 'POST', url: '/api/v1/me/tokens', headers, payload: payload as any });
  const me = (headers: Record<string, string>) => h.app.inject({ method: 'GET', url: '/api/v1/me', headers });

  it('a browser session mints a read-only token by default, which resolves to the user', async () => {
    const r = await mint(bearer(memberTok), { name: ' laptop ' });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.secret).toMatch(/^bbu_[A-Za-z0-9_-]{40,}$/);
    expect(body).toMatchObject({ name: 'laptop', user_id: f.member.user_id, scopes: [...READ_ONLY_SCOPES], revoked_at: null, last_used_at: null, mcp_url: 'http://localhost:4000/api/v1/mcp' });
    expect(body.token_id).toMatch(/^ptk_/);
    expect(Date.parse(body.expires_at) - Date.now()).toBeGreaterThan(89 * 864e5);

    const who = await me(bearer(body.secret));
    expect(who.statusCode).toBe(200);
    expect(who.json()).toMatchObject({ user: { handle: 'member' }, roles: ['scientist'], is_admin: false, token_kind: 'personal', scopes: [...READ_ONLY_SCOPES], actor: { kind: 'user', id: f.member.user_id } });

    // Listed without the secret, with the use just stamped; the list is per user.
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/me/tokens', headers: bearer(memberTok) });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((t: any) => t.token_id)).toEqual([body.token_id]);
    expect(list.json().items[0].secret).toBeUndefined();
    expect(list.json().items[0].last_used_at).not.toBeNull();
    expect(list.json().mcp_url).toBe('http://localhost:4000/api/v1/mcp');
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me/tokens', headers: bearer(adminTok) })).json().items).toEqual([]);
  });

  it("a read-only token of an admin is a member: no admin reads or writes, and it cannot mint", async () => {
    const ro = (await mint(bearer(adminTok), { name: 'ro' })).json().secret as string;
    expect((await me(bearer(ro))).json()).toMatchObject({ user: { handle: 'admin' }, is_admin: true, token_kind: 'personal' });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: bearer(ro) })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: bearer(ro), payload: { handle: 'x' } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/roles', headers: bearer(ro) })).statusCode).toBe(200);
    const escalate = await mint(bearer(ro), { name: 'escalate', read_only: false });
    expect(escalate.statusCode).toBe(403);
    expect(escalate.json().error.message).toMatch(/sign in through the browser/);
  });

  it('a full-access token acts as the user, and still cannot mint tokens', async () => {
    const r = await mint(bearer(adminTok), { name: 'full', read_only: false, expires_in_days: 7 });
    expect(r.statusCode).toBe(201);
    expect(r.json().scopes).toBeNull();
    expect(Date.parse(r.json().expires_at) - Date.now()).toBeLessThan(7.1 * 864e5);
    const full = r.json().secret as string;
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: bearer(full) })).statusCode).toBe(200);
    expect((await mint(bearer(full), { name: 'again' })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me/tokens', headers: bearer(full) })).statusCode).toBe(200);
  });

  it("an authenticating edge's identity may mint: that is the member's browser session on such a deployment", async () => {
    const r = await mint({ [PROXY_HEADER]: PROXY_SECRET }, { name: 'edge' });
    expect(r.statusCode).toBe(201);
    expect((await me(bearer(r.json().secret))).json()).toMatchObject({ user: { handle: 'operator' }, token_kind: 'personal' });
  });

  it('service tokens cannot mint personal tokens', async () => {
    const svc = await h.app.inject({ method: 'POST', url: '/api/v1/admin/service-tokens', headers: bearer(adminTok), payload: { name: 'bridge', scopes: ['admin'] } });
    expect(svc.statusCode).toBe(201);
    expect((await mint(bearer(svc.json().secret), { name: 'x' })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me/tokens', headers: bearer(svc.json().secret) })).statusCode).toBe(403);
  });

  it('validates the request', async () => {
    expect((await mint(bearer(memberTok), {})).statusCode).toBe(400);
    expect((await mint(bearer(memberTok), { name: '  ' })).statusCode).toBe(400);
    expect((await mint(bearer(memberTok), { name: 'x', expires_in_days: 400 })).statusCode).toBe(400);
    expect((await mint(bearer(memberTok), { name: 'x', expires_in_days: 0 })).statusCode).toBe(400);
    expect((await mint(bearer(memberTok), { name: 'x', read_only: 'yes' })).statusCode).toBe(400);
    expect((await mint({}, { name: 'x' })).statusCode).toBe(401);
  });

  it('revocation takes effect at once, and only on your own tokens', async () => {
    const { token_id, secret } = (await mint(bearer(memberTok), { name: 'temp' })).json();
    expect((await me(bearer(secret))).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'POST', url: `/api/v1/me/tokens/${token_id}/revoke`, headers: bearer(adminTok) })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'POST', url: `/api/v1/me/tokens/${token_id}/revoke`, headers: bearer(secret) })).statusCode).toBe(403);
    const rev = await h.app.inject({ method: 'POST', url: `/api/v1/me/tokens/${token_id}/revoke`, headers: bearer(memberTok) });
    expect(rev.statusCode).toBe(200);
    expect(rev.json().revoked_at).not.toBeNull();
    expect((await me(bearer(secret))).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'POST', url: `/api/v1/me/tokens/ptk_nope/revoke`, headers: bearer(memberTok) })).statusCode).toBe(404);
  });

  it('expired tokens, unknown secrets and deactivated users are refused', async () => {
    const old = await f.identity.createUserToken({ team_id: f.team_id, user_id: f.member.user_id, name: 'old', scopes: null, expires_at: new Date(Date.now() - 1000).toISOString() });
    expect((await me(bearer(old.secret))).statusCode).toBe(401);
    expect((await me(bearer('bbu_not-a-real-token'))).statusCode).toBe(401);
    const leaver = await f.identity.upsertUser({ team_id: f.team_id, handle: 'leaver', display_name: 'Leaver' });
    const t = await f.identity.createUserToken({ team_id: f.team_id, user_id: leaver.user_id, name: 'x', scopes: null, expires_at: new Date(Date.now() + 864e5).toISOString() });
    expect((await me(bearer(t.secret))).statusCode).toBe(200);
    await f.identity.deactivateUser(leaver.user_id);
    h.auth.invalidate();
    expect((await me(bearer(t.secret))).statusCode).toBe(401);
  });
});
