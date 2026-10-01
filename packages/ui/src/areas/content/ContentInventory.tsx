/** Content inventory ([09] §5.1): every Task, Artifact, Comment and Note; defaults to deliverable Artifacts. */
import { useMemo } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { FileText, Inbox, MessageSquareReply } from 'lucide-react';
import { NODE_TYPES, isNeedInputTag, type NodeDto } from '@breadboard/shared';
import { useConfigTree, useNodes, useReviewCount, useRoles } from '../../lib/queries';
import { useUrlSearch } from '../../lib/url';
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
  Pagination,
  TagChip,
  TimeAgo,
  type Column,
  type FilterDef,
} from '../../components';

type Search = { type?: string; tag?: string; need_input_role?: string; circuit?: string; created_after?: string; q?: string };

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
    { key: 'created_after', label: 'Since', type: 'date' },
  ];

  const filterValue = { ...search, type: type === ALL ? undefined : type, tag: tag === ANY ? undefined : tag };
  const query = {
    type: type === ALL ? undefined : type,
    tag: tag === ANY ? undefined : tag,
    need_input_role: search.need_input_role,
    circuit: search.circuit,
    created_after: search.created_after ? new Date(search.created_after).toISOString() : undefined,
    q: search.q,
  };
  const list = useNodes(query, { limit: 50 });
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
      sortValue: (n) => n.title.toLowerCase(),
    },
    { key: 'type', header: 'Type', cell: (n) => <Badge size="xs">{n.type}</Badge>, sortValue: (n) => n.type, width: '6.5rem' },
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
    { key: 'updated', header: 'Updated', cell: (n) => <TimeAgo at={n.updated_at} className="text-fg-muted" />, sortValue: (n) => n.updated_at, width: '7rem' },
  ];

  const anyFilter = !isDefault || !!(search.need_input_role || search.circuit || search.created_after || search.q);

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
              q: v.q,
            })
          }
          trailing={
            !isDefault ? (
              <button type="button" className={buttonClasses('ghost', 'xs')} onClick={() => setSearch({ type: undefined, tag: undefined })}>
                Deliverables only
              </button>
            ) : (
              <button type="button" className={buttonClasses('ghost', 'xs')} onClick={() => setSearch({ type: ALL, tag: ANY })}>
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
            <Pagination hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => list.fetchNextPage()} shown={rows.length} />
          </>
        )}
      </PageBody>
    </>
  );
}
