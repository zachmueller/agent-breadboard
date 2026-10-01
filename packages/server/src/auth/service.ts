/**
 * AuthService ([12] §3, [11] §2): resolves every bearer token to a Principal.
 *
 * Token kinds:
 *  - `bbs_…` service tokens (admin-issued, hashed at rest, named capability scopes);
 *  - local-dev static user tokens from `breadboard.yaml` `auth.local_users` (mode `local` only) —
 *    the users are real `users` rows (`syncLocalUsers`);
 *  - user session tokens: compact HS256 JWS `{sub, kind:'user', exp}` minted after local/OIDC login;
 *  - internal actor tokens for sandbox executions / subagents: compact JWE (dir + A256GCM, key derived
 *    from the signing key) carrying the serialized principal (grants, visible sessions, config commit,
 *    execution key); TTL = execution. Encrypted rather than merely signed because grants carry hidden
 *    per-grant tool settings that tool code must not be able to read out of its own token.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, EncryptJWT, jwtVerify, jwtDecrypt, type JWTPayload } from 'jose';
import * as oidc from 'openid-client';
import { BreadboardError, type Actor, type BreadboardConfig } from '@breadboard/shared';
import type { Db } from '../db/index.js';
import type { Logger } from '../core/logger.js';
import type { AuthService, SessionStore } from '../core/services.js';
import { userPrincipal, type Grants, type Principal } from '../core/principal.js';
import { hashToken, type IdentityStore, type UserRecord } from '../identity/identity.js';

export const USER_TOKEN_TTL_S = 12 * 60 * 60;
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 2_000;
const ISSUER = 'agent-breadboard';
const USER_AUD = 'breadboard:user';
const ACTOR_AUD = 'breadboard:actor';

export interface AuthServiceDeps {
  db: Db;
  identity: IdentityStore;
  team_id: string;
  settings: () => Promise<BreadboardConfig>;
  signingKey: string;
  publicUrl: string;
  log: Logger;
  sessions: () => SessionStore | null;
  /** Re-resolve grants for actor tokens minted without embedded grants. */
  grantsResolver?: (subagentUid: string, commit: string, sessionId: string | null) => Promise<Grants>;
  /** Secret lookup for the OIDC client secret (defaults to `process.env`). */
  secretFor?: (envName: string) => string | undefined;
  /** Production: never accept the seed's well-known `*-change-me` local tokens. */
  rejectWellKnownTokens?: boolean;
  /**
   * `BREADBOARD_BOOTSTRAP_ADMIN_TOKEN`: authenticates as the `bootstrap-admin` user in any auth mode, so an operator
   * can sign in to a fresh production deployment (whose seed tokens are refused) and configure OIDC.
   */
  bootstrapAdminToken?: string | null;
}

export const BOOTSTRAP_ADMIN_HANDLE = 'bootstrap-admin';
const WELL_KNOWN_TOKEN = /-change-me$/;

// ---------------------------------------------------------------------------
// Grants (de)serialization — Maps/Sets ↔ arrays
// ---------------------------------------------------------------------------
export interface SerializedGrants {
  subagent_uid: string;
  tools: Array<[string, Record<string, unknown>]>;
  mcp: Array<[string, string[] | null]>;
  circuits: { read: string[]; execute: string[] };
  knowledge: { read: string[]; write: string[] };
  primitives: string[];
  tools_override: string[] | null;
}

export function serializeGrants(g: Grants): SerializedGrants {
  return {
    subagent_uid: g.subagent_uid,
    tools: [...g.tools.entries()],
    mcp: [...g.mcp.entries()],
    circuits: { read: [...g.circuits.read], execute: [...g.circuits.execute] },
    knowledge: { read: [...g.knowledge.read], write: [...g.knowledge.write] },
    primitives: [...g.primitives],
    tools_override: g.tools_override ? [...g.tools_override] : null,
  };
}

export function deserializeGrants(s: SerializedGrants): Grants {
  return {
    subagent_uid: s.subagent_uid,
    tools: new Map(s.tools ?? []),
    mcp: new Map(s.mcp ?? []),
    circuits: { read: new Set(s.circuits?.read ?? []), execute: new Set(s.circuits?.execute ?? []) },
    knowledge: { read: new Set(s.knowledge?.read ?? []), write: new Set(s.knowledge?.write ?? []) },
    primitives: new Set(s.primitives ?? []),
    tools_override: s.tools_override ? new Set(s.tools_override) : null,
  };
}

interface ActorClaimsBody {
  kind: 'actor';
  actor: Actor;
  team_id: string;
  user_id: string | null;
  roles: string[];
  is_admin: boolean;
  scopes: string[] | null;
  session_id: string | null;
  visible_sessions: string[] | null;
  config_commit: string | null;
  execution_key: string | null;
  grants: SerializedGrants | null;
}
type ActorClaims = JWTPayload & ActorClaimsBody;

// ---------------------------------------------------------------------------

export class AuthServiceImpl implements AuthService {
  private readonly jwsKey: Uint8Array;
  private readonly jweKey: Uint8Array;
  private readonly cache = new Map<string, { principal: Principal; until: number }>();
  private snapshot: BreadboardConfig | null = null;
  private localUsersSig: string | null = null;
  private oidcConfig: { key: string; config: oidc.Configuration } | null = null;

  readonly oidc: AuthService['oidc'];

  constructor(private deps: AuthServiceDeps) {
    if (!deps.signingKey) throw new Error('auth: signingKey is required');
    this.jwsKey = new TextEncoder().encode(deps.signingKey);
    this.jweKey = createHash('sha256').update(`breadboard-actor-token:${deps.signingKey}`).digest();
    this.oidc = {
      enabled: () => this.oidcEnabled(this.snapshot),
      authorizationUrl: (state, nonce) => this.oidcAuthorizationUrl(state, nonce),
      callback: (params, expected) => this.oidcCallback(params, expected),
    };
    void this.refresh().catch(() => undefined);
  }

  // --- authenticate --------------------------------------------------------

  async authenticate(token: string | null | undefined): Promise<Principal> {
    if (!token) throw new BreadboardError('unauthorized', 'missing credentials');
    const key = hashToken(token);
    const hit = this.cache.get(key);
    const now = Date.now();
    if (hit && hit.until > now) return hit.principal;
    if (hit) this.cache.delete(key);

    const { principal, expiresAtMs } = await this.resolve(token);
    this.remember(key, principal, Math.min(now + CACHE_TTL_MS, expiresAtMs ?? Infinity));
    return principal;
  }

  /** Drop cached principals (after deactivation / revocation, or in tests). */
  invalidate(): void {
    this.cache.clear();
  }

  private async resolve(token: string): Promise<{ principal: Principal; expiresAtMs: number | null }> {
    if (token.startsWith('bbs_')) {
      const t = await this.deps.identity.findServiceToken(token);
      if (!t || t.team_id !== this.deps.team_id) throw new BreadboardError('unauthorized', 'invalid service token');
      const principal: Principal = {
        actor: { kind: 'service', id: t.name },
        team_id: t.team_id,
        user: null,
        roles: [],
        is_admin: t.scopes.includes('admin'),
        scopes: [...t.scopes],
        grants: null,
        session_id: null,
        visible_sessions: null,
        config_commit: null,
        execution_key: null,
        token_kind: 'service',
      };
      return { principal, expiresAtMs: t.expires_at ? Date.parse(t.expires_at) : null };
    }

    const boot = await this.bootstrapAdmin(token);
    if (boot) return { principal: await this.principalForUser(boot), expiresAtMs: null };
    const settings = await this.refresh();
    const local = this.matchLocalUser(settings, token);
    if (local) {
      const user = await this.localUserRow(settings, local.handle);
      return { principal: await this.principalForUser(user), expiresAtMs: null };
    }

    const parts = token.split('.').length;
    if (parts === 3) return this.resolveUserJwt(token);
    if (parts === 5) return this.resolveActorJwt(token);
    throw new BreadboardError('unauthorized', 'invalid token');
  }

  private async resolveUserJwt(token: string): Promise<{ principal: Principal; expiresAtMs: number | null }> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwsKey, { algorithms: ['HS256'], issuer: ISSUER, audience: USER_AUD }));
    } catch (err: any) {
      throw new BreadboardError('unauthorized', err?.code === 'ERR_JWT_EXPIRED' ? 'token expired' : 'invalid token');
    }
    if (payload.kind !== 'user' || typeof payload.sub !== 'string') throw new BreadboardError('unauthorized', 'invalid token');
    const user = await this.activeUser(payload.sub);
    return { principal: await this.principalForUser(user), expiresAtMs: payload.exp ? payload.exp * 1000 : null };
  }

  private async resolveActorJwt(token: string): Promise<{ principal: Principal; expiresAtMs: number | null }> {
    let c: ActorClaims;
    try {
      const { payload } = await jwtDecrypt(token, this.jweKey, { issuer: ISSUER, audience: ACTOR_AUD, keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'] });
      c = payload as ActorClaims;
    } catch (err: any) {
      throw new BreadboardError('unauthorized', err?.code === 'ERR_JWT_EXPIRED' ? 'token expired' : 'invalid token');
    }
    if (c.kind !== 'actor' || !c.actor || c.team_id !== this.deps.team_id) throw new BreadboardError('unauthorized', 'invalid token');
    const user = c.user_id ? await this.activeUser(c.user_id) : null;
    let grants: Grants | null = c.grants ? deserializeGrants(c.grants) : null;
    if (!grants && (c.actor.kind === 'subagent' || c.actor.kind === 'code-step') && c.config_commit && this.deps.grantsResolver) {
      const subagentUid = c.actor.kind === 'subagent' ? c.actor.id : null;
      if (subagentUid) grants = await this.deps.grantsResolver(subagentUid, c.config_commit, c.session_id ?? null);
    }
    const principal: Principal = {
      actor: c.actor,
      team_id: c.team_id,
      user,
      roles: c.roles ?? [],
      is_admin: !!c.is_admin && (!user || user.is_admin),
      scopes: c.scopes ?? null,
      grants,
      session_id: c.session_id ?? null,
      visible_sessions: c.visible_sessions ?? null,
      config_commit: c.config_commit ?? null,
      execution_key: c.execution_key ?? null,
      token_kind: 'actor',
    };
    return { principal, expiresAtMs: c.exp ? c.exp * 1000 : null };
  }

  private async activeUser(userId: string): Promise<UserRecord> {
    const user = await this.deps.identity.getUser(userId);
    if (!user || user.team_id !== this.deps.team_id) throw new BreadboardError('unauthorized', 'unknown user');
    if (user.deactivated_at) throw new BreadboardError('unauthorized', 'user is deactivated');
    return user;
  }

  private remember(key: string, principal: Principal, until: number): void {
    if (this.cache.size >= CACHE_MAX) {
      const now = Date.now();
      for (const [k, v] of this.cache) if (v.until <= now) this.cache.delete(k);
      while (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(key, { principal, until });
  }

  // --- minting -------------------------------------------------------------

  async mintUserToken(user: UserRecord, ttlSeconds = USER_TOKEN_TTL_S): Promise<string> {
    return new SignJWT({ kind: 'user', team_id: user.team_id })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.user_id)
      .setIssuer(ISSUER)
      .setAudience(USER_AUD)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(ttlSeconds)))
      .sign(this.jwsKey);
  }

  async mintActorToken(input: { principal: Principal; ttlSeconds: number; execution_key?: string | null }): Promise<string> {
    const p = input.principal;
    const claims: ActorClaimsBody = {
      kind: 'actor',
      actor: p.actor,
      team_id: p.team_id,
      user_id: p.user?.user_id ?? null,
      roles: p.roles,
      is_admin: p.is_admin,
      scopes: p.scopes,
      session_id: p.session_id,
      visible_sessions: p.visible_sessions,
      config_commit: p.config_commit,
      execution_key: input.execution_key ?? p.execution_key ?? null,
      grants: p.grants ? serializeGrants(p.grants) : null,
    };
    return new EncryptJWT(claims as unknown as JWTPayload)
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(ACTOR_AUD)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(input.ttlSeconds)))
      .encrypt(this.jweKey);
  }

  // --- users ---------------------------------------------------------------

  async principalForUser(user: UserRecord): Promise<Principal> {
    const roles = await this.deps.identity.rolesOfUser(user.user_id);
    return userPrincipal(user, roles);
  }

  async loginLocal(token: string): Promise<{ user: UserRecord; session_token: string } | null> {
    if (!token) return null;
    const boot = await this.bootstrapAdmin(token);
    if (boot) return { user: boot, session_token: await this.mintUserToken(boot) };
    const settings = await this.refresh();
    const local = this.matchLocalUser(settings, token);
    if (!local) return null;
    let user: UserRecord;
    try {
      user = await this.localUserRow(settings, local.handle);
    } catch {
      return null;
    }
    return { user, session_token: await this.mintUserToken(user) };
  }

  /**
   * Upsert each static user (handle, display_name, is_admin) and add their configured review-role
   * memberships. Memberships are additive: roles are DB-managed ([09] §7.1), so admin-assigned
   * memberships are not clobbered. Users deactivated by an admin stay deactivated.
   */
  async syncLocalUsers(): Promise<void> {
    const settings = await this.refresh();
    await this.syncLocal(settings);
    const refused = settings.auth.mode === 'local' && this.deps.rejectWellKnownTokens ? settings.auth.local_users.filter((u) => WELL_KNOWN_TOKEN.test(u.token)) : [];
    if (refused.length) {
      this.deps.log.warn(
        { users: refused.map((u) => u.handle), bootstrap_admin: !!this.deps.bootstrapAdminToken },
        'production: local users with well-known *-change-me tokens are refused; sign in with BREADBOARD_BOOTSTRAP_ADMIN_TOKEN and configure OIDC or real tokens',
      );
    }
  }

  /** The break-glass admin for `bootstrapAdminToken`; created once, never re-enabled once an admin deactivates it. */
  private async bootstrapAdmin(token: string): Promise<UserRecord | null> {
    const expected = this.deps.bootstrapAdminToken;
    if (!expected) return null;
    if (!timingSafeEqual(createHash('sha256').update(token).digest(), createHash('sha256').update(expected).digest())) return null;
    const { identity, team_id } = this.deps;
    const existing = await identity.getUserByHandle(team_id, BOOTSTRAP_ADMIN_HANDLE);
    if (existing) return existing.deactivated_at ? null : existing;
    return identity.upsertUser({ team_id, handle: BOOTSTRAP_ADMIN_HANDLE, display_name: 'Bootstrap admin', is_admin: true });
  }

  private async syncLocal(settings: BreadboardConfig): Promise<void> {
    const { identity, team_id } = this.deps;
    for (const u of settings.auth.local_users) {
      const existing = await identity.getUserByHandle(team_id, u.handle);
      if (existing?.deactivated_at) continue;
      const user = await identity.upsertUser({ team_id, handle: u.handle, display_name: u.display_name ?? u.handle, is_admin: u.admin });
      if (u.roles.length) await identity.syncUserRoles(team_id, user.user_id, u.roles);
    }
    this.localUsersSig = localUsersSignature(settings);
  }

  private matchLocalUser(settings: BreadboardConfig, token: string): BreadboardConfig['auth']['local_users'][number] | null {
    if (settings.auth.mode !== 'local') return null;
    const given = createHash('sha256').update(token).digest();
    let found: BreadboardConfig['auth']['local_users'][number] | null = null;
    for (const u of settings.auth.local_users) {
      const expected = createHash('sha256').update(u.token).digest();
      // constant-time over every candidate; no early exit
      if (timingSafeEqual(given, expected) && !found && !(this.deps.rejectWellKnownTokens && WELL_KNOWN_TOKEN.test(u.token))) found = u;
    }
    return found;
  }

  private async localUserRow(settings: BreadboardConfig, handle: string): Promise<UserRecord> {
    if (this.localUsersSig !== localUsersSignature(settings)) await this.syncLocal(settings);
    let user = await this.deps.identity.getUserByHandle(this.deps.team_id, handle);
    if (!user) {
      await this.syncLocal(settings);
      user = await this.deps.identity.getUserByHandle(this.deps.team_id, handle);
    }
    if (!user) throw new BreadboardError('unauthorized', 'unknown user');
    if (user.deactivated_at) throw new BreadboardError('unauthorized', 'user is deactivated');
    return user;
  }

  private async refresh(): Promise<BreadboardConfig> {
    const s = await this.deps.settings();
    this.snapshot = s;
    return s;
  }

  // --- OIDC ----------------------------------------------------------------

  private oidcEnabled(s: BreadboardConfig | null): boolean {
    return !!s && s.auth.mode === 'oidc' && !!s.auth.oidc;
  }

  private redirectUri(s: BreadboardConfig): string {
    return s.auth.oidc?.redirect_uri ?? `${this.deps.publicUrl.replace(/\/+$/, '')}/api/v1/auth/oidc/callback`;
  }

  /** PKCE verifier derived from the state (HMAC with the signing key) so no extra state is stored. */
  private pkceVerifier(state: string): string {
    return createHmac('sha256', this.deps.signingKey).update(`pkce:${state}`).digest('base64url');
  }

  private async oidcClient(): Promise<{ settings: BreadboardConfig; config: oidc.Configuration }> {
    const settings = await this.refresh();
    if (!this.oidcEnabled(settings)) throw new BreadboardError('not-found', 'OIDC login is not configured');
    const o = settings.auth.oidc!;
    const secret = (this.deps.secretFor ?? ((n: string) => process.env[n]))(o.client_secret_env) || undefined;
    const key = JSON.stringify([o.issuer, o.client_id, !!secret]);
    if (this.oidcConfig?.key === key) return { settings, config: this.oidcConfig.config };
    const issuer = new URL(o.issuer);
    const config = await oidc.discovery(issuer, o.client_id, secret, secret ? undefined : oidc.None(), issuer.protocol === 'http:' ? { execute: [oidc.allowInsecureRequests] } : undefined);
    this.oidcConfig = { key, config };
    return { settings, config };
  }

  private async oidcAuthorizationUrl(state: string, nonce: string): Promise<string> {
    const { settings, config } = await this.oidcClient();
    const o = settings.auth.oidc!;
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri(settings),
      scope: o.scopes.join(' '),
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(this.pkceVerifier(state)),
      code_challenge_method: 'S256',
    });
    return url.href;
  }

  private async oidcCallback(params: Record<string, string>, expected: { state: string; nonce: string }): Promise<{ user: UserRecord; session_token: string }> {
    if (params.error) throw new BreadboardError('unauthorized', `OIDC provider error: ${params.error}${params.error_description ? ` (${params.error_description})` : ''}`);
    if (!expected.state || !params.state || params.state !== expected.state) throw new BreadboardError('unauthorized', 'OIDC state mismatch');
    const { settings, config } = await this.oidcClient();
    const o = settings.auth.oidc!;
    const current = new URL(this.redirectUri(settings));
    for (const [k, v] of Object.entries(params)) current.searchParams.set(k, v);

    let claims: Record<string, unknown>;
    let accessToken: string;
    try {
      const tokens = await oidc.authorizationCodeGrant(config, current, { expectedState: expected.state, expectedNonce: expected.nonce, pkceCodeVerifier: this.pkceVerifier(expected.state), idTokenExpected: true });
      claims = (tokens.claims() ?? {}) as Record<string, unknown>;
      accessToken = tokens.access_token;
    } catch (err: any) {
      this.deps.log.warn({ err: err?.message ?? String(err) }, 'OIDC code exchange failed');
      throw new BreadboardError('unauthorized', 'OIDC login failed');
    }
    const sub = String(claims.sub ?? '');
    if (!sub) throw new BreadboardError('unauthorized', 'OIDC id token has no subject');
    let info: Record<string, unknown> = {};
    try {
      info = (await oidc.fetchUserInfo(config, accessToken, sub)) as Record<string, unknown>;
    } catch (err: any) {
      this.deps.log.debug({ err: err?.message }, 'OIDC userinfo unavailable; using id token claims');
    }
    const merged = { ...claims, ...info };
    const user = await this.upsertOidcUser(settings, sub, merged);
    return { user, session_token: await this.mintUserToken(user) };
  }

  private async upsertOidcUser(settings: BreadboardConfig, sub: string, c: Record<string, unknown>): Promise<UserRecord> {
    const { identity, team_id } = this.deps;
    const o = settings.auth.oidc!;
    const existing = await identity.getUserByOidc(sub);
    if (existing?.deactivated_at) throw new BreadboardError('unauthorized', 'user is deactivated');

    const email = typeof c.email === 'string' ? c.email : '';
    let handle = sanitizeHandle(typeof c.preferred_username === 'string' && c.preferred_username ? c.preferred_username : email ? email.split('@')[0]! : sub);
    // Never link to (or collide with) another account by handle: suffix on conflict.
    const clash = await identity.getUserByHandle(team_id, handle);
    if (clash && clash.oidc_subject !== sub) handle = `${handle}-${createHash('sha256').update(sub).digest('hex').slice(0, 6)}`;
    const display_name = typeof c.name === 'string' && c.name ? c.name : handle;

    const groups = groupsOf(c[o.groups_claim]);
    const adminGroups = o.group_mappings.admin;
    const is_admin = adminGroups.length ? groups.some((g) => adminGroups.includes(g)) : undefined; // no mapping → leave as managed in the DB
    const user = await identity.upsertUser({ team_id, handle, display_name, oidc_subject: sub, is_admin });

    // Review roles governed by group mappings are synced both ways; unmapped roles are left to the admin UI.
    const add: string[] = [];
    const remove: string[] = [];
    for (const [slug, mapped] of Object.entries(o.group_mappings.roles)) (groups.some((g) => mapped.includes(g)) ? add : remove).push(slug);
    if (add.length) await identity.syncUserRoles(team_id, user.user_id, add);
    if (remove.length) {
      const roles = await identity.listRoles(team_id);
      for (const r of roles) if (remove.includes(r.slug) && r.members.includes(user.user_id)) await identity.setMembership(r.role_id, user.user_id, false);
    }
    return user;
  }
}

export function createAuthService(deps: AuthServiceDeps): AuthServiceImpl {
  return new AuthServiceImpl(deps);
}

/** Random URL-safe value for OIDC state / nonce. */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

function localUsersSignature(s: BreadboardConfig): string {
  return createHash('sha256')
    .update(JSON.stringify(s.auth.local_users.map((u) => [u.handle, u.display_name ?? null, u.admin, u.roles])))
    .digest('hex');
}

function sanitizeHandle(h: string): string {
  const s = h.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 64) || 'user';
}

function groupsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(/[\s,]+/).filter(Boolean);
  return [];
}
