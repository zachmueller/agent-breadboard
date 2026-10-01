/**
 * Built-in analysis views over the results store ([04] §6): model-regression, cheapest-sufficient-model,
 * circuit-change regression. The score trend lives in the Runs panel.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useWorkingTree } from '../../model/workingTree';
import { Pill, SelectInput, Spin, ErrorBox, TabBar, Field } from '../../ui';
import { AppLink } from '../../components/AppLink';
import { evalsApi, qk, latestFirst } from '../../lib/configApi';
import { shortCommit, fmtUsd, fmtPct, fmtScore, fmtRelative } from '../../lib/format';
import { variantLabel } from './RunsPanel';

type View = 'cheapest-model' | 'model-regression' | 'circuit-regression';

export function fmtDelta(d: number | null | undefined, digits = 2): string {
  if (d == null || Number.isNaN(d)) return '–';
  const s = d.toFixed(digits);
  return d > 0 ? `+${s}` : s;
}

function Delta({ d, digits = 2, invert }: { d: number | null | undefined; digits?: number; invert?: boolean }) {
  const bad = d != null && (invert ? d > 0 : d < 0) && Math.abs(d) >= 10 ** -digits;
  return <span className={`tabular-nums ${bad ? 'text-danger-fg' : ''}`}>{fmtDelta(d, digits)}</span>;
}

const Th = ({ children }: { children?: React.ReactNode }) => <th className="whitespace-nowrap px-2 py-1.5 text-left font-medium">{children}</th>;
const Td = ({ children, className = '' }: { children?: React.ReactNode; className?: string }) => <td className={`px-2 py-1.5 ${className}`}>{children}</td>;

export function AnalysisPanel() {
  const [view, setView] = useState<View>('cheapest-model');
  return (
    <div className="space-y-3">
      <TabBar
        tabs={[
          { id: 'cheapest-model', label: 'Cheapest sufficient model' },
          { id: 'model-regression', label: 'Model regression' },
          { id: 'circuit-regression', label: 'Circuit-change regression' },
        ]}
        value={view}
        onChange={setView}
      />
      {view === 'cheapest-model' && <CheapestModel />}
      {view === 'model-regression' && <ModelRegression />}
      {view === 'circuit-regression' && <CircuitRegression />}
    </div>
  );
}

function useAnalysis<T>(view: View, params: Record<string, string | undefined> = {}) {
  const wt = useWorkingTree();
  return useQuery({ queryKey: ['evals', 'analysis', wt.uid, view, params], queryFn: () => evalsApi.analysis<T>(wt.uid, view, params), retry: false });
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border border-dashed border-line p-3 text-xs text-fg-muted">{children}</div>;
}

/* ------------------------------------------------------------------ cheapest */

interface CheapestRow {
  variant: string;
  label: string;
  model_overrides: Record<string, string> | null;
  runs: number;
  fixtures: number;
  mean_aggregate: number | null;
  pass_rate: number | null;
  mean_session_cost_usd: number | null;
  passes_gate: boolean | null;
  latest_run: string | null;
}

function CheapestModel() {
  const q = useAnalysis<{ baseline?: any; gate_min: number | null; rows: CheapestRow[]; cheapest_passing: string | CheapestRow | null; note?: string }>('cheapest-model');
  if (q.isLoading) return <Spin />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const cheapest = typeof d.cheapest_passing === 'string' ? d.cheapest_passing : (d.cheapest_passing?.variant ?? null);
  const rows = [...(d.rows ?? [])].sort((a, b) => (a.mean_session_cost_usd ?? Infinity) - (b.mean_session_cost_usd ?? Infinity));
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-muted">
        Preset option × aggregate score × mean session cost, at the latest comparable circuit + rubric + judge. Gate: <span className="font-mono">{d.gate_min ?? 'none'}</span>.
        {d.baseline?.circuit_commit && (
          <>
            {' '}
            Circuit <span className="font-mono">{shortCommit(d.baseline.circuit_commit)}</span>, rubric <span className="font-mono">{shortCommit(d.baseline.rubric_commit)}</span>, judge <span className="font-mono">{d.baseline.judge_model_id}</span>.
          </>
        )}
      </p>
      {d.note && <Note>{d.note}</Note>}
      {rows.length === 0 ? (
        <Note>No comparable runs. Launch runs with different model overrides to populate this matrix.</Note>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full text-xs">
            <thead className="bg-sunken text-fg-muted">
              <tr>
                <Th>Option</Th>
                <Th>Runs</Th>
                <Th>Fixtures</Th>
                <Th>Mean aggregate</Th>
                <Th>Pass rate</Th>
                <Th>Mean session cost</Th>
                <Th>Gate</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const best = r.variant === cheapest;
                return (
                  <tr key={r.variant} className={`border-t border-line ${best ? 'bg-ok-soft font-medium' : ''}`}>
                    <Td className="font-mono">
                      {r.label || r.variant}
                      {best && (
                        <Pill tone="ok" className="ml-2">
                          cheapest passing
                        </Pill>
                      )}
                    </Td>
                    <Td className="tabular-nums">{r.runs}</Td>
                    <Td className="tabular-nums">{r.fixtures}</Td>
                    <Td className="tabular-nums">{fmtScore(r.mean_aggregate)}</Td>
                    <Td className="tabular-nums">{r.pass_rate == null ? '–' : fmtPct(r.pass_rate)}</Td>
                    <Td className="tabular-nums">{fmtUsd(r.mean_session_cost_usd)}</Td>
                    <Td>{r.passes_gate == null ? <span className="text-fg-subtle">no gate</span> : r.passes_gate ? <Pill tone="ok">passes</Pill> : <Pill tone="danger">below gate</Pill>}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 0 && !cheapest && d.gate_min != null && <Note>No option meets the gate ({d.gate_min}).</Note>}
    </div>
  );
}

/* ------------------------------------------------------------------ model regression */

interface MrVariant {
  variant: string;
  model_overrides: Record<string, string> | null;
  runs: number;
  fixtures: number;
  mean_aggregate: number | null;
  pass_rate: number | null;
  mean_session_cost_usd: number | null;
  per_dimension: Record<string, number | null>;
  delta_vs_baseline: { aggregate: number | null; per_dimension: Record<string, number | null> } | null;
  regression: boolean;
}
interface MrGroup {
  circuit_commit: string;
  rubric_commit: string;
  judge_model_id: string;
  gate_min: number | null;
  latest_at: string;
  baseline: string | null;
  variants: MrVariant[];
}

function ModelRegression() {
  const q = useAnalysis<{ groups: MrGroup[]; note?: string }>('model-regression');
  if (q.isLoading) return <Spin />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const groups = q.data?.groups ?? [];
  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted">Same circuit commit + rubric commit + judge, compared across model overrides. Deltas are against the baseline variant of each group.</p>
      {q.data?.note && <Note>{q.data.note}</Note>}
      {groups.length === 0 && <Note>No completed runs to compare.</Note>}
      {groups.map((g) => {
        const dims = [...new Set(g.variants.flatMap((v) => Object.keys(v.per_dimension ?? {})))];
        return (
          <div key={`${g.circuit_commit}:${g.rubric_commit}:${g.judge_model_id}`} className="rounded-md border border-line">
            <div className="flex flex-wrap gap-x-3 border-b border-line bg-sunken px-3 py-1.5 text-xs text-fg-muted">
              <span>
                circuit <span className="font-mono text-fg">{shortCommit(g.circuit_commit)}</span>
              </span>
              <span>
                rubric <span className="font-mono text-fg">{shortCommit(g.rubric_commit)}</span>
              </span>
              <span>
                judge <span className="font-mono text-fg">{g.judge_model_id}</span>
              </span>
              <span>gate {g.gate_min ?? 'none'}</span>
              <span className="ml-auto">{fmtRelative(g.latest_at)}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-fg-muted">
                  <tr>
                    <Th>Variant</Th>
                    <Th>Runs</Th>
                    <Th>Aggregate</Th>
                    <Th>Δ</Th>
                    <Th>Pass</Th>
                    <Th>Cost</Th>
                    {dims.map((d) => (
                      <Th key={d}>
                        <span className="font-mono">{d}</span>
                      </Th>
                    ))}
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {g.variants.map((v) => {
                    const isBase = v.variant === g.baseline;
                    return (
                      <tr key={v.variant} className="border-t border-line">
                        <Td className="font-mono">
                          {v.variant}
                          {isBase && (
                            <Pill tone="neutral" className="ml-2">
                              baseline
                            </Pill>
                          )}
                        </Td>
                        <Td className="tabular-nums">{v.runs}</Td>
                        <Td className="tabular-nums">{fmtScore(v.mean_aggregate)}</Td>
                        <Td>{isBase ? '' : <Delta d={v.delta_vs_baseline?.aggregate} />}</Td>
                        <Td className="tabular-nums">{v.pass_rate == null ? '–' : fmtPct(v.pass_rate)}</Td>
                        <Td className="tabular-nums">{fmtUsd(v.mean_session_cost_usd)}</Td>
                        {dims.map((d) => (
                          <Td key={d} className="tabular-nums">
                            {fmtScore(v.per_dimension?.[d] ?? null)}
                            {!isBase && v.delta_vs_baseline?.per_dimension?.[d] != null && (
                              <span className="ml-1 text-[10px]">
                                (<Delta d={v.delta_vs_baseline.per_dimension[d]} />)
                              </span>
                            )}
                          </Td>
                        ))}
                        <Td>
                          {v.regression && (
                            <Pill tone="danger">
                              <AlertTriangle className="mr-1 inline size-3" />
                              regression
                            </Pill>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ circuit regression */

interface CrSide {
  eval_run_id?: string;
  circuit_commit?: string;
  rubric_commit?: string;
  judge_model_id?: string;
  mean_aggregate?: number | null;
  pass_rate?: number | null;
  created_at?: string;
}
interface CrResult {
  variant: string;
  base: CrSide | null;
  head: CrSide | null;
  comparable: boolean;
  rubric_changed: boolean;
  judge_changed: boolean;
  delta: { aggregate: number | null; pass_rate: number | null; per_dimension: Record<string, number | null>; mean_session_cost_usd: number | null } | null;
  fixtures: Array<{ fixture_id: string; base_score: number | null; head_score: number | null; delta: number | null; base_pass: boolean | null; head_pass: boolean | null; base_session: string | null; head_session: string | null }>;
  regressions: Array<{ fixture_id: string }> | string[];
  note?: string;
}

function CircuitRegression() {
  const wt = useWorkingTree();
  const runsQ = useQuery({ queryKey: qk.runs(wt.uid), queryFn: () => evalsApi.runs(wt.uid), select: latestFirst });
  const completed = (runsQ.data ?? []).filter((r) => r.status === 'completed');
  const variants = [...new Set(completed.map(variantLabel))];
  const [variant, setVariant] = useState('preset-default');
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const q = useAnalysis<CrResult>('circuit-regression', { variant, base: base || undefined, head: head || undefined });
  const inVariant = completed.filter((r) => variantLabel(r) === variant);
  const runOption = (r: (typeof completed)[number]) => (
    <option key={r.eval_run_id} value={r.eval_run_id}>
      {shortCommit(r.circuit_commit)} · {fmtRelative(r.created_at)} · {fmtScore(r.aggregate)}
    </option>
  );
  const d = q.data;
  const regressionIds = new Set((Array.isArray(d?.regressions) ? d!.regressions : []).map((x: any) => (typeof x === 'string' ? x : x?.fixture_id)));
  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted">Same fixtures + rubric, compared across circuit commits. Defaults to the latest run against the previous distinct circuit commit.</p>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Variant">
          <SelectInput value={variant} onChange={(e) => (setVariant(e.target.value), setBase(''), setHead(''))} className="font-mono">
            {[...new Set(['preset-default', ...variants])].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Base">
          <SelectInput value={base} onChange={(e) => setBase(e.target.value)} className="font-mono">
            <option value="">auto (previous circuit commit)</option>
            {inVariant.map(runOption)}
          </SelectInput>
        </Field>
        <Field label="Head">
          <SelectInput value={head} onChange={(e) => setHead(e.target.value)} className="font-mono">
            <option value="">auto (latest run)</option>
            {inVariant.map(runOption)}
          </SelectInput>
        </Field>
      </div>
      {q.isLoading ? (
        <Spin />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !d?.base || !d?.head ? (
        <Note>{d?.note ?? 'Need at least two runs at different circuit commits in this variant.'}</Note>
      ) : (
        <>
          {d.note && <Note>{d.note}</Note>}
          {(!d.comparable || d.rubric_changed || d.judge_changed) && (
            <div className="flex items-start gap-2 rounded-md bg-warn-soft p-2 text-xs text-warn-fg">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <div>
                {d.rubric_changed && <div>The rubric changed between these runs; score differences may reflect grading, not behavior.</div>}
                {d.judge_changed && <div>The judge model changed between these runs; treat this as a new baseline.</div>}
                {!d.comparable && !d.rubric_changed && !d.judge_changed && <div>These runs are not directly comparable.</div>}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
            {[
              ['Base', d.base],
              ['Head', d.head],
            ].map(([label, s]: any) => (
              <div key={label} className="rounded-md border border-line p-2">
                <div className="text-fg-muted">{label}</div>
                <div className="font-mono">{shortCommit(s.circuit_commit)}</div>
                <div className="tabular-nums">mean {fmtScore(s.mean_aggregate)}</div>
              </div>
            ))}
            <div className="rounded-md border border-line p-2">
              <div className="text-fg-muted">Δ aggregate</div>
              <div className="text-base">
                <Delta d={d.delta?.aggregate} />
              </div>
              <div className="text-fg-muted">
                Δ pass <Delta d={d.delta?.pass_rate} />
              </div>
            </div>
            <div className="rounded-md border border-line p-2">
              <div className="text-fg-muted">Δ mean session cost</div>
              <div className="text-base">
                <Delta d={d.delta?.mean_session_cost_usd} digits={4} invert />
              </div>
              <div className="text-fg-muted">{regressionIds.size} fixture regression(s)</div>
            </div>
          </div>
          {d.delta?.per_dimension && Object.keys(d.delta.per_dimension).length > 0 && (
            <div className="flex flex-wrap gap-3 text-xs">
              {Object.entries(d.delta.per_dimension).map(([k, v]) => (
                <span key={k}>
                  <span className="font-mono">{k}</span> <Delta d={v} />
                </span>
              ))}
            </div>
          )}
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full text-xs">
              <thead className="bg-sunken text-fg-muted">
                <tr>
                  <Th>Fixture</Th>
                  <Th>Base</Th>
                  <Th>Head</Th>
                  <Th>Δ</Th>
                  <Th>Sessions</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {d.fixtures.map((f) => {
                  const reg = regressionIds.has(f.fixture_id) || (f.base_pass === true && f.head_pass === false);
                  return (
                    <tr key={f.fixture_id} className="border-t border-line">
                      <Td className="font-mono">{f.fixture_id}</Td>
                      <Td className="tabular-nums">
                        {fmtScore(f.base_score)} {f.base_pass != null && <span className="text-fg-subtle">({f.base_pass ? 'pass' : 'fail'})</span>}
                      </Td>
                      <Td className="tabular-nums">
                        {fmtScore(f.head_score)} {f.head_pass != null && <span className="text-fg-subtle">({f.head_pass ? 'pass' : 'fail'})</span>}
                      </Td>
                      <Td>
                        <Delta d={f.delta} />
                      </Td>
                      <Td className="font-mono">
                        {f.base_session && (
                          <AppLink href={`/s/${f.base_session}`} className="mr-2 text-accent-text hover:underline">
                            base
                          </AppLink>
                        )}
                        {f.head_session && (
                          <AppLink href={`/s/${f.head_session}`} className="text-accent-text hover:underline">
                            head
                          </AppLink>
                        )}
                      </Td>
                      <Td>{reg && <Pill tone="danger">regression</Pill>}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
