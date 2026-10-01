/**
 * Revision browser ([10] §3): named revisions with trigger labels + author; pick any two (or one
 * against the live document) for a text diff; restore as a new forward revision.
 */
import { useMemo, useState } from 'react';
import { GitCompareArrows, History, RotateCcw } from 'lucide-react';
import type { NodeRevision } from '@breadboard/shared';
import { useNodeRevision, useNodeRevisions } from '../../../lib/queries';
import { formatDateTime, humanize } from '../../../lib/format';
import { toast } from '../../../lib/toast';
import { ActorLabel, Badge, Button, ConfirmDialog, Drawer, EmptyState, ErrorState, IconButton, Loading, Pagination, cn } from '../../../components';
import { CURRENT, diffRevisions, orderCompare, revLabel, revisionText, togglePick, PRE_AI_EDIT, type DiffRow } from './revisionDiff';

export { CURRENT, revLabel };
import { useRestoreRevision } from './mutations';


export function useSortedRevisions(uid: string, enabled = true) {
  const list = useNodeRevisions(uid, enabled);
  const items = useMemo(() => [...list.items].sort((a, b) => b.revision_id - a.revision_id), [list.items]);
  return { ...list, items };
}

export function RevisionsPanel({ uid, head, readOnly, onCompare }: { uid: string; head: number | null; readOnly: boolean; onCompare: (pair: [number, number]) => void }) {
  const list = useSortedRevisions(uid);
  const [picked, setPicked] = useState<number[]>([]);
  const [restoring, setRestoring] = useState<NodeRevision | null>(null);

  if (list.isPending) return <Loading label="Loading revisions…" className="py-10" />;
  if (list.error) return <ErrorState error={list.error} onRetry={() => list.refetch()} compact className="m-3" />;

  const rows: Array<{ id: number; rev: NodeRevision | null }> = [{ id: CURRENT, rev: null }, ...list.items.map((r) => ({ id: r.revision_id, rev: r }))];
  const pair = picked.length === 2 ? orderCompare(picked[0]!, picked[1]!) : null;

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <p className="min-w-0 flex-1 text-xs text-fg-subtle">{pair ? `Compare ${revLabel(pair[0])} → ${revLabel(pair[1])}` : picked.length === 1 ? 'Pick one more to compare.' : 'Pick two to compare.'}</p>
        <Button size="xs" variant="secondary" icon={<GitCompareArrows size={13} />} disabled={!pair} onClick={() => pair && onCompare(pair)}>
          Compare
        </Button>
      </div>
      {!list.items.length && <EmptyState compact icon={<History size={18} />} title="No revisions yet" description="Revisions are cut at step completion, publish, restore, and before every AI edit." className="py-8" />}
      <ul aria-label="Revisions" className="flex flex-col">
        {rows.map(({ id, rev }) => {
          const on = picked.includes(id);
          return (
            <li key={id} className={cn('group flex items-start gap-2 border-b border-line px-3 py-2', on && 'bg-accent-soft')}>
              <input
                type="checkbox"
                className="mt-1 size-3.5 accent-[var(--bb-accent)]"
                checked={on}
                onChange={() => setPicked((p) => togglePick(p, id))}
                aria-label={`Select ${revLabel(id)} to compare`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[12.5px] font-medium">{id === CURRENT ? 'Current' : revLabel(id)}</span>
                  {id === CURRENT && (
                    <Badge size="xs" tone="ok" variant="dot">
                      live
                    </Badge>
                  )}
                  {id === head && (
                    <Badge size="xs" tone="accent">
                      head
                    </Badge>
                  )}
                  {rev?.labels.map((l) => (
                    <Badge key={l} size="xs" variant="outline" tone={l === PRE_AI_EDIT ? 'info' : 'neutral'}>
                      {humanize(l)}
                    </Badge>
                  ))}
                </div>
                {rev ? (
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-fg-subtle">
                    <ActorLabel actor={rev.created_by} icon={false} />
                    <span aria-hidden>·</span>
                    <span>{formatDateTime(rev.created_at)}</span>
                  </div>
                ) : (
                  <div className="mt-0.5 text-[11.5px] text-fg-subtle">The live document, including edits not yet cut into a revision.</div>
                )}
                {rev && (
                  <button type="button" className="mt-1 text-[11.5px] text-accent-text hover:underline" onClick={() => onCompare([rev.revision_id, CURRENT])}>
                    Diff with current
                  </button>
                )}
              </div>
              {rev && !readOnly && rev.revision_id !== head && (
                <IconButton label={`Restore ${revLabel(rev.revision_id)}`} size="sm" variant="ghost" onClick={() => setRestoring(rev)}>
                  <RotateCcw size={14} />
                </IconButton>
              )}
            </li>
          );
        })}
      </ul>
      <Pagination hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={() => list.fetchNextPage()} />
      <RestoreConfirm uid={uid} rev={restoring} onClose={() => setRestoring(null)} />
    </div>
  );
}

function RestoreConfirm({ uid, rev, onClose }: { uid: string; rev: Pick<NodeRevision, 'revision_id'> | null; onClose: () => void }) {
  const restore = useRestoreRevision(uid);
  return (
    <ConfirmDialog
      open={!!rev}
      onClose={onClose}
      title={rev ? `Restore ${revLabel(rev.revision_id)}?` : 'Restore'}
      description="The note’s content is replaced with this revision’s, applied as a new change everyone sees live. Nothing is lost: the current state stays in history."
      confirmLabel="Restore"
      loading={restore.isPending}
      onConfirm={async () => {
        if (!rev) return;
        try {
          await restore.mutateAsync(rev.revision_id);
          toast.success(`Restored ${revLabel(rev.revision_id)}`, 'Applied as a new revision.');
          onClose();
        } catch (e) {
          toast.error('Restore failed', e);
        }
      }}
    />
  );
}

/** Text diff between two revisions (or a revision and the live document). */
export function RevisionDiffDrawer({ uid, pair, liveText, readOnly, onClose }: { uid: string; pair: [number, number] | null; liveText: string; readOnly: boolean; onClose: () => void }) {
  const [a, b] = pair ?? [null, null];
  const ra = useNodeRevision(uid, a !== null && a !== CURRENT ? a : null);
  const rb = useNodeRevision(uid, b !== null && b !== CURRENT ? b : null);
  const [raw, setRaw] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const textOf = (id: number | null, q: typeof ra) => (id === CURRENT ? liveText : revisionText(q.data));
  const pending = (a !== null && a !== CURRENT && ra.isPending) || (b !== null && b !== CURRENT && rb.isPending);
  const error = ra.error ?? rb.error;
  const diff = useMemo(() => (pair && !pending && !error ? diffRevisions(textOf(a, ra), textOf(b, rb), revLabel(a!), revLabel(b!)) : null), [pair, pending, error, a, b, ra.data, rb.data, liveText]);

  return (
    <Drawer
      open={!!pair}
      onClose={onClose}
      width="xl"
      title={
        <span className="inline-flex items-center gap-2">
          <GitCompareArrows size={16} aria-hidden /> {pair ? `${revLabel(pair[0])} → ${revLabel(pair[1])}` : 'Compare'}
        </span>
      }
      description={diff ? `+${diff.added} −${diff.removed} lines` : undefined}
      actions={
        <Button size="xs" variant="ghost" onClick={() => setRaw((r) => !r)} aria-pressed={raw}>
          {raw ? 'Rendered diff' : 'Raw patch'}
        </Button>
      }
      footer={
        a !== null && a !== CURRENT && !readOnly ? (
          <div className="flex justify-end">
            <Button size="sm" variant="secondary" icon={<RotateCcw size={14} />} onClick={() => setRestoring(a)}>
              Restore {revLabel(a)}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="px-5 py-4">
        {pending ? (
          <Loading label="Loading revisions…" />
        ) : error ? (
          <ErrorState error={error} onRetry={() => (ra.error ? ra.refetch() : rb.refetch())} />
        ) : !diff ? null : !diff.rows.length ? (
          <EmptyState compact title="No differences" description="These two versions have identical text." />
        ) : raw ? (
          <pre className="overflow-auto rounded-md border border-line bg-sunken p-3 font-mono text-[12px] leading-[1.5] whitespace-pre">{diff.patch}</pre>
        ) : (
          <DiffRows rows={diff.rows} />
        )}
      </div>
      <RestoreConfirm uid={uid} rev={restoring === null ? null : { revision_id: restoring }} onClose={() => setRestoring(null)} />
    </Drawer>
  );
}

export function DiffRows({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="overflow-auto rounded-md border border-line bg-surface font-mono text-[12px] leading-[1.55]" role="table" aria-label="Text diff">
      {rows.map((r, i) =>
        r.kind === 'hunk' ? (
          <div key={i} className="bg-info-soft px-2 text-info-fg" role="row">
            {r.text}
          </div>
        ) : (
          <div key={i} role="row" className={cn('flex whitespace-pre-wrap', r.kind === 'add' && 'bg-ok-soft text-ok-fg', r.kind === 'del' && 'bg-danger-soft text-danger-fg')}>
            <span className="w-10 shrink-0 pr-1 text-right text-fg-subtle select-none">{r.oldNo ?? ''}</span>
            <span className="w-10 shrink-0 pr-1 text-right text-fg-subtle select-none">{r.newNo ?? ''}</span>
            <span className="w-4 shrink-0 text-center select-none" aria-label={r.kind === 'add' ? 'added' : r.kind === 'del' ? 'removed' : undefined}>
              {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}
            </span>
            <span className="min-w-0 pr-3 break-words">{r.text || ' '}</span>
          </div>
        ),
      )}
    </div>
  );
}
