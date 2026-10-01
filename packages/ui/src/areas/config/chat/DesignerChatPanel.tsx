/**
 * Designer chat panel ([10] §4): a `conversation` Session with the editor's designer Subagent,
 * started lazily on the first message. Every message carries the live working tree so the designer
 * reasons about unsaved edits; config changes come back as proposals rendered as proposal cards.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Send, Wrench, Sparkles, RotateCcw, ExternalLink } from 'lucide-react';
import { convApi, useBreadboardSettings, type ConversationTurn } from '../lib/configApi';
import { useWorkingTree } from '../model/workingTree';
import { Btn, Md, Spin, TextAreaInput, notify, errorMessage } from '../ui';
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

export function DesignerChatPanel({ kind, renderDiff, canRunEvals, placeholder }: { kind: DesignerKind; renderDiff: DiffRenderer; canRunEvals?: boolean; placeholder?: string }) {
  const wt = useWorkingTree();
  const settings = useBreadboardSettings();
  const designerUid: string | undefined = settings.data?.designers?.[kind];

  const [stored, setStored] = useState<Stored | null>(() => readStored(wt.uid));
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(!!stored);
  const [pending, setPending] = useState<string | null>(null);
  const [text, setText] = useState('');
  const scroller = useRef<HTMLDivElement>(null);

  const persist = useCallback(
    (s: Stored | null) => {
      setStored(s);
      writeStored(wt.uid, s);
    },
    [wt.uid],
  );

  // Rehydrate an existing designer session for this definition (per browser tab).
  useEffect(() => {
    const s = readStored(wt.uid);
    setStored(s);
    setTurns([]);
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
        if (r.state && r.state !== 'running') {
          writeStored(wt.uid, null);
          setStored(null);
          return;
        }
        setTurns(r.turns);
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
  }, [wt.uid]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [turns.length, pending, stored?.proposals.length]);

  const contextNow = useCallback(
    (extra: Record<string, unknown> = {}) => {
      const working_tree = Object.fromEntries(wt.changes().map((c) => [c.path, c.content]));
      return { definition_uid: wt.uid, ref: wt.state.base_commit ?? undefined, working_tree, ...extra };
    },
    [wt],
  );

  const send = useCallback(
    async (message: string, extra: Record<string, unknown> = {}) => {
      if (!designerUid || pending !== null) return;
      setPending(message);
      try {
        let s = stored;
        if (!s) {
          const title = `Designer: ${wt.state.definition?.slug ?? wt.uid}`;
          const started = await convApi.start({ kind: 'conversation', subagent_uid: designerUid, context: contextNow(), title });
          if (!started.session_id) throw new Error('server did not return a session id');
          s = { session_id: started.session_id, proposals: [] };
          persist(s);
        }
        const r = await convApi.post(s.session_id, message, contextNow(extra));
        const nextTurns = [...turns, ...r.turns];
        setTurns(nextTurns);
        if (r.proposals.length) {
          const known = new Set(s.proposals.map((p) => p.id));
          persist({ ...s, proposals: [...s.proposals, ...r.proposals.filter((id) => !known.has(id)).map((id) => ({ id, at: nextTurns.length }))] });
        }
        setText('');
      } catch (e) {
        notify(`Designer: ${errorMessage(e)}`, 'danger');
      } finally {
        setPending(null);
      }
    },
    [designerUid, pending, stored, turns, wt, contextNow, persist],
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
        ) : items.length === 0 && pending === null ? (
          <div className="text-xs text-fg-subtle">
            Describe what you want to change. The designer sees your unsaved edits and replies with proposals you can review, evaluate, and merge.
          </div>
        ) : null}
        {items.map((it, i) =>
          it.t === 'turn' ? (
            <TurnView key={it.turn.turn_id ?? i} turn={it.turn} />
          ) : (
            <ProposalCard key={`p:${it.id}`} proposalId={it.id} renderDiff={renderDiff} canRunEvals={canRunEvals} busy={pending !== null} onRevise={(msg, proposal_id) => void send(msg, { proposal_id })} />
          ),
        )}
        {pending !== null && (
          <>
            <UserBubble text={pending} />
            <div className="flex items-center gap-2 text-xs text-fg-subtle">
              <Spin /> Designer is working...
            </div>
          </>
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
          <Btn type="submit" size="sm" variant="primary" icon={<Send className="size-3.5" />} disabled={!designerUid || !text.trim()} loading={pending !== null}>
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
