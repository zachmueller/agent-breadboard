/** Step detail drawer: turns for LLM steps, journal + logs for code steps, child session for sub-circuits, artifacts for gates. */
import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Bot, Boxes, Code2, GitBranch, ShieldCheck, Terminal } from 'lucide-react';
import type { SessionEvent, SessionSummaryDto } from '@breadboard/shared';
import { useSessionExecutions, useStepTurns } from '../../lib/queries';
import type { ExecutionDto } from '../../lib/types';
import { durationMs, formatDuration, humanize } from '../../lib/format';
import { nodePath } from '../../lib/paths';
import { cn } from '../../components/cn';
import {
  Badge,
  buttonClasses,
  Callout,
  ConfigLink,
  CostInline,
  Drawer,
  EmptyState,
  ErrorState,
  JsonView,
  Loading,
  MetaList,
  NodeChip,
  SessionChip,
  StepStatusBadge,
  Tabs,
  TimeAgo,
} from '../../components';
import { EventList } from './EventsTab';
import { TurnList, type TurnLike } from './TurnView';
import { gateArtifacts, type CircuitStepInfo, type groupSteps } from './util';

type StepGroup = ReturnType<typeof groupSteps>[number];

export const STEP_KIND_ICON: Record<string, typeof Bot> = { llm: Bot, code: Code2, circuit: Boxes, gate: ShieldCheck };

export function stepKindOf(group: StepGroup | undefined, info: CircuitStepInfo | undefined): string {
  return info?.kind || group?.latest.kind || (group?.latest.child_session_id ? 'circuit' : '') || 'step';
}

export function StepDrawer({
  session,
  stepId,
  group,
  info,
  events,
  onClose,
}: {
  session: SessionSummaryDto;
  stepId: string | null;
  group: StepGroup | undefined;
  info: CircuitStepInfo | undefined;
  events: SessionEvent[];
  onClose: () => void;
}) {
  const kind = stepKindOf(group, info);
  const Icon = STEP_KIND_ICON[kind] ?? GitBranch;
  const latest = group?.latest;
  const stepEvents = useMemo(() => events.filter((e) => e.step_id === stepId), [events, stepId]);
  const [tab, setTab] = useState<'detail' | 'events'>('detail');

  return (
    <Drawer
      open={!!stepId}
      onClose={onClose}
      width="xl"
      title={
        <span className="flex items-center gap-2">
          <Icon size={16} className="text-fg-muted" aria-hidden />
          <span className="font-mono">{stepId}</span>
          {latest && <StepStatusBadge status={latest.status} size="xs" />}
        </span>
      }
      description={info?.title ?? (kind !== 'step' ? `${humanize(kind)} step` : undefined)}
    >
      {stepId && (
        <div className="flex flex-col gap-4 px-5 py-4">
          {latest ? (
            <MetaList
              items={[
                { label: 'Kind', value: humanize(kind) },
                info?.subagent ? { label: 'Subagent', value: <ConfigLink uid={info.subagent} kind="subagent" /> } : null,
                info?.tool ? { label: 'Tool', value: <ConfigLink uid={info.tool} kind="tool" /> } : null,
                info?.circuit ? { label: 'Circuit', value: <ConfigLink uid={info.circuit} kind="circuit" /> } : null,
                { label: 'Attempts', value: <span className="tabular">{group!.attempts.length}</span> },
                { label: 'Exit', value: latest.exit_name ? <span className="font-mono">{latest.exit_name}</span> : <span className="text-fg-subtle">—</span> },
                { label: 'Cost', value: <CostInline usd={group!.attempts.reduce((a, s) => a + Number(s.cost_usd || 0), 0)} tokensIn={group!.attempts.reduce((a, s) => a + (s.tokens_in || 0), 0)} tokensOut={group!.attempts.reduce((a, s) => a + (s.tokens_out || 0), 0)} /> },
                { label: 'Duration', value: <span className="tabular">{formatDuration(durationMs(group!.attempts[0]!.started_at, latest.ended_at))}</span> },
                { label: 'Started', value: <TimeAgo at={group!.attempts[0]!.started_at} /> },
              ]}
            />
          ) : (
            <Callout tone="info">This step has not run in this session yet.</Callout>
          )}
          {latest?.error && (
            <Callout tone="danger" title="Step failed">
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px]">{latest.error}</pre>
            </Callout>
          )}
          {info?.exits.length ? (
            <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-fg-muted">
              <span>Exits</span>
              {info.exits.map((x) => (
                <Badge key={x.name} size="xs" variant={latest?.exit_name === x.name ? 'solid' : 'outline'} tone={latest?.exit_name === x.name ? 'accent' : 'neutral'} mono>
                  {x.name} → {x.to}
                </Badge>
              ))}
            </div>
          ) : null}

          <Tabs size="sm" value={tab} onChange={setTab} items={[{ key: 'detail', label: kind === 'llm' ? 'Turns' : kind === 'code' ? 'Executions' : 'Detail' }, { key: 'events', label: 'Events', count: stepEvents.length }]} />
          {tab === 'events' ? (
            stepEvents.length ? <EventList events={stepEvents} showStep={false} compact /> : <EmptyState title="No events for this step" compact />
          ) : kind === 'llm' || kind === 'step' ? (
            <LlmDetail sessionId={session.session_id} stepId={stepId} />
          ) : kind === 'code' ? (
            <CodeDetail sessionId={session.session_id} stepId={stepId} />
          ) : kind === 'circuit' ? (
            <CircuitDetail session={session} stepId={stepId} group={group} />
          ) : kind === 'gate' ? (
            <GateDetail session={session} stepId={stepId} events={events} />
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

function LlmDetail({ sessionId, stepId }: { sessionId: string; stepId: string }) {
  const q = useStepTurns(sessionId, stepId);
  const turns = (q.data ?? []) as TurnLike[];
  const attempts = useMemo(() => [...new Set(turns.map((t) => t.attempt ?? 1))].sort((a, b) => a - b), [turns]);
  const [attempt, setAttempt] = useState<number | null>(null);
  const current = attempt ?? attempts[attempts.length - 1] ?? 1;
  if (q.isPending) return <Loading label="Loading turns…" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} compact />;
  if (!turns.length) return <EmptyState icon={<Bot size={20} />} title="No turns recorded" description="Turns appear as the subagent converses with the model." compact />;
  const shown = attempts.length > 1 ? turns.filter((t) => (t.attempt ?? 1) === current) : turns;
  return (
    <div className="flex flex-col gap-3">
      {attempts.length > 1 && (
        <div className="flex items-center gap-1" role="group" aria-label="Attempt">
          {attempts.map((a) => (
            <button key={a} type="button" onClick={() => setAttempt(a)} aria-pressed={a === current} className={cn(buttonClasses(a === current ? 'primary' : 'ghost', 'xs'))}>
              Attempt {a}
            </button>
          ))}
        </div>
      )}
      <TurnList turns={shown} />
    </div>
  );
}

function CodeDetail({ sessionId, stepId }: { sessionId: string; stepId: string }) {
  const q = useSessionExecutions(sessionId);
  const execs = useMemo(() => (q.data ?? []).filter((x) => x.step_id === stepId), [q.data, stepId]);
  if (q.isPending) return <Loading label="Loading executions…" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} compact />;
  if (!execs.length) return <EmptyState icon={<Terminal size={20} />} title="No executions recorded" description="Tool executions are journaled as the code step runs." compact />;
  return (
    <div className="flex flex-col gap-3">
      {execs.map((x) => (
        <ExecutionCard key={x.execution_key} exec={x} />
      ))}
    </div>
  );
}

/** Journaled `ctx.log` entries as one line each: time, level, message, data. */
export function formatLogs(logs: ExecutionDto['logs']): string | null {
  if (!logs) return null;
  if (typeof logs === 'string') return logs || null;
  if (!logs.length) return null;
  return logs.map((l) => [l.at?.slice(11, 23), l.level.toUpperCase(), l.message, l.data === undefined ? '' : JSON.stringify(l.data)].filter(Boolean).join('  ')).join('\n');
}

export function ExecutionCard({ exec: x, showStep }: { exec: ExecutionDto; showStep?: boolean }) {
  const [open, setOpen] = useState<'output' | 'input' | 'logs'>(x.error ? 'logs' : 'output');
  const logs = formatLogs(x.logs) ?? x.log_text ?? null;
  const tone = x.status === 'failed' ? 'danger' : x.status === 'completed' ? 'ok' : 'info';
  return (
    <section className="rounded-lg border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[12.5px]">
        <Terminal size={14} className="text-fg-subtle" aria-hidden />
        <ConfigLink uid={x.tool_uid} slug={x.tool_slug} kind="tool" />
        {showStep && x.step_id && <span className="font-mono text-fg-muted">· {x.step_id}</span>}
        {x.attempt != null && <span className="text-fg-subtle">attempt {x.attempt}</span>}
        {x.call_index != null && <span className="text-fg-subtle">call {x.call_index}</span>}
        <Badge size="xs" tone={tone}>
          {x.status}
        </Badge>
        <span className="ml-auto flex items-center gap-3 text-fg-subtle tabular">
          {x.tool_commit && <span className="font-mono">@{x.tool_commit.slice(0, 7)}</span>}
          <span>{formatDuration(durationMs(x.started_at, x.ended_at))}</span>
          <TimeAgo at={x.started_at} />
        </span>
      </header>
      {x.error && <pre className="whitespace-pre-wrap break-words border-b border-line bg-danger-soft px-3 py-2 font-mono text-[12px] text-danger-fg">{x.error}</pre>}
      <div className="px-3 pt-2">
        <Tabs size="sm" value={open} onChange={setOpen} items={[{ key: 'output', label: 'Output' }, { key: 'input', label: 'Input' }, { key: 'logs', label: 'Logs', disabled: !logs && !x.log_ref }]} />
      </div>
      <div className="p-3">
        {open === 'output' ? (
          x.output !== undefined && x.output !== null ? <JsonView value={x.output} defaultExpandDepth={2} maxHeight="22rem" /> : <p className="text-[12.5px] text-fg-subtle">{x.output_ref ? `Stored as ${x.output_ref}` : 'No output.'}</p>
        ) : open === 'input' ? (
          <JsonView value={x.input ?? null} defaultExpandDepth={2} maxHeight="22rem" />
        ) : logs ? (
          <pre className="max-h-[22rem] overflow-auto rounded-md bg-sunken p-2.5 font-mono text-[11.5px] leading-relaxed text-fg">{logs}</pre>
        ) : (
          <p className="text-[12.5px] text-fg-subtle">Logs stored at {x.log_ref}.</p>
        )}
      </div>
    </section>
  );
}

function CircuitDetail({ session, stepId, group }: { session: SessionSummaryDto; stepId: string; group: StepGroup | undefined }) {
  const children = session.children.filter((c) => c.parent_step_id === stepId);
  const ids = new Set(children.map((c) => c.session_id));
  for (const a of group?.attempts ?? []) if (a.child_session_id && !ids.has(a.child_session_id)) children.push({ session_id: a.child_session_id, kind: 'circuit-run', circuit_uid: null, state: 'running', parent_step_id: stepId });
  if (!children.length) return <EmptyState icon={<Boxes size={20} />} title="No sub-session yet" description="The child circuit run appears here once it is started." compact />;
  return (
    <ul className="flex flex-col gap-2">
      {children.map((c) => (
        <li key={c.session_id} className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5">
          <SessionChip id={c.session_id} state={c.state} kind={c.kind} />
          {c.circuit_uid && <ConfigLink uid={c.circuit_uid} kind="circuit" />}
          <Link to="/s/$id" params={{ id: c.session_id }} className={cn(buttonClasses('secondary', 'xs'), 'ml-auto')}>
            Open sub-session <ArrowRight size={12} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function GateDetail({ session, stepId, events }: { session: SessionSummaryDto; stepId: string; events: SessionEvent[] }) {
  const artifacts = gateArtifacts(session, events, stepId);
  const verdicts = events.filter((e) => e.step_id === stepId && (e.event_type === 'gate-verdict' || e.event_type === 'gate-resolved'));
  const waiting = session.state === 'suspended-gate';
  return (
    <div className="flex flex-col gap-3">
      {waiting && <Callout tone="warn" title="Waiting on reviewers">Each targeted reviewer records approve or request-changes per artifact; the gate resolves on its own once verdicts are in.</Callout>}
      {artifacts.length ? (
        <ul className="flex flex-col gap-2">
          {artifacts.map((a) => (
            <li key={a.uid} className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5">
              <NodeChip uid={a.uid} revision={a.revision_id} />
              {waiting && (
                <Link to={nodePath(a.uid)} className={cn(buttonClasses('primary', 'xs'), 'ml-auto')}>
                  Go review <ArrowRight size={12} />
                </Link>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={<ShieldCheck size={20} />} title="No gated artifacts recorded" compact />
      )}
      {verdicts.length > 0 && <EventList events={verdicts} showStep={false} compact />}
    </div>
  );
}
