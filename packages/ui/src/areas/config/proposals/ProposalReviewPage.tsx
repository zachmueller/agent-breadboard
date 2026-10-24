/**
 * Proposal review (`/proposals/:id`, [10] §4 propose-review-commit): the change in each definition's native diff,
 * tool checks and validation, merge / discard / run evals, and revision requests that go back to the designer chat
 * that opened it. Every designer proposal card links here, so a review never depends on the chat panel's state.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProposalDto } from '@breadboard/shared';
import { ArrowLeft, GitMerge, GitPullRequest, MessageSquare, Send, Trash2 } from 'lucide-react';
import { configApi, convApi, qk, proposalDefinitions, type ConversationSnapshot } from '../lib/configApi';
import { useSessions } from '../../../lib/queries';
import { SessionChip } from '../../../components';
import { Btn, Confirm, ErrorBox, Md, Spin, TabBar, TextAreaInput, errorMessage, notify, useLiveEvents, payloadSessionId } from '../ui';
import { AppLink } from '../components/AppLink';
import { RawPatch } from '../components/Diff';
import { ValidationList } from '../components/fields';
import { fmtDate, fmtRelative, hrefFor, shortCommit } from '../lib/format';
import { blocksOf, conversationEnded } from '../chat/turns';
import { BranchEvalLauncher, EvalRunSummary, ProposalAuthor, ProposalChanges, ProposalPills, ToolChecks, isLiveProposal, useDefinitionLabels } from './ProposalParts';

const NO_PROPOSAL = { changes: [] } as unknown as ProposalDto;

export function ProposalReviewPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.proposal(id), queryFn: () => configApi.proposal(id), staleTime: 5_000 });
  const [view, setView] = useState<'changes' | 'raw'>('changes');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [runIds, setRunIds] = useState<string[]>([]);
  const p = q.data;
  const defs = useDefinitionLabels(p ?? NO_PROPOSAL);

  const settled = () => void qc.invalidateQueries({ queryKey: ['config'] });
  const merge = useMutation({
    mutationFn: () => configApi.merge(id),
    onSuccess: () => {
      notify('Proposal merged to main', 'ok');
      settled();
    },
    onError: (e) => notify(`Merge failed: ${errorMessage(e)}`, 'danger'),
  });
  const discard = useMutation({
    mutationFn: () => configApi.discard(id),
    onSuccess: () => {
      setConfirmDiscard(false);
      notify('Proposal discarded', 'info');
      settled();
    },
    onError: (e) => notify(errorMessage(e), 'danger'),
  });
  const submit = useMutation({
    mutationFn: () => configApi.submit(id),
    onSuccess: () => {
      notify('Submitted for review', 'ok');
      settled();
    },
    onError: (e) => notify(errorMessage(e), 'danger'),
  });
  // Circuit runs on the branch (`run_circuit {proposal_id}`), alongside its eval runs.
  const branchRuns = useSessions({ proposal: id, kind: 'circuit-run' }, { offset: 0, size: 25 }, { enabled: !!p, live: false });

  if (q.isLoading)
    return (
      <div className="flex h-full items-center justify-center">
        <Spin />
      </div>
    );
  if (q.error || !p) return <ErrorBox error={q.error ?? new Error('proposal not found')} title={`Proposal ${id}`} onRetry={() => void q.refetch()} />;

  const open = p.status === 'open';
  const draft = p.status === 'draft';
  const live = isLiveProposal(p);
  const runs = [...new Set([...(p.eval_runs ?? []), ...runIds])];
  const primary = defs.find((d) => d.exists) ?? null;

  return (
    <div className="h-full overflow-y-auto bg-page">
      <div className="border-b border-line bg-surface px-5 py-3">
        <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
          <AppLink href="/proposals" className="text-fg-subtle hover:text-fg">
            Proposals
          </AppLink>
          <span aria-hidden>/</span>
          <span className="font-mono">{p.proposal_id}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-start gap-3">
          <GitPullRequest className="mt-1 size-5 shrink-0 text-accent-text" aria-hidden />
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold break-words">{p.message || 'Proposed change'}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
              <ProposalPills p={p} />
              <span className="flex items-center gap-1">
                by <ProposalAuthor actor={p.created_by} />
              </span>
              <span title={fmtDate(p.created_at)}>{fmtRelative(p.created_at)}</span>
              <span>
                base <span className="font-mono">{shortCommit(p.base_commit)}</span>
              </span>
              {p.session_id && (
                <AppLink href={`/s/${p.session_id}`} className="flex items-center gap-1">
                  <MessageSquare className="size-3.5" aria-hidden /> conversation
                </AppLink>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {primary && (
              <AppLink href={hrefFor(primary.kind, primary.uid)} className="mr-1 flex items-center gap-1 text-xs">
                <ArrowLeft className="size-3.5" aria-hidden /> {primary.label}
              </AppLink>
            )}
            <BranchEvalLauncher p={p} onStarted={(r) => setRunIds((ids) => [...new Set([...ids, r])])} />
            {live && (
              <Btn size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDiscard(true)}>
                Discard
              </Btn>
            )}
            {draft && (
              <Btn size="sm" variant="primary" icon={<Send className="size-3.5" />} loading={submit.isPending} onClick={() => submit.mutate()}>
                Submit for review
              </Btn>
            )}
            {open && (
              <Btn size="sm" variant="primary" icon={<GitMerge className="size-3.5" />} loading={merge.isPending} disabled={!p.validation?.ok} onClick={() => merge.mutate()}>
                Merge
              </Btn>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl space-y-4 p-5">
        {p.status === 'merged' && (
          <div className="rounded-md border border-ok/40 bg-ok-soft px-3 py-2 text-sm text-ok-fg">
            Merged to main{p.merged_commit ? <> as <span className="font-mono">{shortCommit(p.merged_commit)}</span></> : null}.
          </div>
        )}
        {p.status === 'discarded' && <div className="rounded-md border border-line bg-sunken px-3 py-2 text-sm text-fg-muted">Discarded. Nothing from this proposal reached main.</div>}
        {draft && (
          <div className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn-fg">
            Draft: not in the review queue yet. Its branch runs and evaluates like any proposal; run its evals, then submit it for review once it behaves as intended.
          </div>
        )}
        {live && !p.validation?.ok && (
          <section className="rounded-md border border-danger/40 bg-danger-soft p-3">
            <h3 className="mb-1 text-sm font-semibold text-danger-fg">Fails validation, so it cannot be merged yet</h3>
            <ValidationList errors={p.validation?.errors ?? []} warnings={p.validation?.warnings ?? []} />
          </section>
        )}
        <ToolChecks p={p} />
        {runs.length > 0 && (
          <section className="space-y-1 rounded-md border border-line bg-surface p-3">
            <h3 className="mb-1 text-sm font-semibold">Eval runs on this branch</h3>
            {runs.map((r) => (
              <EvalRunSummary key={r} id={r} baseline />
            ))}
          </section>
        )}
        {branchRuns.items.length > 0 && (
          <section className="rounded-md border border-line bg-surface p-3">
            <h3 className="mb-1.5 text-sm font-semibold">Circuit runs on this branch</h3>
            <div className="flex flex-wrap gap-1.5">
              {branchRuns.items.map((s) => (
                <SessionChip key={s.session_id} id={s.session_id} state={s.state} kind={s.kind} />
              ))}
            </div>
          </section>
        )}
        {live && <RevisionRequest p={p} />}

        <TabBar
          value={p.status === 'discarded' ? 'raw' : view}
          onChange={setView}
          tabs={[...(p.status === 'discarded' ? [] : [{ id: 'changes' as const, label: `Changes (${p.changes.length} file${p.changes.length === 1 ? '' : 's'})` }]), { id: 'raw' as const, label: 'Raw patch' }]}
        />
        {view === 'changes' && p.status !== 'discarded' ? <ProposalChanges p={p} /> : <RawPatch patch={p.diff || '(empty diff)'} />}
      </div>

      <Confirm
        open={confirmDiscard}
        title="Discard this proposal?"
        message="Deletes the proposal branch. Nothing reaches main. The designer can open a new proposal later."
        confirmLabel="Discard"
        danger
        busy={discard.isPending}
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => discard.mutate()}
      />
    </div>
  );
}

/** Ask the designer that opened the proposal to amend it, and follow its reply here. */
function RevisionRequest({ p }: { p: ProposalDto }) {
  const qc = useQueryClient();
  const sid = p.session_id;
  const [text, setText] = useState('');
  const [sentAt, setSentAt] = useState<number | null>(null);
  const conv = useQuery({
    queryKey: ['conversation', sid],
    queryFn: () => convApi.get(sid!),
    enabled: !!sid,
    refetchInterval: (query) => ((query.state.data as ConversationSnapshot | undefined)?.busy ? 3_000 : false),
  });
  const c = conv.data;
  useLiveEvents(['session.event', 'session.state'], (e) => payloadSessionId(e) === sid && void conv.refetch(), !!sid && !!c?.busy);

  // When the designer finishes, the proposal may have been amended: refetch it (and its checks).
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && c && !c.busy) void qc.invalidateQueries({ queryKey: qk.proposal(p.proposal_id) });
    wasBusy.current = !!c?.busy;
  }, [c, qc, p.proposal_id]);

  const send = useMutation({
    mutationFn: async (message: string) => {
      setSentAt(c?.turns.length ?? 0);
      await convApi.submit(sid!, message, { proposal_id: p.proposal_id, ...(c?.definition_uid ? { definition_uid: c.definition_uid } : {}) }, crypto.randomUUID());
    },
    onSuccess: () => {
      setText('');
      void conv.refetch();
    },
    onError: (e) => notify(`Designer: ${errorMessage(e)}`, 'danger'),
  });

  const defs = proposalDefinitions(p);
  const chatDef = defs.find((d) => d.uid === c?.definition_uid) ?? defs[0];
  const chatHref = sid && chatDef ? `${hrefFor(chatDef.kind, chatDef.uid)}?chat=${sid}` : null;
  if (!sid) return null;
  if (conv.isLoading) return null;
  const ended = c ? conversationEnded(c.state, c.reason) : 'become unavailable';
  const reply = c && sentAt !== null && !c.busy ? lastAssistantText(c.turns.slice(sentAt)) : null;

  return (
    <section className="rounded-md border border-line bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-semibold">Request changes from the designer</h3>
        {chatHref && (
          <AppLink href={chatHref} className="ml-auto flex items-center gap-1 text-xs">
            <MessageSquare className="size-3.5" aria-hidden /> Open the chat
          </AppLink>
        )}
      </div>
      {ended ? (
        <p className="text-xs text-fg-muted">
          The conversation that opened this proposal has {ended}. {chatHref ? 'Open the chat to start a new conversation; it can still amend this proposal.' : ''}
        </p>
      ) : (
        <>
          <div className="flex gap-1.5">
            <TextAreaInput
              rows={2}
              value={text}
              disabled={c?.busy}
              placeholder="What should change? The designer amends this proposal."
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) send.mutate(text.trim());
              }}
              className="min-h-0 flex-1 text-sm"
            />
            <Btn size="sm" aria-label="Send revision request" icon={<Send className="size-3.5" />} disabled={!text.trim() || c?.busy} loading={send.isPending} onClick={() => send.mutate(text.trim())} />
          </div>
          {c?.busy && (
            <div className="mt-2 flex items-center gap-2 text-xs text-fg-subtle">
              <Spin /> The designer is working. This page refreshes the diff when it finishes.
            </div>
          )}
          {!c?.busy && c?.last_error && <div className="mt-2 text-xs text-danger-fg">The designer's last reply failed: {c.last_error}</div>}
          {reply && (
            <div className="mt-2 rounded-md border border-line bg-sunken p-2">
              <div className="mb-1 text-[11px] text-fg-subtle">Designer replied</div>
              <Md source={reply} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

function lastAssistantText(turns: Array<{ role: string; content: unknown }>): string | null {
  for (const t of [...turns].reverse()) {
    if (t.role !== 'assistant') continue;
    const text = blocksOf(t.content)
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return null;
}
