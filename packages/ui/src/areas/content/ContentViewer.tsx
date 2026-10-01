/** Content viewer (`/n/:uid`, [09] §5.2): body, lineage, comments rail, need-input actions, revisions, editor jump. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { FileText, GitFork, History, MessageSquarePlus, MessageSquareReply, Pencil } from 'lucide-react';
import { isNeedInputTag, type NodeDto } from '@breadboard/shared';
import { useNode, useNodeMarkdown } from '../../lib/queries';
import { useUrlSearch } from '../../lib/url';
import { useEditShortcut } from '../../lib/edit-target';
import { isApiError } from '../../lib/api';
import { humanize } from '../../lib/format';
import {
  ActorLabel,
  Badge,
  Button,
  buttonClasses,
  EmptyState,
  ErrorState,
  JsonView,
  Kbd,
  Loading,
  Markdown,
  NodeTypeIcon,
  PageBody,
  PageHeader,
  Panel,
  Skeleton,
  TagChip,
  TimeAgo,
} from '../../components';
import { CommentsRail, type PendingQuote } from './CommentsRail';
import { LineagePanel } from './LineagePanel';
import { NeedInputRequestCard, openRequests } from './NeedInputRequestCard';
import { NodeEditDrawer, editableProperties } from './NodeEditDrawer';
import { RevisionsDrawer } from './RevisionsDrawer';

export function ContentViewer({ uid: uidProp }: { uid?: string }) {
  const uid = (uidProp ?? '').toUpperCase();
  const q = useNode(uid);
  if (q.isPending) return <Loading label="Loading…" className="py-24" />;
  if (q.error || !q.data)
    return (
      <PageBody>
        {isApiError(q.error) && (q.error.isNotFound || q.error.isForbidden) ? (
          <EmptyState
            icon={<FileText size={20} />}
            title="Node not found"
            description={<>No node <span className="font-mono">{uid}</span> exists, or it is outside your visibility.</>}
            action={<Link to="/content" className={buttonClasses('secondary', 'sm')}>Content inventory</Link>}
          />
        ) : (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        )}
      </PageBody>
    );
  return <Viewer node={q.data} />;
}

/** Find `quote` in `source` and return ~80 chars of surrounding context for re-anchoring. */
export function quoteContext(source: string, quote: string): string | null {
  const i = source.indexOf(quote);
  if (i < 0) return null;
  return source.slice(Math.max(0, i - 80), Math.min(source.length, i + quote.length + 80));
}

function Viewer({ node }: { node: NodeDto }) {
  const navigate = useNavigate();
  const [search, setSearch] = useUrlSearch<{ panel?: string }>();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<PendingQuote | null>(null);
  const [selection, setSelection] = useState<{ quote: string; x: number; y: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const md = useNodeMarkdown(node.uid, node.crdt);
  const source = node.crdt ? (md.data?.markdown ?? '') : (node.body_text ?? (typeof node.body === 'string' ? node.body : ''));
  const requests = openRequests(node.properties);
  const props = useMemo(() => editableProperties(node), [node]);
  const tags = node.tags.filter((t) => !isNeedInputTag(t));
  const readOnly = node.tags.includes('read-only');

  const openEditor = useCallback(() => {
    if (node.crdt) navigate({ to: '/knowledge/$uid', params: { uid: node.uid } });
    else setEditing(true);
  }, [node.crdt, node.uid, navigate]);
  useEditShortcut(openEditor, node.crdt ? 'Open in editor' : 'Edit node');

  // Deep link `?panel=lineage|revisions`.
  useEffect(() => {
    if (search.panel === 'lineage') document.getElementById('lineage')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [search.panel]);

  // Select-text-to-comment: offer a floating button over a selection inside the body.
  useEffect(() => {
    const onUp = () => {
      const sel = window.getSelection();
      const el = bodyRef.current;
      if (!sel || sel.isCollapsed || !el || !sel.rangeCount) return setSelection(null);
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return setSelection(null);
      const quote = sel.toString().trim();
      if (quote.length < 2) return setSelection(null);
      const rect = range.getBoundingClientRect();
      const host = el.getBoundingClientRect();
      setSelection({ quote, x: rect.left - host.left + rect.width / 2, y: rect.top - host.top });
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', onUp);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keyup', onUp);
    };
  }, []);

  const commentOnSelection = () => {
    if (!selection) return;
    setPending({ quote: selection.quote, context: quoteContext(source, selection.quote) });
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <>
      <PageHeader
        icon={<NodeTypeIcon type={node.type} size={16} />}
        eyebrow={
          <>
            <Link to="/content" className="hover:text-fg hover:underline">
              Content
            </Link>
            <span aria-hidden>/</span>
            <span>{humanize(node.type)}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">{node.uid}</span>
          </>
        }
        title={node.title || 'Untitled'}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1">
              <ActorLabel actor={node.created_by} /> <TimeAgo at={node.created_at} prefix="created " className="text-fg-subtle" />
            </span>
            {node.updated_at !== node.created_at && <TimeAgo at={node.updated_at} prefix="updated " className="text-fg-subtle" />}
            <Badge size="xs" variant="outline">
              {node.scope}
            </Badge>
            {node.head_revision !== null && (
              <span className="font-mono text-[12px] text-fg-subtle" title="Head revision">
                r{node.head_revision}
              </span>
            )}
            {tags.length > 0 && (
              <span className="flex flex-wrap gap-1">
                {tags.map((t) => (
                  <TagChip key={t} tag={t} />
                ))}
              </span>
            )}
          </span>
        }
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<GitFork size={14} />} onClick={() => setSearch({ panel: 'lineage' })}>
              Lineage
            </Button>
            <Button size="sm" variant="ghost" icon={<History size={14} />} onClick={() => setSearch({ panel: 'revisions' })}>
              Revisions
            </Button>
            {!readOnly && (
              <Button size="sm" icon={<Pencil size={14} />} onClick={openEditor} title="Open in editor (e)">
                {node.crdt ? 'Open in editor' : 'Edit'} <Kbd className="ml-1">e</Kbd>
              </Button>
            )}
          </>
        }
      />

      <PageBody wide>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-4">
            {requests.length > 0 && (
              <section aria-label="Open requests" className="flex flex-col gap-2">
                <h2 className="inline-flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wide text-warn-fg">
                  <MessageSquareReply size={13} aria-hidden /> {requests.length === 1 ? 'Input requested' : `${requests.length} requests for input`}
                </h2>
                {requests.map((r) => (
                  <NeedInputRequestCard key={r.request_id} nodeUid={node.uid} request={r} gatingSession={r.gate ? { session_id: r.gate.session_id, state: 'suspended-gate' } : null} />
                ))}
              </section>
            )}

            <article className="relative rounded-xl border border-line bg-surface px-6 py-5" ref={bodyRef}>
              {readOnly && <p className="mb-3 text-[12px] text-fg-subtle">Read-only: synced from a connector.</p>}
              {node.crdt && md.isPending ? (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-5 w-2/3" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                </div>
              ) : node.crdt && md.error ? (
                <ErrorState error={md.error} compact onRetry={() => md.refetch()} />
              ) : source ? (
                <Markdown source={source} />
              ) : node.body !== null && node.body !== undefined && typeof node.body === 'object' ? (
                <JsonView value={node.body} defaultExpandDepth={2} />
              ) : (
                <p className="text-[13px] italic text-fg-subtle">No body.</p>
              )}
              {selection && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={commentOnSelection}
                  className="absolute z-20 inline-flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-md bg-fg px-2 py-1 text-[12px] font-medium text-page shadow-pop"
                  style={{ left: selection.x, top: selection.y - 6 }}
                >
                  <MessageSquarePlus size={13} aria-hidden /> Comment
                </button>
              )}
            </article>

            {Object.keys(props).length > 0 && (
              <Panel title="Properties">
                <JsonView value={props} defaultExpandDepth={1} />
              </Panel>
            )}

            <LineagePanel uid={node.uid} />
          </div>

          <CommentsRail node={node} pending={pending} onClearPending={() => setPending(null)} className="lg:sticky lg:top-4 lg:self-start" />
        </div>
      </PageBody>

      <RevisionsDrawer uid={node.uid} head={node.head_revision} open={search.panel === 'revisions'} onClose={() => setSearch({ panel: undefined })} />
      {!node.crdt && <NodeEditDrawer node={node} open={editing} onClose={() => setEditing(false)} />}
    </>
  );
}
