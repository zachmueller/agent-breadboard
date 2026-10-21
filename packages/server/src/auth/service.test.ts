import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { EncryptJWT, SignJWT } from 'jose';
import { BreadboardError, zBreadboardConfig, type BreadboardConfig } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import { requireAdmin, requireScope, type Grants, type Principal } from '../core/principal.js';
import { createAuthService, deserializeGrants, serializeGrants, type AuthServiceImpl } from './service.js';

const KEY = 'test-signing-key-0123456789';

function cfg(auth: Record<string, unknown>): BreadboardConfig {
  return zBreadboardConfig.parse({ schema: 'breadboard/breadboard@v1', auth });
}

async function expectUnauthorized(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof BreadboardError && e.code === 'unauthorized');
}

function sampleGrants(): Grants {
  return {
    subagent_uid: 'SUBAGENT0000000000AA',
    tools: new Map([['TOOL0000000000000001', { repo: 'team/app', hidden_limit: 3 }]]),
    mcp: new Map<string, string[] | null>([
      ['MCP00000000000000001', ['search', 'fetch']],
      ['MCP00000000000000002', null],
    ]),
    circuits: { read: new Set(['C1']), execute: new Set(['C2']) },
    knowledge: { read: new Set(['eng', 'ops']), write: new Set(['eng']) },
    primitives: new Set(['create_artifact', 'read_note']),
    repos: new Set(['handbook']),
    tools_override: new Set(['TOOL0000000000000001']),
  };
}

describe('AuthService', () => {
  let f: Foundation;
  let settings: BreadboardConfig;
  let auth: AuthServiceImpl;

  beforeAll(async () => {
    f = await createFoundation();
  });
  afterAll(async () => {
    await f.close();
  });
  beforeEach(() => {
    settings = cfg({
      mode: 'local',
      local_users: [
        { handle: 'zach', display_name: 'Zach', token: 'local-token-zach', admin: true, roles: ['reviewer', 'scientist'] },
        { handle: 'robin', token: 'local-token-robin' },
      ],
    });
    auth = createAuthService({ db: f.db, identity: f.identity, team_id: f.team_id, settings: async () => settings, signingKey: KEY, publicUrl: 'http://localhost:4000', log: f.log, sessions: () => null });
  });

  it('refuses the seed\'s well-known tokens in production and accepts the bootstrap admin token in any mode', async () => {
    settings = cfg({ mode: 'local', local_users: [{ handle: 'admin', token: 'dev-admin-token-change-me', admin: true }, { handle: 'zach', token: 'local-token-zach' }] });
    const prod = createAuthService({ db: f.db, identity: f.identity, team_id: f.team_id, settings: async () => settings, signingKey: KEY, publicUrl: 'http://x', log: f.log, sessions: () => null, rejectWellKnownTokens: true, bootstrapAdminToken: 'boot-secret-0123456789' });
    await expectUnauthorized(prod.authenticate('dev-admin-token-change-me'));
    expect(await prod.loginLocal('dev-admin-token-change-me')).toBeNull();
    expect((await prod.authenticate('local-token-zach')).actor).toMatchObject({ handle: 'zach' }); // operator-set tokens still work
    const boot = await prod.authenticate('boot-secret-0123456789');
    expect(boot.actor).toMatchObject({ kind: 'user', handle: 'bootstrap-admin' });
    expect(boot.is_admin).toBe(true);
    expect((await prod.loginLocal('boot-secret-0123456789'))?.user.handle).toBe('bootstrap-admin');
    settings = cfg({ mode: 'oidc', oidc: { issuer: 'https://idp.example.com/', client_id: 'bb', client_secret_env: 'X', group_mappings: { admin: [], roles: {} } } } as any);
    expect((await prod.authenticate('boot-secret-0123456789')).actor).toMatchObject({ handle: 'bootstrap-admin' });
    // An admin can revoke it: once deactivated it is never re-enabled.
    const row = await f.identity.getUserByHandle(f.team_id, 'bootstrap-admin');
    await f.identity.deactivateUser(row!.user_id);
    prod.invalidate(); // as the admin deactivation route does
    await expectUnauthorized(prod.authenticate('boot-secret-0123456789'));
    // Development keeps accepting the seed tokens.
    settings = cfg({ mode: 'local', local_users: [{ handle: 'admin', token: 'dev-admin-token-change-me', admin: true }] });
    expect((await auth.authenticate('dev-admin-token-change-me')).actor).toMatchObject({ handle: 'admin' });
  });

  it('rejects missing and garbage tokens', async () => {
    await expectUnauthorized(auth.authenticate(null));
    await expectUnauthorized(auth.authenticate(''));
    await expectUnauthorized(auth.authenticate('not-a-token'));
    await expectUnauthorized(auth.authenticate('a.b.c'));
    await expectUnauthorized(auth.authenticate('a.b.c.d.e'));
    await expectUnauthorized(auth.authenticate('bbs_doesnotexist'));
  });

  it('resolves a local static token to a real users row with roles', async () => {
    const p = await auth.authenticate('local-token-zach');
    expect(p.token_kind).toBe('user');
    expect(p.actor).toMatchObject({ kind: 'user', handle: 'zach' });
    expect(p.is_admin).toBe(true);
    expect(p.scopes).toBeNull();
    expect(p.visible_sessions).toBeNull();
    expect(p.roles.sort()).toEqual(['reviewer', 'scientist']);
    const row = await f.identity.getUserByHandle(f.team_id, 'zach');
    expect(row).toMatchObject({ user_id: p.user!.user_id, display_name: 'Zach', is_admin: true, oidc_subject: null });
    expect((await f.identity.usersInRole(f.team_id, 'reviewer')).map((u) => u.handle)).toContain('zach');

    const robin = await auth.authenticate('local-token-robin');
    expect(robin).toMatchObject({ is_admin: false, roles: [] });
    expect(() => requireAdmin(robin)).toThrow();
  });

  it('ignores static tokens outside local mode', async () => {
    settings = cfg({ mode: 'oidc', local_users: [{ handle: 'zach', token: 'local-token-zach' }] });
    await expectUnauthorized(auth.authenticate('local-token-zach'));
    expect(await auth.loginLocal('local-token-zach')).toBeNull();
  });

  it('syncLocalUsers upserts every static user and respects admin deactivation', async () => {
    await auth.syncLocalUsers();
    const robin = (await f.identity.getUserByHandle(f.team_id, 'robin'))!;
    expect(robin).toMatchObject({ display_name: 'robin', is_admin: false });
    await f.identity.deactivateUser(robin.user_id);
    await auth.syncLocalUsers();
    expect((await f.identity.getUserByHandle(f.team_id, 'robin'))!.deactivated_at).not.toBeNull();
    await expectUnauthorized(auth.authenticate('local-token-robin'));
    expect(await auth.loginLocal('local-token-robin')).toBeNull();
    await f.identity.upsertUser({ team_id: f.team_id, handle: 'robin' }); // reactivate for later tests
  });

  it('loginLocal returns the user and a session token that authenticates', async () => {
    expect(await auth.loginLocal('wrong-token')).toBeNull();
    const out = (await auth.loginLocal('local-token-zach'))!;
    expect(out.user.handle).toBe('zach');
    expect(out.session_token.split('.')).toHaveLength(3);
    const p = await auth.authenticate(out.session_token);
    expect(p.user!.user_id).toBe(out.user.user_id);
    expect(p.token_kind).toBe('user');
    expect(p.roles).toContain('reviewer');
  });

  it('service tokens resolve to scoped service principals', async () => {
    const { secret, token } = await f.identity.createServiceToken({ team_id: f.team_id, name: 'ci-pipeline', scopes: ['tasks:write', 'events:read'], created_by: f.adminPrincipal.actor });
    const p = await auth.authenticate(secret);
    expect(p).toMatchObject({ actor: { kind: 'service', id: 'ci-pipeline' }, user: null, roles: [], is_admin: false, visible_sessions: null, token_kind: 'service', scopes: ['tasks:write', 'events:read'] });
    expect(() => requireScope(p, 'tasks:write')).not.toThrow();
    expect(() => requireScope(p, 'tasks:read')).not.toThrow(); // write implies read
    expect(() => requireScope(p, 'events:read')).not.toThrow();
    expect(() => requireScope(p, 'sessions:read')).toThrow(BreadboardError);
    expect(() => requireScope(p, 'events:write')).toThrow(BreadboardError);
    expect(() => requireAdmin(p)).toThrow(BreadboardError);

    const admin = await f.identity.createServiceToken({ team_id: f.team_id, name: 'ops', scopes: ['admin'], created_by: f.adminPrincipal.actor });
    const ap = await auth.authenticate(admin.secret);
    expect(ap.is_admin).toBe(true);
    expect(() => requireScope(ap, 'config:merge')).not.toThrow();

    await f.identity.revokeServiceToken(token.token_id);
    expect((await auth.authenticate(secret)).actor.id).toBe('ci-pipeline'); // cached ≤30 s
    auth.invalidate();
    await expectUnauthorized(auth.authenticate(secret));
  });

  it('user JWT round trip; deactivated users are rejected', async () => {
    const tok = await auth.mintUserToken(f.member);
    const p = await auth.authenticate(tok);
    expect(p.user!.user_id).toBe(f.member.user_id);
    expect(p.roles).toEqual(['scientist']);
    expect(p.is_admin).toBe(false);

    const other = createAuthService({ db: f.db, identity: f.identity, team_id: f.team_id, settings: async () => settings, signingKey: 'a-different-key-entirely', publicUrl: 'http://x', log: f.log, sessions: () => null });
    await expectUnauthorized(other.authenticate(tok)); // wrong signing key

    const temp = await f.identity.upsertUser({ team_id: f.team_id, handle: 'temp' });
    const tt = await auth.mintUserToken(temp);
    await auth.authenticate(tt);
    await f.identity.deactivateUser(temp.user_id);
    auth.invalidate();
    await expectUnauthorized(auth.authenticate(tt));
  });

  it('expired tokens are unauthorized', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const userTok = await new SignJWT({ kind: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(f.member.user_id)
      .setIssuer('agent-breadboard')
      .setAudience('breadboard:user')
      .setExpirationTime(past)
      .sign(new TextEncoder().encode(KEY));
    await expect(auth.authenticate(userTok)).rejects.toThrow(/expired/);

    const jweKey = createHash('sha256').update(`breadboard-actor-token:${KEY}`).digest();
    const actorTok = await new EncryptJWT({ kind: 'actor', actor: { kind: 'subagent', id: 'S' }, team_id: f.team_id })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuer('agent-breadboard')
      .setAudience('breadboard:actor')
      .setExpirationTime(past)
      .encrypt(jweKey);
    await expect(auth.authenticate(actorTok)).rejects.toThrow(/expired/);
  });

  it('actor tokens round-trip the principal, restoring Maps/Sets and visible sessions', async () => {
    const grants = sampleGrants();
    const principal: Principal = {
      actor: { kind: 'subagent', id: grants.subagent_uid, session_id: 'ses_CHILD', step_id: 'draft' },
      team_id: f.team_id,
      user: null,
      roles: [],
      is_admin: false,
      scopes: null,
      grants,
      session_id: 'ses_CHILD',
      visible_sessions: ['ses_CHILD', 'ses_PARENT'],
      config_commit: 'a'.repeat(40),
      execution_key: null,
      token_kind: 'actor',
    };
    const tok = await auth.mintActorToken({ principal, ttlSeconds: 300, execution_key: 'exe_123' });
    expect(tok.split('.')).toHaveLength(5); // encrypted: grants are not readable by tool code
    expect(Buffer.from(tok.split('.')[0]!, 'base64url').toString()).not.toContain('team/app');

    const p = await auth.authenticate(tok);
    expect(p.token_kind).toBe('actor');
    expect(p.actor).toEqual(principal.actor);
    expect(p.session_id).toBe('ses_CHILD');
    expect(p.visible_sessions).toEqual(['ses_CHILD', 'ses_PARENT']);
    expect(p.config_commit).toBe('a'.repeat(40));
    expect(p.execution_key).toBe('exe_123');
    expect(p.user).toBeNull();
    const g = p.grants!;
    expect(g.tools).toBeInstanceOf(Map);
    expect(g.tools.get('TOOL0000000000000001')).toEqual({ repo: 'team/app', hidden_limit: 3 });
    expect(g.mcp.get('MCP00000000000000001')).toEqual(['search', 'fetch']);
    expect(g.mcp.get('MCP00000000000000002')).toBeNull();
    expect(g.circuits.read).toBeInstanceOf(Set);
    expect([...g.circuits.execute]).toEqual(['C2']);
    expect(g.knowledge.read.has('ops')).toBe(true);
    expect(g.knowledge.write.has('ops')).toBe(false);
    expect(g.primitives.has('read_note')).toBe(true);
    expect([...g.tools_override!]).toEqual(['TOOL0000000000000001']);
  });

  it('actor tokens for a user acting in a session reload the user', async () => {
    const base = await auth.principalForUser(f.member);
    const tok = await auth.mintActorToken({ principal: { ...base, session_id: 'ses_CONV', visible_sessions: ['ses_CONV'] }, ttlSeconds: 60 });
    const p = await auth.authenticate(tok);
    expect(p.user!.handle).toBe('member');
    expect(p.roles).toEqual(['scientist']);
    expect(p.visible_sessions).toEqual(['ses_CONV']);
    expect(p.grants).toBeNull();
  });

  it('uses grantsResolver when an actor token carries no grants', async () => {
    const calls: unknown[] = [];
    const withResolver = createAuthService({
      db: f.db, identity: f.identity, team_id: f.team_id, settings: async () => settings, signingKey: KEY, publicUrl: 'http://x', log: f.log, sessions: () => null,
      grantsResolver: async (uid, commit, sid) => {
        calls.push([uid, commit, sid]);
        return sampleGrants();
      },
    });
    const principal: Principal = { ...f.servicePrincipal, actor: { kind: 'subagent', id: 'SUB' }, is_admin: false, grants: null, session_id: 'ses_1', visible_sessions: ['ses_1'], config_commit: 'c0ffee', token_kind: 'actor' };
    const p = await withResolver.authenticate(await withResolver.mintActorToken({ principal, ttlSeconds: 60 }));
    expect(calls).toEqual([['SUB', 'c0ffee', 'ses_1']]);
    expect(p.grants!.primitives.has('create_artifact')).toBe(true);
  });

  it('grants (de)serialization is lossless', () => {
    const g = sampleGrants();
    const back = deserializeGrants(JSON.parse(JSON.stringify(serializeGrants(g))));
    expect(back).toEqual(g);
  });

  it('principalForUser loads DB roles', async () => {
    const p = await auth.principalForUser(f.member);
    expect(p).toMatchObject({ roles: ['scientist'], is_admin: false, token_kind: 'user' });
  });

  it('OIDC is disabled in local mode and reports not-found', async () => {
    await auth.syncLocalUsers();
    expect(auth.oidc.enabled()).toBe(false);
    await expect(auth.oidc.authorizationUrl('s', 'n')).rejects.toSatisfy((e: unknown) => e instanceof BreadboardError && e.code === 'not-found');
    settings = cfg({ mode: 'oidc', oidc: { issuer: 'https://idp.example.com', client_id: 'bb' } });
    await auth.syncLocalUsers(); // refreshes the settings snapshot
    expect(auth.oidc.enabled()).toBe(true);
    await expect(auth.oidc.callback({ state: 'x', code: 'c' }, { state: 'y', nonce: 'n' })).rejects.toThrow(/state mismatch/);
  });
});

describe('AuthService: disabling the bootstrap admin', () => {
  let f: Foundation;
  let settings: BreadboardConfig;
  const BOOT = 'boot-secret-0123456789';

  beforeAll(async () => {
    f = await createFoundation();
  });
  afterAll(async () => {
    await f.close();
  });

  /** A production auth service with a spy logger, as build.ts creates it. */
  function service(bootstrapAdminToken: string | null) {
    const log = Object.assign(Object.create(f.log), { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    const auth = createAuthService({ db: f.db, identity: f.identity, team_id: f.team_id, settings: async () => settings, signingKey: KEY, publicUrl: 'http://x', log, sessions: () => null, rejectWellKnownTokens: true, bootstrapAdminToken });
    return { auth, log };
  }

  it('refuses the token, and the sessions it started, once disabled; accepts both again when re-enabled', async () => {
    settings = cfg({ mode: 'local', local_users: [] });
    const session = (await service(BOOT).auth.loginLocal(BOOT))!.session_token;
    expect((await service(BOOT).auth.authenticate(session)).actor).toMatchObject({ handle: 'bootstrap-admin' });

    for (const off of [null, '']) {
      const { auth } = service(off);
      await expectUnauthorized(auth.authenticate(BOOT));
      expect(await auth.loginLocal(BOOT)).toBeNull();
      await expect(auth.authenticate(session)).rejects.toThrow(/bootstrap admin is disabled/);
    }
    // Disabling is a switch, not a deactivation: turning it back on restores access (the break-glass path).
    expect((await service(BOOT).auth.authenticate(session)).actor).toMatchObject({ handle: 'bootstrap-admin' });
  });

  it('lists the ways an admin can still sign in', async () => {
    settings = cfg({
      mode: 'local',
      local_users: [
        { handle: 'zach', token: 'a-real-operator-token-0123', admin: true },
        { handle: 'seed', token: 'dev-admin-token-change-me', admin: true },
        { handle: 'robin', token: 'robin-real-token-0123456' },
      ],
    });
    expect(await service(BOOT).auth.adminSignInPaths()).toEqual(['bootstrap admin token', 'local user zach']);
    expect(await service(null).auth.adminSignInPaths()).toEqual(['local user zach']); // the seed token is refused in production

    settings = cfg({ mode: 'oidc', oidc: { issuer: 'https://idp.example.com/', client_id: 'bb', client_secret_env: 'X', group_mappings: { admin: ['bb-admins'], roles: {} } } } as any);
    expect(await service(null).auth.adminSignInPaths()).toEqual(['OIDC admin group']);
  });

  it('logs an error at startup when disabling the token would leave no admin able to sign in', async () => {
    settings = cfg({ mode: 'local', local_users: [{ handle: 'seed2', token: 'dev-admin-token-change-me', admin: true }] });
    const off = service(null);
    await off.auth.syncLocalUsers();
    expect(off.log.error).toHaveBeenCalledWith(expect.objectContaining({ bootstrap_admin: false }), expect.stringMatching(/no admin can sign in.*bootstrapAdmin=true/));
    expect(off.log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/set real tokens or configure OIDC/));

    const on = service(BOOT);
    await on.auth.syncLocalUsers();
    expect(on.log.error).not.toHaveBeenCalled();
    expect(on.log.info).toHaveBeenCalledWith(expect.objectContaining({ admin_sign_in: ['bootstrap admin token'] }), 'admin sign-in paths');
  });
});
