/** Intake conversations ([08] §4, §7.1): idea-shaping chats that produce well-formed Tasks. */
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListTodo, MessagesSquare, Plus } from 'lucide-react';
import type { Actor, SessionRecord } from '@breadboard/shared';
import { asPage, get, post } from '../../lib/api';
import { useLiveEvents } from '../../lib/live';
import { toast } from '../../lib/toast';
import { ActorLabel, Badge, Button, buttonClasses, DataTable, EmptyState, ErrorState, Loading, PageBody, PageHeader, SearchInput, StateBadge, TimeAgo, type Column } from '../../components';
import { conversationTitle, normalizeDraft } from './lib';

export const intakeListKey = ['conversations', 'intake'] as const;

export function useIntakeConversations() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: intakeListKey,
    queryFn: async ({ signal }) => asPage<SessionRecord>(await get('/conversations', { kind: 'intake', limit: 100 }, { signal })).items,
  });
  useLiveEvents(['session.state'], (e) => {
    const p = (e.payload ?? {}) as { kind?: string };
    if (!p.kind || p.kind === 'intake') void qc.invalidateQueries({ queryKey: intakeListKey });
  });
  return q;
}

/** Start a new intake conversation and open it. */
export function useStartIntake() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const start = async () => {
    if (pending) return;
    setPending(true);
    try {
      const s = await post<SessionRecord>('/conversations', { kind: 'intake' }, { idempotencyKey: true });
      void qc.invalidateQueries({ queryKey: intakeListKey });
      navigate({ to: '/intake/$id', params: { id: s.session_id } });
    } catch (e) {
      toast.error('Couldn’t start a conversation', e);
    } finally {
      setPending(false);
    }
  };
  return { start, pending };
}

export function IntakeConversationsPage() {
  const list = useIntakeConversations();
  const navigate = useNavigate();
  const { start, pending } = useStartIntake();
  const [filter, setFilter] = useState('');

  const rows = (list.data ?? []).filter((s) => !filter.trim() || conversationTitle(s).toLowerCase().includes(filter.trim().toLowerCase()));

  const columns: Column<SessionRecord>[] = [
    {
      key: 'title',
      header: 'Conversation',
      cell: (s) => (
        <span className="flex min-w-0 items-center gap-2">
          <MessagesSquare size={14} className="shrink-0 text-fg-subtle" aria-hidden />
          <span className="truncate font-medium text-fg">{conversationTitle(s)}</span>
        </span>
      ),
      sortValue: (s) => conversationTitle(s).toLowerCase(),
    },
    {
      key: 'draft',
      header: 'Draft task',
      cell: (s) => {
        const d = normalizeDraft((s.state_detail as { draft_task?: unknown })?.draft_task);
        if (!d || (!d.taskUid && !d.title)) return <span className="text-[12.5px] text-fg-subtle">—</span>;
        return (
          <span className="flex min-w-0 items-center gap-1.5">
            {d.taskUid ? (
              <Badge size="xs" tone="ok">
                task
              </Badge>
            ) : (
              <Badge size="xs">draft</Badge>
            )}
            <span className="truncate text-[12.5px] text-fg-muted">{d.title ?? 'Untitled'}</span>
          </span>
        );
      },
      hideBelow: 'md',
    },
    { key: 'state', header: 'State', cell: (s) => <StateBadge state={s.state} size="xs" />, sortValue: (s) => s.state, width: '8rem' },
    { key: 'by', header: 'Started by', cell: (s) => <ActorLabel actor={((s.state_detail as { started_by?: Actor })?.started_by ?? s.created_by) as Actor | undefined} className="text-[12.5px]" />, hideBelow: 'lg' },
    { key: 'created', header: 'Started', cell: (s) => <TimeAgo at={s.created_at} className="text-fg-muted" />, sortValue: (s) => s.created_at, width: '7rem' },
  ];

  return (
    <>
      <PageHeader
        icon={<MessagesSquare size={16} />}
        title="Intake"
        subtitle="Shape an idea with the intake assistant into a well-formed Task, then accept it into the queue."
        actions={
          <>
            <Link to="/tasks" className={buttonClasses('ghost', 'sm')}>
              <ListTodo size={14} aria-hidden /> Task queue
            </Link>
            <Button size="sm" icon={<Plus size={14} />} loading={pending} onClick={() => void start()}>
              New conversation
            </Button>
          </>
        }
      >
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter conversations…" />
      </PageHeader>
      <PageBody wide>
        {list.isPending ? (
          <Loading label="Loading conversations…" />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : (
          <DataTable
            caption="Intake conversations"
            columns={columns}
            rows={rows}
            rowKey={(s) => s.session_id}
            onRowClick={(s) => navigate({ to: '/intake/$id', params: { id: s.session_id } })}
            initialSort={{ key: 'created', dir: 'desc' }}
            empty={
              filter.trim() ? (
                <EmptyState compact icon={<MessagesSquare size={20} />} title="No matching conversations" description="Try a different filter." />
              ) : (
                <EmptyState
                  icon={<MessagesSquare size={20} />}
                  title="No intake conversations yet"
                  description="Describe an idea in plain words; the assistant asks clarifying questions and drafts the Task for you."
                  action={
                    <Button size="sm" icon={<Plus size={14} />} loading={pending} onClick={() => void start()}>
                      New conversation
                    </Button>
                  }
                />
              )
            }
          />
        )}
      </PageBody>
    </>
  );
}
