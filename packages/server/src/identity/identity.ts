import { createHash, randomBytes } from 'node:crypto';
import { mintUid, mintId, BreadboardError, type Actor } from '@breadboard/shared';
import type { Db, Queryable } from '../db/index.js';
import { toIso } from '../content/nodes.js';

export interface UserRecord {
  user_id: string;
  team_id: string;
  handle: string;
  display_name: string;
  oidc_subject: string | null;
  is_admin: boolean;
  created_at: string;
  deactivated_at: string | null;
}

export interface RoleRecord {
  role_id: string;
  team_id: string;
  slug: string;
  description: string;
}

export interface ServiceTokenRecord {
  token_id: string;
  team_id: string;
  name: string;
  scopes: string[];
  created_by: Actor;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export const SERVICE_SCOPES = ['tasks:read', 'tasks:write', 'nodes:read', 'nodes:write', 'sessions:read', 'sessions:write', 'config:read', 'config:propose', 'config:merge', 'knowledge:read', 'knowledge:write', 'evals:read', 'evals:write', 'mcp:call', 'events:read', 'admin'] as const;
export type ServiceScope = (typeof SERVICE_SCOPES)[number];

export function hashToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Teams, users, review roles, service tokens ([01] §8, [12] §3). */
export class IdentityStore {
  constructor(private db: Db) {}

  async ensureTeam(name: string, q: Queryable = this.db): Promise<{ team_id: string; name: string }> {
    const r = await q.query(`SELECT team_id, name FROM teams ORDER BY created_at ASC LIMIT 1`);
    if (r.rows[0]) {
      if (r.rows[0].name !== name) await q.query(`UPDATE teams SET name=$2 WHERE team_id=$1`, [r.rows[0].team_id, name]);
      return { team_id: r.rows[0].team_id, name };
    }
    const team_id = mintUid();
    await q.query(`INSERT INTO teams (team_id, name) VALUES ($1,$2)`, [team_id, name]);
    return { team_id, name };
  }

  async getUser(userId: string, q: Queryable = this.db): Promise<UserRecord | null> {
    const r = await q.query(`SELECT * FROM users WHERE user_id=$1`, [userId]);
    return r.rows[0] ? rowToUser(r.rows[0]) : null;
  }

  async getUserByHandle(teamId: string, handle: string, q: Queryable = this.db): Promise<UserRecord | null> {
    const r = await q.query(`SELECT * FROM users WHERE team_id=$1 AND handle=$2`, [teamId, handle]);
    return r.rows[0] ? rowToUser(r.rows[0]) : null;
  }

  async getUserByOidc(subject: string, q: Queryable = this.db): Promise<UserRecord | null> {
    const r = await q.query(`SELECT * FROM users WHERE oidc_subject=$1`, [subject]);
    return r.rows[0] ? rowToUser(r.rows[0]) : null;
  }

  async listUsers(teamId: string, q: Queryable = this.db): Promise<UserRecord[]> {
    const r = await q.query(`SELECT * FROM users WHERE team_id=$1 ORDER BY handle`, [teamId]);
    return r.rows.map(rowToUser);
  }

  async upsertUser(input: { team_id: string; handle: string; display_name?: string; oidc_subject?: string | null; is_admin?: boolean }, q: Queryable = this.db): Promise<UserRecord> {
    const existing = input.oidc_subject ? await this.getUserByOidc(input.oidc_subject, q) : await this.getUserByHandle(input.team_id, input.handle, q);
    if (existing) {
      const r = await q.query(
        `UPDATE users SET display_name = COALESCE($2, display_name), is_admin = COALESCE($3, is_admin), oidc_subject = COALESCE($4, oidc_subject), handle = $5, deactivated_at = NULL WHERE user_id=$1 RETURNING *`,
        [existing.user_id, input.display_name ?? null, input.is_admin ?? null, input.oidc_subject ?? null, input.handle],
      );
      return rowToUser(r.rows[0]);
    }
    const r = await q.query(`INSERT INTO users (user_id, team_id, handle, display_name, oidc_subject, is_admin) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [
      mintUid(),
      input.team_id,
      input.handle,
      input.display_name ?? input.handle,
      input.oidc_subject ?? null,
      !!input.is_admin,
    ]);
    return rowToUser(r.rows[0]);
  }

  /** Give a user that has no OIDC subject this one (adoption, [12] §3). False when the user already has a subject. */
  async linkOidcSubject(userId: string, subject: string, q: Queryable = this.db): Promise<boolean> {
    const r = await q.query(`UPDATE users SET oidc_subject=$2 WHERE user_id=$1 AND oidc_subject IS NULL RETURNING user_id`, [userId, subject]);
    return r.rows.length > 0;
  }

  async deactivateUser(userId: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE users SET deactivated_at = now() WHERE user_id=$1`, [userId]);
  }

  // --- Roles ([09] §7) ---
  async listRoles(teamId: string, q: Queryable = this.db): Promise<Array<RoleRecord & { members: string[] }>> {
    const roles = await q.query(`SELECT * FROM roles WHERE team_id=$1 ORDER BY slug`, [teamId]);
    const mem = await q.query<{ role_id: string; user_id: string }>(`SELECT rm.role_id, rm.user_id FROM role_memberships rm JOIN roles r ON r.role_id=rm.role_id WHERE r.team_id=$1`, [teamId]);
    return roles.rows.map((r) => ({ ...r, members: mem.rows.filter((m) => m.role_id === r.role_id).map((m) => m.user_id) }));
  }

  async ensureRole(teamId: string, slug: string, description = '', q: Queryable = this.db): Promise<RoleRecord> {
    const r = await q.query(`SELECT * FROM roles WHERE team_id=$1 AND slug=$2`, [teamId, slug]);
    if (r.rows[0]) return r.rows[0];
    const ins = await q.query(`INSERT INTO roles (role_id, team_id, slug, description) VALUES ($1,$2,$3,$4) RETURNING *`, [mintUid(), teamId, slug, description]);
    return ins.rows[0];
  }

  async deleteRole(teamId: string, slug: string, q: Queryable = this.db): Promise<void> {
    await q.query(`DELETE FROM roles WHERE team_id=$1 AND slug=$2`, [teamId, slug]);
  }

  async setMembership(roleId: string, userId: string, member: boolean, q: Queryable = this.db): Promise<void> {
    if (member) await q.query(`INSERT INTO role_memberships (role_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [roleId, userId]);
    else await q.query(`DELETE FROM role_memberships WHERE role_id=$1 AND user_id=$2`, [roleId, userId]);
  }

  async rolesOfUser(userId: string, q: Queryable = this.db): Promise<string[]> {
    const r = await q.query<{ slug: string }>(`SELECT r.slug FROM role_memberships rm JOIN roles r ON r.role_id = rm.role_id WHERE rm.user_id=$1`, [userId]);
    return r.rows.map((x) => x.slug);
  }

  async usersInRole(teamId: string, slug: string, q: Queryable = this.db): Promise<UserRecord[]> {
    const r = await q.query(`SELECT u.* FROM users u JOIN role_memberships rm ON rm.user_id=u.user_id JOIN roles r ON r.role_id=rm.role_id WHERE r.team_id=$1 AND r.slug=$2 AND u.deactivated_at IS NULL`, [teamId, slug]);
    return r.rows.map(rowToUser);
  }

  /** Add role memberships for the given slugs (creating roles as needed). Additive: never removes memberships. */
  async syncUserRoles(teamId: string, userId: string, slugs: string[], q: Queryable = this.db): Promise<void> {
    for (const slug of slugs) {
      const role = await this.ensureRole(teamId, slug, '', q);
      await this.setMembership(role.role_id, userId, true, q);
    }
  }

  // --- Service tokens ([12] §3) ---
  async createServiceToken(input: { team_id: string; name: string; scopes: string[]; created_by: Actor; expires_at?: string | null }, q: Queryable = this.db): Promise<{ token: ServiceTokenRecord; secret: string }> {
    for (const s of input.scopes) if (!(SERVICE_SCOPES as readonly string[]).includes(s)) throw new BreadboardError('validation-failed', `unknown scope '${s}'`);
    const secret = 'bbs_' + randomBytes(32).toString('base64url');
    const token_id = mintId('tok');
    const r = await q.query(`INSERT INTO service_tokens (token_id, team_id, name, token_hash, scopes, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [
      token_id,
      input.team_id,
      input.name,
      hashToken(secret),
      input.scopes,
      JSON.stringify(input.created_by),
      input.expires_at ?? null,
    ]);
    return { token: rowToToken(r.rows[0]), secret };
  }

  async findServiceToken(secret: string, q: Queryable = this.db): Promise<ServiceTokenRecord | null> {
    const r = await q.query(`UPDATE service_tokens SET last_used_at = now() WHERE token_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) RETURNING *`, [hashToken(secret)]);
    return r.rows[0] ? rowToToken(r.rows[0]) : null;
  }

  async listServiceTokens(teamId: string, q: Queryable = this.db): Promise<ServiceTokenRecord[]> {
    const r = await q.query(`SELECT * FROM service_tokens WHERE team_id=$1 ORDER BY created_at DESC`, [teamId]);
    return r.rows.map(rowToToken);
  }

  async revokeServiceToken(tokenId: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE service_tokens SET revoked_at = now() WHERE token_id=$1`, [tokenId]);
  }
}

function rowToUser(r: any): UserRecord {
  return { user_id: r.user_id, team_id: r.team_id, handle: r.handle, display_name: r.display_name, oidc_subject: r.oidc_subject ?? null, is_admin: !!r.is_admin, created_at: toIso(r.created_at), deactivated_at: r.deactivated_at ? toIso(r.deactivated_at) : null };
}
function rowToToken(r: any): ServiceTokenRecord {
  return { token_id: r.token_id, team_id: r.team_id, name: r.name, scopes: r.scopes ?? [], created_by: r.created_by, created_at: toIso(r.created_at), expires_at: r.expires_at ? toIso(r.expires_at) : null, revoked_at: r.revoked_at ? toIso(r.revoked_at) : null, last_used_at: r.last_used_at ? toIso(r.last_used_at) : null };
}
