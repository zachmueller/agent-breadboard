/** Comment anchoring + rail ([09] §4, [10] §3): comments sit beside their anchored block; unmatched ones are "possibly stale". */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { MessageSquare, MessageSquareWarning } from 'lucide-react';
import type { CommentAnchor, CommentDto } from '../../../lib/types';
import { ActorLabel, EmptyState, Markdown, TimeAgo, cn } from '../../../components';
import { matchAnchor } from './anchors';

export interface AnchoredComment {
  comment: CommentDto;
  from: number;
  to: number;
}

export interface CommentBuckets {
  anchored: AnchoredComment[];
  stale: CommentDto[];
  general: CommentDto[];
}

export function commentAnchor(c: CommentDto): CommentAnchor | null {
  const a = (c.properties?.anchor ?? null) as CommentAnchor | null;
  return a && typeof a.quote === 'string' && a.quote ? a : null;
}

/** Re-anchor every comment against the live document text (client-side, so it tracks unsaved edits). */
export function bucketComments(comments: readonly CommentDto[], docText: string): CommentBuckets {
  const out: CommentBuckets = { anchored: [], stale: [], general: [] };
  for (const c of comments) {
    if (c.parent_uid) continue; // replies render under their parent
    const anchor = commentAnchor(c);
    if (!anchor) {
      out.general.push(c);
      continue;
    }
    const m = matchAnchor(docText, anchor);
    if (m.status === 'resolved') out.anchored.push({ comment: c, from: m.from, to: m.to });
    else out.stale.push(c);
  }
  out.anchored.sort((a, b) => a.from - b.from);
  return out;
}

export function CommentCard({ comment, active, onSelect, stale }: { comment: CommentDto; active?: boolean; onSelect?: () => void; stale?: boolean }) {
  const anchor = commentAnchor(comment);
  return (
    <article
      onClick={onSelect}
      className={cn(
        'rounded-md border bg-surface p-2.5 text-[13px] shadow-sm transition-colors',
        active ? 'border-warn ring-1 ring-warn/40' : 'border-line hover:border-line-strong',
        onSelect && 'cursor-pointer',
      )}
      aria-current={active ? 'true' : undefined}
    >
      <header className="mb-1 flex items-center gap-1.5 text-xs text-fg-muted">
        <ActorLabel actor={comment.created_by} />
        <span aria-hidden>·</span>
        <TimeAgo at={comment.created_at} />
      </header>
      {anchor?.quote && (
        <blockquote className={cn('mb-1.5 line-clamp-2 border-l-2 pl-2 text-xs text-fg-subtle', stale ? 'border-warn line-through decoration-dotted' : 'border-line-strong')}>{anchor.quote}</blockquote>
      )}
      <Markdown source={comment.body_text ?? ''} size="sm" />
      {!!comment.replies?.length && (
        <div className="mt-2 flex flex-col gap-1.5 border-t border-line pt-2">
          {comment.replies.map((r) => (
            <div key={r.uid} className="text-xs">
              <ActorLabel actor={r.created_by} icon={false} className="font-medium" /> <Markdown source={r.body_text ?? ''} size="sm" />
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * Cards absolutely positioned at their anchors' vertical offsets (`tops`, px within the rail),
 * nudged down to avoid overlaps after measuring.
 */
export function CommentsRail({ items, tops, activeId, onSelect, layoutKey }: { items: AnchoredComment[]; tops: Record<string, number>; activeId: string | null; onSelect: (id: string) => void; layoutKey: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    let floor = 0;
    for (const el of Array.from(host.children) as HTMLElement[]) {
      const want = Number(el.dataset.top ?? 0);
      const top = Math.max(want, floor);
      el.style.top = `${top}px`;
      floor = top + el.offsetHeight + 8;
    }
    host.style.minHeight = `${floor}px`;
  }, [items, tops, activeId, layoutKey]);
  return (
    <div ref={ref} className="relative" aria-label="Anchored comments">
      {items.map(({ comment }) => (
        <div key={comment.uid} data-top={tops[comment.uid] ?? 0} className="absolute inset-x-0" style={{ top: tops[comment.uid] ?? 0 }}>
          <CommentCard comment={comment} active={activeId === comment.uid} onSelect={() => onSelect(comment.uid)} />
        </div>
      ))}
    </div>
  );
}

/** Flat list for the Comments tab: anchored, general, and a "possibly stale" section. */
export function CommentsList({ buckets, activeId, onSelect, loading, error }: { buckets: CommentBuckets; activeId: string | null; onSelect: (id: string) => void; loading?: boolean; error?: ReactNode }) {
  if (loading) return <div className="p-4 text-sm text-fg-subtle">Loading comments…</div>;
  if (error) return <div className="p-4">{error}</div>;
  const total = buckets.anchored.length + buckets.general.length + buckets.stale.length;
  if (!total) return <EmptyState compact icon={<MessageSquare size={18} />} title="No comments" description="Select text in the editor and choose Comment." className="py-10" />;
  return (
    <div className="flex flex-col gap-4 p-3">
      {buckets.anchored.length > 0 && (
        <section className="flex flex-col gap-2">
          {buckets.anchored.map(({ comment }) => (
            <CommentCard key={comment.uid} comment={comment} active={activeId === comment.uid} onSelect={() => onSelect(comment.uid)} />
          ))}
        </section>
      )}
      {buckets.general.length > 0 && (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-medium tracking-wide text-fg-muted uppercase">On the whole note</h4>
          {buckets.general.map((c) => (
            <CommentCard key={c.uid} comment={c} />
          ))}
        </section>
      )}
      {buckets.stale.length > 0 && <StaleComments items={buckets.stale} />}
    </div>
  );
}

export function StaleComments({ items }: { items: CommentDto[] }) {
  return (
    <section className="flex flex-col gap-2" aria-label="Possibly stale comments">
      <h4 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-warn-fg uppercase">
        <MessageSquareWarning size={13} aria-hidden /> Possibly stale ({items.length})
      </h4>
      <p className="text-xs text-fg-subtle">The quoted text was edited or removed, so these can’t be placed in the document.</p>
      {items.map((c) => (
        <CommentCard key={c.uid} comment={c} stale />
      ))}
    </section>
  );
}
