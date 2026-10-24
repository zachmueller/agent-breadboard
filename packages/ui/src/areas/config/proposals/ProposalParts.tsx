/**
 * Pieces of proposal review ([10] §4 propose-review-commit) shared by the review page, the proposals list and the
 * designer chat's proposal card: status pills, author, tool checks, and each changed definition's native diff.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FlaskConical, XCircle } from 'lucide-react';
import { owningDefinition, type AffectedCircuitDto, type ProposalDto } from '@breadboard/shared';
import { configApi, evalsApi, isRunTerminal, proposalDefinitions, qk, useAffectedCircuits, useTreeIndex, type EvalRunDto } from '../lib/configApi';
import { ActorLabel, Btn, Pill, Spin, ErrorBox, errorMessage, notify } from '../ui';
import { RawPatch } from '../components/Diff';
import { AppLink } from '../components/AppLink';
import { useSnapshot, type DiffRenderer } from '../components/snapshot';
import { toolDiffRenderer, plainDiffRenderer } from '../toolbox/SecurityFindings';
import { circuitDiffRenderer } from '../circuits/FlowDiff';
import { subagentDiffRenderer } from '../subagents/SubagentDiff';
import { fmtPct, fmtScore, fmtUsd, hrefFor, shortCommit } from '../lib/format';
import { splitPatch } from './patch';

type DefKind = 'circuit' | 'tool' | 'subagent' | 'mcp';

const RENDERERS: Record<DefKind, DiffRenderer> = { circuit: circuitDiffRenderer, tool: toolDiffRenderer, subagent: subagentDiffRenderer, mcp: plainDiffRenderer };
const KIND_LABEL: Record<DefKind, string> = { circuit: 'Circuit', tool: 'Tool', subagent: 'Subagent', mcp: 'MCP server' };
const STATUS_TONE = { draft: 'warn', open: 'info', merged: 'ok', discarded: 'neutral' } as const;

export function ProposalPills({ p }: { p: ProposalDto }) {
  return (
    <>
      <Pill tone={STATUS_TONE[p.status] ?? 'neutral'}>{p.status}</Pill>
      {(p.status === 'open' || p.status === 'draft') && <Pill tone={p.validation?.ok ? 'ok' : 'danger'}>{p.validation?.ok ? 'valid' : `${p.validation?.errors.length ?? 0} error(s)`}</Pill>}
    </>
  );
}

/** Who opened it; a designer subagent shows as its slug rather than its UID. */
export function ProposalAuthor({ actor }: { actor: unknown }) {
  const idx = useTreeIndex();
  const a = actor as { kind?: string; id?: string } | null;
  if (a?.kind === 'subagent' && a.id) {
    const e = idx.get('subagent', a.id);
    if (e) return <span className="font-mono text-[12px] text-fg-muted">{e.slug}</span>;
  }
  return <ActorLabel actor={a as never} />;
}

/** "slug" for each definition the proposal changes. */
export function useDefinitionLabels(p: ProposalDto) {
  const idx = useTreeIndex();
  return useMemo(() => proposalDefinitions(p).map((d) => ({ ...d, label: idx.get(d.kind, d.uid)?.slug ?? d.uid, exists: !!idx.get(d.kind, d.uid) })), [p, idx]);
}

export function useToolChecks(p: ProposalDto | undefined) {
  const tools = p ? proposalDefinitions(p).filter((d) => d.kind === 'tool') : [];
  return useQuery({
    queryKey: [...qk.proposal(p?.proposal_id ?? ''), 'checks', p?.head_commit ?? ''],
    queryFn: () => configApi.proposalChecks(p!.proposal_id),
    enabled: !!p && (p.status === 'open' || p.status === 'draft') && tools.length > 0,
    staleTime: Infinity, // keyed by head commit, which never changes underneath
  });
}

/** Tool CI at the proposal head: manifest, TypeScript or Python syntax. */
export function ToolChecks({ p }: { p: ProposalDto }) {
  const q = useToolChecks(p);
  const idx = useTreeIndex();
  if (p.status !== 'open' || !proposalDefinitions(p).some((d) => d.kind === 'tool')) return null;
  return (
    <section className="rounded-md border border-line bg-surface p-3">
      <h3 className="mb-2 text-sm font-semibold">Tool checks</h3>
      {q.isLoading ? (
        <Spin />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} title="Checks did not run" />
      ) : (
        <ul className="space-y-2 text-xs">
          {(q.data?.tools ?? []).map((t) => (
            <li key={t.uid}>
              <div className="flex items-center gap-1.5 font-medium">
                {t.ok ? <CheckCircle2 className="size-3.5 text-ok-fg" aria-hidden /> : <XCircle className="size-3.5 text-danger-fg" aria-hidden />}
                <span className="font-mono">{idx.get('tool', t.uid)?.slug ?? t.uid}</span>
                <span className={t.ok ? 'text-ok-fg' : 'text-danger-fg'}>{t.ok ? 'manifest and syntax checks pass' : `${t.errors.length} failing check${t.errors.length === 1 ? '' : 's'}`}</span>
              </div>
              {[...t.errors.map((e) => ({ e, tone: 'text-danger-fg' })), ...t.warnings.map((e) => ({ e, tone: 'text-warn-fg' }))].map(({ e, tone }, i) => (
                <div key={i} className={`ml-5 font-mono ${tone}`}>
                  {e}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Each changed definition in its editor's native diff (flow graph, code, form), then any other files as patches. */
export function ProposalChanges({ p }: { p: ProposalDto }) {
  const defs = useDefinitionLabels(p);
  const patches = useMemo(() => splitPatch(p.diff ?? ''), [p.diff]);
  const others = p.changes.filter((c) => !owningDefinition(c.path));
  if (!p.changes.length) return <div className="text-xs text-fg-subtle">This proposal changes no files.</div>;
  return (
    <div className="space-y-4">
      {defs.map((d) => (
        <section key={d.uid} className="rounded-md border border-line bg-surface">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-sm">
            <span className="text-[11px] tracking-wide text-fg-subtle uppercase">{KIND_LABEL[d.kind]}</span>
            <span className="font-mono font-medium">{d.label}</span>
            {!d.exists && <Pill tone="ok">new</Pill>}
            {d.exists && (
              <AppLink href={hrefFor(d.kind, d.uid)} className="ml-auto text-xs">
                Open in editor
              </AppLink>
            )}
          </div>
          <DefinitionDiff p={p} kind={d.kind} uid={d.uid} />
        </section>
      ))}
      {others.length > 0 && (
        <section className="rounded-md border border-line bg-surface">
          <div className="border-b border-line px-3 py-2 text-sm font-medium">Other files</div>
          <div className="space-y-2 p-2">
            {others.map((c) => (
              <RawPatch key={c.path} patch={patches.get(c.path) ?? `${c.status} ${c.path}`} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function DefinitionDiff({ p, kind, uid }: { p: ProposalDto; kind: DefKind; uid: string }) {
  const base = useSnapshot(kind, uid, p.base_commit, `base ${shortCommit(p.base_commit)}`);
  const head = useSnapshot(kind, uid, p.head_commit, p.status === 'merged' ? 'merged' : 'proposal');
  if (base.isLoading || head.isLoading) return <div className="p-3"><Spin /></div>;
  if (base.error || head.error) return <ErrorBox error={base.error ?? head.error} title="Could not load this definition at the proposal's commits" />;
  if (!base.data || !head.data) return null;
  return <div className="p-1">{RENDERERS[kind](base.data, head.data)}</div>;
}

/** Live summary of one eval run, polled until terminal; `baseline` adds the circuit's latest main-line run beside it. */
export function EvalRunSummary({ id, baseline }: { id: string; baseline?: boolean }) {
  const q = useQuery({
    queryKey: qk.run(id),
    queryFn: () => evalsApi.run(id),
    refetchInterval: (query) => (query.state.data && isRunTerminal((query.state.data as EvalRunDto).status) ? false : 3000),
  });
  const r = q.data;
  const done = r && isRunTerminal(r.status);
  const main = useMainBaseline(baseline ? r?.circuit_uid || undefined : undefined);
  const idx = useTreeIndex();
  return (
    <div className="flex items-center gap-2 text-xs">
      <FlaskConical className="size-3.5 text-fg-subtle" />
      <span className="font-mono text-fg-subtle">{id}</span>
      {!r ? (
        <Spin />
      ) : (
        <>
          <Pill tone={r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'danger' : 'info'}>{r.status}</Pill>
          {!done && <Spin />}
          {baseline && r.circuit_uid && <span className="font-mono text-fg-muted">{idx.get('circuit', r.circuit_uid)?.slug ?? r.circuit_uid}</span>}
          <span>aggregate {fmtScore(r.aggregate)}</span>
          <span>pass {fmtPct(r.pass_rate)}</span>
          <span className="text-fg-subtle">{fmtUsd(r.cost_usd)}</span>
          {baseline && main.data && (
            <span className="text-fg-subtle" title={`Latest completed run on main: ${main.data.eval_run_id}`}>
              · main {fmtScore(main.data.aggregate)} / pass {fmtPct(main.data.pass_rate)}
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** Proposals a branch run may still change: drafts (staged before review) and open ones. */
export const isLiveProposal = (p: Pick<ProposalDto, 'status'>) => p.status === 'open' || p.status === 'draft';

/**
 * "Run evals" on a proposal's branch for each circuit its changes reach ([04] §7): an edited circuit, or one using a
 * changed tool, subagent, preset or tenets. Circuits without fixtures are left out; with several, pick one first.
 */
export function BranchEvalLauncher({ p, onStarted, size = 'sm' }: { p: ProposalDto; onStarted?: (runId: string) => void; size?: 'sm' | 'md' }) {
  const qc = useQueryClient();
  const affected = useAffectedCircuits(p.proposal_id, isLiveProposal(p));
  const runnable = (affected.data ?? []).filter((c) => c.fixtures > 0);
  const [picked, setPicked] = useState<string>('');
  const circuit = runnable.find((c) => c.uid === picked)?.uid ?? runnable[0]?.uid;
  const launch = useMutation({
    mutationFn: (uid: string) => evalsApi.launch({ circuit: uid, proposal_id: p.proposal_id }),
    onSuccess: (r) => {
      if (r.eval_run_id) onStarted?.(r.eval_run_id);
      notify('Eval run started on the proposal branch', 'ok');
      void qc.invalidateQueries({ queryKey: ['evals'] });
      void qc.invalidateQueries({ queryKey: qk.proposal(p.proposal_id) });
    },
    onError: (e) => notify(errorMessage(e), 'danger'),
  });
  if (!isLiveProposal(p) || !runnable.length) return null;
  const label = (c: AffectedCircuitDto) => `${c.slug ?? c.uid} (${c.fixtures} fixture${c.fixtures === 1 ? '' : 's'})`;
  return (
    <span className="inline-flex items-center gap-1">
      {runnable.length > 1 && (
        <select
          aria-label="Circuit to evaluate"
          value={circuit}
          onChange={(e) => setPicked(e.target.value)}
          title={runnable.find((c) => c.uid === circuit)?.via.join(', ')}
          className="h-7 max-w-56 truncate rounded-md border border-line bg-surface px-1.5 text-xs text-fg outline-none focus:border-accent"
        >
          {runnable.map((c) => (
            <option key={c.uid} value={c.uid}>
              {label(c)}
            </option>
          ))}
        </select>
      )}
      <Btn size={size} variant="secondary" icon={<FlaskConical className="size-3.5" />} loading={launch.isPending} onClick={() => circuit && launch.mutate(circuit)} title={runnable.length === 1 ? `${label(runnable[0]!)}: ${runnable[0]!.via.join(', ')}` : undefined}>
        Run evals{runnable.length === 1 ? ` (${runnable[0]!.slug ?? 'circuit'})` : ''}
      </Btn>
    </span>
  );
}

/** The latest completed eval run of a circuit made on main (not on any proposal branch): a branch run's baseline. */
function useMainBaseline(circuit: string | undefined) {
  return useQuery({
    queryKey: [...qk.runs(circuit ?? ''), 'baseline'],
    queryFn: async () => (await evalsApi.runPage({ circuit: circuit!, proposal: 'none', limit: 10 }, 0)).items.find((r) => r.status === 'completed') ?? null,
    enabled: !!circuit,
    staleTime: 60_000,
  });
}
