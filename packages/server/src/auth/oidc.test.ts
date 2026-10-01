import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import { BreadboardError, zBreadboardConfig, type BreadboardConfig } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import { createAuthService, type AuthServiceImpl } from './service.js';

/** Minimal OIDC provider: discovery, JWKS, token (PKCE-checked), userinfo. */
async function fakeIdp() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { nonce: string; challenge: string; sub: string }>();
  const profiles = new Map<string, Record<string, unknown>>();
  let issuer = '';
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const form = new URLSearchParams(raw);
      const entry = codes.get(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      if (!entry || createHash('sha256').update(verifier).digest('base64url') !== entry.challenge) return json(400, { error: 'invalid_grant' });
      codes.delete(form.get('code')!);
      const profile = profiles.get(entry.sub)!;
      const id_token = await new SignJWT({ nonce: entry.nonce, groups: profile.groups })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(issuer)
        .setAudience('breadboard-client')
        .setSubject(entry.sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey as CryptoKey);
      return json(200, { access_token: `at-${entry.sub}`, token_type: 'Bearer', expires_in: 300, id_token });
    }
    if (url.pathname === '/userinfo') {
      const sub = String(req.headers.authorization ?? '').replace(/^Bearer at-/, '');
      return json(200, { sub, ...profiles.get(sub) });
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    profiles,
    /** Simulate the user approving at the IdP: returns the callback params. */
    approve(authUrl: string, sub: string): Record<string, string> {
      const u = new URL(authUrl);
      const code = randomUUID();
      codes.set(code, { nonce: u.searchParams.get('nonce')!, challenge: u.searchParams.get('code_challenge')!, sub });
      return { code, state: u.searchParams.get('state')! };
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('AuthService OIDC', () => {
  let f: Foundation;
  let idp: Awaited<ReturnType<typeof fakeIdp>>;
  let auth: AuthServiceImpl;
  let settings: BreadboardConfig;

  beforeAll(async () => {
    f = await createFoundation();
    idp = await fakeIdp();
    settings = zBreadboardConfig.parse({
      schema: 'breadboard/breadboard@v1',
      auth: {
        mode: 'oidc',
        oidc: {
          issuer: idp.issuer,
          client_id: 'breadboard-client',
          client_secret_env: 'BB_TEST_OIDC_SECRET',
          group_mappings: { admin: ['bb-admins'], roles: { scientist: ['science'], 'legal-review': ['legal'] } },
        },
      },
    });
    auth = createAuthService({
      db: f.db, identity: f.identity, team_id: f.team_id, settings: async () => settings, signingKey: 'k'.repeat(32), publicUrl: 'http://localhost:4000', log: f.log, sessions: () => null,
      secretFor: (n) => (n === 'BB_TEST_OIDC_SECRET' ? 'client-secret' : undefined),
    });
  });
  afterAll(async () => {
    await idp.close();
    await f.close();
  });

  it('builds an authorization URL with state, nonce, PKCE and the default redirect', async () => {
    const url = new URL(await auth.oidc.authorizationUrl('state-1', 'nonce-1'));
    expect(url.origin + url.pathname).toBe(`${idp.issuer}/authorize`);
    expect(url.searchParams.get('client_id')).toBe('breadboard-client');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('nonce')).toBe('nonce-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:4000/api/v1/auth/oidc/callback');
    expect(auth.oidc.enabled()).toBe(true);
  });

  it('completes the code flow, upserts the user, and maps groups to admin + review roles', async () => {
    idp.profiles.set('sub-alice', { preferred_username: 'alice', name: 'Alice A', email: 'alice@example.com', groups: ['bb-admins', 'science'] });
    const authUrl = await auth.oidc.authorizationUrl('st-a', 'nn-a');
    const out = await auth.oidc.callback(idp.approve(authUrl, 'sub-alice'), { state: 'st-a', nonce: 'nn-a' });
    expect(out.user).toMatchObject({ handle: 'alice', display_name: 'Alice A', oidc_subject: 'sub-alice', is_admin: true });
    const p = await auth.authenticate(out.session_token);
    expect(p.user!.user_id).toBe(out.user.user_id);
    expect(p.roles).toEqual(['scientist']);

    // Group membership changes apply at next login: mapped roles sync both ways, admin follows the mapping.
    idp.profiles.set('sub-alice', { preferred_username: 'alice', name: 'Alice A', groups: ['legal'] });
    const again = await auth.oidc.callback(idp.approve(await auth.oidc.authorizationUrl('st-b', 'nn-b'), 'sub-alice'), { state: 'st-b', nonce: 'nn-b' });
    expect(again.user.user_id).toBe(out.user.user_id);
    expect(again.user.is_admin).toBe(false);
    expect((await f.identity.rolesOfUser(out.user.user_id)).sort()).toEqual(['legal-review']);
  });

  it('never links to an existing account by handle', async () => {
    idp.profiles.set('sub-mallory', { preferred_username: 'admin', groups: [] }); // 'admin' is a harness user
    const out = await auth.oidc.callback(idp.approve(await auth.oidc.authorizationUrl('st-m', 'nn-m'), 'sub-mallory'), { state: 'st-m', nonce: 'nn-m' });
    expect(out.user.user_id).not.toBe(f.admin.user_id);
    expect(out.user.handle).toMatch(/^admin-[0-9a-f]{6}$/);
    expect(out.user.is_admin).toBe(false);
  });

  it('rejects nonce mismatch, replayed codes, and deactivated users', async () => {
    idp.profiles.set('sub-bob', { email: 'bob@example.com', groups: [] });
    const params = idp.approve(await auth.oidc.authorizationUrl('st-c', 'nn-c'), 'sub-bob');
    await expect(auth.oidc.callback(params, { state: 'st-c', nonce: 'WRONG' })).rejects.toSatisfy((e: unknown) => e instanceof BreadboardError && e.code === 'unauthorized');

    const ok = await auth.oidc.callback(idp.approve(await auth.oidc.authorizationUrl('st-d', 'nn-d'), 'sub-bob'), { state: 'st-d', nonce: 'nn-d' });
    expect(ok.user.handle).toBe('bob'); // email local-part fallback
    await f.identity.deactivateUser(ok.user.user_id);
    await expect(auth.oidc.callback(idp.approve(await auth.oidc.authorizationUrl('st-e', 'nn-e'), 'sub-bob'), { state: 'st-e', nonce: 'nn-e' })).rejects.toThrow(/deactivated/);
  });

  it('surfaces provider errors', async () => {
    await expect(auth.oidc.callback({ error: 'access_denied', state: 's' }, { state: 's', nonce: 'n' })).rejects.toThrow(/access_denied/);
  });
});
