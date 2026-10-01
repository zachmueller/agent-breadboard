/**
 * The shared live-collaboration editor ([10] §3, [07] §10). Composes the editor foundation in this
 * folder — nothing here re-implements CRDT mapping or decorations:
 *
 *   CollabSession (Hocuspocus over /api/v1/sync, wipeout protocol)
 *     └─ Y.Doc ── blocks ──► createBlockBinding ◄──► CodeMirror EditorView
 *              ├─ properties ──► PropertiesPanel
 *              └─ attribution ─► attributionExtension (AI-edit highlight, toggleable)
 *   awareness ─► presenceExtension (remote carets; local user from useCurrentUser)
 *   wikiLinkExtension + wikiCompletionSource ─► GET /nodes?type=knowledge, open → /n/<uid>
 *   wipeoutGuard ─► confirm ─► announceConfirmedWipeout + replayBlockedEdit
 *   comments (GET /nodes/:uid/comments) ─► bucketComments ─► commentHighlights + CommentsRail
 *   read-only compartment (connector notes, caller reason, read scope)
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { Eye, EyeOff, Highlighter, History as HistoryIcon, Link2, Lock, MessageSquare, MessageSquarePlus, PanelRightClose, PanelRightOpen, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import type { NodeDto } from '@breadboard/shared';
import { asPage, errorMessage, get, isApiError } from '../../../lib/api';
import { qk, useCreateComment, useNode, useNodeComments } from '../../../lib/queries';
import { useCurrentUser } from '../../../lib/auth';
import { toast } from '../../../lib/toast';
import { pluralize } from '../../../lib/format';
import { Badge, Button, Callout, ConfirmDialog, Dialog, ErrorState, IconButton, Loading, Markdown, Tabs, TabPanel, TextArea, Tooltip, cn } from '../../../components';
import {
  attributionExtension,
  attributionRefresh,
  commentHighlights,
  presenceColor,
  presenceExtension,
  readOnlyConfig,
  replayBlockedEdit,
  setAttributionVisible,
  setCommentHighlights,
  sharedEditorTheme,
  wikiCompletionSource,
  wikiLinkExtension,
  wipeoutGuard,
  type BlockedEdit,
  type LinkTarget,
  type NodeLookup,
} from './extensions';
import { createBlockBinding, type BlockBinding } from './yBlockBinding';
import { blocksToMarkdown, getAttribution, getBlocks } from './ydocSchema';
import { bucketComments, CommentsList, CommentsRail } from './comments';
import { PropertiesPanel } from './PropertiesPanel';
import { BacklinksPanel, useBacklinks } from './BacklinksPanel';
import { RevisionDiffDrawer, RevisionsPanel } from './RevisionsPanel';
import { AiEditsPopover } from './AiEditsPopover';
import { useCollabSession } from './useCollabSession';
import { attributedRanges, connectionMeta, newCommentAnchor, sameTops } from './sharedEditorModel';
import { backlinkSources, connectorInfo, readOnlyReason } from '../lib';
import type { CollabSnapshot } from './collab';

export type SideTab = 'properties' | 'backlinks' | 'comments' | 'revisions';

export interface SharedEditorProps {
  uid: string;
  /** Force read-only with a displayed reason (e.g. a Task that is no longer editable). */
  readOnly?: { reason: string } | null;
  /** Start with the live preview open. */
  showPreview?: boolean;
  /** Override where `[[…]]` links open (default: the content viewer `/n/<uid>`). */
  onOpenNode?: (uid: string) => void;
  /** Controlled side tab (optional; uncontrolled otherwise). */
  tab?: SideTab;
  onTabChange?: (tab: SideTab) => void;
  className?: string;
}

const ATTR_KEY = 'bb.editor.attribution';
const SIDE_KEY = 'bb.editor.side';

function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* private mode */
  }
}

function toTarget(n: Pick<NodeDto, 'uid' | 'title' | 'type' | 'body_text'>): LinkTarget {
  const text = (n.body_text ?? '').replace(/\s+/g, ' ').trim();
  return { uid: n.uid, title: n.title || null, type: n.type, snippet: text ? text.slice(0, 180) : null };
}

interface SelectionInfo {
  from: number;
  to: number;
  x: number;
  y: number;
}

interface CommentDraft {
  anchor: NonNullable<ReturnType<typeof newCommentAnchor>>;
}

export function SharedEditor({ uid, readOnly, showPreview = false, onOpenNode, tab: tabProp, onTabChange, className }: SharedEditorProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useCurrentUser();
  const node = useNode(uid);
  const { session, snapshot, rebuild } = useCollabSession(uid);

  // ------------------------------------------------------------- read-only ---
  const conn = connectorInfo(node.data?.tags);
  const roReason = readOnlyReason({ connector: conn.isConnector, explicit: readOnly?.reason, scope: snapshot.scope, authError: snapshot.authError });
  const ro = roReason !== null || node.isPending;

  // ------------------------------------------------------------- UI state ---
  const [preview, setPreview] = useState(showPreview);
  const [showAttr, setShowAttr] = useState(() => readPref(ATTR_KEY, true));
  const [sideOpen, setSideOpen] = useState(() => readPref(SIDE_KEY, true));
  const [tabState, setTabState] = useState<SideTab>('properties');
  const tab = tabProp ?? tabState;
  const setTab = (t: SideTab) => {
    setTabState(t);
    onTabChange?.(t);
    if (!sideOpen) toggleSide(true);
  };
  const toggleSide = (v: boolean) => {
    setSideOpen(v);
    writePref(SIDE_KEY, v);
  };
  const [diffPair, setDiffPair] = useState<[number, number] | null>(null);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [blocked, setBlocked] = useState<BlockedEdit | null>(null);
  const [docText, setDocText] = useState('');
  const [layoutTick, setLayoutTick] = useState(0);
  const [view, setView] = useState<EditorView | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const bindingRef = useRef<BlockBinding | null>(null);
  const roCompartment = useMemo(() => new Compartment(), []);

  // Latest values for callbacks captured once by CodeMirror extensions.
  const open = useCallback((target: string) => (onOpenNode ? onOpenNode(target) : navigate({ to: '/n/$uid', params: { uid: target } })), [onOpenNode, navigate]);
  const live = useRef({ ro, open });
  live.current = { ro, open };

  // [[…]] lookups: search-as-you-type over knowledge notes; hover cards share the node cache.
  const lookup = useMemo<NodeLookup>(
    () => ({
      search: async (q) => asPage<NodeDto>(await get('/nodes', { q: q.trim() || undefined, type: 'knowledge', limit: 12 })).items.filter((n) => n.uid !== uid).map(toTarget),
      get: async (target) => {
        try {
          const n = await qc.fetchQuery({ queryKey: qk.node(target), queryFn: () => get<NodeDto>(`/nodes/${target}`), staleTime: 60_000 });
          return toTarget(n);
        } catch (e) {
          if (isApiError(e) && (e.isNotFound || e.isForbidden)) return null;
          throw e;
        }
      },
    }),
    [qc, uid],
  );

  // ------------------------------------------------------ presence identity ---
  const userName = me.display_name || me.handle;
  useEffect(() => {
    try {
      session?.awareness?.setLocalStateField('user', { name: userName, color: presenceColor(me.handle || userName) });
    } catch {
      /* awareness not ready */
    }
  }, [session, userName, me.handle]);

  // ------------------------------------------------------------ the editor ---
  const synced = snapshot.synced;
  useEffect(() => {
    const host = hostRef.current;
    if (!session || !synced || !host) return;
    const doc = session.doc;
    const attribution = getAttribution(doc);
    let binding: BlockBinding | null = null;
    let textTimer: ReturnType<typeof setTimeout> | null = null;
    let layoutFrame = 0;
    let destroyed = false;

    const scheduleText = () => {
      if (textTimer) return;
      textTimer = setTimeout(() => {
        textTimer = null;
        if (!destroyed) setDocText(v.state.doc.toString());
      }, 150);
    };
    const scheduleLayout = () => {
      if (layoutFrame) return;
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = 0;
        if (!destroyed) setLayoutTick((t) => t + 1);
      });
    };
    const measureSelection = (ev: EditorView) => {
      ev.requestMeasure({
        key: 'bb-comment-selection',
        read: (mv): SelectionInfo | null => {
          const sel = mv.state.selection.main;
          const wrap = wrapRef.current;
          if (sel.empty || !wrap || mv.state.sliceDoc(sel.from, sel.to).trim().length < 2) return null;
          const start = mv.coordsAtPos(sel.from, 1);
          const end = mv.coordsAtPos(sel.to, -1);
          if (!start) return null;
          const box = wrap.getBoundingClientRect();
          const x = end && Math.abs(end.top - start.top) < 2 ? (start.left + end.left) / 2 : start.left + 24;
          return { from: sel.from, to: sel.to, x: x - box.left, y: start.top - box.top };
        },
        write: (m) => {
          if (!destroyed) setSelection(m);
        },
      });
    };

    const v = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: '',
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          EditorView.lineWrapping,
          sharedEditorTheme,
          placeholder('Start writing… type [[ to link a note.'),
          autocompletion({ override: [wikiCompletionSource(lookup)] }),
          wikiLinkExtension({ lookup, onOpen: (target) => live.current.open(target) }),
          session.awareness ? presenceExtension(session.awareness, () => binding) : [],
          attributionExtension(() => (binding ? attributedRanges(binding.blockRanges(), (id) => attribution.get(id)) : [])),
          wipeoutGuard({ onBlocked: (edit) => setBlocked(edit) }),
          commentHighlights((id) => {
            setActiveComment(id);
          }),
          roCompartment.of(readOnlyConfig(live.current.ro)),
          EditorView.contentAttributes.of({ 'aria-label': 'Note body (Markdown)', 'aria-multiline': 'true' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) scheduleText();
            if (u.docChanged || u.geometryChanged || u.heightChanged || u.viewportChanged) scheduleLayout();
            if (u.selectionSet || u.docChanged) measureSelection(u.view);
          }),
        ],
      }),
    });
    binding = createBlockBinding(getBlocks(doc), v);
    bindingRef.current = binding;
    setDocText(v.state.doc.toString());
    setView(v);

    // The server stamps attribution on every write: repaint the layer when it changes.
    const onAttribution = () =>
      setTimeout(() => {
        if (!destroyed) v.dispatch({ effects: attributionRefresh.of(null) });
      }, 0);
    attribution.observe(onAttribution);

    return () => {
      destroyed = true;
      if (textTimer) clearTimeout(textTimer);
      if (layoutFrame) cancelAnimationFrame(layoutFrame);
      attribution.unobserve(onAttribution);
      binding?.destroy();
      bindingRef.current = null;
      v.destroy();
      setView(null);
      setSelection(null);
    };
  }, [session, synced, lookup, roCompartment]);

  // Keep the compartments in sync with React state.
  useEffect(() => {
    view?.dispatch({ effects: roCompartment.reconfigure(readOnlyConfig(ro)) });
  }, [view, ro, roCompartment]);
  useEffect(() => {
    view?.dispatch({ effects: setAttributionVisible.of(showAttr) });
  }, [view, showAttr]);

  // Hide the floating Comment button when clicking anywhere outside the editor.
  useEffect(() => {
    if (!selection) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setSelection(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [selection]);

  // -------------------------------------------------------------- comments ---
  const comments = useNodeComments(uid);
  const buckets = useMemo(() => bucketComments(comments.data ?? [], docText), [comments.data, docText]);
  const commentCount = buckets.anchored.length + buckets.general.length + buckets.stale.length;
  useEffect(() => {
    view?.dispatch({ effects: setCommentHighlights.of(buckets.anchored.map((a) => ({ id: a.comment.uid, from: a.from, to: a.to, active: a.comment.uid === activeComment }))) });
  }, [view, buckets, activeComment]);

  const [tops, setTops] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!view || !rail) return;
    const base = view.documentTop - rail.getBoundingClientRect().top;
    const next: Record<string, number> = {};
    for (const a of buckets.anchored) next[a.comment.uid] = Math.max(0, base + view.lineBlockAt(a.from).top);
    setTops((cur) => (sameTops(cur, next) ? cur : next));
  }, [view, buckets, layoutTick, preview, sideOpen]);

  const selectComment = (id: string) => {
    setActiveComment(id);
    const hit = buckets.anchored.find((a) => a.comment.uid === id);
    if (hit && view) view.dispatch({ effects: EditorView.scrollIntoView(hit.from, { y: 'center' }) });
  };

  const create = useCreateComment(uid);
  const startComment = () => {
    if (!view || !selection) return;
    const anchor = newCommentAnchor(view.state.doc.toString(), selection.from, selection.to, node.data?.head_revision ?? null, bindingRef.current?.blockRanges() ?? []);
    setSelection(null);
    if (anchor) setDraft({ anchor });
  };

  // ------------------------------------------------------------ backlinks ---
  const backlinks = useBacklinks(uid);

  // --------------------------------------------------------------- preview ---
  const previewText = useMemo(() => (session && synced ? blocksToMarkdown(getBlocks(session.doc)) : ''), [session, synced, docText]);

  // ------------------------------------------------------------- render ---
  if (node.error) {
    const e = node.error;
    return (
      <ErrorState
        error={e}
        title={isApiError(e) && e.isNotFound ? 'Note not found' : isApiError(e) && e.isForbidden ? 'You don’t have access to this note' : 'Couldn’t load the note'}
        onRetry={() => node.refetch()}
        className="m-6"
      />
    );
  }

  const showRail = !preview && buckets.anchored.length > 0;
  const sideTabs = [
    { key: 'properties' as const, label: 'Properties', icon: <SlidersHorizontal size={13} /> },
    { key: 'backlinks' as const, label: 'Backlinks', icon: <Link2 size={13} />, count: backlinks.data ? backlinkSources(backlinks.data, uid).length || null : null },
    { key: 'comments' as const, label: 'Comments', icon: <MessageSquare size={13} />, count: commentCount || null },
    { key: 'revisions' as const, label: 'Revisions', icon: <HistoryIcon size={13} /> },
  ];

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col bg-page', className)}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-surface px-3 py-1.5" role="toolbar" aria-label="Editor">
        <ConnectionPill snapshot={snapshot} />
        {ro && roReason && (
          <Badge size="xs" tone="warn" icon={<Lock size={11} />}>
            Read-only
          </Badge>
        )}
        <div className="flex-1" />
        <Tooltip content={showAttr ? 'Hide AI-edit highlighting' : 'Highlight blocks last written by AI'}>
          <Button
            size="xs"
            variant={showAttr ? 'subtle' : 'ghost'}
            icon={<Highlighter size={14} />}
            aria-pressed={showAttr}
            onClick={() => {
              setShowAttr((v) => {
                writePref(ATTR_KEY, !v);
                return !v;
              });
            }}
          >
            Attribution
          </Button>
        </Tooltip>
        <AiEditsPopover uid={uid} readOnly={ro} onCompare={setDiffPair} />
        <Button size="xs" variant={preview ? 'subtle' : 'ghost'} icon={preview ? <EyeOff size={14} /> : <Eye size={14} />} aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
          Preview
        </Button>
        <Button size="xs" variant="ghost" icon={<HistoryIcon size={14} />} onClick={() => setTab('revisions')}>
          History
        </Button>
        <IconButton label={sideOpen ? 'Hide side panel' : 'Show side panel'} size="xs" onClick={() => toggleSide(!sideOpen)} aria-pressed={sideOpen}>
          {sideOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
        </IconButton>
      </div>

      {ro && roReason && (
        <div className="flex items-center gap-2 border-b border-line bg-warn-soft px-4 py-1.5 text-[12.5px] text-warn-fg" role="status">
          <Lock size={13} aria-hidden className="shrink-0" />
          <span>{roReason}</span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Document column */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" id={`bb-editor-scroll-${uid}`}>
          {!synced ? (
            <SyncGate snapshot={snapshot} onRetry={rebuild} />
          ) : null}
          <div className={cn('mx-auto flex w-full max-w-[1400px]', !synced && 'hidden', preview && 'grid grid-cols-1 lg:grid-cols-2')}>
            <div ref={wrapRef} className="relative min-w-0 flex-1 px-4">
              <div ref={hostRef} className="bb-shared-editor min-h-[50vh]" />
              {selection && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={startComment}
                  className="absolute z-20 inline-flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-md bg-fg px-2 py-1 text-[12px] font-medium text-page shadow-pop focus-visible:outline-2 focus-visible:outline-focus"
                  style={{ left: selection.x, top: selection.y - 6 }}
                >
                  <MessageSquarePlus size={13} aria-hidden /> Comment
                </button>
              )}
            </div>
            {preview ? (
              <div className="min-w-0 border-t border-line px-6 py-4 lg:border-t-0 lg:border-l" aria-label="Preview">
                <div className="mb-2 text-xs font-medium tracking-wide text-fg-muted uppercase">Preview</div>
                {previewText.trim() ? <Markdown source={previewText} /> : <p className="text-sm text-fg-subtle">Nothing to preview yet.</p>}
              </div>
            ) : (
              showRail && (
                <div className="hidden w-64 shrink-0 border-l border-line px-3 pt-3 xl:block">
                  <div ref={railRef}>
                    <CommentsRail items={buckets.anchored} tops={tops} activeId={activeComment} onSelect={selectComment} layoutKey={layoutTick} />
                  </div>
                </div>
              )
            )}
          </div>
        </div>

        {/* Side panel */}
        {sideOpen && (
          <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-surface" aria-label="Note details">
            <Tabs items={sideTabs} value={tab} onChange={setTab} size="sm" idBase={`bb-note-${uid}`} className="px-2" />
            <div className="min-h-0 flex-1 overflow-y-auto">
              <TabPanel idBase={`bb-note-${uid}`} tabKey={tab}>
                {tab === 'properties' &&
                  (session && synced ? <PropertiesPanel doc={session.doc} node={node.data} readOnly={ro} /> : <Loading label="Waiting for the live document…" className="py-10" />)}
                {tab === 'backlinks' && <BacklinksPanel uid={uid} />}
                {tab === 'comments' && (
                  <>
                    <CommentsList
                      buckets={buckets}
                      activeId={activeComment}
                      onSelect={selectComment}
                      loading={comments.isPending}
                      error={comments.error ? <ErrorState error={comments.error} onRetry={() => comments.refetch()} compact /> : undefined}
                    />
                    <GeneralComment uid={uid} />
                  </>
                )}
                {tab === 'revisions' && <RevisionsPanel uid={uid} head={node.data?.head_revision ?? null} readOnly={ro} onCompare={setDiffPair} />}
              </TabPanel>
            </div>
          </aside>
        )}
      </div>

      <RevisionDiffDrawer uid={uid} pair={diffPair} liveText={docText} readOnly={ro} onClose={() => setDiffPair(null)} />

      {/* New anchored comment */}
      <CommentComposer
        draft={draft}
        pending={create.isPending}
        onClose={() => setDraft(null)}
        onSubmit={async (body) => {
          if (!draft) return;
          try {
            const created = await create.mutateAsync({ body, anchor: draft.anchor });
            toast.success('Comment added');
            setDraft(null);
            setTab('comments');
            if (created && typeof created === 'object' && 'uid' in created) setActiveComment(created.uid);
          } catch (e) {
            toast.error('Couldn’t add the comment', e);
          }
        }}
      />

      {/* Client-side wipeout guard: the edit was held back until confirmed. */}
      <ConfirmDialog
        open={!!blocked}
        onClose={() => setBlocked(null)}
        title="Delete most of this note?"
        description={blocked ? `This edit removes ${blocked.deleted.toLocaleString()} of ${blocked.total.toLocaleString()} characters. Everyone editing sees the change immediately.` : undefined}
        confirmLabel="Delete content"
        variant="danger"
        onConfirm={() => {
          const edit = blocked;
          setBlocked(null);
          if (!edit || !view) return;
          session?.announceConfirmedWipeout();
          if (!replayBlockedEdit(view, edit)) toast.warning('Edit not applied', 'The note changed while you were deciding. Try again.');
        }}
      />

      {/* Server-side wipeout block (close 4409): reconnect with ?confirmWipeout=1, or discard local changes. */}
      <ConfirmDialog
        open={!!snapshot.wipeout}
        onClose={() => {
          session?.dismissWipeout();
          rebuild();
          toast.info('Large deletion discarded', 'Reloaded the note from the server.');
        }}
        title="The server held back a large deletion"
        description={
          snapshot.wipeout?.deleted != null && snapshot.wipeout.total != null
            ? `Your pending changes delete ${snapshot.wipeout.deleted.toLocaleString()} of ${snapshot.wipeout.total.toLocaleString()} characters.`
            : 'Your pending changes delete most of this note.'
        }
        confirmLabel="Apply deletion"
        cancelLabel="Discard my changes"
        variant="danger"
        onConfirm={() => session?.confirmServerWipeout()}
      >
        <p className="text-[13px] text-fg-muted">Discarding reloads the note from the server; any other unsynced edits in this tab are lost.</p>
      </ConfirmDialog>
    </div>
  );
}

function ConnectionPill({ snapshot }: { snapshot: CollabSnapshot }) {
  const m = connectionMeta(snapshot);
  const dot = { ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', neutral: 'bg-fg-subtle' }[m.tone];
  return (
    <Tooltip content={m.detail}>
      <span className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-fg-muted" role="status" aria-live="polite">
        <span className={cn('size-2 rounded-full', dot, m.label.endsWith('…') && 'animate-pulse')} aria-hidden />
        {m.label}
        {snapshot.unsynced > 0 && snapshot.status !== 'connected' && <span className="text-fg-subtle">· {pluralize(snapshot.unsynced, 'pending change')}</span>}
      </span>
    </Tooltip>
  );
}

function SyncGate({ snapshot, onRetry }: { snapshot: CollabSnapshot; onRetry: () => void }) {
  if (snapshot.authError) {
    return (
      <Callout
        tone="danger"
        title="The live session was refused"
        icon={<TriangleAlert size={15} />}
        className="m-6"
        action={
          <Button size="xs" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        {snapshot.authError === 'denied' ? 'You may not have access to this note, or your session expired.' : snapshot.authError}
      </Callout>
    );
  }
  return <Loading label={connectionMeta(snapshot).detail} className="py-24" />;
}

function CommentComposer({ draft, pending, onClose, onSubmit }: { draft: CommentDraft | null; pending: boolean; onClose: () => void; onSubmit: (body: string) => void }) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (draft) setText('');
  }, [draft]);
  const submit = () => text.trim() && onSubmit(text.trim());
  return (
    <Dialog
      open={!!draft}
      onClose={onClose}
      title="Comment on selection"
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" loading={pending} disabled={!text.trim()} onClick={submit}>
            Comment
          </Button>
        </div>
      }
    >
      {draft && (
        <div className="flex flex-col gap-3">
          <blockquote className="line-clamp-4 border-l-2 border-warn pl-2 text-[13px] text-fg-muted">{draft.anchor.quote}</blockquote>
          <TextArea
            label="Comment"
            autoFocus
            rows={4}
            value={text}
            placeholder="Markdown supported. ⌘/Ctrl+Enter to post."
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </div>
      )}
    </Dialog>
  );
}

/** A comment on the whole note (no anchor). */
function GeneralComment({ uid }: { uid: string }) {
  const create = useCreateComment(uid);
  const [text, setText] = useState('');
  const submit = async () => {
    const body = text.trim();
    if (!body) return;
    try {
      await create.mutateAsync({ body });
      setText('');
    } catch (e) {
      toast.error('Couldn’t add the comment', errorMessage(e));
    }
  };
  return (
    <div className="flex flex-col gap-2 border-t border-line p-3">
      <TextArea
        aria-label="Comment on the whole note"
        rows={2}
        value={text}
        placeholder="Comment on the whole note…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="flex justify-end">
        <Button size="xs" variant="secondary" loading={create.isPending} disabled={!text.trim()} onClick={() => void submit()}>
          Comment
        </Button>
      </div>
    </div>
  );
}
