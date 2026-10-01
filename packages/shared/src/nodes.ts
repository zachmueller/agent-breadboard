import type { Actor } from './actor.js';

/** Content-plane node types. Extensible ([01] §3.1); v1 ships these four. */
export const NODE_TYPES = ['task', 'artifact', 'comment', 'knowledge'] as const;
export type NodeType = (typeof NODE_TYPES)[number] | (string & {});

export const SCOPES = ['team', 'session', 'external'] as const;
export type Scope = (typeof SCOPES)[number];

/** Scope widths for the propagation/narrowing rule ([01] §3.4). Higher = wider. */
export const SCOPE_WIDTH: Record<Scope, number> = { session: 0, team: 1, external: 2 };

export const REVISION_LABELS = ['step-completion', 'gate-resolution', 'publish', 'pre-ai-edit', 'intake', 'compaction', 'connector-sync'] as const;
export type RevisionLabel = (typeof REVISION_LABELS)[number];

export interface NodeRecord {
  uid: string;
  team_id: string;
  type: NodeType;
  title: string;
  properties: Record<string, unknown>;
  body: unknown | null;
  body_text: string | null;
  crdt: boolean;
  tags: string[];
  scope: Scope;
  created_at: string;
  created_by: Actor;
  updated_at: string;
  deleted_at: string | null;
}

export interface NodeRevision {
  uid: string;
  revision_id: number;
  labels: RevisionLabel[];
  properties: Record<string, unknown>;
  body: unknown | null;
  body_text: string | null;
  created_at: string;
  created_by: Actor;
  /** Present for CRDT nodes; base64 on the wire. */
  ydoc_state?: string | null;
  ydoc_vector?: string | null;
}

/** Revision-pinned artifact reference — the system-provided `#/defs/artifact-ref` ([03] §4). */
export interface ArtifactRef {
  uid: string;
  revision_id: number;
}

export const ARTIFACT_REF_SCHEMA = {
  type: 'object',
  required: ['uid', 'revision_id'],
  properties: {
    uid: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{20}$' },
    revision_id: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
} as const;

export const TASK_PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = ['draft', 'queued', 'triaging', 'active', 'gated', 'done', 'rejected'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskOrigin {
  kind: 'user' | 'subagent' | 'api';
  id: string;
}

/** Well-known structured tags. */
export const TAG = {
  intermediate: 'intermediate',
  deliverable: 'deliverable',
  needInput: 'need-input',
  readOnly: 'read-only',
  connector: (uid: string) => `connector:${uid}`,
  possibleDupOf: (uid: string) => `possible-dup-of:${uid}`,
  origin: (kind: string) => `origin:${kind}`,
} as const;
