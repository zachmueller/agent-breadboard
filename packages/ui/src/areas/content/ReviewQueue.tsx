/** Review queue ([09] §5.1): open need-input requests targeted at me, plus gates awaiting my verdict. */
import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Inbox, PauseCircle } from 'lucide-react';
import type { ReviewQueueItemDto } from '@breadboard/shared';
import { useReviewQueue } from '../../lib/queries';
import { cn } from '../../components/cn';
import { Badge, ConfigLink, EmptyState, ErrorState, Loading, NodeTypeIcon, PageBody, PageHeader, Tabs, TimeAgo } from '../../components';
import { ContentTabs } from './ContentInventory';
import { asRequest, NeedInputRequestCard } from './NeedInputRequestCard';

type Filter = 'all' | 'gates' | 'input';

export function ReviewQueuePage() {
  const q = useReviewQueue();
  const [filter, setFilter] = useState<Filter>('all');
  const items = q.data ?? [];
  const isGate = (it: ReviewQueueItemDto) => it.requests.some((r) => !!r.gate) || !!it.gating_session;
  const counts = useMemo(() => ({ all: items.length, gates: items.filter(isGate).length, input: items.filter((i) => !isGate(i)).length }), [items]);
  const shown = items
    .filter((i) => (filter === 'all' ? true : filter === 'gates' ? isGate(i) : !isGate(i)))
    // Gates first: they hold a suspended run.
    .sort((a, b) => Number(isGate(b)) - Number(isGate(a)));

  return (
    <>
      <PageHeader icon={<Inbox size={16} />} title="Content" subtitle="Requests for your input and gated runs waiting on your verdict.">
        <ContentTabs active="review" />
      </PageHeader>
      <PageBody className="flex max-w-5xl flex-col gap-4">
        <Tabs
          size="sm"
          value={filter}
          onChange={setFilter}
          items={[
            { key: 'all', label: 'All', count: counts.all },
            { key: 'gates', label: 'Gates', count: counts.gates },
            { key: 'input', label: 'Needs input', count: counts.input },
          ]}
        />
        {q.isPending ? (
          <Loading label="Loading review queue…" />
        ) : q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !shown.length ? (
          <EmptyState icon={<Inbox size={20} />} title={items.length ? 'Nothing in this filter' : 'Your review queue is clear'} description={items.length ? undefined : 'Requests targeted at you or your roles show up here.'} />
        ) : (
          <ul className="flex flex-col gap-3">
            {shown.map((it) => (
              <ReviewItem key={it.node.uid} item={it} gate={isGate(it)} />
            ))}
          </ul>
        )}
      </PageBody>
    </>
  );
}

function ReviewItem({ item, gate }: { item: ReviewQueueItemDto; gate: boolean }) {
  const { node } = item;
  return (
    <li className={cn('rounded-xl border bg-raised/40 p-3', gate ? 'border-warn/60' : 'border-line')}>
      <div className="mb-2.5 flex flex-wrap items-center gap-2 px-0.5">
        <NodeTypeIcon type={node.type} size={15} className="text-fg-subtle" />
        <Link to="/n/$uid" params={{ uid: node.uid }} className="min-w-0 truncate text-[14px] font-semibold text-fg hover:text-accent-text hover:underline">
          {node.title || 'Untitled'}
        </Link>
        {item.gating_session?.circuit_uid && (
          <span className="inline-flex items-center gap-1 text-[12.5px] text-fg-muted">
            <PauseCircle size={13} className="text-warn-fg" aria-hidden />
            <ConfigLink uid={item.gating_session.circuit_uid} kind="circuit" />
          </span>
        )}
        {item.gating_session?.kind === 'eval-run' && (
          <Badge tone="info" size="xs" title="This gate belongs to an eval run; its fixture is scored after your verdict.">
            eval run
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-2 text-[12px] text-fg-subtle">
          <TimeAgo at={node.updated_at} />
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {item.requests.map((r) => {
          const req = asRequest(r);
          return <NeedInputRequestCard key={req.request_id} nodeUid={node.uid} request={req} gatingSession={req.gate ? item.gating_session : null} compact />;
        })}
      </div>
    </li>
  );
}
