/** Session explorer (`/s/:id`, [02] §8): header, step path, step drawer, conversation, events, executions. Live-follows via SSE. */
import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { Activity, ArrowRight, Boxes, CornerDownRight, GitCommitHorizontal, GitPullRequest, MessagesSquare, Radio, ScrollText, Terminal } from 'lucide-react';
import { TERMINAL_SESSION_STATES, type SessionSummaryDto } from '@breadboard/shared';
import { useConfigDefinition, useSession, useSessionEvents, useSessionExecutions, useSessionProposals, useSessionTurns } from '../../lib/queries';
import { useUrlSearch } from '../../lib/url';
import { durationMs, formatCost, formatDuration, formatTokens, humanize, shortCommit, shortId } from '../../lib/format';
import { nodePath, proposalPath } from '../../lib/paths';
import { isApiError } from '../../lib/api';
import { cn } from '../../components/cn';
import {
  Badge,
  buttonClasses,
  Callout,
  ConfigLink,
  CopyButton,
  CostInline,
  EmptyState,
  ErrorState,
  Loading,
  MetaList,
  NodeChip,
  PageBody,
  PageHeader,
  SessionChip,
  StateBadge,
  StepStatusBadge,
  Tabs,
  TimeAgo,
  useConfigLabel,
} from '../../components';
import { EventsTab } from './EventsTab';
import { SessionActions } from './SessionActions';
import { ExecutionCard, STEP_KIND_ICON, StepDrawer, stepKindOf } from './StepDrawer';
import { TurnList, type TurnLike } from './TurnView';
import { circuitSteps, gateArtifacts, groupSteps, stateDetailMessage, type CircuitStepInfo } from './util';

type Tab = 'steps' | 'conversation' | 'events' | 'executions';

export function SessionExplorer({ id: idProp }: { id?: string }) {
  const [search, setSearch] = useUrlSearch<{ step?: string; tab?: string }>();
  const id = idProp ?? '';
  const q = useSession(id, { live: true });
  const s = q.data;
  const live = !!s && !TERMINAL_SESSION_STATES.includes(s.state);
  const events = useSessionEvents(id, { live });

  if (q.isPending) return <Loading label="Loading session…" className="py-24" />;
  if (q.error || !s)
    return (
      <PageBody>
        {isApiError(q.error) && q.error.isNotFound ? (
          <EmptyState icon={<Activity size={20} />} title="Session not found" description={<>No session <span className="font-mono">{id}</span> exists, or it is outside your visibility.</>} action={<Link to="/sessions" className={buttonClasses('secondary', 'sm')}>All sessions</Link>} />
        ) : (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        )}
      </PageBody>
    );

  const tab = (search.tab as Tab) || (s.kind === 'circuit-run' || s.kind === 'eval-run' ? 'steps' : 'conversation');
  return <Explorer session={s} live={live} tab={tab} stepParam={search.step ?? null} setSearch={setSearch} events={events} />;
}

function Explorer({
  session: s,
  live,
  tab,
  stepParam,
  setSearch,
  events,
}: {
  session: SessionSummaryDto;
  live: boolean;
  tab: Tab;
  stepParam: string | null;
  setSearch: (p: Record<string, string | undefined | null>, o?: { replace?: boolean }) => void;
  events: ReturnType<typeof useSessionEvents>;
}) {
  const def = useConfigDefinition(s.circuit_uid, s.config_commit ?? undefined);
  const stepInfo = useMemo(() => circuitSteps(def.data?.definition), [def.data]);
  const groups = useMemo(() => groupSteps(s.steps ?? []), [s.steps]);
  const { label: circuitLabel } = useConfigLabel(s.circuit_uid, s.circuit_slug ?? def.data?.slug);
  const isRun = s.kind === 'circuit-run' || s.kind === 'eval-run';
  const turnsTab = !isRun;

  const drawerGroup = useMemo(() => {
    if (!stepParam) return undefined;
    const all = groups.filter((g) => g.step_id === stepParam);
    if (!all.length) return undefined;
    const attempts = all.flatMap((g) => g.attempts);
    return { step_id: stepParam, attempts, latest: attempts[attempts.length - 1]!, visit: all.length };
  }, [groups, stepParam]);

  const gated = s.state === 'suspended-gate' ? gateArtifacts(s, events.items) : [];
  const gateStep = (s.state_detail as { step_id?: string } | null)?.step_id ?? null;
  const errorMsg = s.state === 'suspended-error' ? stateDetailMessage(s) : null;
  const budgetStop = s.state === 'suspended-error' && (s.state_detail as { reason?: string })?.reason === 'budget-exceeded';
  const b = s.budget;

  const tabs = [
    isRun ? { key: 'steps' as Tab, label: 'Steps', count: groups.length, icon: <Boxes size={14} /> } : null,
    turnsTab ? { key: 'conversation' as Tab, label: 'Conversation', icon: <MessagesSquare size={14} /> } : null,
    { key: 'events' as Tab, label: 'Events', count: events.items.length || null, icon: <ScrollText size={14} /> },
    { key: 'executions' as Tab, label: 'Executions', icon: <Terminal size={14} /> },
  ].filter((t): t is NonNullable<typeof t> => !!t);

  return (
    <>
      <PageHeader
        icon={<Activity size={16} />}
        eyebrow={
          <>
            <Link to="/sessions" className="hover:text-fg hover:underline">
              Sessions
            </Link>
            <span aria-hidden>/</span>
            <span className="font-mono">{s.session_id}</span>
            <CopyButton value={s.session_id} label="Copy session id" size={12} />
          </>
        }
        title={
          <span className="flex items-center gap-2.5">
            <span className="truncate">{s.circuit_uid ? circuitLabel : humanize(s.kind)}</span>
            <StateBadge state={s.state} detail={s.state_detail} />
            {live && (
              <span className="inline-flex items-center gap-1 text-[12px] font-normal text-ok-fg" title="Following live">
                <Radio size={13} className="animate-pulse" aria-hidden /> Live
              </span>
            )}
          </span>
        }
        actions={<SessionActions session={s} />}
      >
        <MetaList
          items={[
            { label: 'Kind', value: <Badge size="xs">{s.kind}</Badge> },
            s.circuit_uid ? { label: 'Circuit', value: <ConfigLink uid={s.circuit_uid} slug={s.circuit_slug} kind="circuit" /> } : null,
            s.task_uid ? { label: 'Task', value: <NodeChip uid={s.task_uid} type="task" maxWidth="max-w-[18rem]" /> } : null,
            { label: 'Cost', value: <CostInline usd={s.cost_usd} includingChildren={s.cost_usd_including_children} tokensIn={s.tokens_in} tokensOut={s.tokens_out} /> },
            b && (b.max_cost_usd || b.max_tokens)
              ? { label: 'Budget', value: <BudgetMeter spent={b.spent_usd} max={b.max_cost_usd} tokens={b.spent_tokens} maxTokens={b.max_tokens} /> }
              : null,
            s.config_commit
              ? {
                  label: 'Config',
                  value: (
                    <span className="inline-flex items-center gap-1 font-mono text-[12.5px]" title={s.config_commit}>
                      <GitCommitHorizontal size={13} className="text-fg-subtle" aria-hidden />
                      {shortCommit(s.config_commit)}
                      <CopyButton value={s.config_commit} label="Copy commit hash" size={12} />
                    </span>
                  ),
                }
              : null,
            { label: 'Created', value: <TimeAgo at={s.created_at} /> },
            { label: 'Duration', value: <span className="tabular">{s.started_at ? formatDuration(durationMs(s.started_at, s.ended_at)) : 'Not started'}</span> },
            s.parent_session
              ? {
                  label: 'Parent',
                  value: (
                    <span className="inline-flex items-center gap-1">
                      <CornerDownRight size={12} className="rotate-180 text-fg-subtle" aria-hidden />
                      <SessionChip id={s.parent_session} step={s.parent_step_id} />
                    </span>
                  ),
                }
              : null,
            s.children.length
              ? {
                  label: `Sub-sessions (${s.children.length})`,
                  value: (
                    <span className="flex flex-wrap gap-1">
                      {s.children.slice(0, 6).map((c) => (
                        <SessionChip key={c.session_id} id={c.session_id} state={c.state} kind={c.kind} />
                      ))}
                      {s.children.length > 6 && <span className="text-fg-subtle">+{s.children.length - 6}</span>}
                    </span>
                  ),
                }
              : null,
          ]}
        />
      </PageHeader>

      <PageBody wide className="flex flex-col gap-4">
        {s.state === 'suspended-gate' && (
          <Callout
            tone="warn"
            title={`Waiting at gate${gateStep ? ` “${gateStep}”` : ''}`}
            action={
              gated[0] ? (
                <Link to={nodePath(gated[0].uid)} className={buttonClasses('primary', 'sm')}>
                  Go review <ArrowRight size={13} />
                </Link>
              ) : (
                <Link to="/content/review" className={buttonClasses('secondary', 'sm')}>
                  Review queue
                </Link>
              )
            }
          >
            The run is suspended (no capacity held) until reviewers record a verdict on {gated.length ? pluralize2(gated.length, 'artifact') : 'the gated artifacts'}.
            {gated.length > 1 && (
              <span className="mt-2 flex flex-wrap gap-1.5">
                {gated.map((a) => (
                  <NodeChip key={a.uid} uid={a.uid} revision={a.revision_id} />
                ))}
              </span>
            )}
          </Callout>
        )}
        {s.state === 'suspended-error' && (
          <Callout tone="danger" title={budgetStop ? 'Stopped at budget ceiling' : 'Suspended on error'}>
            {budgetStop ? (
              <>
                Spent {formatCost(b?.spent_usd)} of {formatCost(b?.max_cost_usd)} ({formatTokens(b?.spent_tokens)} of {formatTokens(b?.max_tokens)} tokens). Resume with a raised budget to continue.
              </>
            ) : (
              <>
                {errorMsg ? <span className="font-mono text-[12.5px]">{errorMsg}</span> : 'A step exhausted its retries.'} Retry, route past the failed step manually, or cancel.
              </>
            )}
          </Callout>
        )}

        {s.kind === 'conversation' && <SessionProposals id={s.session_id} />}

        <Tabs items={tabs} value={tabs.some((t) => t.key === tab) ? tab : tabs[0]!.key} onChange={(k) => setSearch({ tab: k })} idBase="session" />

        {tab === 'steps' && isRun ? (
          <StepPath session={s} groups={groups} stepInfo={stepInfo} events={events.items} onOpen={(step) => setSearch({ step }, { replace: false })} defLoading={def.isPending && !!s.circuit_uid} />
        ) : tab === 'conversation' && turnsTab ? (
          <ConversationTab id={s.session_id} live={live} />
        ) : tab === 'events' ? (
          <EventsTab events={events.items} query={events} />
        ) : tab === 'executions' ? (
          <ExecutionsTab id={s.session_id} />
        ) : (
          <StepPath session={s} groups={groups} stepInfo={stepInfo} events={events.items} onOpen={(step) => setSearch({ step }, { replace: false })} defLoading={false} />
        )}
      </PageBody>

      <StepDrawer
        key={stepParam ?? ''}
        session={s}
        stepId={stepParam}
        group={drawerGroup}
        info={stepParam ? stepInfo.get(stepParam) : undefined}
        events={events.items}
        onClose={() => setSearch({ step: undefined }, { replace: false })}
      />
    </>
  );
}

/** Config proposals the designer opened in this conversation, each linking to its review page. */
function SessionProposals({ id }: { id: string }) {
  const q = useSessionProposals(id);
  const items = q.data ?? [];
  if (!items.length) return null;
  const open = items.filter((p) => p.status === 'open').length;
  return (
    <Callout icon={<GitPullRequest size={15} />} title={`${pluralize2(items.length, 'configuration proposal')} from this conversation${open ? `, ${open} waiting for review` : ''}`}>
      <ul className="mt-1.5 flex flex-col gap-1">
        {items.map((p) => (
          <li key={p.proposal_id} className="flex flex-wrap items-center gap-2">
            <Link to={proposalPath(p.proposal_id)} className="font-medium text-accent-text hover:underline">
              {p.message || 'Proposed change'}
            </Link>
            <Badge size="xs" tone={p.status === 'open' ? 'info' : p.status === 'merged' ? 'ok' : 'neutral'}>
              {p.status}
            </Badge>
            <span className="font-mono text-[11.5px] text-fg-subtle">{p.proposal_id}</span>
            {p.status === 'open' && (
              <Link to={proposalPath(p.proposal_id)} className={buttonClasses('primary', 'xs')}>
                Review <ArrowRight size={12} />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

function pluralize2(n: number, w: string) {
  return `${n} ${w}${n === 1 ? '' : 's'}`;
}

function BudgetMeter({ spent, max, tokens, maxTokens }: { spent: number; max: number; tokens: number; maxTokens: number }) {
  const r = Math.max(max ? spent / max : 0, maxTokens ? tokens / maxTokens : 0);
  const tone = r >= 0.9 ? 'bg-danger' : r >= 0.7 ? 'bg-warn' : 'bg-accent';
  return (
    <span className="inline-flex items-center gap-2" title={`${formatCost(spent)} of ${formatCost(max)} · ${formatTokens(tokens)} of ${formatTokens(maxTokens)} tokens`}>
      <span className="relative h-1.5 w-20 overflow-hidden rounded-full bg-sunken" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r * 100)} aria-label="Budget used">
        <span className={cn('absolute inset-y-0 left-0 rounded-full', tone)} style={{ width: `${Math.min(r, 1) * 100}%` }} />
      </span>
      <span className="tabular text-[12.5px] text-fg-muted">{Math.round(r * 100)}%</span>
    </span>
  );
}

function StepPath({
  session: s,
  groups,
  stepInfo,
  events,
  onOpen,
  defLoading,
}: {
  session: SessionSummaryDto;
  groups: ReturnType<typeof groupSteps>;
  stepInfo: Map<string, CircuitStepInfo>;
  events: ReturnType<typeof useSessionEvents>['items'];
  onOpen: (step: string) => void;
  defLoading: boolean;
}) {
  if (!groups.length)
    return (
      <EmptyState
        icon={<Boxes size={20} />}
        title={s.state === 'queued' ? 'Queued' : 'No steps yet'}
        description={s.state === 'queued' ? 'This run is waiting for dispatch capacity.' : 'Steps appear here as the orchestrator records checkpoints.'}
        compact
      />
    );
  const gateStep = s.state === 'suspended-gate' ? ((s.state_detail as { step_id?: string } | null)?.step_id ?? groups[groups.length - 1]?.step_id) : null;
  return (
    <ol className="relative flex flex-col" aria-label="Step path">
      {groups.map((g, i) => {
        const info = stepInfo.get(g.step_id);
        const kind = stepKindOf(g, info);
        const Icon = STEP_KIND_ICON[kind] ?? Boxes;
        const last = i === groups.length - 1;
        const cost = g.attempts.reduce((a, x) => a + Number(x.cost_usd || 0), 0);
        const tin = g.attempts.reduce((a, x) => a + (x.tokens_in || 0), 0);
        const tout = g.attempts.reduce((a, x) => a + (x.tokens_out || 0), 0);
        const child = g.latest.child_session_id ?? s.children.find((c) => c.parent_step_id === g.step_id)?.session_id ?? null;
        const childState = s.children.find((c) => c.session_id === child)?.state;
        const isGateWaiting = kind === 'gate' && last && gateStep === g.step_id;
        const artifacts = isGateWaiting ? gateArtifacts(s, events, g.step_id) : [];
        const exitTo = g.latest.exit_name ? info?.exits.find((x) => x.name === g.latest.exit_name)?.to : undefined;
        const tone = g.latest.status === 'failed' ? 'border-danger/60' : isGateWaiting ? 'border-warn/70' : g.latest.status === 'running' ? 'border-accent/60' : 'border-line';
        return (
          <li key={`${g.step_id}-${g.visit}-${i}`} className="relative flex gap-3 pb-2">
            <div className="flex w-7 shrink-0 flex-col items-center">
              <span className={cn('z-10 mt-2.5 flex size-7 items-center justify-center rounded-full border bg-surface text-fg-muted', tone)}>
                <Icon size={14} aria-hidden />
              </span>
              {!last && <span className="mt-1 w-px flex-1 bg-line" aria-hidden />}
            </div>
            <div
              role="button"
              tabIndex={0}
              onClick={() => onOpen(g.step_id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(g.step_id);
                }
              }}
              className={cn('flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-surface px-3.5 py-2.5 hover:border-line-strong hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus', tone, isGateWaiting && 'bg-warn-soft/40')}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2">
                  <span className="truncate font-mono text-[13px] font-medium text-fg">{g.step_id}</span>
                  {g.visit > 1 && <Badge size="xs" variant="outline">visit {g.visit}</Badge>}
                  {g.attempts.length > 1 && (
                    <Badge size="xs" tone="warn" variant="soft">
                      {g.attempts.length} attempts
                    </Badge>
                  )}
                </span>
                <span className="truncate text-[12px] text-fg-subtle">{info?.title ?? (defLoading ? '…' : humanize(kind))}</span>
              </div>
              <StepStatusBadge status={isGateWaiting && g.latest.status === 'running' ? 'gated' : g.latest.status} size="xs" />
              {g.latest.exit_name && (
                <span className="inline-flex items-center gap-1 font-mono text-[12px] text-fg-muted" title="Exit taken">
                  {g.latest.exit_name}
                  {exitTo && (
                    <>
                      <ArrowRight size={11} aria-hidden /> {exitTo}
                    </>
                  )}
                </span>
              )}
              {child && (
                <span onClick={(e) => e.stopPropagation()}>
                  <SessionChip id={child} state={childState} label={`sub ${shortId(child)}`} />
                </span>
              )}
              {isGateWaiting && artifacts[0] && (
                <Link to={nodePath(artifacts[0].uid)} onClick={(e) => e.stopPropagation()} className={buttonClasses('primary', 'xs')}>
                  Go review <ArrowRight size={12} />
                </Link>
              )}
              <span className="w-20 text-right">
                <CostInline usd={cost} tokensIn={tin} tokensOut={tout} />
              </span>
              <span className="w-14 text-right text-[12px] text-fg-subtle tabular">{g.attempts[0]!.started_at ? formatDuration(durationMs(g.attempts[0]!.started_at, g.latest.ended_at)) : '—'}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ConversationTab({ id }: { id: string; live: boolean }) {
  const q = useSessionTurns(id);
  if (q.isPending) return <Loading label="Loading conversation…" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.length) return <EmptyState icon={<MessagesSquare size={20} />} title="No turns yet" compact />;
  return (
    <div className="max-w-4xl">
      <TurnList turns={q.data as TurnLike[]} />
    </div>
  );
}

function ExecutionsTab({ id }: { id: string }) {
  const q = useSessionExecutions(id);
  if (q.isPending) return <Loading label="Loading executions…" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.length) return <EmptyState icon={<Terminal size={20} />} title="No tool executions" description="Code steps and tool calls from LLM steps are journaled here." compact />;
  return (
    <div className="flex flex-col gap-3">
      {q.data.map((x) => (
        <ExecutionCard key={x.execution_key} exec={x} showStep />
      ))}
    </div>
  );
}
