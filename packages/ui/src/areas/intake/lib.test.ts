import { describe, expect, it } from 'vitest';
import type { NodeDto } from '@breadboard/shared';
import {
  ALL_STATUSES,
  DEFAULT_TASK_STATUSES,
  canAccept,
  chatItems,
  canEditDraft,
  conversationTitle,
  formatQueueAge,
  isEmptyDraft,
  isNonUserOrigin,
  isTerminalTask,
  normalizeDraft,
  originKinds,
  possibleDuplicates,
  priorityRank,
  queueAgeTone,
  raisedPriority,
  shouldSend,
  taskListQuery,
  taskOrigin,
  taskPriority,
  taskStatus,
} from './lib';

const node = (over: Partial<NodeDto> = {}): NodeDto =>
  ({ uid: 'T'.repeat(20), type: 'task', title: 't', properties: {}, tags: [], body: null, body_text: null, crdt: false, scope: 'team', head_revision: null, ...over }) as NodeDto;

describe('formatQueueAge', () => {
  it('formats across units', () => {
    expect(formatQueueAge(null)).toBe('—');
    expect(formatQueueAge(-1)).toBe('—');
    expect(formatQueueAge(45)).toBe('45s');
    expect(formatQueueAge(12 * 60 + 5)).toBe('12m');
    expect(formatQueueAge(3 * 3600 + 5 * 60)).toBe('3h 05m');
    expect(formatQueueAge(4 * 86400 + 2 * 3600)).toBe('4d 2h');
    expect(formatQueueAge(2 * 86400)).toBe('2d');
  });
  it('tones older work', () => {
    expect(queueAgeTone(null)).toBe('neutral');
    expect(queueAgeTone(60)).toBe('neutral');
    expect(queueAgeTone(7200)).toBe('warn');
    expect(queueAgeTone(90000)).toBe('danger');
  });
});

describe('origins', () => {
  it('reads origin tags and properties', () => {
    expect(originKinds(['origin:subagent', 'x', 'origin:subagent', 'origin:'])).toEqual(['subagent']);
    expect(possibleDuplicates(['possible-dup-of:ABC', 'x'])).toEqual(['ABC']);
    expect(taskOrigin(node({ properties: { origin: { kind: 'api', id: 'svc' } } }))).toEqual({ kind: 'api', id: 'svc' });
    expect(taskOrigin(node())).toBeNull();
  });
  it('detects non-user origins until reviewed', () => {
    expect(isNonUserOrigin(node({ tags: ['origin:subagent'] }))).toBe(true);
    expect(isNonUserOrigin(node({ properties: { origin: { kind: 'user', id: 'z' } } }))).toBe(false);
    expect(isNonUserOrigin(node({ properties: { origin: { kind: 'api', id: 'z' } } }))).toBe(true);
    expect(isNonUserOrigin(node({ properties: { origin: { kind: 'api', id: 'z' } }, tags: ['reviewed'] }))).toBe(false);
  });
});

describe('task properties', () => {
  it('reads status and priority', () => {
    const n = node({ properties: { status: 'queued', priority: 'p1' } });
    expect(taskStatus(n)).toBe('queued');
    expect(taskPriority(n)).toBe('p1');
    expect(taskStatus(node())).toBeNull();
    expect(isTerminalTask('done')).toBe(true);
    expect(isTerminalTask('gated')).toBe(false);
  });
  it('ranks and raises priority', () => {
    expect(priorityRank('p0')).toBe(0);
    expect(priorityRank('zz')).toBe(4);
    expect(raisedPriority('p2')).toBe('p1');
    expect(raisedPriority('p0')).toBe('p0');
    expect(raisedPriority(null)).toBe('p1');
  });
});

describe('taskListQuery', () => {
  it('defaults to the live queue', () => {
    expect(taskListQuery({}).status).toEqual([...DEFAULT_TASK_STATUSES]);
  });
  it('supports all statuses and a single status', () => {
    expect(taskListQuery({ status: ALL_STATUSES }).status).toContain('rejected');
    expect(taskListQuery({ status: 'draft' }).status).toEqual(['draft']);
  });
  it('turns the From/To days into a local, inclusive window and drops blanks', () => {
    const q = taskListQuery({ created_after: '2026-09-01', created_before: '2026-09-30', tag: '', priority: 'p0', order: 'asc' });
    // Local midnight, not UTC midnight: `new Date('2026-09-01')` would be the evening before west of UTC.
    expect(q.created_after).toBe(new Date(2026, 8, 1).toISOString());
    expect(q.created_before).toBe(new Date(2026, 9, 1, 0, 0, 0, -1).toISOString());
    expect(q.order).toBe('asc');
    expect(q.tag).toBeUndefined();
    expect(q.priority).toBe('p0');
    expect(taskListQuery({ created_after: 'nope' }).created_after).toBeUndefined();
    expect(taskListQuery({ order: 'sideways' }).order).toBeUndefined();
  });
});

describe('conversations', () => {
  it('titles conversations', () => {
    expect(conversationTitle({ state_detail: { title: ' Idea ' } })).toBe('Idea');
    expect(conversationTitle({ state_detail: { draft_task: { title: 'Fix login' } } })).toBe('Fix login');
    expect(conversationTitle({ state_detail: {} })).toBe('Untitled conversation');
  });

  it('normalizes a pure draft', () => {
    const d = normalizeDraft({ source: 'draft', title: 'T', body: null, priority: null, target_circuit: null, references: ['A', 'A', 3] });
    expect(d).toMatchObject({ source: 'draft', taskUid: null, title: 'T', body: '', references: ['A'], status: null, missing: false });
    expect(canAccept(d)).toBe(false);
    expect(isEmptyDraft(d)).toBe(false);
  });

  it('normalizes a task-backed draft', () => {
    const d = normalizeDraft({ source: 'task', task_uid: 'U1', title: 'T', body: 'b', priority: 'p2', target_circuit: 'C', status: 'draft', references: [], created_tasks: ['U1'], node: { uid: 'U1' } });
    expect(d).toMatchObject({ taskUid: 'U1', status: 'draft', createdTasks: ['U1'], targetCircuit: 'C' });
    expect(d?.node?.uid).toBe('U1');
    expect(canAccept(d)).toBe(true);
    expect(canEditDraft(d)).toBe(true);
    expect(canAccept({ ...d!, status: 'queued' })).toBe(false);
  });

  it('treats a missing task as unlinked', () => {
    const d = normalizeDraft({ source: 'draft', task_uid: 'GONE', title: null, body: null, references: [], missing: true });
    expect(d?.taskUid).toBeNull();
    expect(d?.missing).toBe(true);
    expect(isEmptyDraft(d)).toBe(true);
  });

  it('handles null and junk', () => {
    expect(normalizeDraft(null)).toBeNull();
    expect(normalizeDraft('x')).toBeNull();
    expect(isEmptyDraft(null)).toBe(true);
  });

  it('decides when Enter sends', () => {
    expect(shouldSend({ key: 'Enter' })).toBe(true);
    expect(shouldSend({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(shouldSend({ key: 'Enter', isComposing: true })).toBe(false);
    expect(shouldSend({ key: 'a' })).toBe(false);
  });
});

describe('chatItems', () => {
  const t = (role: string, content: unknown, i = 0) => ({ turn_id: `t${i}`, role: role as never, username: role === 'user' ? 'zach' : null, content, created_at: '2026-09-30T00:00:00Z', model_id: null });
  it('classifies roles and splits text from tool blocks', () => {
    const items = chatItems([
      t('user', 'hello', 0),
      t('assistant', [{ type: 'text', text: 'Sure.' }, { type: 'tool_use', id: 'a', name: 'create_task', input: { title: 'x' } }], 1),
      t('user', [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }], 2),
      t('tool', [{ type: 'tool_result', tool_use_id: 'b', content: 'ok' }], 3),
      t('system', 'sys', 4),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'system']);
    expect(items[0]).toMatchObject({ text: 'hello', username: 'zach', extras: [] });
    expect(items[1].text).toBe('Sure.');
    expect(items[1].extras[0]).toMatchObject({ kind: 'tool_use', name: 'create_task' });
  });
});
