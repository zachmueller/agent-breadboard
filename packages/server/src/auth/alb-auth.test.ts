// Load-balancer identity ([12] §3): a verified `x-amzn-oidc-data` header signs in as its subject.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createFoundation, type Foundation } from '../test/harness.js';
import { albAuthConfig, albAuthProblems, oidcAdoptHandles, type AlbAuthConfig, type Env } from '../core/env.js';
import { createAlbVerifier } from './alb.js';
import { buildRouteHarness, type RouteHarness } from './route-harness.js';

const ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/breadboard-alb/0123456789abcdef';
const OTHER_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/someone-else/fedcba9876543210';
const ISSUER = 'https://idp.example.com';
const CLIENT = 'breadboard-client';
const KID = '6a1b2c3d-0000-4000-8000-0123456789ab';
const HEADER = 'x-amzn-oidc-data';
const PROXY_HEADER = 'x-breadboard-proxy-auth';
const PROXY_SECRET = 'p'.repeat(40);

const env = (over: Partial<Env>) => over as Env;

/** Standard base64 alphabet made URL-safe, with the `=` padding the load balancer leaves in. */
const b64 = (b: Buffer | string) => {
  const s = Buffer.from(b).toString('base64url');
  return s + '='.repeat((4 - (s.length % 4)) % 4);
};

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
}

/** A token shaped like the load balancer's: claims in the payload, signer / iss / client / exp in the header. */
function albToken(privateKey: KeyObject, opts: { sub?: string | null; header?: Record<string, unknown>; payload?: Record<string, unknown>; expIn?: number } = {}): string {
  const exp = Math.floor(Date.now() / 1000) + (opts.expIn ?? 120);
  const header = { typ: 'JWT', alg: 'ES256', kid: KID, signer: ARN, iss: ISSUER, client: CLIENT, exp, ...opts.header };
  const payload: Record<string, unknown> = { exp, iss: ISSUER, ...opts.payload };
  if (opts.sub !== null) payload.sub = opts.sub ?? 'alice';
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  return `${input}.${b64(sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }))}`;
}

const config = (over: Partial<AlbAuthConfig> = {}): AlbAuthConfig => ({ ...albAuthConfig(env({ BREADBOARD_ALB_AUTH_ARN: ARN, BREADBOARD_ALB_AUTH_ISSUER: ISSUER, BREADBOARD_ALB_AUTH_CLIENT_ID: CLIENT }))!, ...over });

describe('load-balancer identity configuration', () => {
  it('is off by default and derives the regional key endpoint from the ARN', () => {
    expect(albAuthConfig(env({}))).toBeNull();
    const c = albAuthConfig(env({ BREADBOARD_ALB_AUTH_ARN: ` ${ARN} ` }))!;
    expect(c).toMatchObject({ signerArn: ARN, issuer: null, clientId: null });
    expect(c.keyUrl(KID)).toBe(`https://public-keys.auth.elb.us-east-1.amazonaws.com/${KID}`);
  });

  it('refuses anything but an Application Load Balancer ARN, and pins without an ARN', () => {
    for (const bad of ['arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/net/nlb/0123456789abcdef', 'arn:aws-us-gov:elasticloadbalancing:us-gov-west-1:123456789012:loadbalancer/app/x/0123456789abcdef', 'not-an-arn', `${ARN}/extra`]) {
      expect(() => albAuthConfig(env({ BREADBOARD_ALB_AUTH_ARN: bad }))).toThrow(/Application Load Balancer ARN/);
    }
    expect(albAuthProblems(env({ BREADBOARD_ALB_AUTH_ISSUER: ISSUER }))).toEqual([expect.stringMatching(/need BREADBOARD_ALB_AUTH_ARN/)]);
    expect(albAuthProblems(env({ BREADBOARD_ALB_AUTH_ARN: ARN, BREADBOARD_ALB_AUTH_ISSUER: 'http://idp.example.com' }))).toEqual([expect.stringMatching(/https URL/)]);
    expect(albAuthProblems(env({ BREADBOARD_ALB_AUTH_ARN: ARN, BREADBOARD_ALB_AUTH_CLIENT_ID: 'a b' }))).toEqual([expect.stringMatching(/client id/)]);
  });

  it('reads the adoption list', () => {
    expect(oidcAdoptHandles(env({}))).toEqual([]);
    expect(oidcAdoptHandles(env({ BREADBOARD_OIDC_ADOPT_HANDLES: ' Operator, ops ,,operator' }))).toEqual(['operator', 'ops']);
  });
});

describe('load-balancer token verification', () => {
  const { pem, privateKey } = keyPair();
  const fetchKey = vi.fn(async (url: string) => {
    if (url.endsWith(`/${KID}`)) return pem;
    throw new Error('the key endpoint answered 404');
  });

  it('accepts a token the load balancer signed, padding and all', async () => {
    const token = albToken(privateKey, { payload: { email: 'alice@example.com' } });
    expect(token).toMatch(/=/);
    const id = await createAlbVerifier(config(), { fetchKey }).verify(token);
    expect(id).toMatchObject({ sub: 'alice', claims: { email: 'alice@example.com' } });
  });

  it('refuses everything else', async () => {
    const v = createAlbVerifier(config(), { fetchKey });
    const other = keyPair().privateKey;
    const good = albToken(privateKey);
    const [h, p, s] = good.split('.');
    const cases: Record<string, string> = {
      'another load balancer': albToken(privateKey, { header: { signer: OTHER_ARN } }),
      'a key the endpoint does not serve': albToken(other),
      'a kid with path characters': albToken(privateKey, { header: { kid: '../x' } }),
      'an unknown kid': albToken(privateKey, { header: { kid: 'f'.repeat(36) } }),
      'alg none': `${b64(JSON.stringify({ alg: 'none', kid: KID, signer: ARN }))}.${p}.`,
      'HS256 with the public key as secret': (() => {
        const hh = b64(JSON.stringify({ alg: 'HS256', kid: KID, signer: ARN, exp: 9e9 }));
        return `${hh}.${p}.${b64(createHmac('sha256', pem).update(`${hh}.${p}`).digest())}`;
      })(),
      'a tampered payload': `${h}.${b64(JSON.stringify({ sub: 'mallory', exp: 9e9 }))}.${s}`,
      expired: albToken(privateKey, { expIn: -120 }),
      'another issuer': albToken(privateKey, { header: { iss: 'https://evil.example.com' } }),
      'another client': albToken(privateKey, { header: { client: 'someone-else' } }),
      'no subject': albToken(privateKey, { sub: null }),
      'no expiry': albToken(privateKey, { header: { exp: undefined }, payload: { exp: undefined } }),
      oversized: albToken(privateKey, { payload: { pad: 'x'.repeat(20_000) } }),
      garbage: 'not.a.token',
    };
    for (const [what, token] of Object.entries(cases)) await expect(v.verify(token), what).rejects.toThrow();
  });

  it('fetches a key once, shares in-flight fetches, and does not hammer the endpoint for a kid it lacks', async () => {
    const calls: string[] = [];
    const slow = async (url: string) => {
      calls.push(url);
      await new Promise((r) => setTimeout(r, 10));
      if (url.endsWith(`/${KID}`)) return pem;
      throw new Error('404');
    };
    const v = createAlbVerifier(config(), { fetchKey: slow });
    await Promise.all([v.verify(albToken(privateKey)), v.verify(albToken(privateKey)), v.verify(albToken(privateKey))]);
    await v.verify(albToken(privateKey, { sub: 'bob' }));
    expect(calls).toHaveLength(1);
    const unknown = albToken(privateKey, { header: { kid: 'f'.repeat(36) } });
    await expect(v.verify(unknown)).rejects.toThrow();
    await expect(v.verify(unknown)).rejects.toThrow();
    expect(calls).toHaveLength(2);
    // Nothing is fetched for a token that names another load balancer.
    await expect(v.verify(albToken(privateKey, { header: { signer: OTHER_ARN, kid: 'e'.repeat(36) } }))).rejects.toThrow(/another load balancer/);
    expect(calls).toHaveLength(2);
  });
});

describe('load-balancer identity: request authentication', () => {
  const { pem, privateKey } = keyPair();
  const fetchAlbKey = async (url: string) => {
    if (url.endsWith(`/${KID}`)) return pem;
    throw new Error('404');
  };
  let f: Foundation;
  let h: RouteHarness;
  let memberTok: string;

  beforeAll(async () => {
    f = await createFoundation();
    h = await buildRouteHarness(f, ['auth', 'admin'], { albAuth: config(), fetchAlbKey, trustedProxy: { header: PROXY_HEADER, secret: PROXY_SECRET, user: 'operator' } });
    memberTok = await h.auth.mintUserToken(f.member);
  });
  afterAll(async () => {
    await h.app.close();
    await f.close();
  });

  const me = (headers: Record<string, string>) => h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { host: 'bb.example.com', ...headers } });

  it('signs a request in as the subject, provisioned at first sign-in as a member', async () => {
    const r = await me({ [HEADER]: albToken(privateKey, { sub: 'alice' }) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ user: { handle: 'alice', is_admin: false }, is_admin: false, token_kind: 'proxy', actor: { kind: 'user' } });
    expect((await f.identity.getUserByOidc('alice'))?.user_id).toBe(r.json().user.user_id);
    // Every request carries a freshly signed token; the user stays the same row.
    expect((await me({ [HEADER]: albToken(privateKey, { sub: 'alice' }) })).json().user.user_id).toBe(r.json().user.user_id);
    expect((await f.identity.listUsers(f.team_id)).filter((u) => u.handle.startsWith('alice'))).toHaveLength(1);
    // Admin routes stay closed to a member.
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: { host: 'bb.example.com', [HEADER]: albToken(privateKey, { sub: 'alice' }) } })).statusCode).toBe(403);
  });

  it('fails closed: a header that does not verify is a 401, even next to the proxy secret', async () => {
    const forged = albToken(keyPair().privateKey, { sub: 'operator' });
    expect((await me({ [HEADER]: forged })).statusCode).toBe(401);
    expect((await me({ [HEADER]: forged, [PROXY_HEADER]: PROXY_SECRET })).statusCode).toBe(401);
    expect((await me({ [HEADER]: albToken(privateKey, { header: { signer: OTHER_ARN } }) })).statusCode).toBe(401);
    const twice = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { host: 'bb.example.com', [HEADER]: [albToken(privateKey), albToken(privateKey)] as unknown as string } });
    expect(twice.statusCode).toBe(401);
    // Without the header, the trusted proxy still works.
    expect((await me({ [PROXY_HEADER]: PROXY_SECRET })).json()).toMatchObject({ user: { handle: 'operator' } });
  });

  it('lets an explicit credential win, and falls back to the load balancer when it is stale', async () => {
    expect((await me({ authorization: `Bearer ${memberTok}`, [HEADER]: albToken(privateKey, { sub: 'alice' }) })).json().user.handle).toBe(f.member.handle);
    expect((await me({ authorization: 'Bearer stale-or-revoked', [HEADER]: albToken(privateKey, { sub: 'alice' }) })).json().user.handle).toBe('alice');
  });

  it('honours edge identity only for requests from its own site', async () => {
    const token = () => albToken(privateKey, { sub: 'alice' });
    expect((await me({ [HEADER]: token(), origin: 'https://bb.example.com' })).statusCode).toBe(200);
    expect((await me({ [HEADER]: token(), origin: 'https://BB.example.com' })).statusCode).toBe(200);
    for (const origin of ['https://evil.example.com', 'https://bb.example.com.evil.com', 'null', 'https://bb.example.com:8443']) {
      expect((await me({ [HEADER]: token(), origin })).statusCode, origin).toBe(401);
      expect((await me({ [PROXY_HEADER]: PROXY_SECRET, origin })).statusCode, origin).toBe(401);
    }
    // An explicit credential is not ambient, so it is unaffected.
    expect((await me({ authorization: `Bearer ${memberTok}`, origin: 'https://evil.example.com' })).statusCode).toBe(200);
  });

  it('stops when the user is deactivated', async () => {
    await me({ [HEADER]: albToken(privateKey, { sub: 'carol' }) });
    await f.identity.deactivateUser((await f.identity.getUserByOidc('carol'))!.user_id);
    h.auth.invalidate();
    const r = await me({ [HEADER]: albToken(privateKey, { sub: 'carol' }) });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toMatch(/deactivated/);
  });
});

describe('load-balancer identity: adopting an existing user', () => {
  const { pem, privateKey } = keyPair();
  const fetchAlbKey = async () => pem;
  const harnesses: Array<{ f: Foundation; h: RouteHarness }> = [];
  async function setup(adoptHandles: string[]) {
    const f = await createFoundation();
    const h = await buildRouteHarness(f, ['auth', 'admin'], { albAuth: config(), fetchAlbKey, adoptHandles, bootstrapAdminToken: null });
    const operator = await f.identity.upsertUser({ team_id: f.team_id, handle: 'operator', display_name: 'Operator', is_admin: true });
    harnesses.push({ f, h });
    const me = (sub: string) => h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { [HEADER]: albToken(privateKey, { sub }) } });
    return { f, h, operator, me };
  }
  afterAll(async () => {
    for (const { f, h } of harnesses) {
      await h.app.close();
      await f.close();
    }
  });

  it('becomes the named user (same id, still an admin) on the first sign-in with its handle', async () => {
    const { h, operator, me } = await setup(['operator']);
    expect(await h.auth.adminSignInPaths()).toContain('load balancer user operator (adopted at first sign-in)');
    const r = await me('operator');
    expect(r.json()).toMatchObject({ user: { user_id: operator.user_id, handle: 'operator', is_admin: true }, is_admin: true });
    expect(await h.auth.adminSignInPaths()).toContain('load balancer user operator');
  });

  it('never links by handle without the setting, or to a deactivated user, or to one with another subject', async () => {
    const plain = await setup([]);
    expect((await plain.me('operator')).json().user).toMatchObject({ handle: expect.stringMatching(/^operator-[0-9a-f]{6}$/), is_admin: false });

    const gone = await setup(['operator']);
    await gone.f.identity.deactivateUser(gone.operator.user_id);
    expect((await gone.me('operator')).json().user.handle).toMatch(/^operator-[0-9a-f]{6}$/);

    const taken = await setup(['operator']);
    await taken.f.identity.linkOidcSubject(taken.operator.user_id, 'someone-else');
    expect((await taken.me('operator')).json().user).toMatchObject({ handle: expect.stringMatching(/^operator-[0-9a-f]{6}$/), is_admin: false });
    expect(await taken.f.identity.linkOidcSubject(taken.operator.user_id, 'operator')).toBe(false);
  });
});

