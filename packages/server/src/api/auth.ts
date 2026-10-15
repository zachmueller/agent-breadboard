/**
 * Login / identity routes ([12] §3). Public: `/auth/mode`, `/auth/login`, `/auth/oidc/start`,
 * `/auth/oidc/callback` (see PUBLIC_PATHS in app.ts). Session tokens travel as the `bb_session`
 * httpOnly cookie (browser) or as a bearer token (returned by `/auth/login`).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { BreadboardError } from '@breadboard/shared';
import type { Services } from '../core/services.js';
import { API_PREFIX } from '../app.js';
import { principalOf, requireBody, requireField } from './util.js';
import { requireUser, type Principal } from '../core/principal.js';
import { READ_ONLY_SCOPES, type UserRecord } from '../identity/identity.js';
import { randomToken, USER_TOKEN_TTL_S } from '../auth/service.js';

const TOKEN_DEFAULT_DAYS = 90;
const TOKEN_MAX_DAYS = 365;

export const SESSION_COOKIE = 'bb_session';
const OIDC_COOKIE = 'bb_oidc';
const OIDC_COOKIE_PATH = `${API_PREFIX}/auth/oidc`;
const OIDC_STATE_TTL_S = 600;

function secureCookies(services: Services): boolean {
  return services.publicUrl.startsWith('https://');
}

function setSessionCookie(reply: FastifyReply, services: Services, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', secure: secureCookies(services), maxAge: USER_TOKEN_TTL_S });
}

/** Short-lived HMAC-signed cookie carrying OIDC state + nonce. */
function sealState(key: string, v: { state: string; nonce: string }): string {
  const body = Buffer.from(JSON.stringify({ ...v, exp: Math.floor(Date.now() / 1000) + OIDC_STATE_TTL_S })).toString('base64url');
  const mac = createHmac('sha256', key).update(`oidc-state:${body}`).digest('base64url');
  return `${body}.${mac}`;
}

function openState(key: string, raw: string | undefined): { state: string; nonce: string } | null {
  if (!raw) return null;
  const [body, mac] = raw.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', key).update(`oidc-state:${body}`).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof v.state !== 'string' || typeof v.nonce !== 'string' || typeof v.exp !== 'number' || v.exp < Date.now() / 1000) return null;
    return { state: v.state, nonce: v.nonce };
  } catch {
    return null;
  }
}

export async function register(app: FastifyInstance, services: Services): Promise<void> {
  const stateKey = services.env.TOKEN_SIGNING_KEY;

  app.get(`${API_PREFIX}/auth/mode`, async () => {
    const s = await services.config.settings();
    const oidcConfigured = s.auth.mode === 'oidc' && !!s.auth.oidc;
    return { mode: s.auth.mode, oidc_enabled: oidcConfigured || services.auth.oidc.enabled(), local_banner: s.auth.mode === 'local' };
  });

  app.post(`${API_PREFIX}/auth/login`, async (req, reply) => {
    const body = requireBody(req);
    const token = requireField<string>(body, 'token');
    const s = await services.config.settings();
    if (s.auth.mode !== 'local') throw new BreadboardError('forbidden', 'token login is only available in local mode; use OIDC');
    const out = await services.auth.loginLocal(token);
    if (!out) throw new BreadboardError('unauthorized', 'invalid login token');
    setSessionCookie(reply, services, out.session_token);
    return { session_token: out.session_token, user: out.user };
  });

  app.get(`${API_PREFIX}/auth/oidc/start`, async (_req, reply) => {
    const state = randomToken();
    const nonce = randomToken();
    const url = await services.auth.oidc.authorizationUrl(state, nonce);
    reply.setCookie(OIDC_COOKIE, sealState(stateKey, { state, nonce }), { httpOnly: true, sameSite: 'lax', path: OIDC_COOKIE_PATH, secure: secureCookies(services), maxAge: OIDC_STATE_TTL_S });
    return reply.redirect(url, 302);
  });

  app.get(`${API_PREFIX}/auth/oidc/callback`, async (req, reply) => {
    const expected = openState(stateKey, (req as any).cookies?.[OIDC_COOKIE]);
    reply.clearCookie(OIDC_COOKIE, { path: OIDC_COOKIE_PATH });
    if (!expected) throw new BreadboardError('unauthorized', 'OIDC login state missing or expired; start the login again');
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries((req.query as Record<string, unknown>) ?? {})) if (typeof v === 'string') params[k] = v;
    const out = await services.auth.oidc.callback(params, expected);
    setSessionCookie(reply, services, out.session_token);
    return reply.redirect('/', 302);
  });

  app.post(`${API_PREFIX}/auth/logout`, async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get(`${API_PREFIX}/me`, async (req) => {
    const p = principalOf(req);
    return { user: p.user, roles: p.roles, is_admin: p.is_admin, actor: p.actor, scopes: p.scopes, token_kind: p.token_kind, session_id: p.session_id };
  });

  // --- Personal access tokens ([12] §3) -------------------------------------------------------------
  // Only a browser sign-in may manage them: a session token or cookie (`user`), or an authenticating edge's
  // identity (`proxy`, which is same-origin only). A token can never mint a token, so a leaked read-only
  // token stays read-only, and service tokens stay the admin's business.
  const requireTokenManager = (p: Principal): UserRecord => {
    const user = requireUser(p);
    if (p.scopes !== null || (p.token_kind !== 'user' && p.token_kind !== 'proxy')) throw new BreadboardError('forbidden', 'sign in through the browser to manage personal access tokens');
    return user;
  };
  const mcpUrl = () => (services.publicUrl ? `${services.publicUrl.replace(/\/$/, '')}${API_PREFIX}/mcp` : null);

  app.get(`${API_PREFIX}/me/tokens`, async (req) => {
    const user = requireUser(principalOf(req));
    return { items: await services.identity.listUserTokens(user.user_id), next_cursor: null, mcp_url: mcpUrl() };
  });

  app.post(`${API_PREFIX}/me/tokens`, async (req, reply) => {
    const p = principalOf(req);
    const user = requireTokenManager(p);
    const body = requireBody(req);
    const name = requireField<string>(body, 'name').trim();
    if (!name) throw new BreadboardError('validation-failed', "field 'name' must be non-empty");
    const read_only = body.read_only === undefined ? true : body.read_only;
    if (typeof read_only !== 'boolean') throw new BreadboardError('validation-failed', "field 'read_only' must be a boolean");
    const days = body.expires_in_days === undefined ? TOKEN_DEFAULT_DAYS : Number(body.expires_in_days);
    if (!Number.isInteger(days) || days < 1 || days > TOKEN_MAX_DAYS) throw new BreadboardError('validation-failed', `field 'expires_in_days' must be an integer from 1 to ${TOKEN_MAX_DAYS}`);
    const { token, secret } = await services.identity.createUserToken({ team_id: p.team_id, user_id: user.user_id, name, scopes: read_only ? [...READ_ONLY_SCOPES] : null, expires_at: new Date(Date.now() + days * 864e5).toISOString() });
    reply.status(201);
    return { ...token, secret, mcp_url: mcpUrl() };
  });

  app.post(`${API_PREFIX}/me/tokens/:id/revoke`, async (req) => {
    const p = principalOf(req);
    const user = requireTokenManager(p);
    const { id } = req.params as { id: string };
    const token = await services.identity.revokeUserToken(id, user.user_id);
    if (!token) throw new BreadboardError('not-found', `personal access token ${id} not found`);
    services.auth.invalidate?.();
    return token;
  });
}
