/** Pure helpers for the Intake area ([08] §2, §4, §7). */
import { TASK_PRIORITIES, TASK_STATUSES, type NodeDto, type SessionRecord, type TaskStatus, type Turn } from '@breadboard/shared';
import { toBlocks } from '../sessions/TurnView';

/** `GET /tasks` default ([08] §7.2): the live queue. */
export const DEFAULT_TASK_STATUSES: readonly TaskStatus[] = ['queued', 'triaging', 'active', 'gated'];
/** Sentinel for the status filter meaning "every status". */
export const ALL_STATUSES = 'all';

/** Compact queue age: `45s`, `12m`, `3h 05m`, `4d 2h`. */
export function formatQueueAge(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Queue-age tone: older queued work deserves attention. */
export function queueAgeTone(seconds: number | null | undefined): 'neutral' | 'warn' | 'danger' {
  if (typeof seconds !== 'number') return 'neutral';
  if (seconds >= 24 * 3600) return 'danger';
  if (seconds >= 3600) return 'warn';
  return 'neutral';
}

/** Kinds from `origin:<kind>` tags (non-user origins only carry one, [08] §5). */
export function originKinds(tags: readonly string[] | null | undefined): string[] {
  return [...new Set((tags ?? []).filter((t) => t.startsWith('origin:')).map((t) => t.slice('origin:'.length)).filter(Boolean))];
}

/** `possible-dup-of:<uid>` targets. */
export function possibleDuplicates(tags: readonly string[] | null | undefined): string[] {
  return (tags ?? []).filter((t) => t.startsWith('possible-dup-of:')).map((t) => t.slice('possible-dup-of:'.length)).filter(Boolean);
}

export interface TaskOriginInfo {
  kind: string;
  id: string | null;
}

export function taskOrigin(node: Pick<NodeDto, 'properties'> | null | undefined): TaskOriginInfo | null {
  const o = node?.properties?.origin as { kind?: unknown; id?: unknown } | undefined;
  if (!o || typeof o !== 'object' || typeof o.kind !== 'string') return null;
  return { kind: o.kind, id: typeof o.id === 'string' ? o.id : null };
}

/** Subagent/API-originated and not yet reviewed: eligible for promote / mark-reviewed. */
export function isNonUserOrigin(node: Pick<NodeDto, 'properties' | 'tags'>): boolean {
  if (originKinds(node.tags).length) return true;
  const o = taskOrigin(node);
  return !!o && o.kind !== 'user' && !node.tags.includes('reviewed');
}

export function taskStatus(node: Pick<NodeDto, 'properties'> | null | undefined): string | null {
  const s = node?.properties?.status;
  return typeof s === 'string' ? s : null;
}

export function taskPriority(node: Pick<NodeDto, 'properties'> | null | undefined): string | null {
  const p = node?.properties?.priority;
  return typeof p === 'string' ? p : null;
}

export function isTerminalTask(status: string | null | undefined): boolean {
  return status === 'done' || status === 'rejected';
}

/** Priority rank for sorting (p0 first; unknown last). */
export function priorityRank(p: string | null | undefined): number {
  const i = (TASK_PRIORITIES as readonly string[]).indexOf(p ?? '');
  return i === -1 ? TASK_PRIORITIES.length : i;
}

/** One step more urgent (p2 → p1); p0 stays p0; unknown → p1. */
export function raisedPriority(p: string | null | undefined): string {
  const r = priorityRank(p);
  if (r >= TASK_PRIORITIES.length) return 'p1';
  return TASK_PRIORITIES[Math.max(0, r - 1)];
}

/** URL search → `GET /tasks` query. */
export function taskListQuery(s: { status?: string; priority?: string; origin?: string; tag?: string; circuit?: string; created_after?: string; q?: string }): Record<string, string | string[] | undefined> {
  const status = !s.status ? [...DEFAULT_TASK_STATUSES] : s.status === ALL_STATUSES ? [...TASK_STATUSES] : [s.status];
  let created_after: string | undefined;
  if (s.created_after) {
    const d = new Date(s.created_after);
    created_after = Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return { status, priority: s.priority || undefined, origin: s.origin || undefined, tag: s.tag || undefined, circuit: s.circuit || undefined, created_after, q: s.q || undefined };
}

// ----------------------------------------------------------- conversations ---

export function conversationTitle(s: Pick<SessionRecord, 'state_detail'>): string {
  const d = (s.state_detail ?? {}) as { title?: unknown; draft_task?: { title?: unknown } | null };
  if (typeof d.title === 'string' && d.title.trim()) return d.title.trim();
  if (d.draft_task && typeof d.draft_task.title === 'string' && d.draft_task.title.trim()) return d.draft_task.title.trim();
  return 'Untitled conversation';
}

/** Normalized Draft Task panel state from `draft_task` ([08] §7.1): either the shaper's draft or the live Task node. */
export interface DraftView {
  source: 'draft' | 'task';
  taskUid: string | null;
  title: string | null;
  body: string;
  priority: string | null;
  targetCircuit: string | null;
  status: string | null;
  references: string[];
  createdTasks: string[];
  /** The draft points at a task that no longer exists. */
  missing: boolean;
  node: NodeDto | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function normalizeDraft(raw: unknown): DraftView | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const source = o.source === 'task' ? 'task' : 'draft';
  const missing = o.missing === true;
  const refs = Array.isArray(o.references) ? [...new Set(o.references.filter((r): r is string => typeof r === 'string' && !!r))] : [];
  const created = Array.isArray(o.created_tasks) ? o.created_tasks.filter((r): r is string => typeof r === 'string' && !!r) : [];
  return {
    source,
    taskUid: missing ? null : str(o.task_uid),
    title: str(o.title),
    body: typeof o.body === 'string' ? o.body : '',
    priority: str(o.priority),
    targetCircuit: str(o.target_circuit),
    status: source === 'task' ? str(o.status) : null,
    references: refs,
    createdTasks: created,
    missing,
    node: source === 'task' && o.node && typeof o.node === 'object' ? (o.node as NodeDto) : null,
  };
}

/** True when nothing has been drafted yet. */
export function isEmptyDraft(d: DraftView | null): boolean {
  return !d || (!d.taskUid && !d.title && !d.body.trim() && !d.priority && !d.targetCircuit && d.references.length === 0);
}

/** Only a `draft`-status task can be accepted into the queue. */
export function canAccept(d: DraftView | null): boolean {
  return !!d && !!d.taskUid && d.status === 'draft';
}

/** The draft fields are editable while the task is still a draft. */
export function canEditDraft(d: DraftView | null): boolean {
  return canAccept(d);
}

/** Composer: Enter sends, Shift+Enter (or an IME composition) inserts a newline. */
export function shouldSend(e: { key: string; shiftKey?: boolean; isComposing?: boolean; altKey?: boolean }): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing;
}

// -------------------------------------------------------------- chat turns ---

export type ChatBlock = ReturnType<typeof toBlocks>[number];

export interface ChatItem {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'system';
  username: string | null;
  /** Concatenated text blocks (Markdown for assistant turns). */
  text: string;
  /** Non-text blocks (tool calls / results / unknown), shown collapsed. */
  extras: ChatBlock[];
  created_at: string;
  model_id: string | null;
}

/** Classify conversation turns for the chat pane. A `user` turn holding only tool results is a tool turn. */
export function chatItems(turns: ReadonlyArray<Pick<Turn, 'turn_id' | 'role' | 'username' | 'content' | 'created_at' | 'model_id'>>): ChatItem[] {
  return turns.map((t) => {
    const blocks = toBlocks(t.content);
    const texts = blocks.filter((b): b is Extract<ChatBlock, { kind: 'text' }> => b.kind === 'text');
    const extras = blocks.filter((b) => b.kind !== 'text');
    let kind: ChatItem['kind'] = t.role === 'assistant' ? 'assistant' : t.role === 'system' ? 'system' : t.role === 'tool' ? 'tool' : 'user';
    if (kind === 'user' && blocks.length > 0 && texts.length === 0 && extras.every((b) => b.kind === 'tool_result')) kind = 'tool';
    return { id: t.turn_id, kind, username: t.username, text: texts.map((b) => b.text).join('\n\n').trim(), extras, created_at: t.created_at, model_id: t.model_id };
  });
}
