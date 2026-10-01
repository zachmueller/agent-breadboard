/** Raw orchestrator event log for a session, paged by `after_seq` ([02] §3). */
import { useMemo, useState } from 'react';
import { ScrollText } from 'lucide-react';
import type { SessionEvent } from '@breadboard/shared';
import { formatDateTime } from '../../lib/format';
import { cn } from '../../components/cn';
import { EmptyState, ErrorState, JsonView, Loading, Pagination, Select } from '../../components';

const TONE: Record<string, string> = {
  'step-failed': 'text-danger-fg',
  'budget-exceeded': 'text-danger-fg',
  'session-cancelled': 'text-danger-fg',
  'gate-suspended': 'text-warn-fg',
  'session-suspended': 'text-warn-fg',
  'retry-scheduled': 'text-warn-fg',
  'step-exited': 'text-ok-fg',
  'session-completed': 'text-ok-fg',
  'gate-resolved': 'text-ok-fg',
};

export function eventTone(type: string): string {
  return TONE[type] ?? 'text-fg';
}

/** Presentational event list; `events` already loaded. */
export function EventList({ events, showStep = true, compact }: { events: SessionEvent[]; showStep?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (seq: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(seq)) n.delete(seq);
      else n.add(seq);
      return n;
    });
  return (
    <ol className="divide-y divide-line rounded-lg border border-line bg-surface">
      {events.map((e) => {
        const expanded = open.has(e.seq);
        const hasPayload = e.payload !== null && e.payload !== undefined && !(typeof e.payload === 'object' && Object.keys(e.payload as object).length === 0);
        return (
          <li key={e.seq}>
            <button
              type="button"
              onClick={() => hasPayload && toggle(e.seq)}
              aria-expanded={hasPayload ? expanded : undefined}
              className={cn('flex w-full items-baseline gap-3 px-3 text-left text-[12.5px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus', compact ? 'py-1.5' : 'py-2', hasPayload ? 'hover:bg-hover' : 'cursor-default')}
            >
              <span className="w-10 shrink-0 text-right font-mono text-fg-subtle tabular">#{e.seq}</span>
              <span className={cn('w-36 shrink-0 font-mono font-medium', eventTone(e.event_type))}>{e.event_type}</span>
              {showStep && <span className="w-32 shrink-0 truncate font-mono text-fg-muted">{e.step_id ?? ''}</span>}
              <span className="min-w-0 flex-1 truncate font-mono text-fg-subtle">{hasPayload && !expanded ? previewPayload(e.payload) : ''}</span>
              <time className="shrink-0 text-fg-subtle tabular" dateTime={e.created_at}>
                {formatDateTime(e.created_at)}
              </time>
            </button>
            {expanded && (
              <div className="px-3 pb-3 pl-[3.25rem]">
                <JsonView value={e.payload} defaultExpandDepth={2} maxHeight="24rem" />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function previewPayload(p: unknown): string {
  try {
    const s = JSON.stringify(p);
    return s.length > 160 ? s.slice(0, 160) + '…' : s;
  } catch {
    return '';
  }
}

export function EventsTab({ events, query }: { events: SessionEvent[]; query: { isPending: boolean; error: unknown; refetch: () => unknown; hasNextPage?: boolean; isFetchingNextPage?: boolean; fetchNextPage: () => unknown } }) {
  const [type, setType] = useState('');
  const [step, setStep] = useState('');
  const types = useMemo(() => [...new Set(events.map((e) => e.event_type))].sort(), [events]);
  const steps = useMemo(() => [...new Set(events.map((e) => e.step_id).filter((s): s is string => !!s))], [events]);
  const shown = events.filter((e) => (!type || e.event_type === type) && (!step || e.step_id === step));

  if (query.isPending) return <Loading label="Loading events…" />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select size="sm" aria-label="Event type" value={type} onChange={(e) => setType(e.target.value)} placeholder="All event types" options={types.map((t) => ({ value: t, label: t }))} wrapperClassName="w-52" />
        <Select size="sm" aria-label="Step" value={step} onChange={(e) => setStep(e.target.value)} placeholder="All steps" options={steps.map((s) => ({ value: s, label: s }))} wrapperClassName="w-48" />
        <span className="ml-auto text-xs text-fg-subtle tabular">
          {shown.length} of {events.length} loaded
        </span>
      </div>
      {shown.length ? <EventList events={shown} /> : <EmptyState icon={<ScrollText size={20} />} title="No events" description={events.length ? 'No events match these filters.' : 'The orchestrator has not recorded any events yet.'} compact />}
      <Pagination hasMore={!!query.hasNextPage} loading={!!query.isFetchingNextPage} onLoadMore={() => query.fetchNextPage()} shown={events.length} />
    </div>
  );
}
