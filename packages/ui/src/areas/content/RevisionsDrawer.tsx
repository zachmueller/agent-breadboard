/** Named revisions of a node ([01] §5): list with trigger labels + author; view any one. */
import { useState } from 'react';
import { History } from 'lucide-react';
import { useNodeRevision, useNodeRevisions } from '../../lib/queries';
import { formatDateTime } from '../../lib/format';
import { cn } from '../../components/cn';
import { ActorLabel, Badge, Drawer, EmptyState, ErrorState, JsonView, Loading, Markdown, Pagination } from '../../components';

export function RevisionsDrawer({ uid, open, onClose, head }: { uid: string; open: boolean; onClose: () => void; head: number | null }) {
  const list = useNodeRevisions(uid, open);
  const [sel, setSel] = useState<number | null>(null);
  const items = list.items;
  const current = sel ?? items[0]?.revision_id ?? null;
  const rev = useNodeRevision(uid, open ? current : null);
  return (
    <Drawer open={open} onClose={onClose} width="xl" title={<span className="inline-flex items-center gap-2"><History size={16} aria-hidden /> Revisions</span>} description="Immutable snapshots cut at step completion, gate resolution, publish, and before AI edits.">
      {list.isPending ? (
        <Loading />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} className="m-5" />
      ) : !items.length ? (
        <EmptyState icon={<History size={20} />} title="No revisions yet" description="A revision is cut at the next meaningful boundary." className="m-5" />
      ) : (
        <div className="grid h-full min-h-0 grid-cols-[15rem_1fr]">
          <div className="min-h-0 overflow-y-auto border-r border-line">
            <ul role="listbox" aria-label="Revisions">
              {items.map((r) => (
                <li key={r.revision_id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={r.revision_id === current}
                    onClick={() => setSel(r.revision_id)}
                    className={cn('flex w-full flex-col gap-1 border-b border-line px-3.5 py-2.5 text-left hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus', r.revision_id === current && 'bg-accent-soft')}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono text-[13px] font-medium">r{r.revision_id}</span>
                      {r.revision_id === head && (
                        <Badge size="xs" tone="accent">
                          head
                        </Badge>
                      )}
                    </span>
                    <span className="flex flex-wrap gap-1">
                      {r.labels.map((l) => (
                        <Badge key={l} size="xs" variant="outline">
                          {l}
                        </Badge>
                      ))}
                    </span>
                    <span className="flex items-center gap-1.5 text-[11.5px] text-fg-subtle">
                      <ActorLabel actor={r.created_by} icon={false} />· {formatDateTime(r.created_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <Pagination hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => list.fetchNextPage()} />
          </div>
          <div className="min-h-0 overflow-y-auto px-5 py-4">
            {rev.isPending ? (
              <Loading />
            ) : rev.error ? (
              <ErrorState error={rev.error} compact />
            ) : rev.data ? (
              <div className="flex flex-col gap-4">
                {rev.data.body_text ? <Markdown source={rev.data.body_text} /> : rev.data.body !== null && rev.data.body !== undefined ? <JsonView value={rev.data.body} defaultExpandDepth={2} /> : <p className="text-[13px] text-fg-subtle">No body at this revision.</p>}
                {Object.keys(rev.data.properties ?? {}).length > 0 && (
                  <section>
                    <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Properties</h3>
                    <JsonView value={rev.data.properties} defaultExpandDepth={1} />
                  </section>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </Drawer>
  );
}
