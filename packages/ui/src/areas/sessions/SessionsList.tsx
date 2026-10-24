/** Sessions history ([02] §8): filterable list of every run and conversation; gated runs flagged. */
import { useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Activity, PauseCircle } from 'lucide-react';
import { SESSION_KINDS, SESSION_STATES, type SessionRecord } from '@breadboard/shared';
import { useConfigTree, useSessions } from '../../lib/queries';
import { useUrlSearch } from '../../lib/url';
import { dayEndIso, dayStartIso, pageState } from '../../lib/paging';
import { durationMs, formatDuration, humanize } from '../../lib/format';
import { RUN_KINDS, sessionStateMeta } from '../../lib/states';
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
  Pager,
  StateBadge,
  TimeAgo,
  type Column,
  type FilterDef,
} from '../../components';

type Row = SessionRecord & { cost_usd?: number | string; cost_usd_including_children?: number };

type Search = { state?: string; kind?: string; circuit?: string; task?: string; created_after?: string; created_before?: string; order?: string; page?: string; size?: string };

/** Search keys that narrow the list; changing one returns to page 1. */
const FILTER_KEYS = ['state', 'kind', 'circuit', 'task', 'created_after', 'created_before', 'order'] as const;

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
    { key: 'kind', label: 'Kind', type: 'select', options: [{ value: RUN_KINDS, label: 'Runs (circuit + eval)' }, ...SESSION_KINDS.map((k) => ({ value: k, label: humanize(k) }))] },
    { key: 'circuit', label: 'Circuit', type: 'select', options: circuitOptions },
    { key: 'task', label: 'Task', type: 'text', placeholder: 'Task UID', mono: true },
    { key: 'created', label: 'Created', type: 'daterange', fromKey: 'created_after', toKey: 'created_before' },
    { key: 'order', label: 'Order', type: 'select', allLabel: 'Newest first', options: [{ value: 'asc', label: 'Oldest first' }] },
  ];

  const filter = {
    state: search.state,
    kind: search.kind,
    circuit: search.circuit,
    task: search.task?.trim().toUpperCase() || undefined,
    created_after: dayStartIso(search.created_after),
    created_before: dayEndIso(search.created_before),
    order: search.order === 'asc' ? ('asc' as const) : undefined,
  };
  const paging = pageState(search);
  const list = useSessions(filter, paging);
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
    { key: 'kind', header: 'Kind', cell: (r) => <Badge size="xs">{r.kind}</Badge>, width: '7.5rem' },
    {
      key: 'circuit',
      header: 'Circuit',
      cell: (r) => (r.circuit_uid ? <ConfigLink uid={r.circuit_uid} slug={r.circuit_slug} kind="circuit" /> : <span className="text-fg-subtle">—</span>),
    },
    { key: 'state', header: 'State', cell: (r) => <StateBadge state={r.state} detail={r.state_detail} size="xs" />, width: '9.5rem' },
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
      width: '6rem',
    },
    { key: 'created', header: 'Created', cell: (r) => <TimeAgo at={r.created_at} className="text-fg-muted" />, width: '7rem', hideBelow: 'md' },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      cell: (r) => <span className="tabular text-fg-muted">{r.started_at ? formatDuration(durationMs(r.started_at, r.ended_at)) : '—'}</span>,
      width: '6rem',
      hideBelow: 'md',
    },
  ];

  const anyFilter = FILTER_KEYS.some((k) => search[k]);

  return (
    <>
      <PageHeader icon={<Activity size={16} />} title="Sessions" subtitle="Every circuit run, eval run, and conversation, with the config versions each used and what it produced.">
        <FilterBar filters={filters} value={search} onChange={(v) => setSearch({ ...Object.fromEntries(FILTER_KEYS.map((k) => [k, v[k]])), page: undefined })} />
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
            <Pager
              page={paging.page}
              size={paging.size}
              total={list.total}
              shown={rows.length}
              loading={list.isPlaceholderData}
              onPage={(p) => setSearch({ page: p > 1 ? String(p) : undefined })}
              onSize={(n) => setSearch({ size: String(n), page: undefined })}
            />
          </>
        )}
      </PageBody>
    </>
  );
}
