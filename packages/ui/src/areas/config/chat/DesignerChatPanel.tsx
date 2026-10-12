/**
 * Designer chat panel ([10] §4): a `conversation` Session with the editor's designer Subagent,
 * started lazily on the first message. Every message carries the live working tree so the designer
 * reasons about unsaved edits; config changes come back as proposals rendered as proposal cards.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Send, Wrench, Sparkles, RotateCcw, ExternalLink } from 'lucide-react';
import { convApi, useBreadboardSettings, type ConversationSnapshot, type ConversationTurn } from '../lib/configApi';
import { useWorkingTree } from '../model/workingTree';
import { Btn, Md, Spin, TextAreaInput, notify, errorMessage, useLiveEvents, useLiveConnected, payloadSessionId } from '../ui';
import { AppLink } from '../components/AppLink';
import type { DiffRenderer } from '../components/snapshot';
import { ProposalCard } from './ProposalCard';
import { blocksOf, resultText } from './turns';

type DesignerKind = 'circuit' | 'tool' | 'subagent';

interface Stored {
  session_id: string;
  /** Proposal ids with the transcript length at which they appeared (cards render inline there). */
  proposals: Array<{ id: string; at: number }>;
}

const storeKey = (uid: string) => `bb.designer.${uid}`;
function readStored(uid: string): Stored | null {
  try {
    const raw = sessionStorage.getItem(storeKey(uid));
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v.session_id === 'string' ? { session_id: v.session_id, proposals: Array.isArray(v.proposals) ? v.proposals : [] } : null;
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

const userTurns = (turns: ConversationTurn[]) => turns.filter((t) => t.role === 'user').length;

export function DesignerChatPanel({ kind, renderDiff, canRunEvals, placeholder }: { kind: DesignerKind; renderDiff: DiffRenderer; canRunEvals?: boolean; placeholder?: string }) {
  const wt = useWorkingTree();
  const settings = useBreadboardSettings();
  const designerUid: string | undefined = settings.data?.designers?.[kind];

  const [stored, setStored] = useState<Stored | null>(() => readStored(wt.uid));
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(!!stored);
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
  const sessionId = stored?.session_id ?? null;
  const busy = pending !== null || following;

  const persist = useCallback(
    (s: Stored | null) => {
      setStored(s);
      writeStored(wt.uid, s);
    },
    [wt.uid],
  );

  /** Add proposals the session opened that the panel has not shown yet; their cards render at transcript length `at`. */
  const mergeProposals = useCallback(
    (ids: string[], at: number) => {
      setStored((cur) => {
        const known = new Set(cur?.proposals.map((p) => p.id));
        const fresh = ids.filter((id) => !known.has(id));
        if (!cur || !fresh.length) return cur;
        const next = { ...cur, proposals: [...cur.proposals, ...fresh.map((id) => ({ id, at }))] };
        writeStored(wt.uid, next);
        return next;
      });
    },
    [wt.uid],
  );

  const apply = useCallback(
    (r: ConversationSnapshot) => {
      setTurns(r.turns);
      mergeProposals(r.proposals, r.turns.length);
      if (userTurns(r.turns) > sentAt.current) setPending(null);
      if (!r.busy) {
        setFollowing(false);
        setPending(null);
        setLastError(r.last_error ?? (r.state && r.state !== 'running' ? `the conversation is ${r.state}` : null));
      }
    },
    [mergeProposals],
  );

  // Rehydrate an existing designer session for this definition (per browser tab), resuming a reply still running.
  useEffect(() => {
    const s = readStored(wt.uid);
    setStored(s);
    setTurns([]);
    setPending(null);
    setFollowing(false);
    setLastError(null);
    if (!s) {
      setLoadingHistory(false);
      return;
    }
    let cancelled = false;
    setLoadingHistory(true);
    convApi
      .get(s.session_id)
      .then((r) => {
        if (cancelled) return;
        if (r.state && r.state !== 'running' && !r.busy) {
          writeStored(wt.uid, null);
          setStored(null);
          return;
        }
        sentAt.current = userTurns(r.turns);
        apply(r);
        if (r.busy) setFollowing(true);
      })
      .catch(() => {
        if (cancelled) return;
        writeStored(wt.uid, null);
        setStored(null);
      })
      .finally(() => !cancelled && setLoadingHistory(false));
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

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [turns.length, pending, following, stored?.proposals.length]);

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
      sentAt.current = userTurns(turns);
      let s = stored;
      try {
        if (!s) {
          const title = `Designer: ${wt.state.definition?.slug ?? wt.uid}`;
          const started = await convApi.start({ kind: 'conversation', subagent_uid: designerUid, context: contextNow(), title });
          if (!started.session_id) throw new Error('server did not return a session id');
          s = { session_id: started.session_id, proposals: [] };
          persist(s);
        }
        const context = contextNow(extra);
        const body = JSON.stringify([s.session_id, message, context]);
        const key = failed.current?.body === body ? failed.current.key : crypto.randomUUID();
        failed.current = { body, key };
        await convApi.submit(s.session_id, message, context, key);
        failed.current = null;
        setFollowing(true);
      } catch (e) {
        // The message may have reached the server even though its answer did not (a proxy timeout, a dropped
        // connection): follow the reply if one is running or already recorded, rather than inviting a duplicate.
        const r = s ? await convApi.get(s.session_id).catch(() => null) : null;
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
    [designerUid, busy, stored, turns, wt, contextNow, persist, apply],
  );

  const items = useMemo(() => {
    const out: Array<{ t: 'turn'; turn: ConversationTurn } | { t: 'proposal'; id: string }> = [];
    const props = stored?.proposals ?? [];
    turns.forEach((turn, i) => {
      out.push({ t: 'turn', turn });
      for (const p of props) if (p.at === i + 1) out.push({ t: 'proposal', id: p.id });
    });
    for (const p of props) if (p.at > turns.length || p.at < 1) out.push({ t: 'proposal', id: p.id });
    return out;
  }, [turns, stored]);

  const label = kind === 'circuit' ? 'Circuit designer' : kind === 'tool' ? 'Tool designer' : 'Subagent designer';
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="size-4 text-accent-text" />
          {label}
        </div>
        <div className="flex items-center gap-1">
          {stored && (
            <AppLink href={`/s/${stored.session_id}`} className="rounded p-1 text-fg-subtle hover:bg-hover" title="Open the conversation session">
              <ExternalLink className="size-3.5" />
            </AppLink>
          )}
          {stored && (
            <button
              type="button"
              className="rounded p-1 text-fg-subtle hover:bg-hover"
              title="Start a new conversation"
              onClick={() => {
                persist(null);
                setTurns([]);
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
            <TurnView key={it.turn.turn_id ?? i} turn={it.turn} />
          ) : (
            <ProposalCard key={`p:${it.id}`} proposalId={it.id} renderDiff={renderDiff} canRunEvals={canRunEvals} busy={busy} onRevise={(msg, proposal_id) => void send(msg, { proposal_id })} />
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
            Send
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

function TurnView({ turn }: { turn: ConversationTurn }) {
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
