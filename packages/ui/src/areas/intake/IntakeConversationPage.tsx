/**
 * Intake idea-shaping conversation ([08] §4, §7.1): chat with the intake assistant on the left, the
 * Draft Task it is shaping on the right. Accepting the draft moves the Task into the queue.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, CheckCircle2, ChevronRight, CircleAlert, ListTodo, MessagesSquare, Pencil, ScrollText, SendHorizontal, Settings2, User, Wrench } from 'lucide-react';
import { TASK_PRIORITIES, TERMINAL_SESSION_STATES, type NodeDto, type SessionRecord, type SessionSummaryDto, type Turn } from '@breadboard/shared';
import { errorMessage, get, isApiError, patch, post } from '../../lib/api';
import { qk, useConfigTree, useSession } from '../../lib/queries';
import { useCurrentUser } from '../../lib/auth';
import { pushToast, toast } from '../../lib/toast';
import {
  Badge,
  Button,
  buttonClasses,
  Callout,
  cn,
  ConfigLink,
  CostInline,
  EmptyState,
  ErrorState,
  Input,
  JsonView,
  Kbd,
  Loading,
  Markdown,
  NodeChip,
  Select,
  SessionChip,
  StateBadge,
  StepStatusBadge,
  TaskStatusBadge,
  TextArea,
  TimeAgo,
} from '../../components';
import { intakeListKey } from './IntakeConversationsPage';
import { canAccept, canEditDraft, chatItems, conversationTitle, isEmptyDraft, normalizeDraft, shouldSend, type ChatBlock, type ChatItem, type DraftView } from './lib';

interface ConversationDto {
  session: SessionRecord;
  turns: Turn[];
  draft_task: unknown;
  /** The server is running the assistant's reply. */
  busy?: boolean;
  /** Why the last reply failed, if it did. */
  last_error?: string | null;
}

const userTurns = (turns: Turn[]) => turns.filter((t) => t.role === 'user').length;

/** Under the session's `turns` prefix so live `session.event` invalidation (useSession) refreshes it. */
const convKey = (id: string) => ['session', id, 'turns', 'conversation'] as const;

function useConversation(id: string) {
  return useQuery({
    queryKey: convKey(id),
    queryFn: ({ signal }) => get<ConversationDto>(`/conversations/${id}`, undefined, { signal }),
    // Live `session.event`s refresh it while a reply runs; poll slowly as well in case the stream is down.
    refetchInterval: (q) => (q.state.data?.busy ? 5_000 : false),
  });
}

export function IntakeConversationPage({ id }: { id: string }) {
  const conv = useConversation(id);
  const summary = useSession(id);
  const qc = useQueryClient();

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: convKey(id) });
    void qc.invalidateQueries({ queryKey: qk.session(id) });
    void qc.invalidateQueries({ queryKey: intakeListKey });
  };

  if (conv.isPending) return <Loading label="Loading conversation…" className="py-24" />;
  if (conv.error) {
    const e = conv.error;
    return (
      <ErrorState
        error={e}
        title={isApiError(e) && e.isNotFound ? 'Conversation not found' : isApiError(e) && e.code === 'invalid-state' ? 'Not an intake conversation' : 'Couldn’t load the conversation'}
        onRetry={() => conv.refetch()}
        className="m-6"
      />
    );
  }

  const session = summary.data ?? conv.data.session;
  const ended = TERMINAL_SESSION_STATES.includes(session.state);
  const draft = normalizeDraft(conv.data.draft_task);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
        <Link to="/intake" className={buttonClasses('ghost', 'xs')} aria-label="Back to intake conversations">
          <ArrowLeft size={14} aria-hidden />
        </Link>
        <MessagesSquare size={16} className="shrink-0 text-fg-subtle" aria-hidden />
        <h1 className="min-w-0 truncate text-[15px] font-semibold text-fg">{conversationTitle(session)}</h1>
        <StateBadge state={session.state} size="xs" />
        <div className="flex-1" />
        {summary.data && <CostInline usd={summary.data.cost_usd} tokensIn={summary.data.tokens_in} tokensOut={summary.data.tokens_out} includingChildren={summary.data.cost_usd_including_children} className="text-[12.5px] text-fg-muted" />}
        <Link to="/s/$id" params={{ id }} className={buttonClasses('ghost', 'xs')}>
          <ScrollText size={13} aria-hidden /> Session log
        </Link>
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <ChatPane
          id={id}
          turns={conv.data.turns}
          busy={conv.data.busy === true}
          lastError={conv.data.last_error ?? null}
          fetchedAt={conv.dataUpdatedAt}
          childSessions={summary.data?.children ?? []}
          ended={ended}
          onSent={refresh}
        />
        <aside className="flex min-h-0 shrink-0 flex-col border-t border-line bg-surface lg:w-[26rem] lg:border-t-0 lg:border-l" aria-label="Draft task">
          <DraftTaskPanel draft={draft} onChanged={refresh} />
        </aside>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- chat ---

function ChatPane({
  id,
  turns,
  busy,
  lastError,
  fetchedAt,
  childSessions,
  ended,
  onSent,
}: {
  id: string;
  turns: Turn[];
  busy: boolean;
  lastError: string | null;
  fetchedAt: number;
  childSessions: SessionSummaryDto['children'];
  ended: boolean;
  onSent: () => void;
}) {
  const me = useCurrentUser();
  const [text, setText] = useState('');
  /** The message just sent, shown until the server records it (`base`: user turns when it was sent). */
  const [pending, setPending] = useState<{ text: string; base: number; acceptedAt: number | null } | null>(null);
  const pendingText = pending?.text ?? null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const items = useMemo(() => chatItems(turns), [turns]);

  // The server accepts the message at once and replies in the background (`Prefer: respond-async`): a reply that
  // uses tools can outlast a proxy's request timeout. The transcript follows through live events and `busy`.
  const send = useMutation({
    mutationFn: async (message: string) => {
      try {
        await post(`/conversations/${id}/messages`, { text: message }, { idempotencyKey: true, headers: { Prefer: 'respond-async' } });
      } catch (e) {
        // The message may have arrived even though the answer did not: if so, follow the reply instead of failing.
        const now = await get<ConversationDto>(`/conversations/${id}`).catch(() => null);
        if (!now || !(now.busy || userTurns(now.turns) > userTurns(turns))) throw e;
      }
    },
    onMutate: (message) => {
      setPending({ text: message, base: userTurns(turns), acceptedAt: null });
      setText('');
    },
    onSuccess: () => setPending((p) => p && { ...p, acceptedAt: Date.now() }),
    onError: (e, message) => {
      setPending(null);
      setText((cur) => cur || message);
      toast.error('Message not sent', e);
    },
    onSettled: () => {
      onSent();
      requestAnimationFrame(() => inputRef.current?.focus());
    },
  });

  // Drop the optimistic bubble once the server has the message, or has gone idle without it (the reply failed).
  useEffect(() => {
    if (!pending) return;
    if (userTurns(turns) > pending.base || (pending.acceptedAt !== null && !busy && fetchedAt > pending.acceptedAt)) setPending(null);
  }, [pending, turns, busy, fetchedAt]);
  const thinking = pendingText !== null || busy;

  // Keep the newest message in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, pendingText, thinking, childSessions.length]);

  const submit = () => {
    const m = text.trim();
    if (!m || thinking || ended) return;
    send.mutate(m);
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-page" aria-label="Conversation">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3" role="log" aria-live="polite" aria-relevant="additions">
          {items.length === 0 && !pendingText && (
            <EmptyState
              icon={<MessagesSquare size={20} />}
              title="Describe your idea"
              description="What do you want done, and why? The assistant asks follow-up questions and drafts a Task you can review on the right."
              className="py-16"
            />
          )}
          {items.map((it) => (
            <ChatBubble key={it.id} item={it} me={me.handle} />
          ))}
          {pendingText && (
            <ChatBubble item={{ id: 'pending', kind: 'user', username: me.handle, text: pendingText, extras: [], created_at: new Date().toISOString(), model_id: null }} me={me.handle} pending />
          )}
          {thinking && (
            <div className="flex items-center gap-2 pl-9 text-[13px] text-fg-muted" role="status">
              <span className="flex gap-1" aria-hidden>
                <span className="size-1.5 animate-pulse rounded-full bg-fg-subtle" />
                <span className="size-1.5 animate-pulse rounded-full bg-fg-subtle [animation-delay:150ms]" />
                <span className="size-1.5 animate-pulse rounded-full bg-fg-subtle [animation-delay:300ms]" />
              </span>
              Assistant is thinking…
            </div>
          )}
          {!thinking && lastError && (
            <Callout tone="danger" title="The assistant’s last reply failed">
              {lastError}
            </Callout>
          )}
          {childSessions.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              <div className="text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">Sub-sessions</div>
              {childSessions.map((c) => (
                <ChildSessionCard key={c.session_id} child={c} />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="border-t border-line bg-surface px-4 py-3">
        <div className="mx-auto max-w-3xl">
          {ended ? (
            <p className="text-[13px] text-fg-muted">This conversation has ended. Start a new one from the Intake list.</p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
              className="flex items-end gap-2"
            >
              <TextArea
                ref={inputRef}
                aria-label="Message"
                wrapperClassName="flex-1"
                rows={2}
                autoFocus
                value={text}
                placeholder="Message the intake assistant…"
                disabled={thinking}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (shouldSend({ key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing })) {
                    e.preventDefault();
                    submit();
                  }
                }}
                className="max-h-48 min-h-[2.75rem] resize-y"
              />
              <Button type="submit" icon={<SendHorizontal size={14} />} loading={thinking} disabled={!text.trim()}>
                Send
              </Button>
            </form>
          )}
          {!ended && (
            <p className="mt-1.5 text-[11.5px] text-fg-subtle">
              <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> for a new line
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function ChatBubble({ item, me, pending }: { item: ChatItem; me: string; pending?: boolean }) {
  if (item.kind === 'tool' || item.kind === 'system') return <CollapsedTurn item={item} />;
  const isUser = item.kind === 'user';
  const mine = isUser && item.username === me;
  return (
    <article className={cn('flex gap-2.5', pending && 'opacity-70')} aria-label={isUser ? `Message from ${item.username ?? 'user'}` : 'Assistant message'}>
      <div className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full', isUser ? 'bg-raised text-fg-muted' : 'bg-accent-soft text-accent-text')} aria-hidden>
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-baseline gap-2 text-[12px]">
          <span className="font-medium text-fg">{isUser ? (mine ? 'You' : (item.username ?? 'User')) : 'Intake assistant'}</span>
          {isUser && item.username && mine && <span className="text-fg-subtle">@{item.username}</span>}
          {!pending && <TimeAgo at={item.created_at} className="text-fg-subtle" />}
        </div>
        {item.text ? (
          isUser ? (
            <p className="text-[14px] whitespace-pre-wrap text-fg">{item.text}</p>
          ) : (
            <Markdown source={item.text} size="sm" />
          )
        ) : null}
        {item.extras.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {item.extras.map((b, i) => (
              <ExtraBlock key={i} block={b} />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function blockLabel(b: ChatBlock): string {
  if (b.kind === 'tool_use') return b.name;
  if (b.kind === 'tool_result') return b.is_error ? 'Tool error' : 'Tool result';
  if (b.kind === 'text') return 'Text';
  return 'Content';
}

function ExtraBlock({ block }: { block: ChatBlock }) {
  const [open, setOpen] = useState(false);
  const value = block.kind === 'tool_use' ? block.input : block.kind === 'tool_result' ? block.content : block.kind === 'other' ? block.value : block.text;
  return (
    <div className="rounded-md border border-line bg-sunken">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] hover:bg-hover">
        <ChevronRight size={13} className={cn('shrink-0 text-fg-subtle transition-transform', open && 'rotate-90')} aria-hidden />
        <Wrench size={13} className="shrink-0 text-fg-subtle" aria-hidden />
        <span className="font-mono font-medium">{blockLabel(block)}</span>
        {block.kind === 'tool_result' && block.is_error && (
          <Badge size="xs" tone="danger">
            error
          </Badge>
        )}
        {!open && <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-subtle">{typeof value === 'string' ? value : JSON.stringify(value ?? null)}</span>}
      </button>
      {open && (
        <div className="border-t border-line p-2">
          <JsonView value={parseMaybeJson(value)} defaultExpandDepth={2} maxHeight="320px" />
        </div>
      )}
    </div>
  );
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function CollapsedTurn({ item }: { item: ChatItem }) {
  const [open, setOpen] = useState(false);
  const Icon = item.kind === 'system' ? Settings2 : Wrench;
  const label = item.kind === 'system' ? 'System context' : `${item.extras.length || 1} tool result${item.extras.length === 1 ? '' : 's'}`;
  return (
    <div className="ml-9">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-[12px] text-fg-subtle hover:bg-hover hover:text-fg-muted">
        <ChevronRight size={12} className={cn('transition-transform', open && 'rotate-90')} aria-hidden />
        <Icon size={12} aria-hidden /> {label}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1.5">
          {item.text && <pre className="max-h-64 overflow-auto rounded-md border border-line bg-sunken p-2 font-mono text-[12px] whitespace-pre-wrap text-fg-muted">{item.text}</pre>}
          {item.extras.map((b, i) => (
            <div key={i} className="rounded-md border border-line bg-sunken p-2">
              <JsonView value={parseMaybeJson(b.kind === 'tool_result' ? b.content : b.kind === 'tool_use' ? b.input : b.kind === 'other' ? b.value : b.text)} defaultExpandDepth={1} maxHeight="320px" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChildSessionCard({ child }: { child: SessionSummaryDto['children'][number] }) {
  const [open, setOpen] = useState(false);
  const detail = useSession(open ? child.session_id : null, { live: open });
  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" aria-expanded={open} aria-label={open ? 'Collapse sub-session' : 'Expand sub-session'} onClick={() => setOpen((o) => !o)} className="rounded p-0.5 text-fg-subtle hover:bg-hover">
          <ChevronRight size={14} className={cn('transition-transform', open && 'rotate-90')} aria-hidden />
        </button>
        <SessionChip id={child.session_id} state={child.state} kind={child.kind} />
        <Badge size="xs">{child.kind}</Badge>
        {child.circuit_uid && <ConfigLink uid={child.circuit_uid} kind="circuit" className="min-w-0 truncate text-[12.5px]" />}
        <div className="flex-1" />
        <StateBadge state={child.state} size="xs" />
      </div>
      {open && (
        <div className="border-t border-line px-3 py-2 text-[12.5px]">
          {detail.isPending ? (
            <Loading label="Loading…" className="py-3" />
          ) : detail.error ? (
            <ErrorState error={detail.error} onRetry={() => detail.refetch()} compact />
          ) : detail.data ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-fg-muted">
                <span>
                  Started <TimeAgo at={detail.data.started_at ?? detail.data.created_at} />
                </span>
                <CostInline usd={detail.data.cost_usd} tokensIn={detail.data.tokens_in} tokensOut={detail.data.tokens_out} includingChildren={detail.data.cost_usd_including_children} />
                <span>{detail.data.steps.length} step{detail.data.steps.length === 1 ? '' : 's'}</span>
              </div>
              {detail.data.steps.length > 0 && (
                <ol className="flex flex-col gap-0.5">
                  {detail.data.steps.slice(-6).map((s) => (
                    <li key={`${s.step_id}-${s.attempt ?? 0}`} className="flex items-center gap-2">
                      <span className="font-mono text-[12px] text-fg">{s.step_id}</span>
                      <StepStatusBadge status={s.status} size="xs" />
                    </li>
                  ))}
                </ol>
              )}
              <Link to="/s/$id" params={{ id: child.session_id }} className="self-start text-[12.5px] text-accent-text hover:underline">
                Open session →
              </Link>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- draft task ---

function DraftTaskPanel({ draft, onChanged }: { draft: DraftView | null; onChanged: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const tree = useConfigTree();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState('');
  const [title, setTitle] = useState('');
  const uid = draft?.taskUid ?? null;
  const editable = canEditDraft(draft);

  useEffect(() => {
    if (!editing) setBody(draft?.body ?? '');
  }, [draft?.body, editing]);
  useEffect(() => setTitle(draft?.title ?? ''), [draft?.title]);

  const circuits = useMemo(
    () =>
      (tree.data ?? [])
        .filter((e) => e.kind === 'circuit' && e.uid)
        .map((e) => ({ value: e.uid!, label: e.slug ?? e.title ?? e.uid! }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [tree.data],
  );

  const save = useMutation({
    mutationFn: (p: Record<string, unknown>) => patch<NodeDto>(`/nodes/${uid}`, p),
    onSuccess: (n) => {
      qc.setQueryData(qk.node(n.uid), n);
      onChanged();
    },
    onError: (e) => toast.error('Couldn’t update the draft', e),
  });

  const accept = useMutation({
    mutationFn: () => post<NodeDto>(`/tasks/${uid}/accept`, undefined, { idempotencyKey: true }),
    onSuccess: () => {
      onChanged();
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      if (uid) void qc.invalidateQueries({ queryKey: qk.node(uid) });
      pushToast({ kind: 'success', title: 'Task accepted into the queue', description: draft?.title ?? undefined, action: { label: 'View queue', onClick: () => navigate({ to: '/tasks' }) } });
    },
    onError: (e) => toast.error('Couldn’t accept the task', errorMessage(e)),
  });

  if (isEmptyDraft(draft)) {
    return (
      <div className="flex-1 overflow-y-auto">
        <PanelTitle />
        {draft?.missing && <MissingCallout />}
        <EmptyState compact icon={<ListTodo size={20} />} title="No draft yet" description="As the conversation clarifies the idea, the assistant drafts a Task here: title, pitch, priority and target circuit." className="py-12" />
      </div>
    );
  }
  const d = draft!;
  const otherTasks = d.createdTasks.filter((t) => t !== uid);

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PanelTitle status={d.status} uid={uid} />
        <div className="flex flex-col gap-4 px-4 pb-4">
          {d.missing && <MissingCallout />}
          {!uid && !d.missing && (
            <Callout tone="info" icon={<CircleAlert size={14} />}>
              Still a sketch: the assistant hasn’t created the Task yet. Ask it to create the task when the idea is ready.
            </Callout>
          )}
          {uid && d.status && d.status !== 'draft' && (
            <Callout tone="ok" icon={<CheckCircle2 size={14} />} title="Accepted">
              This Task is <strong>{d.status}</strong>.{' '}
              <Link to="/n/$uid" params={{ uid }} className="text-accent-text hover:underline">
                Open the task
              </Link>{' '}
              or{' '}
              <Link to="/tasks" className="text-accent-text hover:underline">
                view the queue
              </Link>
              .
            </Callout>
          )}

          {editable ? (
            <Input
              label="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title.trim() && title.trim() !== d.title && save.mutate({ title: title.trim() })}
              onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
            />
          ) : (
            <div>
              <div className="mb-1 text-[12px] font-medium text-fg-muted">Title</div>
              <div className="text-[15px] font-semibold text-fg">{d.title ?? <span className="text-fg-subtle italic">Untitled</span>}</div>
            </div>
          )}

          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[12px] font-medium text-fg-muted">Pitch</span>
              <div className="flex-1" />
              {editable && !editing && (
                <Button size="xs" variant="ghost" icon={<Pencil size={12} />} onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
            </div>
            {editing ? (
              <div className="flex flex-col gap-2">
                <TextArea aria-label="Pitch (Markdown)" mono rows={10} value={body} autoFocus onChange={(e) => setBody(e.target.value)} />
                <div className="flex justify-end gap-2">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setBody(d.body);
                      setEditing(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="xs"
                    loading={save.isPending}
                    disabled={body === d.body}
                    onClick={() => save.mutate({ body }, { onSuccess: () => setEditing(false) })}
                  >
                    Save pitch
                  </Button>
                </div>
              </div>
            ) : d.body.trim() ? (
              <div className="rounded-md border border-line bg-page px-3 py-2">
                <Markdown source={d.body} size="sm" />
              </div>
            ) : (
              <p className="text-[13px] text-fg-subtle italic">No pitch yet.</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Priority"
              size="sm"
              value={d.priority ?? ''}
              disabled={!editable || save.isPending}
              placeholder="—"
              options={TASK_PRIORITIES.map((p) => ({ value: p, label: p.toUpperCase() }))}
              onChange={(e) => e.target.value && save.mutate({ properties: { priority: e.target.value } })}
            />
            <Select
              label="Target circuit"
              size="sm"
              value={d.targetCircuit ?? ''}
              disabled={!editable || save.isPending}
              placeholder="Triage decides"
              options={circuits}
              onChange={(e) => save.mutate({ properties: { target_circuit: e.target.value || null } })}
            />
          </div>
          {!editable && d.targetCircuit && (
            <div className="-mt-2 text-[12.5px]">
              <ConfigLink uid={d.targetCircuit} kind="circuit" />
            </div>
          )}

          <div>
            <div className="mb-1 text-[12px] font-medium text-fg-muted">References</div>
            {d.references.length ? (
              <div className="flex flex-wrap gap-1.5">
                {d.references.map((r) => (
                  <NodeChip key={r} uid={r} />
                ))}
              </div>
            ) : (
              <p className="text-[12.5px] text-fg-subtle">None. Mention notes or artifacts with [[…]] in the chat to attach them.</p>
            )}
          </div>

          {otherTasks.length > 0 && (
            <div>
              <div className="mb-1 text-[12px] font-medium text-fg-muted">Other tasks from this conversation</div>
              <div className="flex flex-wrap gap-1.5">
                {otherTasks.map((t) => (
                  <NodeChip key={t} uid={t} type="task" />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="border-t border-line px-4 py-3">
        <Button className="w-full" icon={<CheckCircle2 size={14} />} disabled={!canAccept(d)} loading={accept.isPending} onClick={() => accept.mutate()}>
          Accept into queue
        </Button>
        {!canAccept(d) && <p className="mt-1.5 text-center text-[11.5px] text-fg-subtle">{!uid ? 'Available once the assistant creates the Task.' : 'Already accepted.'}</p>}
      </div>
    </>
  );
}

function PanelTitle({ status, uid }: { status?: string | null; uid?: string | null }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-3 pb-2">
      <ListTodo size={14} className="text-fg-subtle" aria-hidden />
      <h2 className="text-[13px] font-semibold text-fg">Draft task</h2>
      {status && <TaskStatusBadge status={status} size="xs" />}
      <div className="flex-1" />
      {uid && <NodeChip uid={uid} type="task" menu={false} maxWidth="max-w-[9rem]" />}
    </div>
  );
}

function MissingCallout() {
  return (
    <Callout tone="warn" icon={<CircleAlert size={14} />} className="mx-4">
      The Task drafted in this conversation was deleted. Ask the assistant to create it again.
    </Callout>
  );
}
