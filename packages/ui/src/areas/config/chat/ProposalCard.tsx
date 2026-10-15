/**
 * Proposal card in the designer chat ([10] §4, [01] §10 propose-review-commit): what the proposal changes, its
 * validation and tool checks, and the way to its review page, plus merge / discard / run-evals-on-branch /
 * request-revisions in place.
 */
import { useState } from 'react';
import clsx from 'clsx';
import { ArrowRight, GitMerge, Trash2, FlaskConical, Send, GitPullRequest } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProposalDto } from '@breadboard/shared';
import { configApi, evalsApi, qk, proposalPath } from '../lib/configApi';
import { useWorkingTree } from '../model/workingTree';
import { Btn, Pill, Spin, ErrorBox, Modal, notify, errorMessage, TextAreaInput, buttonClasses } from '../ui';
import { ValidationList } from '../components/fields';
import { AppLink } from '../components/AppLink';
import { shortCommit, hrefFor } from '../lib/format';
import { parseConfigPath } from '@breadboard/shared';
import { EvalRunSummary, ProposalPills, useToolChecks } from '../proposals/ProposalParts';

export function ProposalCard({ proposalId, canRunEvals, onRevise, busy, amended }: { proposalId: string; canRunEvals?: boolean; onRevise: (text: string, proposalId: string) => void; busy?: boolean; amended?: boolean }) {
  const wt = useWorkingTree();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.proposal(proposalId), queryFn: () => configApi.proposal(proposalId), staleTime: 5_000 });
  const checks = useToolChecks(q.data);
  const [mergeAsk, setMergeAsk] = useState(false);
  const [revision, setRevision] = useState('');
  const [runIds, setRunIds] = useState<string[]>([]);

  const p = q.data;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['config'] });
  const merge = useMutation({
    mutationFn: async (keepEdits: boolean) => {
      await configApi.merge(proposalId);
      return keepEdits;
    },
    onSuccess: async (keepEdits) => {
      setMergeAsk(false);
      notify('Proposal merged to main', 'ok');
      refresh();
      await wt.reload({ keepEdits });
    },
    onError: (e) => notify(`Merge failed: ${errorMessage(e)}`, 'danger'),
  });
  const discard = useMutation({
    mutationFn: () => configApi.discard(proposalId),
    onSuccess: () => {
      notify('Proposal discarded', 'info');
      refresh();
    },
    onError: (e) => notify(errorMessage(e), 'danger'),
  });
  const runEvals = useMutation({
    mutationFn: () => evalsApi.launch({ circuit: wt.uid, ref: p!.branch, proposal_id: proposalId }),
    onSuccess: (r) => {
      if (r.eval_run_id) setRunIds((ids) => [...new Set([...ids, r.eval_run_id])]);
      notify('Eval run started on the proposal branch', 'ok');
      void qc.invalidateQueries({ queryKey: ['evals'] });
    },
    onError: (e) => notify(errorMessage(e), 'danger'),
  });

  if (q.isLoading) {
    return (
      <div className="rounded-lg border border-line bg-raised p-3">
        <Spin />
      </div>
    );
  }
  if (q.error || !p) return <ErrorBox error={q.error ?? new Error('proposal not found')} title={`Proposal ${proposalId}`} onRetry={() => void q.refetch()} />;

  const allRuns = [...new Set([...(p.eval_runs ?? []), ...runIds])];
  const open = p.status === 'open';
  const failing = (checks.data?.tools ?? []).filter((t) => !t.ok).length;
  const review = proposalPath(p.proposal_id);
  return (
    <div className={clsx('rounded-lg border bg-raised text-sm shadow-sm', open ? 'border-accent/40' : 'border-line')}>
      <div className="flex items-start gap-2 border-b border-line px-3 py-2">
        <GitPullRequest className="mt-0.5 size-4 shrink-0 text-accent-text" />
        <div className="min-w-0 flex-1">
          <AppLink href={review} className="font-medium break-words text-fg">
            {p.message || 'Proposed change'}
          </AppLink>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-fg-subtle">
            <ProposalPills p={p} />
            {open && checks.isLoading && <Pill>checking…</Pill>}
            {open && checks.data && <Pill tone={failing ? 'danger' : 'ok'}>{failing ? `${failing} tool check${failing === 1 ? '' : 's'} failing` : 'checks pass'}</Pill>}
            {amended && <Pill tone="info">amended</Pill>}
            <span className="font-mono">{p.proposal_id}</span>
            <span>
              base <span className="font-mono">{shortCommit(p.base_commit)}</span>
            </span>
          </div>
        </div>
      </div>

      <ChangedPaths p={p} />
      {open && !p.validation?.ok && (
        <div className="px-3 pb-2">
          <ValidationList errors={p.validation?.errors ?? []} warnings={p.validation?.warnings ?? []} max={6} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">
        <AppLink bare href={review} className={buttonClasses(open ? 'primary' : 'secondary', 'sm', 'gap-1.5')}>
          {open ? 'Review changes' : 'View changes'} <ArrowRight className="size-3.5" aria-hidden />
        </AppLink>
        {open && (
          <>
            <Btn size="sm" icon={<GitMerge className="size-3.5" />} loading={merge.isPending} disabled={!p.validation?.ok} onClick={() => (wt.state.dirty.size ? setMergeAsk(true) : merge.mutate(false))}>
              Merge
            </Btn>
            <Btn size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} loading={discard.isPending} onClick={() => discard.mutate()}>
              Discard
            </Btn>
            {canRunEvals && (
              <Btn size="sm" variant="ghost" icon={<FlaskConical className="size-3.5" />} loading={runEvals.isPending} onClick={() => runEvals.mutate()}>
                Run evals on branch
              </Btn>
            )}
          </>
        )}
        {p.status === 'merged' && p.merged_commit && <span className="text-[11px] text-fg-subtle">merged as {shortCommit(p.merged_commit)}</span>}
      </div>

      {allRuns.length > 0 && (
        <div className="space-y-1 border-t border-line px-3 py-2">
          {allRuns.map((id) => (
            <EvalRunSummary key={id} id={id} />
          ))}
        </div>
      )}

      {open && (
        <div className="border-t border-line px-3 py-2">
          <div className="flex gap-1.5">
            <TextAreaInput
              rows={2}
              value={revision}
              placeholder="Request revisions to this proposal..."
              onChange={(e) => setRevision(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && revision.trim() && !busy) {
                  onRevise(revision.trim(), proposalId);
                  setRevision('');
                }
              }}
              className="min-h-0 flex-1 text-xs"
            />
            <Btn
              size="sm"
              aria-label="Send revision request"
              icon={<Send className="size-3.5" />}
              disabled={!revision.trim() || busy}
              onClick={() => {
                onRevise(revision.trim(), proposalId);
                setRevision('');
              }}
            />
          </div>
        </div>
      )}

      <Modal
        open={mergeAsk}
        onClose={() => setMergeAsk(false)}
        title="You have unsaved edits"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setMergeAsk(false)}>
              Cancel
            </Btn>
            <Btn variant="danger" loading={merge.isPending} onClick={() => merge.mutate(false)}>
              Merge and drop my edits
            </Btn>
            <Btn variant="primary" loading={merge.isPending} onClick={() => merge.mutate(true)}>
              Merge and keep my edits
            </Btn>
          </>
        }
      >
        <p className="text-sm text-fg-muted">
          Merging moves main forward. Your {wt.state.dirty.size} unsaved change(s) can be kept on top of the new main (they will overwrite the proposal's version of the same files) or dropped.
        </p>
      </Modal>
    </div>
  );
}

function ChangedPaths({ p }: { p: ProposalDto }) {
  if (!p.changes?.length) return null;
  return (
    <ul className="space-y-0.5 px-3 py-2 font-mono text-[11px]">
      {p.changes.map((c) => {
        const parsed = parseConfigPath(c.path);
        const href = parsed?.uid && c.status !== 'deleted' ? hrefFor(parsed.kind, parsed.uid) : null;
        const tone = c.status === 'added' ? 'text-ok-fg' : c.status === 'deleted' ? 'text-danger-fg' : 'text-warn-fg';
        return (
          <li key={c.path} className="flex gap-2">
            <span className={clsx('w-3 shrink-0 font-semibold', tone)}>{c.status === 'added' ? 'A' : c.status === 'deleted' ? 'D' : 'M'}</span>
            {href ? (
              <AppLink href={href} className="truncate text-accent-text hover:underline" title={c.path}>
                {c.path}
              </AppLink>
            ) : (
              <span className="truncate" title={c.path}>
                {c.path}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
