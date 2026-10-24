/**
 * Designer chat panel ([10] §4): a `conversation` Session with the editor's designer Subagent,
 * started lazily on the first message. Every message carries the live working tree so the designer
 * reasons about unsaved edits; config changes come back as proposals rendered as proposal cards.
 *
 * The server holds the conversation: the panel resumes this tab's session, else a `?chat=` link's, else the
 * user's latest designer chat on this definition. Cards are placed from the transcript itself, so they survive
 * reloads, other tabs and ended conversations. An ended conversation stays readable; the next message starts a
 * new one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { useQueryClient } from '@tanstack/react-query';
import { Send, Wrench, Sparkles, RotateCcw, ExternalLink, AlertTriangle, CheckCircle2, Brain } from 'lucide-react';
import { convApi, proposalPath, useBreadboardSettings, type ConversationSnapshot, type ConversationTurn } from '../lib/configApi';
import { useWorkingTree } from '../model/workingTree';
import { Btn, Md, Spin, TextAreaInput, notify, errorMessage, useLiveEvents, useLiveConnected, payloadSessionId } from '../ui';
import { AppLink } from '../components/AppLink';
import { ProposalCard } from './ProposalCard';
import { blocksOf, conversationEnded, placeProposals, proposeOutcomes, resultText, toolNamesById, PROPOSE_TOOL, type ProposeOutcome } from './turns';

type DesignerKind = 'circuit' | 'tool' | 'subagent';

/** This tab's conversation for the definition; `reset_at` marks "Start a new conversation" so it is not re-found. */
interface Stored {
  session_id: string | null;
  reset_at?: string;
}

const storeKey = (uid: string) => `bb.designer.${uid}`;
function readStored(uid: string): Stored | null {
  try {
    const raw = sessionStorage.getItem(storeKey(uid));
    const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== 'object') return null;
    return { session_id: typeof v.session_id === 'string' ? v.session_id : null, ...(typeof v.reset_at === 'string' ? { reset_at: v.reset_at } : {}) };
  } catch {
    return null;
  }
}
function writeStored(uid: string, s: Stored | null) {
  try {
    if (s) sessionStorage.setItem(storeKey(uid), JSON.stringify(s));
    else sessionStorage.removeItem(storeKey(uid));
  } catch {
    /* storage unavailable */
  }
}

/** A `?chat=<session>` deep link (from a proposal's review page), read once and removed from the URL. */
function takeChatParam(): string | null {
  const u = new URL(window.location.href);
  const v = u.searchParams.get('chat');
  if (!v) return null;
  u.searchParams.delete('chat');
  window.history.replaceState(window.history.state, '', u);
  return v;
}

const userTurns = (turns: ConversationTurn[]) => turns.filter((t) => t.role === 'user').length;

export function DesignerChatPanel({ kind, placeholder }: { kind: DesignerKind; placeholder?: string }) {
  const wt = useWorkingTree();
  const qc = useQueryClient();
  const settings = useBreadboardSettings();
  const designerUid: string | undefined = settings.data?.designers?.[kind];

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [snap, setSnap] = useState<ConversationSnapshot | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  /** The message just sent, shown until the server records it. */
  const [pending, setPending] = useState<string | null>(null);
  /** The server is running a reply; the panel follows it until it finishes. */
  const [following, setFollowing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  /** User turns in the transcript when the pending message was sent. */
  const sentAt = useRef(0);
  /** The last send that failed, so resending it unchanged reuses its idempotency key. */
  const failed = useRef<{ body: string; key: string } | null>(null);
  const turns = useMemo(() => snap?.turns ?? [], [snap]);
  const ended = conversationEnded(snap?.state ?? null, snap?.reason ?? null);
  const busy = pending !== null || following;

  const adopt = useCallback(
    (sid: string | null) => {
      setSessionId(sid);
      writeStored(wt.uid, sid ? { session_id: sid } : { session_id: null, reset_at: new Date().toISOString() });
    },
    [wt.uid],
  );

  const apply = useCallback(
    (r: ConversationSnapshot) => {
      setSnap(r);
      if (userTurns(r.turns) > sentAt.current) setPending(null);
      if (!r.busy) {
        setFollowing(false);
        setPending(null);
        setLastError(r.last_error);
      }
    },
    [],
  );

  // A reply that just finished may have amended a proposal under the same id: refresh the cards and badges.
  const wasFollowing = useRef(false);
  useEffect(() => {
    if (wasFollowing.current && !following) {
      void qc.invalidateQueries({ queryKey: ['config', 'proposal'] });
      void qc.invalidateQueries({ queryKey: ['config', 'proposals'] });
    }
    wasFollowing.current = following;
  }, [following, qc]);

  // Find this definition's conversation: this tab's, a `?chat=` link's, else the user's latest one on it.
  useEffect(() => {
    let cancelled = false;
    setSessionId(null);
    setSnap(null);
    setPending(null);
    setFollowing(false);
    setLastError(null);
    setLoadingHistory(true);
    // Record a link's session before any await, so an effect that runs again (StrictMode) still finds it.
    const linked = takeChatParam();
    if (linked) writeStored(wt.uid, { session_id: linked });
    (async () => {
      const stored = readStored(wt.uid);
      let sid = stored?.session_id ?? null;
      if (!sid && !stored?.reset_at) sid = (await convApi.forDefinition(wt.uid, 1).catch(() => []))[0]?.session_id ?? null;
      if (!sid) return;
      const r = await convApi.get(sid).catch(() => null);
      if (cancelled) return;
      if (!r || (r.definition_uid && r.definition_uid !== wt.uid)) {
        if (sid === stored?.session_id) writeStored(wt.uid, null);
        return;
      }
      writeStored(wt.uid, { session_id: sid });
      setSessionId(sid);
      sentAt.current = userTurns(r.turns);
      apply(r);
      if (r.busy) setFollowing(true);
    })().finally(() => !cancelled && setLoadingHistory(false));
    return () => {
      cancelled = true;
    };
  }, [wt.uid, apply]);

  // Follow a running reply: refresh on the session's live events, with a slower poll in case the stream is down.
  const inflight = useRef(false);
  const again = useRef(false);
  const refresh = useCallback(() => {
    if (!sessionId) return;
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    convApi
      .get(sessionId)
      .then(apply, () => undefined)
      .finally(() => {
        inflight.current = false;
        if (again.current) {
          again.current = false;
          refresh();
        }
      });
  }, [sessionId, apply]);
  useLiveEvents(['session.event', 'session.state'], (e) => payloadSessionId(e) === sessionId && refresh(), following && !!sessionId);
  const live = useLiveConnected();
  useEffect(() => {
    if (!following) return;
    const t = setInterval(refresh, live ? 15_000 : 3_000);
    return () => clearInterval(t);
  }, [following, live, refresh]);

  const proposals = snap?.proposals;
  const outcomes = useMemo(() => proposeOutcomes(turns), [turns]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [turns.length, pending, following, proposals?.length]);

  const contextNow = useCallback(
    (extra: Record<string, unknown> = {}) => {
      const working_tree = Object.fromEntries(wt.changes().map((c) => [c.path, c.content]));
      return { definition_uid: wt.uid, ref: wt.state.base_commit ?? undefined, working_tree, ...extra };
    },
    [wt],
  );

  const send = useCallback(
    async (message: string, extra: Record<string, unknown> = {}) => {
      if (!designerUid || busy) return;
      setPending(message);
      setLastError(null);
      setText('');
      // An ended conversation takes no messages: this one starts a new conversation (which can still amend an open proposal).
      let sid = ended ? null : sessionId;
      sentAt.current = sid ? userTurns(turns) : 0;
      try {
        if (!sid) {
          const title = `Designer: ${wt.state.definition?.slug ?? wt.uid}`;
          const started = await convApi.start({ kind: 'conversation', subagent_uid: designerUid, context: contextNow(), title });
          if (!started.session_id) throw new Error('server did not return a session id');
          sid = started.session_id;
          adopt(sid);
          setSnap(null);
        }
        const context = contextNow(extra);
        const body = JSON.stringify([sid, message, context]);
        const key = failed.current?.body === body ? failed.current.key : crypto.randomUUID();
        failed.current = { body, key };
        await convApi.submit(sid, message, context, key);
        failed.current = null;
        setFollowing(true);
      } catch (e) {
        // The message may have reached the server even though its answer did not (a proxy timeout, a dropped
        // connection): follow the reply if one is running or already recorded, rather than inviting a duplicate.
        const r = sid ? await convApi.get(sid).catch(() => null) : null;
        if (r && (r.busy || userTurns(r.turns) > sentAt.current)) {
          failed.current = null;
          apply(r);
          if (r.busy) setFollowing(true);
          return;
        }
        notify(`Designer: ${errorMessage(e)}`, 'danger');
        setText((cur) => cur || message);
        setPending(null);
      }
    },
    [designerUid, busy, ended, sessionId, turns, wt, contextNow, adopt, apply],
  );

  const items = useMemo(() => {
    const out: Array<{ t: 'turn'; turn: ConversationTurn } | { t: 'proposal'; id: string; amended: boolean }> = [];
    // The session's own proposals, plus any older one this conversation amended (it belongs to the chat that opened it).
    const ids = [...new Set([...(proposals ?? []), ...outcomes.flatMap((o) => (o.proposal_id ? [o.proposal_id] : []))])];
    const at = placeProposals(turns, ids);
    const amended = new Set(outcomes.filter((o) => o.amended && o.proposal_id).map((o) => o.proposal_id!));
    const cards = (i: number) => [...at].filter(([, n]) => n === i).map(([id]) => ({ t: 'proposal' as const, id, amended: amended.has(id) }));
    turns.forEach((turn, i) => {
      out.push({ t: 'turn', turn });
      out.push(...cards(i + 1));
    });
    if (!turns.length) out.push(...cards(0));
    return out;
  }, [turns, proposals, outcomes]);

  const toolNames = useMemo(() => toolNamesById(turns), [turns]);
  const outcomeById = useMemo(() => new Map(outcomes.map((o) => [o.tool_use_id, o])), [outcomes]);

  const label = kind === 'circuit' ? 'Circuit designer' : kind === 'tool' ? 'Tool designer' : 'Subagent designer';
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="size-4 text-accent-text" />
          {label}
        </div>
        <div className="flex items-center gap-1">
          {sessionId && (
            <AppLink href={`/s/${sessionId}`} className="rounded p-1 text-fg-subtle hover:bg-hover" title="Open the conversation session">
              <ExternalLink className="size-3.5" />
            </AppLink>
          )}
          {sessionId && (
            <button
              type="button"
              className="rounded p-1 text-fg-subtle hover:bg-hover"
              title="Start a new conversation"
              onClick={() => {
                adopt(null);
                setSnap(null);
                setPending(null);
                setFollowing(false);
                setLastError(null);
              }}
            >
              <RotateCcw className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-auto px-3 py-3">
        {settings.isLoading || loadingHistory ? (
          <Spin />
        ) : !designerUid ? (
          <div className="rounded-md border border-warn/40 bg-warn-soft p-3 text-xs text-warn-fg">
            No designer subagent is configured for {kind}s. Set <span className="font-mono">designers.{kind}</span> in <span className="font-mono">breadboard.yaml</span>.
          </div>
        ) : items.length === 0 && !busy ? (
          <div className="text-xs text-fg-subtle">
            Describe what you want to change. The designer sees your unsaved edits and replies with proposals you can review, evaluate, and merge.
          </div>
        ) : null}
        {items.map((it, i) =>
          it.t === 'turn' ? (
            <TurnView key={it.turn.turn_id ?? i} turn={it.turn} toolNames={toolNames} outcomes={outcomeById} />
          ) : (
            <ProposalCard key={`p:${it.id}`} proposalId={it.id} amended={it.amended} busy={busy} onRevise={(msg, proposal_id) => void send(msg, { proposal_id })} />
          ),
        )}
        {pending !== null && <UserBubble text={pending} />}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-fg-subtle">
            <Spin /> Designer is working... (you can leave this page; the reply keeps running)
          </div>
        )}
        {!busy && lastError && (
          <div className="rounded-md border border-danger/40 bg-danger-soft p-2 text-xs text-danger-fg" role="alert">
            The designer's last reply failed: {lastError}
          </div>
        )}
        {!busy && ended && (
          <div className="rounded-md border border-warn/40 bg-warn-soft p-2 text-xs text-warn-fg">
            This conversation has {ended}. Its proposals above can still be reviewed and merged. Your next message starts a new conversation.
          </div>
        )}
      </div>

      <form
        className="border-t border-line p-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void send(text.trim());
        }}
      >
        <TextAreaInput
          rows={3}
          value={text}
          disabled={!designerUid}
          placeholder={placeholder ?? 'Ask the designer... (Cmd/Ctrl+Enter to send)'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
              e.preventDefault();
              void send(text.trim());
            }
          }}
          className="w-full resize-none text-sm"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[11px] text-fg-subtle">{wt.state.dirty.size ? `Sends ${wt.state.dirty.size} unsaved file(s) as context` : 'Sends the committed definition as context'}</span>
          <Btn type="submit" size="sm" variant="primary" icon={<Send className="size-3.5" />} disabled={!designerUid || !text.trim()} loading={busy}>
            {ended ? 'Send (new chat)' : 'Send'}
          </Btn>
        </div>
      </form>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[90%] rounded-lg bg-accent-soft px-3 py-2 text-sm whitespace-pre-wrap break-words">{text}</div>
    </div>
  );
}

function TurnView({ turn, toolNames, outcomes }: { turn: ConversationTurn; toolNames: Map<string, string>; outcomes: Map<string, ProposeOutcome> }) {
  const blocks = blocksOf(turn.content);
  if (turn.role === 'system' || !blocks.length) return null;
  if (turn.role === 'user') {
    const t = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
    return t ? <UserBubble text={t} /> : null;
  }
  return (
    <div className="space-y-1.5">
      {blocks.map((b, i) => {
        if (b.type === 'text') return <Md key={i} source={b.text} />;
        if (b.type === 'reasoning') {
          return (
            <details key={i} className="rounded-md border border-dashed border-line text-xs">
              <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1 text-fg-muted">
                <Brain className="size-3" /> Reasoning
              </summary>
              <div className="px-2 pb-2 text-fg-muted">
                <Md source={b.text} />
              </div>
            </details>
          );
        }
        if (b.type === 'tool_use') {
          return (
            <details key={i} className="rounded-md border border-line bg-sunken text-xs">
              <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1 text-fg-muted">
                <Wrench className="size-3" /> <span className="font-mono">{b.name}</span>
              </summary>
              <pre className="max-h-64 overflow-auto px-2 pb-2 font-mono text-[11px]">{JSON.stringify(b.input, null, 2)}</pre>
            </details>
          );
        }
        const o = toolNames.get(b.id) === PROPOSE_TOOL ? outcomes.get(b.id) : undefined;
        if (o) return <ProposeResult key={i} o={o} />;
        const body = resultText(b.content);
        return (
          <details key={i} className={clsx('rounded-md border text-xs', b.is_error ? 'border-danger/40 bg-danger-soft' : 'border-line bg-sunken')}>
            <summary className="cursor-pointer px-2 py-1 text-fg-muted">
              {b.is_error ? 'Tool error' : 'Tool result'} <span className="text-fg-subtle">({body.length} chars)</span>
            </summary>
            <pre className="max-h-64 overflow-auto px-2 pb-2 font-mono text-[11px] whitespace-pre-wrap">{body}</pre>
          </details>
        );
      })}
    </div>
  );
}

/** A `propose_config_change` result, in words: a failed call must never read as a proposal. */
function ProposeResult({ o }: { o: ProposeOutcome }) {
  if (o.error || !o.proposal_id)
    return (
      <div className="flex items-start gap-1.5 rounded-md border border-danger/40 bg-danger-soft px-2 py-1.5 text-xs text-danger-fg" role="alert">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          <span className="font-semibold">No proposal was {o.amended ? 'amended' : 'opened'}:</span> {o.error ?? 'the result carried no proposal id'}
        </span>
      </div>
    );
  return (
    <div className="flex items-center gap-1.5 text-xs text-fg-muted">
      <CheckCircle2 className="size-3.5 text-ok-fg" aria-hidden />
      {o.amended ? 'Amended' : 'Opened'} proposal
      <AppLink href={proposalPath(o.proposal_id)} className="font-mono">
        {o.proposal_id}
      </AppLink>
    </div>
  );
}
