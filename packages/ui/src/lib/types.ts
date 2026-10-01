/**
 * UI-side DTO shapes for endpoints whose payloads aren't (yet) in @breadboard/shared.
 * All fields beyond identifiers are optional: the UI tolerates additive/unknown fields ([11] §6).
 */
import type { Actor, NeedInputRequest, NodeDto, SessionState } from '@breadboard/shared';

export type AuthMode = 'local' | 'oidc';

export interface AuthModeDto {
  mode: AuthMode;
  /** OIDC provider display name, when configured. */
  provider?: string | null;
  team_name?: string | null;
  /** Local mode: handles of the static users (for a login hint). */
  users?: Array<{ handle: string; display_name?: string }>;
  /** Server: OIDC is configured and the "Sign in" button should be offered. */
  oidc_enabled?: boolean;
  /** Server: show the local-dev warning banner. */
  local_banner?: boolean;
}

export interface MeDto {
  user_id: string;
  team_id?: string;
  handle: string;
  display_name: string;
  is_admin: boolean;
  roles: string[];
  team_name?: string | null;
}

export interface LoginResponse {
  session_token: string;
  user: MeDto;
}

/** `GET /roles` returns `members` as handles; `GET /admin/roles` as user objects. */
export interface RoleDto {
  role_id?: string;
  slug: string;
  description: string;
  members?: Array<string | RoleMemberDto>;
  member_count?: number;
}

export interface RoleMemberDto {
  user_id: string;
  handle: string;
  display_name: string;
}

export interface UserDto {
  user_id: string;
  handle: string;
  display_name: string;
  is_admin: boolean;
  oidc_subject?: string | null;
  created_at: string;
  deactivated_at: string | null;
  roles?: string[];
}

export interface ServiceTokenDto {
  token_id: string;
  name: string;
  scopes: string[];
  created_by?: Actor;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

/** `POST /admin/service-tokens` → the token record spread plus the one-time `secret`. */
export interface CreatedServiceTokenDto extends Partial<ServiceTokenDto> {
  secret?: string;
}

export interface BrokerCredentialDto {
  credential_id: string;
  name: string;
  kind: string;
  created_at: string;
  updated_at?: string;
}

export interface BrokerCapabilityDto {
  capability_id: string;
  name: string;
  /** Server returns the credential *name* as `credential`. */
  credential?: string | null;
  credential_id?: string | null;
  description: string;
  scope: { hosts?: string[]; methods?: string[]; path_prefixes?: string[]; scopes?: string[]; [k: string]: unknown };
  created_at?: string;
}

export interface CommentAnchor {
  revision?: number | null;
  quote?: string | null;
  context?: string | null;
  block_id?: string | null;
}

/** A comment node as returned by `GET /nodes/:uid/comments`. */
export interface CommentDto extends NodeDto {
  /** Server-computed re-anchoring outcome, when provided. */
  anchor_status?: 'anchored' | 'stale' | 'none' | string;
  stale?: boolean;
  replies?: CommentDto[];
  parent_uid?: string | null;
}

export interface ExecutionDto {
  execution_key: string;
  session_id?: string;
  step_id: string | null;
  attempt: number | null;
  call_index: number | null;
  tool_uid: string;
  tool_slug?: string | null;
  tool_commit?: string | null;
  status: 'running' | 'completed' | 'failed' | string;
  input?: unknown;
  output?: unknown;
  output_ref?: string | null;
  error?: string | null;
  cost_units?: number | string;
  log_ref?: string | null;
  /** `ctx.log` entries (journal), or legacy plain text. */
  logs?: Array<{ at?: string; level: string; message: string; data?: unknown }> | string | null;
  log_text?: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface DispatcherCapacityDto {
  /** Server shape ([02] §5.1): `{running, max_concurrent_runs, spend_last_hour_usd, max_spend_usd_per_hour, queued}`. */
  spend_last_hour_usd?: number;
  running?: number;
  queued?: number;
  max_concurrent_runs?: number;
  spend_window_usd?: number;
  spent_usd_window?: number;
  max_spend_usd_per_hour?: number;
  window_minutes?: number;
  paused?: boolean;
  [k: string]: unknown;
}

export interface ReviewRequest extends Partial<NeedInputRequest> {
  request_id: string;
}

export interface ConfigSearchHit {
  uid: string | null;
  kind: string;
  slug: string | null;
  title: string | null;
  path?: string;
}

export type SessionCounts = Partial<Record<SessionState, number>>;
