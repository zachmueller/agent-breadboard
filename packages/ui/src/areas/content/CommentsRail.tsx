/** Comments rail ([09] §4): anchored comments, a "possibly stale" section, and select-text-to-comment. */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, MessageSquare, Quote, X } from 'lucide-react';
import type { NodeDto } from '@breadboard/shared';
import { useCreateComment, useNodeComments } from '../../lib/queries';
import type { CommentAnchor, CommentDto } from '../../lib/types';
import { cn } from '../../components/cn';
import { ActorLabel, Button, ErrorState, IconButton, Kbd, Markdown, modKey, Skeleton, TextArea, TimeAgo } from '../../components';
import { toast } from '../../lib/toast';

export interface PendingQuote {
  quote: string;
  context: string | null;
}

const STALE = new Set(['stale', 'not_found', 'ambiguous', 'unmappable']);

export function isStaleComment(c: CommentDto): boolean {
  return !!c.stale || (!!c.anchor_status && STALE.has(c.anchor_status));
}

function anchorOf(c: CommentDto): CommentAnchor | null {
  const a = c.properties?.anchor as CommentAnchor | undefined;
  return a && typeof a.quote === 'string' ? a : null;
}

function commentText(c: CommentDto): string {
  if (typeof c.body_text === 'string') return c.body_text;
  if (typeof c.body === 'string') return c.body;
  return '';
}

function CommentItem({ c }: { c: CommentDto }) {
  const a = anchorOf(c);
  const stale = isStaleComment(c);
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2 text-[12px]">
        <ActorLabel actor={c.created_by} className="font-medium text-fg" />
        <TimeAgo at={c.created_at} className="ml-auto text-fg-subtle" />
      </div>
      {a?.quote && (
        <blockquote className={cn('border-l-2 pl-2 text-[12.5px] italic', stale ? 'border-warn text-fg-subtle line-through decoration-fg-subtle/40' : 'border-accent/60 text-fg-muted')} title={a.revision != null ? `Anchored at revision ${a.revision}` : undefined}>
          {a.quote.length > 220 ? a.quote.slice(0, 220) + '…' : a.quote}
        </blockquote>
      )}
      <Markdown source={commentText(c)} size="sm" />
    </li>
  );
}

export function CommentsRail({ node, pending, onClearPending, className }: { node: NodeDto; pending: PendingQuote | null; onClearPending: () => void; className?: string }) {
  const q = useNodeComments(node.uid);
  const create = useCreateComment(node.uid);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (pending) ref.current?.focus();
  }, [pending]);

  const comments = q.data ?? [];
  const current = comments.filter((c) => !isStaleComment(c));
  const stale = comments.filter(isStaleComment);

  const submit = async () => {
    const body = text.trim();
    if (!body) return;
    try {
      await create.mutateAsync({ body, anchor: pending ? { quote: pending.quote, context: pending.context, revision: node.head_revision } : undefined });
      setText('');
      onClearPending();
    } catch (e) {
      toast.error('Comment not posted', e);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <aside className={cn('flex flex-col gap-3', className)} aria-label="Comments">
      <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
        <MessageSquare size={14} aria-hidden /> Comments
        {comments.length > 0 && <span className="font-normal text-fg-subtle tabular">{comments.length}</span>}
      </h2>

      <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5">
        {pending && (
          <div className="flex items-start gap-1.5 rounded-md bg-accent-soft px-2 py-1.5 text-[12.5px] text-fg">
            <Quote size={12} className="mt-0.5 shrink-0 text-accent-text" aria-hidden />
            <span className="line-clamp-3 min-w-0 flex-1 italic">{pending.quote}</span>
            <IconButton label="Remove quote" size="xs" onClick={onClearPending}>
              <X size={12} />
            </IconButton>
          </div>
        )}
        <TextArea
          ref={ref}
          aria-label="New comment"
          rows={pending ? 3 : 2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={pending ? 'Comment on the selection…' : 'Add a comment, or select text to anchor one…'}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-fg-subtle">
            <Kbd>{modKey}</Kbd>
            <Kbd>Enter</Kbd> to post
          </span>
          <Button size="xs" variant="primary" onClick={submit} loading={create.isPending} disabled={!text.trim()}>
            Comment
          </Button>
        </div>
      </div>

      {q.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-12" />
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} compact onRetry={() => q.refetch()} />
      ) : (
        <>
          {current.length ? (
            <ul className="flex flex-col gap-2">
              {current.map((c) => (
                <CommentItem key={c.uid} c={c} />
              ))}
            </ul>
          ) : (
            !stale.length && <p className="px-1 text-[12.5px] text-fg-subtle">No comments yet.</p>
          )}
          {stale.length > 0 && (
            <section className="flex flex-col gap-2" aria-label="Possibly stale comments">
              <h3 className="flex items-center gap-1.5 px-0.5 text-[11.5px] font-medium uppercase tracking-wide text-warn-fg">
                <AlertTriangle size={12} aria-hidden /> Possibly stale
              </h3>
              <p className="px-0.5 text-[12px] text-fg-subtle">The quoted text changed since these were written, so they can't be anchored confidently.</p>
              <ul className="flex flex-col gap-2 opacity-90">
                {stale.map((c) => (
                  <CommentItem key={c.uid} c={c} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </aside>
  );
}
