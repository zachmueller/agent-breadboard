/**
 * Shared scaffolding for the primitive catalogs (`primitives.ts`, `inspection.ts`): the definition shape, the
 * dependency bag, JSON Schema fragments, the session-visibility gate and the output-clipping helpers.
 */
import type { JsonSchema } from '@breadboard/shared';
import type { Queryable } from '../db/index.js';
import type { Logger } from '../core/logger.js';
import { canSeeSession, type Principal } from '../core/principal.js';
import type { IdentityStore } from '../identity/identity.js';
import type { ConfigService, ConnectorScheduler, ContentService, ConversationService, CredentialBroker, Dispatcher, EvalService, EventBus, KnowledgeService, ModelGateway, Orchestrator, RepoMirrors, SessionStore, TaskService, Toolbox } from '../core/services.js';

export interface PrimitiveCallCtx {
  session_id?: string | null;
  step_id?: string | null;
  attempt?: number | null;
  call_index?: number | null;
  depth?: number;
}

export interface PrimitiveDef {
  name: string;
  description: string;
  input_schema: JsonSchema;
  /** Capability scope required of a scoped token ([11] §2); null = any authenticated principal. No-op for unscoped principals. */
  scope: string | null;
  handler(args: any, principal: Principal, ctx: PrimitiveCallCtx): Promise<unknown>;
}

export interface PrimitivesDeps {
  content: ContentService;
  knowledge: KnowledgeService;
  tasks: TaskService;
  orchestrator: Orchestrator;
  sessions: SessionStore;
  evals: EvalService;
  config: ConfigService;
  /** Lazy: toolbox → sandbox API → primitives is cyclic. */
  toolbox: () => Toolbox;
  broker: CredentialBroker;
  /** `model_converse`: tool code's model calls go through the gateway like every other LLM call; `providers` / `fallbackEvents` feed the overview. */
  gateway: Pick<ModelGateway, 'complete' | 'providers' | 'fallbackEvents'>;
  /** Used to resolve the executing tool from the execution journal (`broker_fetch`). */
  db: Queryable;
  log: Logger;
  team_id: string;
  identity: Pick<IdentityStore, 'listUsers' | 'rolesOfUser'>;
  events: Pick<EventBus, 'replay' | 'visibleTo'>;
  /** Lazy: built after the primitives (core/build.ts). */
  conversations: () => Pick<ConversationService, 'proposals' | 'busy' | 'draftTask'>;
  dispatcher: () => Pick<Dispatcher, 'capacity'>;
  connectors: () => Pick<ConnectorScheduler, 'status'>;
  /** Repository mirrors behind `search_repo` / `read_repo_file` ([06] §7.1). */
  mirrors: () => Pick<RepoMirrors, 'search' | 'read' | 'status'>;
  /** Instance facts for `get_breadboard_overview` (the `/health` fields plus the public URL). */
  instance: { name: string; version: string; db: string; sandbox: string; public_url: string };
}

// ---------------------------------------------------------------------------
// Schema fragments
// ---------------------------------------------------------------------------
export const UID = { type: 'string', description: '20-character Breadboard UID of a content node.' };
export const STRING_ARRAY = (description: string) => ({ type: 'array', items: { type: 'string' }, description });
export const LIMIT = (max: number, dflt: number, what = 'results') => ({ type: 'integer', minimum: 1, maximum: max, description: `Max ${what} (default ${dflt}).` });
export const MAX_CHARS = (dflt: number) => ({
  type: 'integer',
  minimum: 0,
  description: `Clip each long text or JSON value to this many characters (default ${dflt}; 0 = no clipping). A clipped value is an object with \`truncated: true\`, its \`total_chars\`, and the kept prefix.`,
});

export function obj(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

// ---------------------------------------------------------------------------
// Gates & clipping
// ---------------------------------------------------------------------------
/** Session visibility for `get_session_summary` and the inspection tools: members see all; AI principals their family. */
export async function sessionVisible(sessions: Pick<SessionStore, 'get'>, p: Principal, id: string): Promise<boolean> {
  if (canSeeSession(p, id)) return true;
  if (p.visible_sessions === null) return true;
  // Children spawned after the principal was minted (e.g. run_circuit with wait=false).
  const s = await sessions.get(id);
  if (!s) return false;
  return !!s.parent_session && (s.parent_session === p.session_id || p.visible_sessions.includes(s.parent_session));
}

export interface ClippedText {
  truncated: true;
  total_chars: number;
  text: string;
}

export interface ClippedJson {
  truncated: true;
  total_chars: number;
  preview: string;
}

/** `s` unchanged when it fits (or `max` is 0); else its prefix with a truncation marker. */
export function clipText(s: string, max: number): string | ClippedText {
  if (max <= 0 || s.length <= max) return s;
  return { truncated: true, total_chars: s.length, text: s.slice(0, max) };
}

/** `v` unchanged when its JSON fits (or `max` is 0); else a prefix of the JSON with a truncation marker. */
export function clipJson(v: unknown, max: number): unknown {
  if (max <= 0) return v ?? null;
  const s = JSON.stringify(v ?? null);
  if (s.length <= max) return v ?? null;
  const out: ClippedJson = { truncated: true, total_chars: s.length, preview: s.slice(0, max) };
  return out;
}
