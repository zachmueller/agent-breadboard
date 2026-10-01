/** Shared REST DTO shapes used by both server and UI ([11] §3). Snake_case on the wire. */
import type { NodeRecord, NodeRevision } from './nodes.js';
import type { EdgeRecord } from './edges.js';
import type { SessionRecord, SessionEvent, Turn } from './sessions.js';

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface ApiError {
  error: { code: string; message: string; detail?: unknown };
}

export interface NodeDto extends NodeRecord {
  /** Current head revision id (latest cut), or null if none. */
  head_revision: number | null;
}

export interface LineageDto {
  root: string;
  direction: 'up' | 'down';
  edges: EdgeRecord[];
  nodes: Array<Pick<NodeDto, 'uid' | 'type' | 'title' | 'tags' | 'scope'>>;
  sessions: Array<Pick<SessionRecord, 'session_id' | 'kind' | 'circuit_uid' | 'state'>>;
  truncated: boolean;
}

export interface SessionSummaryDto extends SessionRecord {
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  /** Including descendant sessions, computed at query time ([02] §6). */
  cost_usd_including_children: number;
  children: Array<Pick<SessionRecord, 'session_id' | 'kind' | 'circuit_uid' | 'state' | 'parent_step_id'>>;
  steps: StepSummaryDto[];
}

export interface StepSummaryDto {
  step_id: string;
  attempt: number;
  status: 'running' | 'exited' | 'failed';
  exit_name: string | null;
  kind?: string;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  started_at: string | null;
  ended_at: string | null;
  child_session_id?: string | null;
  error?: string | null;
}

export interface ConfigTreeEntry {
  uid: string | null;
  kind: string;
  slug: string | null;
  title: string | null;
  path: string;
}

export interface ConfigDefinitionDto {
  uid: string | null;
  kind: string;
  path: string;
  commit: string;
  slug: string | null;
  title: string | null;
  /** Parsed, validated definition (schema-specific shape). */
  definition: unknown;
  /** Raw file text. */
  raw: string;
  /** For circuits: prompt templates keyed by relative path; for tools: source files keyed by relative path. */
  files?: Record<string, string>;
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  /** Config-plane backlinks: definitions referencing this one ([03] §8.2). */
  referenced_by: ConfigTreeEntry[];
}

export interface ProposalDto {
  proposal_id: string;
  branch: string;
  base_commit: string;
  head_commit: string;
  message: string;
  status: 'open' | 'merged' | 'discarded';
  created_by: unknown;
  created_at: string;
  merged_commit?: string | null;
  changes: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>;
  diff: string;
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  eval_runs: string[];
}

export interface ReviewQueueItemDto {
  node: NodeDto;
  requests: Array<Record<string, unknown>>;
  gating_session: Pick<SessionRecord, 'session_id' | 'circuit_uid' | 'state' | 'kind'> | null;
}

export type { NodeRecord, NodeRevision, EdgeRecord, SessionRecord, SessionEvent, Turn };
