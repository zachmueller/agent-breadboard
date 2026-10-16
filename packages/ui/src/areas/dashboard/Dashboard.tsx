/**
 * Breadboard dashboard ([10] §2): need-input rate trend, spend vs. rate limit, gated/suspended
 * session counts, recent eval regressions, gateway fallbacks, connector status, and the
 * signed-in user's review queue.
 */
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, ArrowRight, CheckCircle2, ClipboardCheck, CloudOff, Gauge, Hourglass, Pause, Play, RefreshCw, ShieldAlert, TrendingDown } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useDashboard, useReviewQueue } from '../../lib/queries';
import { formatCost, formatNumber, pluralize } from '../../lib/format';
import { RUN_KINDS, TONE_CLASSES, type Tone } from '../../lib/states';
import { Badge, Callout, ConfigLink, EmptyState, ErrorState, NodeChip, PageBody, PageHeader, Panel, SessionChip, Skeleton, TimeAgo, Tooltip, buttonClasses, cn } from '../../components';
import { LineChart } from './LineChart';

// ----------------------------------------------------------------- shape ---

interface NeedInputSeries {
  series: Array<{ day: string; requests: number; deliverables: number; rate: number }>;
  by_circuit: Array<{ circuit_uid: string | null; requests: number; deliverables: number; rate: number }>;
}
interface Capacity {
  running: number;
  queued: number;
  max_concurrent_runs: number;
  spend_last_hour_usd: number;
  max_spend_usd_per_hour: number;
}
interface Regression {
  circuit_uid: string;
  eval_run_id: string;
  previous_run_id?: string;
  variant?: string | null;
  gate_min: number;
  previous: number;
  current: number;
  delta: number;
  at: string;
}
interface Fallback {
  at: string;
  from: string;
  to: string;
  reason: string;
}
interface Connector {
  tool_uid: string;
  slug: string;
  last_sync_at: string | null;
  last_error: string | null;
  running: boolean;
  doc_count: number;
  schedule_minutes: number;
}
export interface DashboardData {
  need_input: NeedInputSeries | null;
  capacity: Capacity | null;
  sessions: { gated: number; suspended_error: number; running: number; queued: number };
  regressions: Regression[];
  evals_running: number;
  gateway_fallbacks: Fallback[];
  connectors: Connector[];
  review_count: number;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : d);
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Tolerant normalization of `GET /dashboard` (each panel may be null when its subsystem failed). */
export function normalizeDashboard(raw: Record<string, unknown> | undefined): DashboardData {
  const r = raw ?? {};
  const ni = r.need_input as Partial<NeedInputSeries> | null | undefined;
  const cap = r.capacity as Partial<Capacity> | null | undefined;
  const s = (r.sessions ?? {}) as Record<string, unknown>;
  const ev = (r.evals ?? {}) as Record<string, unknown>;
  return {
    need_input: ni && Array.isArray(ni.series) ? { series: ni.series, by_circuit: arr(ni.by_circuit) } : null,
    capacity: cap
      ? {
          running: num(cap.running),
          queued: num(cap.queued),
          max_concurrent_runs: num(cap.max_concurrent_runs),
          spend_last_hour_usd: num(cap.spend_last_hour_usd ?? (cap as Record<string, unknown>).spent_usd_window),
          max_spend_usd_per_hour: num(cap.max_spend_usd_per_hour),
        }
      : null,
    sessions: { gated: num(s.gated ?? s['suspended-gate']), suspended_error: num(s.suspended_error ?? s['suspended-error']), running: num(s.running), queued: num(s.queued) },
    regressions: arr<Regression>(ev.regressions),
    evals_running: num(ev.running),
    gateway_fallbacks: arr<Fallback>(r.gateway_fallbacks),
    connectors: arr<Connector>(r.connectors),
    review_count: num(r.review_count),
  };
}

// ------------------------------------------------------------ components ---

function Meter({ value, max, tone, label }: { value: number; max: number; tone: Tone; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="h-2 w-full overflow-hidden rounded-full bg-sunken">
      <div className={cn('h-full rounded-full transition-[width] duration-500', TONE_CLASSES[tone].dot)} style={{ width: `${pct}%` }} />
    </div>
  );
}

function usageTone(frac: number): Tone {
  return frac >= 0.9 ? 'danger' : frac >= 0.7 ? 'warn' : 'ok';
}

function StatTile({ to, search, icon, label, value, tone, hint }: { to: string; search?: Record<string, string>; icon: ReactNode; label: string; value: number; tone: Tone; hint: string }) {
  const hot = value > 0 && (tone === 'warn' || tone === 'danger');
  return (
    <Link
      to={to}
      search={search as never}
      className={cn(
        'group flex flex-col gap-2 rounded-lg border bg-surface p-4 transition-colors hover:border-line-strong',
        hot ? cn(TONE_CLASSES[tone].border, 'border-l-[3px]') : 'border-line',
      )}
    >
      <div className="flex items-center gap-2 text-[12.5px] text-fg-muted">
        <span className={cn('flex', value > 0 ? TONE_CLASSES[tone].text : 'text-fg-subtle')}>{icon}</span>
        <span className="flex-1">{label}</span>
        <ArrowRight size={13} className="text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
      </div>
      <div className={cn('text-[26px] font-semibold leading-none tracking-tight', value > 0 && hot ? TONE_CLASSES[tone].text : 'text-fg')}>{formatNumber(value)}</div>
      <div className="text-[11.5px] text-fg-subtle">{hint}</div>
    </Link>
  );
}

function NeedInputPanel({ data }: { data: NeedInputSeries | null }) {
  if (!data) return <Panel title="Need-input rate">{<EmptyState compact title="Metric unavailable" description="The need-input health metric could not be computed." />}</Panel>;
  const totalReq = data.series.reduce((a, s) => a + s.requests, 0);
  const totalDel = data.series.reduce((a, s) => a + s.deliverables, 0);
  const overall = totalReq / Math.max(totalDel, 1);
  const half = Math.floor(data.series.length / 2);
  const rate = (xs: typeof data.series) => xs.reduce((a, s) => a + s.requests, 0) / Math.max(xs.reduce((a, s) => a + s.deliverables, 0), 1);
  const prev = rate(data.series.slice(0, half));
  const recent = rate(data.series.slice(half));
  const delta = recent - prev;
  const topCircuits = [...data.by_circuit].filter((c) => c.requests > 0).sort((a, b) => b.rate - a.rate).slice(0, 5);
  return (
    <Panel
      title="Need-input rate"
      description="Need-input requests per deliverable, daily · last 30 days. Lower means circuits run more autonomously."
      actions={
        <div className="text-right">
          <div className="text-lg font-semibold leading-none tabular">{overall.toFixed(2)}</div>
          <div className={cn('mt-0.5 text-[11.5px]', delta > 0.005 ? 'text-warn-fg' : delta < -0.005 ? 'text-ok-fg' : 'text-fg-subtle')}>
            {Math.abs(delta) < 0.005 ? 'flat vs. prior 15d' : `${delta > 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(2)} vs. prior 15d`}
          </div>
        </div>
      }
    >
      {totalReq === 0 && totalDel === 0 ? (
        <EmptyState compact title="No activity yet" description="Requests and deliverables will chart here once circuits start producing content." />
      ) : (
        <LineChart
          label={`Need-input rate over the last ${data.series.length} days; currently ${overall.toFixed(2)} requests per deliverable`}
          points={data.series.map((s) => ({
            x: s.day,
            y: s.rate,
            detail: [
              { label: 'Requests', value: formatNumber(s.requests) },
              { label: 'Deliverables', value: formatNumber(s.deliverables) },
            ],
          }))}
        />
      )}
      {topCircuits.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Highest by circuit</div>
          <table className="w-full text-[12.5px]">
            <thead className="sr-only">
              <tr>
                <th>Circuit</th>
                <th>Requests</th>
                <th>Deliverables</th>
                <th>Rate</th>
              </tr>
            </thead>
            <tbody>
              {topCircuits.map((c) => (
                <tr key={c.circuit_uid ?? 'none'} className="h-7">
                  <td className="max-w-0 truncate pr-2">{c.circuit_uid ? <ConfigLink uid={c.circuit_uid} kind="circuit" /> : <span className="text-fg-subtle">Ad-hoc (no circuit)</span>}</td>
                  <td className="w-24 text-right text-fg-muted tabular">{pluralize(c.requests, 'request')}</td>
                  <td className="w-28 text-right text-fg-muted tabular">{pluralize(c.deliverables, 'deliverable')}</td>
                  <td className="w-14 text-right font-medium tabular">{c.rate.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function CapacityPanel({ cap }: { cap: Capacity | null }) {
  if (!cap) return <Panel title="Spend & capacity">{<EmptyState compact title="Dispatcher unavailable" description="Capacity metrics could not be read." />}</Panel>;
  const spendFrac = cap.max_spend_usd_per_hour > 0 ? cap.spend_last_hour_usd / cap.max_spend_usd_per_hour : 0;
  const runFrac = cap.max_concurrent_runs > 0 ? cap.running / cap.max_concurrent_runs : 0;
  const spendTone = usageTone(spendFrac);
  const runTone = usageTone(runFrac);
  return (
    <Panel title="Spend & capacity" description="Breadboard-level ceilings that bound auto-dispatch.">
      <div className="flex flex-col gap-5">
        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px]">
            <span className="text-fg-muted">Spend, last hour</span>
            <span>
              <span className="font-semibold tabular">{formatCost(cap.spend_last_hour_usd)}</span>
              <span className="text-fg-subtle"> / {cap.max_spend_usd_per_hour > 0 ? `${formatCost(cap.max_spend_usd_per_hour)} per hour` : 'no limit'}</span>
            </span>
          </div>
          <Meter value={cap.spend_last_hour_usd} max={cap.max_spend_usd_per_hour || cap.spend_last_hour_usd || 1} tone={spendTone} label="Spend against hourly rate limit" />
          {spendFrac >= 0.9 && (
            <p className="mt-1.5 flex items-center gap-1 text-[12px] text-danger-fg">
              <AlertTriangle size={12} aria-hidden /> Near the rate limit — new runs will wait for the window to roll.
            </p>
          )}
        </div>
        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px]">
            <span className="text-fg-muted">Concurrent runs</span>
            <span>
              <span className="font-semibold tabular">{cap.running}</span>
              <span className="text-fg-subtle"> / {cap.max_concurrent_runs} max</span>
            </span>
          </div>
          <Meter value={cap.running} max={cap.max_concurrent_runs || 1} tone={runTone} label="Running sessions against max concurrency" />
        </div>
        <div className="flex items-center justify-between rounded-md bg-sunken px-3 py-2 text-[12.5px]">
          <span className="text-fg-muted">Waiting for capacity</span>
          <Link to="/sessions" search={{ state: 'queued' } as never} className="font-medium hover:text-accent-text hover:underline">
            {pluralize(cap.queued, 'queued session')}
          </Link>
        </div>
      </div>
    </Panel>
  );
}

function RegressionsPanel({ items, running }: { items: Regression[]; running: number }) {
  return (
    <Panel title="Recent eval regressions" description="Runs whose mean score fell below the circuit's gate minimum." actions={running > 0 ? <Badge tone="info" icon={<RefreshCw size={11} />}>{running} running</Badge> : undefined} bodyClassName="p-0">
      {items.length === 0 ? (
        <EmptyState compact icon={<CheckCircle2 size={18} />} title="No regressions" description="All circuits are scoring at or above their gates." className="py-8" />
      ) : (
        <ul className="divide-y divide-line">
          {items.slice(0, 6).map((r) => (
            <li key={r.eval_run_id} className="flex items-center gap-3 px-4 py-2.5">
              <TrendingDown size={15} className="shrink-0 text-danger-fg" aria-hidden />
              <div className="min-w-0 flex-1">
                <ConfigLink uid={r.circuit_uid} kind="circuit" />
                <div className="text-[11.5px] text-fg-subtle">
                  {r.previous.toFixed(2)} → <span className="font-medium text-danger-fg">{r.current.toFixed(2)}</span> · gate {r.gate_min.toFixed(2)}
                  {r.variant ? ` · ${r.variant}` : ''}
                </div>
              </div>
              <span className="text-[12px] font-medium text-danger-fg tabular">{r.delta.toFixed(2)}</span>
              <TimeAgo at={r.at} className="w-16 text-right text-[11.5px] text-fg-subtle" />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function FallbacksPanel({ items }: { items: Fallback[] }) {
  const recent = [...items].reverse().slice(0, 6);
  return (
    <Panel title="Model gateway fallbacks" description="Calls served by a fallback model after the preferred one failed." bodyClassName="p-0">
      {recent.length === 0 ? (
        <EmptyState compact icon={<CheckCircle2 size={18} />} title="No fallbacks" description="Every call was served by its preferred model." className="py-8" />
      ) : (
        <ul className="divide-y divide-line">
          {recent.map((f, i) => (
            <li key={i} className="flex items-start gap-3 px-4 py-2.5">
              <ShieldAlert size={15} className="mt-0.5 shrink-0 text-warn-fg" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12px]">
                  {f.from} <span className="text-fg-subtle">→</span> {f.to}
                </div>
                <div className="truncate text-[11.5px] text-fg-subtle" title={f.reason}>
                  {f.reason}
                </div>
              </div>
              <TimeAgo at={f.at} className="shrink-0 text-[11.5px] text-fg-subtle" />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ConnectorsPanel({ items }: { items: Connector[] }) {
  return (
    <Panel title="Knowledge connectors" bodyClassName="p-0">
      {items.length === 0 ? (
        <EmptyState compact title="No connectors" description="Connector tools sync external sources into Knowledge." className="py-8" />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((c) => (
            <li key={c.tool_uid} className="flex items-center gap-3 px-4 py-2.5">
              {c.last_error ? <CloudOff size={15} className="shrink-0 text-danger-fg" aria-label="Error" /> : c.running ? <RefreshCw size={15} className="shrink-0 animate-spin text-info-fg" aria-label="Syncing" /> : <CheckCircle2 size={15} className="shrink-0 text-ok-fg" aria-label="Healthy" />}
              <div className="min-w-0 flex-1">
                <ConfigLink uid={c.tool_uid} slug={c.slug} kind="tool" icon={false} />
                {c.last_error ? (
                  <div className="truncate text-[11.5px] text-danger-fg" title={c.last_error}>
                    {c.last_error}
                  </div>
                ) : (
                  <div className="text-[11.5px] text-fg-subtle">
                    {pluralize(c.doc_count, 'doc')} · every {c.schedule_minutes}m
                  </div>
                )}
              </div>
              <span className="shrink-0 text-[11.5px] text-fg-subtle">{c.running ? 'Syncing…' : c.last_sync_at ? <TimeAgo at={c.last_sync_at} /> : 'Never synced'}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ReviewPanel() {
  const q = useReviewQueue();
  const items = q.data ?? [];
  return (
    <Panel
      title="Your review queue"
      description="Need-input requests and gates targeted at you or your roles."
      bodyClassName="p-0"
      actions={
        <Link to="/content/review" className={buttonClasses('ghost', 'xs')}>
          Open queue <ArrowRight size={12} />
        </Link>
      }
    >
      {q.isPending ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      ) : q.error ? (
        <ErrorState compact error={q.error} onRetry={() => q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState compact icon={<ClipboardCheck size={18} />} title="All caught up" description="Nothing is waiting on you." className="py-8" />
      ) : (
        <ul className="divide-y divide-line">
          {items.slice(0, 7).map((it) => {
            const reqs = it.requests as Array<{ request_id?: string; prompt?: string | null; gate?: unknown }>;
            const gated = !!it.gating_session || reqs.some((r) => r.gate);
            const prompt = reqs.find((r) => r.prompt)?.prompt;
            return (
              <li key={it.node.uid} className={cn('flex items-center gap-3 px-4 py-2.5', gated && 'bg-warn-soft/40')}>
                <div className="min-w-0 flex-1">
                  <NodeChip uid={it.node.uid} title={it.node.title} type={it.node.type} />
                  {prompt && <div className="mt-0.5 truncate text-[12px] text-fg-muted">{prompt}</div>}
                </div>
                {gated ? (
                  <Tooltip content="A gated session is suspended until you record a verdict">
                    <Badge tone="warn" variant="solid" icon={<Pause size={11} />}>
                      Gate
                    </Badge>
                  </Tooltip>
                ) : (
                  <Badge tone="neutral">{pluralize(reqs.length, 'request')}</Badge>
                )}
                {it.gating_session && <SessionChip id={it.gating_session.session_id} state={it.gating_session.state} />}
              </li>
            );
          })}
          {items.length > 7 && (
            <li className="px-4 py-2 text-center text-[12px]">
              <Link to="/content/review" className="text-accent-text hover:underline">
                {items.length - 7} more
              </Link>
            </li>
          )}
        </ul>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ page ---

export function Dashboard() {
  const q = useDashboard();
  const { user, teamName } = useAuth();
  const d = normalizeDashboard(q.data);
  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  })();

  return (
    <PageBody>
      <PageHeader
        title={`${greeting}${user?.display_name ? `, ${user.display_name.split(' ')[0]}` : ''}`}
        subtitle={teamName ? `${teamName} Breadboard health` : 'Breadboard health'}
        icon={<Gauge size={18} />}
        actions={
          <span className="text-[12px] text-fg-subtle">
            {q.isFetching ? 'Refreshing…' : q.dataUpdatedAt ? (
              <>
                Updated <TimeAgo at={new Date(q.dataUpdatedAt).toISOString()} />
              </>
            ) : null}
          </span>
        }
      />
      {q.error && !q.data ? (
        <ErrorState error={q.error} title="Couldn't load the dashboard" onRetry={() => q.refetch()} className="py-16" />
      ) : (
        <div className="flex flex-col gap-4">
          {d.sessions.gated > 0 && (
            <Callout
              tone="warn"
              title={`${pluralize(d.sessions.gated, 'session')} awaiting review`}
              action={
                <Link to="/content/review" className={buttonClasses('secondary', 'sm')}>
                  Review now
                </Link>
              }
            >
              Gated runs hold no capacity, but their downstream work is blocked until reviewers record verdicts.
            </Callout>
          )}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {q.isPending ? (
              [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[106px] rounded-lg" />)
            ) : (
              <>
                <StatTile to="/sessions" search={{ state: 'suspended-gate' }} icon={<Pause size={15} />} label="Awaiting review" value={d.sessions.gated} tone="warn" hint="Suspended at a hard gate" />
                <StatTile to="/sessions" search={{ state: 'suspended-error' }} icon={<AlertTriangle size={15} />} label="Suspended · error" value={d.sessions.suspended_error} tone="danger" hint="Retries exhausted or budget exceeded" />
                <StatTile to="/sessions" search={{ state: 'running', kind: RUN_KINDS }} icon={<Play size={15} />} label="Running" value={d.sessions.running} tone="info" hint="Actively stepping" />
                <StatTile to="/sessions" search={{ state: 'queued' }} icon={<Hourglass size={15} />} label="Queued" value={d.sessions.queued} tone="neutral" hint="Waiting for capacity" />
              </>
            )}
          </div>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            {q.isPending ? <Skeleton className="h-[300px] rounded-lg" /> : <NeedInputPanel data={d.need_input} />}
            {q.isPending ? <Skeleton className="h-[300px] rounded-lg" /> : <CapacityPanel cap={d.capacity} />}
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <ReviewPanel />
            {q.isPending ? <Skeleton className="h-[220px] rounded-lg" /> : <RegressionsPanel items={d.regressions} running={d.evals_running} />}
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            {q.isPending ? <Skeleton className="h-[180px] rounded-lg" /> : <FallbacksPanel items={d.gateway_fallbacks} />}
            {q.isPending ? <Skeleton className="h-[180px] rounded-lg" /> : <ConnectorsPanel items={d.connectors} />}
          </div>
        </div>
      )}
    </PageBody>
  );
}
