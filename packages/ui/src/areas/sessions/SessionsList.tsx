/** Sessions history ([02] §8): filterable list of every run and conversation; gated runs flagged. */
import { useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Activity, PauseCircle } from 'lucide-react';
import { SESSION_KINDS, SESSION_STATES, type SessionRecord } from '@breadboard/shared';
import { useConfigTree, useSessions } from '../../lib/queries';
import { useUrlSearch } from '../../lib/url';
import { durationMs, formatDuration, humanize } from '../../lib/format';
import { sessionStateMeta } from '../../lib/states';
import {
  Badge,
  ConfigLink,
  CostInline,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  Loading,
  NodeChip,
  PageBody,
  PageHeader,
  Pagination,
  StateBadge,
  TimeAgo,
  type Column,
  type FilterDef,
} from '../../components';

type Row = SessionRecord & { cost_usd?: number | string; cost_usd_including_children?: number };

type Search = { state?: string; kind?: string; circuit?: string; task?: string; created_after?: string };

export function SessionsList() {
  const [search, setSearch] = useUrlSearch<Search>();
  const navigate = useNavigate();
  const tree = useConfigTree();

  const circuitOptions = useMemo(
    () =>
      (tree.data ?? [])
        .filter((e) => e.kind === 'circuit' && e.uid)
        .map((e) => ({ value: e.uid!, label: e.slug ?? e.title ?? e.uid! }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [tree.data],
  );

  const filters: FilterDef[] = [
    { key: 'state', label: 'State', type: 'select', options: SESSION_STATES.map((s) => ({ value: s, label: sessionStateMeta(s).label })) },
    { key: 'kind', label: 'Kind', type: 'select', options: SESSION_KINDS.map((k) => ({ value: k, label: humanize(k) })) },
    { key: 'circuit', label: 'Circuit', type: 'select', options: circuitOptions },
    { key: 'task', label: 'Task', type: 'text', placeholder: 'Task UID', mono: true },
    { key: 'created_after', label: 'Since', type: 'date' },
  ];

  const filter = {
    state: search.state,
    kind: search.kind,
    circuit: search.circuit,
    task: search.task?.trim().toUpperCase() || undefined,
    created_after: search.created_after ? new Date(search.created_after).toISOString() : undefined,
  };
  const list = useSessions(filter, { limit: 50 });
  const rows = list.items as Row[];

  const columns: Column<Row>[] = [
    {
      key: 'id',
      header: 'Session',
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5 font-mono text-[12.5px] text-fg">
          {r.state === 'suspended-gate' && <PauseCircle size={13} className="text-warn-fg" aria-label="Gated" />}
          {r.session_id.replace(/^ses_/, '').slice(0, 10)}
        </span>
      ),
      width: '9.5rem',
    },
    { key: 'kind', header: 'Kind', cell: (r) => <Badge size="xs">{r.kind}</Badge>, sortValue: (r) => r.kind, width: '7.5rem' },
    {
      key: 'circuit',
      header: 'Circuit',
      cell: (r) => (r.circuit_uid ? <ConfigLink uid={r.circuit_uid} slug={r.circuit_slug} kind="circuit" /> : <span className="text-fg-subtle">—</span>),
      sortValue: (r) => r.circuit_slug ?? r.circuit_uid ?? '',
    },
    { key: 'state', header: 'State', cell: (r) => <StateBadge state={r.state} detail={r.state_detail} size="xs" />, sortValue: (r) => r.state, width: '9.5rem' },
    {
      key: 'task',
      header: 'Task',
      cell: (r) => (r.task_uid ? <span onClick={(e) => e.stopPropagation()}><NodeChip uid={r.task_uid} type="task" maxWidth="max-w-[16rem]" menu={false} /></span> : <span className="text-fg-subtle">—</span>),
      hideBelow: 'lg',
    },
    {
      key: 'cost',
      header: 'Cost',
      align: 'right',
      cell: (r) => <CostInline usd={r.cost_usd_including_children ?? r.cost_usd} />,
      sortValue: (r) => Number(r.cost_usd_including_children ?? r.cost_usd ?? 0),
      width: '6rem',
    },
    { key: 'created', header: 'Created', cell: (r) => <TimeAgo at={r.created_at} className="text-fg-muted" />, sortValue: (r) => r.created_at, width: '7rem', hideBelow: 'md' },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      cell: (r) => <span className="tabular text-fg-muted">{r.started_at ? formatDuration(durationMs(r.started_at, r.ended_at)) : '—'}</span>,
      sortValue: (r) => durationMs(r.started_at, r.ended_at) ?? -1,
      width: '6rem',
      hideBelow: 'md',
    },
  ];

  const anyFilter = Object.values(search).some(Boolean);

  return (
    <>
      <PageHeader icon={<Activity size={16} />} title="Sessions" subtitle="Every circuit run, eval run, and conversation, with the config versions each used and what it produced.">
        <FilterBar filters={filters} value={search} onChange={(v) => setSearch({ state: v.state, kind: v.kind, circuit: v.circuit, task: v.task, created_after: v.created_after })} />
      </PageHeader>
      <PageBody wide>
        {list.isPending ? (
          <Loading label="Loading sessions…" />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : (
          <>
            <DataTable
              caption="Sessions"
              columns={columns}
              rows={rows}
              rowKey={(r) => r.session_id}
              onRowClick={(r) => navigate({ to: '/s/$id', params: { id: r.session_id } })}
              rowClassName={(r) => (r.state === 'suspended-gate' ? 'bg-warn-soft/50 shadow-[inset_3px_0_0_var(--bb-warn)]' : r.state === 'suspended-error' ? 'shadow-[inset_3px_0_0_var(--bb-danger)]' : undefined)}
              empty={
                <EmptyState
                  icon={<Activity size={20} />}
                  title={anyFilter ? 'No sessions match these filters' : 'No sessions yet'}
                  description={anyFilter ? 'Try widening the date range or clearing a filter.' : 'Sessions appear here as Tasks dispatch into circuits and conversations start.'}
                  compact
                />
              }
            />
            <Pagination hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => list.fetchNextPage()} shown={rows.length} />
          </>
        )}
      </PageBody>
    </>
  );
}
