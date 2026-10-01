export const SESSION_KINDS = ['circuit-run', 'intake', 'conversation', 'eval-run'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const SESSION_STATES = ['queued', 'running', 'suspended-gate', 'suspended-error', 'completed', 'cancelled'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const TERMINAL_SESSION_STATES: readonly SessionState[] = ['completed', 'cancelled'];

export const SESSION_EVENT_TYPES = [
  'session-started',
  'config-resolved',
  'step-started',
  'turn',
  'tool-call',
  'tool-result',
  'step-exited',
  'step-failed',
  'retry-scheduled',
  'checkpoint',
  'gate-suspended',
  'gate-verdict',
  'gate-resolved',
  'budget-exceeded',
  'knowledge-injected',
  'manual-route',
  'session-suspended',
  'session-resumed',
  'session-completed',
  'session-cancelled',
] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

export interface SessionBudget {
  max_cost_usd: number;
  max_tokens: number;
  spent_usd: number;
  spent_tokens: number;
}

export interface SessionRecord {
  session_id: string;
  team_id: string;
  kind: SessionKind;
  circuit_uid: string | null;
  circuit_slug?: string | null;
  config_commit: string | null;
  task_uid: string | null;
  parent_session: string | null;
  parent_step_id: string | null;
  state: SessionState;
  state_detail: Record<string, unknown>;
  budget: SessionBudget;
  priority?: string | null;
  /** The circuit input the run was started with (fixture promotion, replay). */
  input?: unknown;
  model_overrides?: Record<string, string> | null;
  pinned_context?: Array<{ uid: string; revision_id: number }> | null;
  created_by?: import('./actor.js').Actor;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface SessionEvent {
  session_id: string;
  seq: number;
  event_type: SessionEventType;
  step_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export type TurnRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Turn {
  turn_id: string;
  session_id: string;
  step_id: string;
  role: TurnRole;
  username: string | null;
  content: unknown;
  model_id: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  created_at: string;
}

/** Ambient context channel ([03] §4): closed, system-defined. */
export interface AmbientContext {
  task: { uid: string; revision_id: number | null } | null;
  session_id: string;
  budget: { remaining_usd: number; remaining_tokens: number };
  artifacts: Array<{ uid: string; revision_id: number }>;
}

/** Breadboard event-stream topics ([11] §5). */
export const EVENT_TOPICS = ['session.state', 'session.event', 'task.status', 'need-input.tagged', 'need-input.resolved', 'config.committed', 'eval.run-completed', 'node.updated'] as const;
export type EventTopic = (typeof EVENT_TOPICS)[number];

export interface StreamEvent {
  id: string;
  topic: EventTopic;
  at: string;
  /** Minimal summary; consumers fetch detail via REST. */
  payload: Record<string, unknown>;
  /** Visibility: node uids / session ids the subscriber must be able to read. */
  visibility: { scope: 'team' | 'session'; session_id?: string; node_uid?: string };
}
