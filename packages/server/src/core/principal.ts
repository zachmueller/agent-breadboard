import { BreadboardError, type Actor } from '@breadboard/shared';
import type { UserRecord } from '../identity/identity.js';

/** Resolved Subagent grants ([05] §2): the real permission system for AI, enforced at the API layer. */
export interface Grants {
  subagent_uid: string;
  /** tool UID → per-grant settings (hidden settings included; enforced server-side). */
  tools: Map<string, Record<string, unknown>>;
  /** MCP server UID → tool allowlist (null = server default allowlist). */
  mcp: Map<string, string[] | null>;
  circuits: { read: Set<string>; execute: Set<string> };
  knowledge: { read: Set<string>; write: Set<string> };
  /** Built-in primitive names the subagent may call. */
  primitives: Set<string>;
  /** Step-level narrowing of the tool surface ([03] §3.1); null = no override. */
  tools_override: Set<string> | null;
}

export interface Principal {
  actor: Actor;
  team_id: string;
  user: UserRecord | null;
  /** Review-role slugs (users only). */
  roles: string[];
  is_admin: boolean;
  /** Service-token capability scopes; null means unrestricted (users, internal actors). */
  scopes: string[] | null;
  /** Subagent grants for subagent/code-step actors; null for users/services. */
  grants: Grants | null;
  /** Session context the principal acts within (subagents, code steps, conversation users). */
  session_id: string | null;
  /** Sessions whose `session`-scoped nodes this principal may see; null = any (team members). */
  visible_sessions: string[] | null;
  /** Config commit the actor's definitions were resolved at (subagent/code-step). */
  config_commit: string | null;
  /** Tool execution key when the caller is sandboxed tool code. */
  execution_key: string | null;
  token_kind: 'user' | 'service' | 'actor' | 'internal';
}

export function requireUser(p: Principal): UserRecord {
  if (!p.user) throw new BreadboardError('forbidden', 'this action requires a user principal');
  return p.user;
}

export function requireAdmin(p: Principal): void {
  if (!p.is_admin) throw new BreadboardError('forbidden', 'admin role required');
}

export function requireScope(p: Principal, scope: string): void {
  if (p.scopes === null) return;
  if (p.scopes.includes('admin') || p.scopes.includes(scope)) return;
  // read scopes are implied by write scopes
  const [res, verb] = scope.split(':');
  if (verb === 'read' && p.scopes.includes(`${res}:write`)) return;
  throw new BreadboardError('forbidden', `service token lacks scope '${scope}'`);
}

export function servicePrincipal(teamId: string, component: string): Principal {
  return {
    actor: { kind: 'service', id: component },
    team_id: teamId,
    user: null,
    roles: [],
    is_admin: true,
    scopes: null,
    grants: null,
    session_id: null,
    visible_sessions: null,
    config_commit: null,
    execution_key: null,
    token_kind: 'internal',
  };
}

export function userPrincipal(user: UserRecord, roles: string[], opts: { session_id?: string | null; scopes?: string[] | null; token_kind?: Principal['token_kind'] } = {}): Principal {
  return {
    actor: { kind: 'user', id: user.user_id, handle: user.handle, session_id: opts.session_id ?? undefined },
    team_id: user.team_id,
    user,
    roles,
    is_admin: user.is_admin,
    scopes: opts.scopes ?? null,
    grants: null,
    session_id: opts.session_id ?? null,
    visible_sessions: null,
    config_commit: null,
    execution_key: null,
    token_kind: opts.token_kind ?? 'user',
  };
}

/** Can the principal see a `session`-scoped node produced in `sessionId`? */
export function canSeeSession(p: Principal, sessionId: string | null): boolean {
  if (p.visible_sessions === null) return true;
  if (!sessionId) return false;
  return p.visible_sessions.includes(sessionId);
}

/** Knowledge-domain read check for subagent/code-step principals; users/services see everything. */
export function canReadDomains(p: Principal, domains: string[]): boolean {
  if (!p.grants) return true;
  if (domains.length === 0) return false; // notes outside any domain are not visible to AI
  return domains.some((d) => p.grants!.knowledge.read.has(d));
}

export function canWriteDomains(p: Principal, domains: string[]): boolean {
  if (!p.grants) return true;
  return domains.some((d) => p.grants!.knowledge.write.has(d));
}
