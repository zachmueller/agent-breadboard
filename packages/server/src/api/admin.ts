/**
 * Admin API ([12] §4: admin = instance settings, broker credentials, service tokens, user management)
 * under `/api/v1/admin`, plus the read-only `/api/v1/roles` list every member needs for need-input targeting.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BreadboardError } from '@breadboard/shared';
import type { Services } from '../core/services.js';
import { requireAdmin } from '../core/principal.js';
import { SERVICE_SCOPES, type UserRecord } from '../identity/identity.js';
import { API_PREFIX } from '../app.js';
import { intParam, principalOf, requireBody, requireField } from './util.js';

const ADMIN = `${API_PREFIX}/admin`;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

async function rolesWithMembers(services: Services) {
  const [roles, users] = await Promise.all([services.identity.listRoles(services.team_id), services.identity.listUsers(services.team_id)]);
  const byId = new Map<string, UserRecord>(users.map((u) => [u.user_id, u]));
  return roles.map((r) => ({
    role_id: r.role_id,
    slug: r.slug,
    description: r.description,
    members: r.members
      .map((id) => byId.get(id))
      .filter((u): u is UserRecord => !!u && !u.deactivated_at)
      .map((u) => ({ user_id: u.user_id, handle: u.handle, display_name: u.display_name })),
  }));
}

export async function register(app: FastifyInstance, services: Services): Promise<void> {
  const { identity, team_id } = services;

  // Every /admin route is admin-only (route-level preHandler runs after the global auth hook).
  const adminOnly = { preHandler: async (req: FastifyRequest) => requireAdmin(principalOf(req)) };

  // --- Roles (read-only, any member) --------------------------------------
  app.get(`${API_PREFIX}/roles`, async () => {
    const roles = await rolesWithMembers(services);
    return { items: roles.map((r) => ({ slug: r.slug, description: r.description, members: r.members.map((m) => m.handle) })), next_cursor: null };
  });

  // --- Users --------------------------------------------------------------
  app.get(`${ADMIN}/users`, adminOnly, async () => ({ items: await identity.listUsers(team_id), next_cursor: null }));

  app.post(`${ADMIN}/users`, adminOnly, async (req, reply) => {
    const body = requireBody(req);
    const handle = requireField<string>(body, 'handle');
    if (!HANDLE_RE.test(handle)) throw new BreadboardError('validation-failed', 'handle must be 1-64 chars of letters, digits, ".", "_" or "-"');
    if (body.display_name !== undefined && typeof body.display_name !== 'string') throw new BreadboardError('validation-failed', "field 'display_name' must be a string");
    if (body.is_admin !== undefined && typeof body.is_admin !== 'boolean') throw new BreadboardError('validation-failed', "field 'is_admin' must be a boolean");
    // The admin flag of an existing user changes only through its own guarded route below.
    const existing = await identity.getUserByHandle(team_id, handle);
    if (existing && body.is_admin !== undefined && body.is_admin !== existing.is_admin) {
      throw new BreadboardError('conflict', `user ${handle} exists; change its admin flag with POST ${ADMIN}/users/${existing.user_id}/admin`, { user_id: existing.user_id });
    }
    const user = await identity.upsertUser({ team_id, handle, display_name: body.display_name, is_admin: body.is_admin });
    reply.status(201);
    return user;
  });

  // Grant or revoke admin ([12] §4). Never your own flag, and never the last active admin, so no one is locked out.
  app.post(`${ADMIN}/users/:id/admin`, adminOnly, async (req) => {
    const { id } = req.params as { id: string };
    const body = requireBody(req);
    const is_admin = requireField<boolean>(body, 'is_admin', 'boolean');
    const by = principalOf(req);
    const user = await identity.getUser(id);
    if (!user || user.team_id !== team_id) throw new BreadboardError('not-found', `user ${id} not found`);
    if (user.deactivated_at) throw new BreadboardError('invalid-state', `user ${user.handle} is deactivated`);
    if (by.user?.user_id === id) throw new BreadboardError('validation-failed', 'you cannot change your own admin flag');
    if (user.is_admin === is_admin) return user;
    if (!is_admin) {
      const admins = (await identity.listUsers(team_id)).filter((u) => u.is_admin && !u.deactivated_at);
      if (admins.length <= 1) throw new BreadboardError('invalid-state', `${user.handle} is the last active admin`);
    }
    const updated = (await identity.setAdmin(id, is_admin))!;
    // Cached principals carry the old flag: an admin's full-access tokens must stop working at once.
    services.auth.invalidate?.();
    services.log.info({ user: updated.handle, is_admin, by: by.actor }, 'admin flag changed');
    await services.events.publish('user.admin-changed', { user_id: id, handle: updated.handle, is_admin, by: by.actor }, { scope: 'team' });
    return updated;
  });

  app.post(`${ADMIN}/users/:id/deactivate`, adminOnly, async (req) => {
    const { id } = req.params as { id: string };
    const user = await identity.getUser(id);
    if (!user || user.team_id !== team_id) throw new BreadboardError('not-found', `user ${id} not found`);
    if (principalOf(req).user?.user_id === id) throw new BreadboardError('validation-failed', 'you cannot deactivate yourself');
    await identity.deactivateUser(id);
    services.auth.invalidate?.();
    return (await identity.getUser(id))!;
  });

  // --- Roles (admin) ------------------------------------------------------
  app.get(`${ADMIN}/roles`, adminOnly, async () => ({ items: await rolesWithMembers(services), next_cursor: null }));

  app.post(`${ADMIN}/roles`, adminOnly, async (req, reply) => {
    const body = requireBody(req);
    const slug = requireField<string>(body, 'slug');
    if (!SLUG_RE.test(slug)) throw new BreadboardError('validation-failed', 'slug must be lowercase letters, digits and "-" (max 64)');
    const description = typeof body.description === 'string' ? body.description : '';
    const role = await identity.ensureRole(team_id, slug, description);
    if (description && role.description !== description) await services.db.query(`UPDATE roles SET description=$2 WHERE role_id=$1`, [role.role_id, description]);
    reply.status(201);
    return (await rolesWithMembers(services)).find((r) => r.slug === slug)!;
  });

  app.delete(`${ADMIN}/roles/:slug`, adminOnly, async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const exists = (await identity.listRoles(team_id)).some((r) => r.slug === slug);
    if (!exists) throw new BreadboardError('not-found', `role '${slug}' not found`);
    await identity.deleteRole(team_id, slug);
    services.auth.invalidate?.();
    reply.status(204);
  });

  app.post(`${ADMIN}/roles/:slug/members`, adminOnly, async (req) => {
    const { slug } = req.params as { slug: string };
    const body = requireBody(req);
    const user_id = requireField<string>(body, 'user_id');
    const member = body.member === undefined ? true : requireField<boolean>(body, 'member', 'boolean');
    const role = (await identity.listRoles(team_id)).find((r) => r.slug === slug);
    if (!role) throw new BreadboardError('not-found', `role '${slug}' not found`);
    const user = await identity.getUser(user_id);
    if (!user || user.team_id !== team_id) throw new BreadboardError('not-found', `user ${user_id} not found`);
    await identity.setMembership(role.role_id, user_id, member);
    services.auth.invalidate?.();
    return (await rolesWithMembers(services)).find((r) => r.slug === slug)!;
  });

  // --- Service tokens -----------------------------------------------------
  app.get(`${ADMIN}/service-tokens/scopes`, adminOnly, async () => ({ scopes: SERVICE_SCOPES }));

  app.get(`${ADMIN}/service-tokens`, adminOnly, async () => ({ items: await identity.listServiceTokens(team_id), next_cursor: null }));

  app.post(`${ADMIN}/service-tokens`, adminOnly, async (req, reply) => {
    const p = principalOf(req);
    const body = requireBody(req);
    const name = requireField<string>(body, 'name');
    if (!name.trim()) throw new BreadboardError('validation-failed', "field 'name' must be non-empty");
    const scopes = requireField<string[]>(body, 'scopes', 'array');
    let expires_at: string | null = null;
    if (body.expires_at !== undefined && body.expires_at !== null) {
      const t = Date.parse(String(body.expires_at));
      if (!Number.isFinite(t)) throw new BreadboardError('validation-failed', "field 'expires_at' must be an ISO timestamp");
      if (t <= Date.now()) throw new BreadboardError('validation-failed', "field 'expires_at' must be in the future");
      expires_at = new Date(t).toISOString();
    }
    const { token, secret } = await identity.createServiceToken({ team_id, name: name.trim(), scopes: scopes.map(String), created_by: p.actor, expires_at });
    reply.status(201);
    return { ...token, secret };
  });

  app.post(`${ADMIN}/service-tokens/:id/revoke`, adminOnly, async (req) => {
    const { id } = req.params as { id: string };
    const existing = (await identity.listServiceTokens(team_id)).find((t) => t.token_id === id);
    if (!existing) throw new BreadboardError('not-found', `service token ${id} not found`);
    await identity.revokeServiceToken(id);
    services.auth.invalidate?.();
    return (await identity.listServiceTokens(team_id)).find((t) => t.token_id === id)!;
  });

  // --- Credential broker ([12] §5) ---------------------------------------
  app.get(`${ADMIN}/broker/credentials`, adminOnly, async () => ({ items: await services.broker.listCredentials(), next_cursor: null }));

  app.post(`${ADMIN}/broker/credentials`, adminOnly, async (req, reply) => {
    const body = requireBody(req);
    const name = requireField<string>(body, 'name');
    const kind = requireField<string>(body, 'kind');
    const secret = body.secret;
    const okSecret = typeof secret === 'string' ? secret.length > 0 : !!secret && typeof secret === 'object' && !Array.isArray(secret) && Object.values(secret).every((v) => typeof v === 'string');
    if (!okSecret) throw new BreadboardError('validation-failed', "field 'secret' must be a non-empty string or an object of strings");
    const out = await services.broker.registerCredential({ name, kind, secret, by: principalOf(req) });
    reply.status(201);
    return out;
  });

  app.delete(`${ADMIN}/broker/credentials/:name`, adminOnly, async (req, reply) => {
    await services.broker.deleteCredential((req.params as { name: string }).name, principalOf(req));
    reply.status(204);
  });

  app.get(`${ADMIN}/broker/capabilities`, adminOnly, async () => ({ items: await services.broker.listCapabilities(), next_cursor: null }));

  app.post(`${ADMIN}/broker/capabilities`, adminOnly, async (req, reply) => {
    const body = requireBody(req);
    const name = requireField<string>(body, 'name');
    const scope = requireField<Record<string, unknown>>(body, 'scope', 'object');
    if (!Array.isArray(scope.hosts) || scope.hosts.length === 0 || !scope.hosts.every((h) => typeof h === 'string')) throw new BreadboardError('validation-failed', "field 'scope.hosts' must be a non-empty array of strings");
    for (const k of ['methods', 'path_prefixes', 'scopes'] as const) {
      const v = scope[k];
      if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) throw new BreadboardError('validation-failed', `field 'scope.${k}' must be an array of strings`);
    }
    const credential = body.credential === undefined || body.credential === null ? null : requireField<string>(body, 'credential');
    const out = await services.broker.defineCapability({
      name,
      credential,
      description: typeof body.description === 'string' ? body.description : undefined,
      scope: scope as { hosts: string[]; methods?: string[]; path_prefixes?: string[]; scopes?: string[] },
      by: principalOf(req),
    });
    reply.status(201);
    return out;
  });

  app.delete(`${ADMIN}/broker/capabilities/:name`, adminOnly, async (req, reply) => {
    await services.broker.deleteCapability((req.params as { name: string }).name, principalOf(req));
    reply.status(204);
  });

  app.get(`${ADMIN}/broker/audit`, adminOnly, async (req) => {
    const limit = Math.max(1, Math.min(1000, intParam((req.query as any)?.limit, 100)!));
    return { items: await services.broker.audit(limit), next_cursor: null };
  });

  // --- Health detail ------------------------------------------------------
  app.get(`${ADMIN}/health/detail`, adminOnly, async () => {
    const [sandbox, fallbacks, capacity, connectors] = await Promise.allSettled([
      services.sandbox.health(),
      Promise.resolve().then(() => services.gateway.fallbackEvents()),
      services.dispatcher.capacity(),
      services.connectors.status(),
    ]);
    const val = <T>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : { error: String((r.reason as any)?.message ?? r.reason) });
    return {
      sandbox: { kind: services.sandbox.kind, ...(val(sandbox) as object) },
      gateway: { providers: safe(() => services.gateway.providers()), fallback_events: val(fallbacks) },
      dispatcher: val(capacity),
      connectors: val(connectors),
      db: services.db.kind,
    };
  });
}

function safe<T>(fn: () => T): T | { error: string } {
  try {
    return fn();
  } catch (err: any) {
    return { error: String(err?.message ?? err) };
  }
}
