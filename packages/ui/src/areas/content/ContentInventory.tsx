/** Content inventory ([09] §5.1): every Task, Artifact, Comment and Note; defaults to deliverable Artifacts. */
import { useMemo } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { FileText, Inbox, MessageSquareReply } from 'lucide-react';
import { NODE_TYPES, isNeedInputTag, type NodeDto } from '@breadboard/shared';
import { useConfigTree, useNodePage, useReviewCount, useRoles } from '../../lib/queries';
import { useUrlSearch } from '../../lib/url';
import { dayEndIso, dayStartIso, pageState } from '../../lib/paging';
import { humanize } from '../../lib/format';
import { cn } from '../../components/cn';
import {
  ActorLabel,
  Badge,
  buttonClasses,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  Loading,
  NodeTypeIcon,
  PageBody,
  PageHeader,
  Pager,
  TagChip,
  TimeAgo,
  type Column,
  type FilterDef,
} from '../../components';

type Search = { type?: string; tag?: string; need_input_role?: string; circuit?: string; created_after?: string; created_before?: string; order?: string; q?: string; page?: string; size?: string };

/** Sentinels so "no filter" survives the default (artifact + deliverable). */
const ALL = 'all';
const ANY = 'any';

export function ContentTabs({ active }: { active: 'inventory' | 'review' }) {
  const count = useReviewCount();
  const tab = (on: boolean) =>
    cn('-mb-px inline-flex items-center gap-1.5 border-b-2 px-1 pb-2 text-[13.5px] font-medium transition-colors', on ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg');
  return (
    <nav className="mt-1 flex gap-5 border-b border-line" aria-label="Content views">
      <Link to="/content" className={tab(active === 'inventory')} aria-current={active === 'inventory' ? 'page' : undefined}>
        <FileText size={14} aria-hidden /> Inventory
      </Link>
      <Link to="/content/review" className={tab(active === 'review')} aria-current={active === 'review' ? 'page' : undefined}>
        <Inbox size={14} aria-hidden /> Review queue
        {!!count.data?.count && (
          <Badge size="xs" tone="warn" variant="solid">
            {count.data.count}
          </Badge>
        )}
      </Link>
    </nav>
  );
}

export function ContentInventory() {
  const [search, setSearch] = useUrlSearch<Search>();
  const navigate = useNavigate();
  const roles = useRoles();
  const tree = useConfigTree();

  const type = search.type ?? 'artifact';
  const tag = search.tag ?? 'deliverable';
  const isDefault = type === 'artifact' && tag === 'deliverable';

  const circuitOptions = useMemo(
    () =>
      (tree.data ?? [])
        .filter((e) => e.kind === 'circuit' && e.uid)
        .map((e) => ({ value: e.uid!, label: e.slug ?? e.title ?? e.uid! }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [tree.data],
  );

  const filters: FilterDef[] = [
    { key: 'type', label: 'Type', type: 'select', options: NODE_TYPES.map((t) => ({ value: t, label: humanize(t) })), allLabel: 'Any type' },
    { key: 'tag', label: 'Tag', type: 'text', placeholder: 'e.g. deliverable', mono: true },
    { key: 'need_input_role', label: 'Needs input from', type: 'select', options: (roles.data ?? []).map((r) => ({ value: r.slug, label: r.slug })) },
    { key: 'circuit', label: 'Circuit', type: 'select', options: circuitOptions },
    { key: 'created', label: 'Created', type: 'daterange', fromKey: 'created_after', toKey: 'created_before' },
    { key: 'order', label: 'Order', type: 'select', allLabel: 'Newest first', options: [{ value: 'asc', label: 'Oldest first' }] },
  ];

  const filterValue = { ...search, type: type === ALL ? undefined : type, tag: tag === ANY ? undefined : tag };
  const query = {
    type: type === ALL ? undefined : type,
    tag: tag === ANY ? undefined : tag,
    need_input_role: search.need_input_role,
    circuit: search.circuit,
    created_after: dayStartIso(search.created_after),
    created_before: dayEndIso(search.created_before),
    order: search.order === 'asc' ? 'asc' : undefined,
    q: search.q,
  };
  const paging = pageState(search);
  const list = useNodePage(query, paging);
  const rows = list.items as NodeDto[];

  const columns: Column<NodeDto>[] = [
    {
      key: 'title',
      header: 'Title',
      cell: (n) => (
        <span className="flex min-w-0 items-center gap-2">
          <NodeTypeIcon type={n.type} size={14} className="shrink-0 text-fg-subtle" />
          <span className="truncate font-medium text-fg">{n.title || <span className="text-fg-subtle italic">Untitled</span>}</span>
        </span>
      ),
    },
    { key: 'type', header: 'Type', cell: (n) => <Badge size="xs">{n.type}</Badge>, width: '6.5rem' },
    {
      key: 'tags',
      header: 'Tags',
      cell: (n) => {
        const needs = n.tags.some(isNeedInputTag);
        const plain = n.tags.filter((t) => !isNeedInputTag(t));
        return (
          <span className="flex flex-wrap items-center gap-1">
            {needs && (
              <Badge size="xs" tone="warn" icon={<MessageSquareReply size={11} />}>
                needs input
              </Badge>
            )}
            {plain.slice(0, 3).map((t) => (
              <TagChip key={t} tag={t} />
            ))}
            {plain.length > 3 && <span className="text-[12px] text-fg-subtle">+{plain.length - 3}</span>}
          </span>
        );
      },
      hideBelow: 'md',
    },
    { key: 'scope', header: 'Scope', cell: (n) => <span className="text-[12.5px] text-fg-muted">{n.scope}</span>, width: '5.5rem', hideBelow: 'xl' },
    { key: 'by', header: 'Created by', cell: (n) => <ActorLabel actor={n.created_by} className="text-[12.5px]" />, hideBelow: 'lg' },
    { key: 'updated', header: 'Updated', cell: (n) => <TimeAgo at={n.updated_at} className="text-fg-muted" />, width: '7rem', hideBelow: 'lg' },
    { key: 'created', header: 'Created', cell: (n) => <TimeAgo at={n.created_at} className="text-fg-muted" />, width: '7rem' },
  ];

  const anyFilter = !isDefault || !!(search.need_input_role || search.circuit || search.created_after || search.created_before || search.order || search.q);

  return (
    <>
      <PageHeader icon={<FileText size={16} />} title="Content" subtitle="Everything the AI and the team have produced, connected by lineage.">
        <ContentTabs active="inventory" />
        <FilterBar
          className="mt-3"
          filters={filters}
          value={filterValue}
          search={{ placeholder: 'Search titles and text…' }}
          onChange={(v) =>
            setSearch({
              type: v.type === 'artifact' ? undefined : (v.type ?? ALL),
              tag: v.tag === 'deliverable' ? undefined : (v.tag ?? ANY),
              need_input_role: v.need_input_role,
              circuit: v.circuit,
              created_after: v.created_after,
              created_before: v.created_before,
              order: v.order,
              q: v.q,
              page: undefined,
            })
          }
          trailing={
            !isDefault ? (
              <button type="button" className={buttonClasses('ghost', 'xs')} onClick={() => setSearch({ type: undefined, tag: undefined, page: undefined })}>
                Deliverables only
              </button>
            ) : (
              <button type="button" className={buttonClasses('ghost', 'xs')} onClick={() => setSearch({ type: ALL, tag: ANY, page: undefined })}>
                Show all content
              </button>
            )
          }
        />
      </PageHeader>
      <PageBody wide>
        {list.isPending ? (
          <Loading label="Loading content…" />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : (
          <>
            <DataTable
              caption="Content"
              columns={columns}
              rows={rows}
              rowKey={(n) => n.uid}
              onRowClick={(n) => navigate({ to: '/n/$uid', params: { uid: n.uid } })}
              empty={
                <EmptyState
                  icon={<FileText size={20} />}
                  title={isDefault && !anyFilter ? 'No deliverables yet' : 'Nothing matches'}
                  description={isDefault && !anyFilter ? 'Deliverable Artifacts appear here as circuits complete. Intermediate artifacts are hidden by default.' : 'Try clearing a filter or widening the date range.'}
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
