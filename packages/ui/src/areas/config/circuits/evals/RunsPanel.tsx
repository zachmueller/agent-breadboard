/**
 * Eval run launcher, runs table, run detail (fixture × dimension), and score trend ([04] §4, §6, §8).
 */
import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, X } from 'lucide-react';
import { useWorkingTree } from '../../model/workingTree';
import { Btn, Pill, SelectInput, Field, ErrorBox, Spin, errorMessage, notify, type Tone } from '../../ui';
import { AppLink } from '../../components/AppLink';
import { Pager } from '../../../../components';
import { evalsApi, qk, isRunTerminal, useHistory, usePresets, type EvalRunDto, type EvalResultRow } from '../../lib/configApi';
import { shortCommit, fmtRelative, fmtDate, fmtUsd, fmtPct, fmtScore } from '../../lib/format';
import { parseYamlValue } from '../../lib/yamlDoc';
import { fixturesPathOf, showValue, passOf } from './shared';
import { TrendChart } from '../TrendChart';
import type { TrendPoint } from '../trendModel';

export function statusTone(s: string): Tone {
  if (s === 'completed') return 'ok';
  if (s === 'failed' || s === 'error' || s === 'cancelled') return 'danger';
  if (s === 'running' || s === 'queued') return 'info';
  return 'neutral';
}

export function variantLabel(run: Pick<EvalRunDto, 'model_overrides' | 'raw'>): string {
  const v = run.raw?.variant;
  if (typeof v === 'string' && v) return v;
  const o = run.model_overrides;
  if (!o || !Object.keys(o).length) return 'preset-default';
  return Object.keys(o).sort().map((k) => `${k}=${o[k]}`).join(',');
}

const RUNS_PAGE = 25;

export function RunsPanel({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  const wt = useWorkingTree();
  const [page, setPage] = useState(1);
  const runsQ = useQuery({
    queryKey: [...qk.runs(wt.uid), 'page', page],
    queryFn: () => evalsApi.runPage({ circuit: wt.uid, limit: RUNS_PAGE }, (page - 1) * RUNS_PAGE),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => ((q.state.data?.items ?? []).some((r: EvalRunDto) => !isRunTerminal(r.status)) ? 3000 : false),
  });
  const trendQ = useQuery({
    queryKey: ['evals', 'analysis', wt.uid, 'trend', runsQ.dataUpdatedAt],
    queryFn: () => evalsApi.analysis<{ variants: string[]; points: TrendPoint[] }>(wt.uid, 'trend'),
    retry: false,
  });
  const runs = runsQ.data?.items ?? [];

  return (
    <div className="space-y-4">
      <RunLauncher />
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">Score over time</h3>
        {trendQ.isLoading ? (
          <Spin />
        ) : trendQ.error ? (
          <ErrorBox error={trendQ.error} onRetry={() => trendQ.refetch()} title="Trend unavailable" />
        ) : (trendQ.data?.points ?? []).length === 0 ? (
          <div className="rounded-md border border-dashed border-line p-4 text-center text-xs text-fg-subtle">No completed runs yet. Launch one above.</div>
        ) : (
          <TrendChart points={trendQ.data!.points} variants={trendQ.data!.variants} selectedRun={selected} onSelectRun={(id) => onSelect(id)} />
        )}
      </section>
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">Runs</h3>
        {runsQ.isLoading ? (
          <Spin />
        ) : runsQ.error ? (
          <ErrorBox error={runsQ.error} onRetry={() => runsQ.refetch()} />
        ) : runs.length === 0 ? (
          <div className="rounded-md border border-dashed border-line p-4 text-center text-xs text-fg-subtle">No eval runs for this circuit.</div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full text-xs">
              <thead className="bg-sunken text-left text-fg-muted">
                <tr>
                  {['When', 'Status', 'Circuit', 'Variant', 'Tags', 'Mean', 'Pass', 'Cost', 'Proposal'].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.eval_run_id}
                    tabIndex={0}
                    aria-selected={selected === r.eval_run_id}
                    onClick={() => onSelect(selected === r.eval_run_id ? null : r.eval_run_id)}
                    onKeyDown={(e) => e.key === 'Enter' && onSelect(r.eval_run_id)}
                    className={`cursor-pointer border-t border-line hover:bg-hover ${selected === r.eval_run_id ? 'bg-accent-soft' : ''}`}
                  >
                    <td className="whitespace-nowrap px-2 py-1.5" title={fmtDate(r.created_at)}>
                      {fmtRelative(r.created_at)}
                    </td>
                    <td className="px-2 py-1.5">
                      <Pill tone={statusTone(r.status)}>
                        {!isRunTerminal(r.status) && <Spin className="mr-1 size-3" />}
                        {r.status}
                      </Pill>
                    </td>
                    <td className="px-2 py-1.5 font-mono">{shortCommit(r.circuit_commit)}</td>
                    <td className="max-w-48 truncate px-2 py-1.5 font-mono" title={variantLabel(r)}>
                      {variantLabel(r)}
                    </td>
                    <td className="px-2 py-1.5">{r.fixture_tags.length ? r.fixture_tags.join(', ') : <span className="text-fg-subtle">all</span>}</td>
                    <td className="px-2 py-1.5 tabular-nums">{fmtScore(r.aggregate)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{r.pass_rate == null ? <span className="text-fg-subtle" title="Rubric has no gate">–</span> : fmtPct(r.pass_rate)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{fmtUsd(r.cost_usd)}</td>
                    <td className="px-2 py-1.5 font-mono">{r.proposal_id ? <span title={r.proposal_id}>{r.proposal_id.slice(0, 10)}…</span> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(runsQ.data?.total ?? 0) > RUNS_PAGE && <Pager page={page} size={RUNS_PAGE} total={runsQ.data!.total} shown={runs.length} loading={runsQ.isPlaceholderData} onPage={setPage} />}
      </section>
      {selected && <RunDetail id={selected} onClose={() => onSelect(null)} />}
    </div>
  );
}

function RunLauncher() {
  const wt = useWorkingTree();
  const qc = useQueryClient();
  const history = useHistory(wt.historyPath, 30);
  const presets = usePresets();
  const [ref, setRef] = useState('main');
  const [tags, setTags] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const fixturesText = wt.getFile(fixturesPathOf(wt) ?? '');
  const fixtureTags = useMemo(() => {
    const p = fixturesText ? parseYamlValue(fixturesText) : null;
    const list: any[] = p?.ok ? ((p.value as any)?.fixtures ?? []) : [];
    return [...new Set(list.filter((f) => !f?.retired).flatMap((f) => (Array.isArray(f?.tags) ? f.tags : [])))].sort() as string[];
  }, [fixturesText]);
  const presetMap = presets.data?.presets ?? {};
  const dirty = wt.state.dirty.size > 0;

  const launch = async () => {
    setBusy(true);
    setErr(null);
    try {
      const mo = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v));
      const r = await evalsApi.launch({ circuit: wt.uid, ref: ref || undefined, fixture_tags: tags.length ? tags : undefined, model_overrides: Object.keys(mo).length ? mo : undefined });
      notify(`Eval run ${r.eval_run_id || ''} started`, 'ok');
      await qc.invalidateQueries({ queryKey: qk.runs(wt.uid) });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-md border border-line p-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Launch eval run</h3>
        <Btn size="xs" variant="primary" className="ml-auto" icon={<Play className="size-3.5" />} loading={busy} onClick={launch}>
          Run evals
        </Btn>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Config version" hint="Fixtures execute fresh at this commit.">
          <SelectInput value={ref} onChange={(e) => setRef(e.target.value)} className="font-mono">
            <option value="main">main (latest)</option>
            {(history.data ?? []).map((h) => (
              <option key={h.commit} value={h.commit}>
                {shortCommit(h.commit)} {h.message.slice(0, 48)}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Fixture tags" hint={fixtureTags.length ? 'None checked = all active fixtures.' : 'No tagged fixtures.'}>
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-xs">
            {fixtureTags.map((t) => (
              <label key={t} className="flex items-center gap-1 font-mono">
                <input type="checkbox" checked={tags.includes(t)} onChange={(e) => setTags(e.target.checked ? [...tags, t] : tags.filter((x) => x !== t))} />
                {t}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Model overrides" hint="Pin a preset to one model to compare options.">
          <div className="space-y-1">
            {Object.keys(presetMap).length === 0 && <div className="text-xs text-fg-subtle">No presets defined.</div>}
            {Object.entries(presetMap).map(([name, opts]) => (
              <label key={name} className="flex items-center gap-2 text-xs">
                <span className="w-16 font-mono">{name}</span>
                <SelectInput value={overrides[name] ?? ''} onChange={(e) => setOverrides({ ...overrides, [name]: e.target.value })} className="flex-1 font-mono text-xs">
                  <option value="">preset default</option>
                  {(opts ?? []).map((o) => (
                    <option key={o.model_id} value={o.model_id}>
                      {o.model_id}
                    </option>
                  ))}
                </SelectInput>
              </label>
            ))}
          </div>
        </Field>
      </div>
      {dirty && <div className="mt-2 rounded bg-warn-soft px-2 py-1 text-xs text-warn-fg">You have uncommitted edits. Eval runs execute committed config only; commit first to evaluate them.</div>}
      {err != null && <div className="mt-2 text-xs text-danger-fg">{errorMessage(err)}</div>}
    </section>
  );
}

/** Pivot result rows into fixture × dimension with the aggregate row separated. */
export function pivotResults(rows: EvalResultRow[]) {
  const dims: string[] = [];
  const byFixture = new Map<string, { fixture_id: string; session: string | null; cells: Map<string, EvalResultRow>; aggregate: EvalResultRow | null; cost: number }>();
  for (const r of rows) {
    let f = byFixture.get(r.fixture_id);
    if (!f) byFixture.set(r.fixture_id, (f = { fixture_id: r.fixture_id, session: r.scored_session, cells: new Map(), aggregate: null, cost: 0 }));
    f.session ??= r.scored_session;
    f.cost += r.cost_usd ?? 0;
    if (r.dimension === '*') f.aggregate = r;
    else {
      if (!dims.includes(r.dimension)) dims.push(r.dimension);
      f.cells.set(r.dimension, r);
    }
  }
  return { dims, fixtures: [...byFixture.values()] };
}

function RunDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: qk.run(id), queryFn: () => evalsApi.run(id), refetchInterval: (qq) => (qq.state.data && !isRunTerminal(qq.state.data.status) ? 3000 : false) });
  const [cell, setCell] = useState<EvalResultRow | null>(null);
  if (q.isLoading) return <Spin />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const run = q.data!;
  const { dims, fixtures } = pivotResults(run.results);
  const errors: Array<{ fixture_id: string; error: string }> = ((run.raw?.summary as any)?.errors ?? []) as any;
  return (
    <section className="rounded-md border border-line">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs">
        <span className="font-semibold">Run</span>
        <span className="font-mono">{run.eval_run_id}</span>
        <Pill tone={statusTone(run.status)}>{run.status}</Pill>
        <span className="text-fg-muted">
          circuit <span className="font-mono">{shortCommit(run.circuit_commit)}</span> · rubric <span className="font-mono">{shortCommit(run.rubric_commit)}</span> · judge <span className="font-mono">{run.judge_model_id ?? '–'}</span> · {variantLabel(run)}
        </span>
        <span className="ml-auto tabular-nums">
          mean {fmtScore(run.aggregate)} · pass {run.pass_rate == null ? '–' : fmtPct(run.pass_rate)} · {fmtUsd(run.cost_usd)}
        </span>
        <button type="button" aria-label="Close run detail" className="rounded p-0.5 hover:bg-hover" onClick={onClose}>
          <X className="size-3.5" />
        </button>
      </div>
      {errors.length > 0 && (
        <div className="border-b border-line bg-danger-soft px-3 py-1.5 text-xs text-danger-fg">
          {errors.map((e) => (
            <div key={e.fixture_id}>
              <span className="font-mono">{e.fixture_id}</span>: {e.error}
            </div>
          ))}
        </div>
      )}
      {fixtures.length === 0 ? (
        <div className="p-4 text-center text-xs text-fg-subtle">{isRunTerminal(run.status) ? 'No results recorded.' : 'Scoring in progress…'}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-sunken text-left text-fg-muted">
              <tr>
                <th className="px-2 py-1.5 font-medium">Fixture</th>
                <th className="px-2 py-1.5 font-medium">Session</th>
                {dims.map((d) => (
                  <th key={d} className="px-2 py-1.5 font-mono font-medium">
                    {d}
                  </th>
                ))}
                <th className="px-2 py-1.5 font-medium">Aggregate</th>
                <th className="px-2 py-1.5 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {fixtures.map((f) => (
                <tr key={f.fixture_id} className="border-t border-line align-top">
                  <td className="px-2 py-1.5 font-mono">{f.fixture_id}</td>
                  <td className="px-2 py-1.5 font-mono">{f.session ? <AppLink href={`/s/${f.session}`} className="text-accent-text hover:underline">{f.session.slice(0, 10)}…</AppLink> : '–'}</td>
                  {dims.map((d) => {
                    const c = f.cells.get(d);
                    const p = c ? passOf(c.value) : null;
                    return (
                      <td key={d} className="px-2 py-1.5">
                        {c ? (
                          <button type="button" onClick={() => setCell(cell === c ? null : c)} className={`rounded px-1 text-left tabular-nums hover:bg-hover ${p === false ? 'text-danger-fg' : ''} ${cell === c ? 'ring-1 ring-accent' : ''}`} title={c.rationale ?? undefined}>
                            {showValue(c.value)}
                          </button>
                        ) : (
                          <span className="text-fg-subtle">–</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5 tabular-nums">{f.aggregate ? showValue(f.aggregate.value) : '–'}</td>
                  <td className="px-2 py-1.5 tabular-nums">{fmtUsd(f.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cell && (
        <div className="border-t border-line bg-sunken px-3 py-2 text-xs">
          <div className="mb-1 font-medium">
            <span className="font-mono">{cell.fixture_id}</span> · <span className="font-mono">{cell.dimension}</span> ({cell.dim_type}) = {showValue(cell.value)}
          </div>
          <p className="whitespace-pre-wrap text-fg-muted">{cell.rationale || 'No rationale recorded.'}</p>
        </div>
      )}
    </section>
  );
}
