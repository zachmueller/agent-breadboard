/** Task inventory ([08] §7.2): the queue and everything that has passed through it, with review actions for AI/API-originated tasks. */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, Check, Copy, ListTodo, MessagesSquare, MoreHorizontal, Plus, XCircle } from 'lucide-react';
import { TASK_PRIORITIES, TASK_STATUSES, type NodeDto, type SessionSummaryDto } from '@breadboard/shared';
import { asPage, get, post } from '../../lib/api';
import { qk, useConfigTree } from '../../lib/queries';
import { useLiveEvents } from '../../lib/live';
import { useUrlSearch } from '../../lib/url';
import { toast } from '../../lib/toast';
import { humanize } from '../../lib/format';
import {
  Badge,
  Button,
  buttonClasses,
  Checkbox,
  ConfigLink,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  FilterBar,
  Input,
  Loading,
  Menu,
  PageBody,
  PageHeader,
  Pagination,
  Select,
  SessionChip,
  TaskStatusBadge,
  TextArea,
  TimeAgo,
  type Column,
  type FilterDef,
} from '../../components';
import {
  ALL_STATUSES,
  formatQueueAge,
  isNonUserOrigin,
  isTerminalTask,
  originKinds,
  possibleDuplicates,
  priorityRank,
  queueAgeTone,
  raisedPriority,
  taskListQuery,
  taskPriority,
  taskStatus,
} from './lib';

type Search = { status?: string; priority?: string; origin?: string; tag?: string; circuit?: string; created_after?: string; q?: string };
type TaskRow = NodeDto & { queue_age_s?: number | null };

type Action = { kind: 'promote' | 'reject' | 'mark-reviewed'; task: TaskRow };

const PRIORITY_TONE: Record<string, 'danger' | 'warn' | 'info' | 'neutral'> = { p0: 'danger', p1: 'warn', p2: 'info', p3: 'neutral' };

export function TaskInventoryPage() {
  const [search, setSearch] = useUrlSearch<Search>();
  const navigate = useNavigate();
  const tree = useConfigTree();
  const [action, setAction] = useState<Action | null>(null);
  const [creating, setCreating] = useState(false);

  const query = taskListQuery(search);
  const list = useTasks(query);
  const rows = list.items as TaskRow[];

  const circuitOptions = useMemo(
    () =>
      (tree.data ?? [])
        .filter((e) => e.kind === 'circuit' && e.uid)
        .map((e) => ({ value: e.uid!, label: e.slug ?? e.title ?? e.uid! }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [tree.data],
  );

  const filters: FilterDef[] = [
    { key: 'status', label: 'Status', type: 'select', options: [...TASK_STATUSES.map((s) => ({ value: s, label: humanize(s) })), { value: ALL_STATUSES, label: 'All statuses' }], allLabel: 'Open (queued → gated)' },
    { key: 'priority', label: 'Priority', type: 'select', options: TASK_PRIORITIES.map((p) => ({ value: p, label: p.toUpperCase() })) },
    { key: 'origin', label: 'Origin', type: 'select', options: ['user', 'subagent', 'api'].map((o) => ({ value: o, label: humanize(o) })) },
    { key: 'tag', label: 'Tag', type: 'text', placeholder: 'e.g. reviewed', mono: true },
    { key: 'circuit', label: 'Circuit', type: 'select', options: circuitOptions },
    { key: 'created_after', label: 'Since', type: 'date' },
  ];

  const columns: Column<TaskRow>[] = [
    {
      key: 'title',
      header: 'Task',
      cell: (t) => (
        <span className="flex min-w-0 flex-col">
          <Link to="/n/$uid" params={{ uid: t.uid }} className="truncate font-medium text-fg hover:text-accent-text hover:underline" onClick={(e) => e.stopPropagation()}>
            {t.title || <span className="text-fg-subtle italic">Untitled</span>}
          </Link>
          {possibleDuplicates(t.tags).length > 0 && (
            <span className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] text-warn-fg">
              <Copy size={11} aria-hidden /> possible duplicate
            </span>
          )}
        </span>
      ),
      sortValue: (t) => t.title.toLowerCase(),
    },
    { key: 'status', header: 'Status', cell: (t) => <TaskStatusBadge status={taskStatus(t)} size="xs" />, sortValue: (t) => TASK_STATUSES.indexOf(taskStatus(t) as never), width: '7.5rem' },
    {
      key: 'priority',
      header: 'Priority',
      cell: (t) => {
        const p = taskPriority(t);
        return p ? (
          <Badge size="xs" mono tone={PRIORITY_TONE[p] ?? 'neutral'}>
            {p.toUpperCase()}
          </Badge>
        ) : (
          <span className="text-fg-subtle">—</span>
        );
      },
      sortValue: (t) => priorityRank(taskPriority(t)),
      width: '5.5rem',
    },
    {
      key: 'origin',
      header: 'Origin',
      cell: (t) => {
        const kinds = originKinds(t.tags);
        return kinds.length ? (
          <span className="flex flex-wrap gap-1">
            {kinds.map((k) => (
              <Badge key={k} size="xs" tone="info" mono>
                origin:{k}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-[12.5px] text-fg-muted">{t.tags.includes('reviewed') ? 'reviewed' : 'user'}</span>
        );
      },
      hideBelow: 'md',
      width: '8.5rem',
    },
    {
      key: 'circuit',
      header: 'Circuit',
      cell: (t) => {
        const c = t.properties?.target_circuit;
        return typeof c === 'string' && c ? <ConfigLink uid={c} kind="circuit" className="text-[12.5px]" /> : <span className="text-[12.5px] text-fg-subtle">triage</span>;
      },
      hideBelow: 'lg',
    },
    {
      key: 'age',
      header: 'Queued',
      cell: (t) => {
        const tone = queueAgeTone(t.queue_age_s);
        return t.queue_age_s == null ? (
          <TimeAgo at={t.created_at} className="text-[12.5px] text-fg-subtle" />
        ) : (
          <span className={tone === 'danger' ? 'text-danger-fg' : tone === 'warn' ? 'text-warn-fg' : 'text-fg-muted'} title="Time in the queue">
            {formatQueueAge(t.queue_age_s)}
          </span>
        );
      },
      sortValue: (t) => t.queue_age_s ?? -1,
      width: '6rem',
      align: 'right',
    },
    { key: 'session', header: 'Latest session', cell: (t) => <LatestSession uid={t.uid} />, hideBelow: 'xl', width: '9rem' },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      cell: (t) => <RowActions task={t} onAction={setAction} />,
      width: '3rem',
      align: 'right',
    },
  ];

  const anyFilter = Object.values(search).some(Boolean);

  return (
    <>
      <PageHeader
        icon={<ListTodo size={16} />}
        title="Tasks"
        subtitle="Work the AI will pick up. New Tasks auto-dispatch into triage as capacity allows."
        actions={
          <>
            <Link to="/intake" className={buttonClasses('ghost', 'sm')}>
              <MessagesSquare size={14} aria-hidden /> Shape an idea
            </Link>
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
              New task
            </Button>
          </>
        }
      >
        <FilterBar filters={filters} value={search} search={{ placeholder: 'Search tasks…' }} onChange={(v) => setSearch(v)} />
      </PageHeader>
      <PageBody wide>
        {list.isPending ? (
          <Loading label="Loading tasks…" />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : (
          <>
            <DataTable
              caption="Tasks"
              columns={columns}
              rows={rows}
              rowKey={(t) => t.uid}
              onRowClick={(t) => navigate({ to: '/n/$uid', params: { uid: t.uid } })}
              empty={
                anyFilter ? (
                  <EmptyState compact icon={<ListTodo size={20} />} title="No tasks match" description="Try clearing a filter, or include done and rejected tasks." />
                ) : (
                  <EmptyState
                    icon={<ListTodo size={20} />}
                    title="The queue is empty"
                    description="Shape an idea in Intake, inject a Task through the API, or create one directly."
                    action={
                      <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
                        New task
                      </Button>
                    }
                  />
                )
              }
            />
            <Pagination hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => list.fetchNextPage()} shown={rows.length} />
          </>
        )}
      </PageBody>

      <ActionDialog action={action} onClose={() => setAction(null)} />
      <NewTaskDialog open={creating} onClose={() => setCreating(false)} circuits={circuitOptions} />
    </>
  );
}

const tasksKey = (q: Record<string, unknown>) => ['tasks', q] as const;

/** `GET /tasks` (not `/nodes`): adds `queue_age_s` and the live-queue status default; cursor-paged. */
function useTasks(query: Record<string, string | string[] | undefined>) {
  const qc = useQueryClient();
  const q = useInfiniteQuery({
    queryKey: tasksKey(query),
    queryFn: async ({ pageParam, signal }) => asPage<TaskRow>(await get('/tasks', { ...query, limit: 50, cursor: pageParam ?? undefined }, { signal })),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  useLiveEvents(['node.updated'], (e) => {
    if ((e.payload as { type?: string }).type === 'task') void qc.invalidateQueries({ queryKey: ['tasks'] });
  });
  return { ...q, items: q.data?.pages.flatMap((p) => p.items) ?? [] };
}

function LatestSession({ uid }: { uid: string }) {
  const q = useQuery({
    queryKey: ['tasks', uid, 'sessions', 'latest'],
    queryFn: async ({ signal }) => asPage<SessionSummaryDto>(await get(`/tasks/${uid}/sessions`, { limit: 1 }, { signal })).items[0] ?? null,
    staleTime: 30_000,
  });
  if (q.isPending) return <span className="inline-block h-4 w-16 animate-pulse rounded bg-raised" aria-label="Loading" />;
  if (q.error || !q.data) return <span className="text-[12.5px] text-fg-subtle">—</span>;
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <SessionChip id={q.data.session_id} state={q.data.state} kind={q.data.kind} />
    </span>
  );
}

function RowActions({ task, onAction }: { task: TaskRow; onAction: (a: Action) => void }) {
  const status = taskStatus(task);
  if (isTerminalTask(status)) return null;
  const review = isNonUserOrigin(task);
  const items = [
    ...(review
      ? [
          { key: 'promote', label: 'Promote', icon: <ArrowUpCircle size={14} />, onSelect: () => onAction({ kind: 'promote', task }) },
          { key: 'mark-reviewed', label: 'Mark reviewed', icon: <Check size={14} />, onSelect: () => onAction({ kind: 'mark-reviewed', task }) },
        ]
      : []),
    { key: 'reject', separator: review, label: 'Reject', icon: <XCircle size={14} />, danger: true, onSelect: () => onAction({ kind: 'reject', task }) },
  ];
  return (
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Menu
        items={items}
        trigger={(props) => (
          <button type="button" {...props} aria-label={`Actions for ${task.title || 'task'}`} className={buttonClasses('ghost', 'xs')}>
            <MoreHorizontal size={14} aria-hidden />
          </button>
        )}
      />
    </span>
  );
}

function ActionDialog({ action, onClose }: { action: Action | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [priority, setPriority] = useState('');
  const [lastKey, setLastKey] = useState<string | null>(null);
  const key = action ? `${action.kind}:${action.task.uid}` : null;
  if (key !== lastKey) {
    setLastKey(key);
    setReason('');
    setPriority(action ? raisedPriority(taskPriority(action.task)) : '');
  }
  const run = useMutation({
    mutationFn: (a: Action) => {
      const path = `/tasks/${a.task.uid}/${a.kind}`;
      const body = a.kind === 'reject' ? (reason.trim() ? { reason: reason.trim() } : {}) : a.kind === 'promote' ? { priority } : undefined;
      return post<NodeDto>(path, body, { idempotencyKey: true });
    },
    onSuccess: (n, a) => {
      if (n && typeof n === 'object' && 'uid' in n) qc.setQueryData(qk.node(n.uid), n);
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: qk.node(a.task.uid) });
      toast.success(a.kind === 'reject' ? 'Task rejected' : a.kind === 'promote' ? 'Task promoted' : 'Marked reviewed', a.task.title);
      onClose();
    },
    onError: (e) => toast.error('Action failed', e),
  });
  if (!action) return null;
  const t = action.task;
  const copy = {
    promote: { title: 'Promote task?', confirm: 'Promote', variant: 'primary' as const, description: 'Raises its priority, removes the origin tags and marks it reviewed.' },
    'mark-reviewed': { title: 'Mark as reviewed?', confirm: 'Mark reviewed', variant: 'primary' as const, description: 'Removes the origin tags so it’s treated like a user-filed task. Priority is unchanged.' },
    reject: { title: 'Reject task?', confirm: 'Reject', variant: 'danger' as const, description: 'The task leaves the queue and won’t be dispatched. This can’t be undone from here.' },
  }[action.kind];
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      onConfirm={() => run.mutate(action)}
      loading={run.isPending}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirm}
      variant={copy.variant}
      confirmDisabled={action.kind === 'promote' && !priority}
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-md border border-line bg-sunken px-3 py-2 text-[13px]">
          <div className="font-medium text-fg">{t.title || 'Untitled'}</div>
          <div className="mt-1 flex items-center gap-1.5">
            <TaskStatusBadge status={taskStatus(t)} size="xs" />
            {taskPriority(t) && (
              <Badge size="xs" mono>
                {taskPriority(t)!.toUpperCase()}
              </Badge>
            )}
            {originKinds(t.tags).map((k) => (
              <Badge key={k} size="xs" tone="info" mono>
                origin:{k}
              </Badge>
            ))}
          </div>
        </div>
        {action.kind === 'promote' && (
          <Select label="New priority" size="sm" value={priority} onChange={(e) => setPriority(e.target.value)} options={TASK_PRIORITIES.map((p) => ({ value: p, label: p.toUpperCase() }))} />
        )}
        {action.kind === 'reject' && <TextArea label="Reason (optional)" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this task won’t be worked on" />}
      </div>
    </ConfirmDialog>
  );
}

function NewTaskDialog({ open, onClose, circuits }: { open: boolean; onClose: () => void; circuits: Array<{ value: string; label: string }> }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState('p2');
  const [circuit, setCircuit] = useState('');
  const [asDraft, setAsDraft] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTitle('');
      setBody('');
      setPriority('p2');
      setCircuit('');
      setAsDraft(false);
    }
  }
  const create = useMutation({
    mutationFn: () => post<NodeDto>('/tasks', { title: title.trim(), body, priority, target_circuit: circuit || null, draft: asDraft }, { idempotencyKey: true }),
    onSuccess: (n) => {
      qc.setQueryData(qk.node(n.uid), n);
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      toast.success(asDraft ? 'Draft task created' : 'Task queued', n.title);
      onClose();
      if (asDraft) navigate({ to: '/n/$uid', params: { uid: n.uid } });
    },
    onError: (e) => toast.error('Couldn’t create the task', e),
  });
  const submit = () => title.trim() && !create.isPending && create.mutate();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New task"
      description="Tasks go straight into the queue and are triaged automatically. Use Intake to shape a fuzzy idea first."
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" loading={create.isPending} disabled={!title.trim()} onClick={submit}>
            {asDraft ? 'Create draft' : 'Create & queue'}
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input label="Title" required autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should be done?" />
        <TextArea label="Pitch" hint="Markdown. Why it matters, what done looks like, links with [[…]]." rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <Select label="Priority" size="sm" value={priority} onChange={(e) => setPriority(e.target.value)} options={TASK_PRIORITIES.map((p) => ({ value: p, label: p.toUpperCase() }))} />
          <Select label="Target circuit" size="sm" value={circuit} placeholder="Triage decides" onChange={(e) => setCircuit(e.target.value)} options={circuits} />
        </div>
        <Checkbox label="Save as draft" description="Drafts stay out of the queue until accepted." checked={asDraft} onChange={(e) => setAsDraft(e.target.checked)} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
