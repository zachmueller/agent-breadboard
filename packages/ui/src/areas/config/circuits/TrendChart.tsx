/**
 * Eval score trend ([04] §6): mean aggregate (0–1) per run, one line per model variant, with
 * vertical change markers where the circuit commit, rubric or judge changed since that variant's
 * previous run. Hand-written SVG: 2px lines, 8px ringed points, recessive grid, crosshair tooltip
 * listing every series, legend + direct end labels (≤4 series), and a table view as relief for
 * the light-mode slots under 3:1 contrast.
 */
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Table2, LineChart as LineIcon } from 'lucide-react';
import { trendLayout, valuesAt, snapTimes, nearestIndex, SERIES_LIGHT, SERIES_DARK, MARKER_LABEL, type TrendPoint } from './trendModel';
import { fmtScore, fmtUsd, fmtPct, shortCommit } from '../lib/format';

const STYLE = `
.bb-trend { ${SERIES_LIGHT.map((c, i) => `--s${i}: ${c};`).join(' ')} }
@media (prefers-color-scheme: dark) { .bb-trend { ${SERIES_DARK.map((c, i) => `--s${i}: ${c};`).join(' ')} } }
`;

const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDateTime = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function TrendChart({ points, variants, onSelectRun, selectedRun, height = 232 }: { points: TrendPoint[]; variants?: string[]; onSelectRun?: (id: string) => void; selectedRun?: string | null; height?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    setWidth(Math.max(280, Math.floor(el.getBoundingClientRect().width)));
    return () => ro.disconnect();
  }, [table]);

  const layout = useMemo(() => trendLayout(points, variants), [points, variants]);
  const times = useMemo(() => snapTimes(layout), [layout]);
  const direct = layout.series.length <= 4;
  const pad = { l: 36, r: direct ? 104 : 16, t: 20, b: 24 };
  const iw = Math.max(40, width - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const x = (t: number) => pad.l + ((t - layout.t0) / (layout.t1 - layout.t0)) * iw;
  const y = (v: number) => pad.t + ih - Math.max(0, Math.min(1, v)) * ih;
  const xTicks = useMemo(() => {
    const n = Math.max(2, Math.min(6, Math.floor(iw / 110)));
    return Array.from({ length: n }, (_, i) => layout.t0 + ((layout.t1 - layout.t0) * i) / (n - 1));
  }, [layout, iw]);

  if (!times.length) return <div className="rounded-md border border-dashed border-line p-6 text-center text-xs text-fg-subtle">No scored runs yet.</div>;

  const hoverT = hover !== null ? times[hover] : undefined;
  const readout = hoverT !== undefined ? valuesAt(layout, hoverT) : [];
  const runsAtHover = hoverT !== undefined ? layout.series.flatMap((s) => s.points.filter((p) => p.t === hoverT)) : [];
  const markerAtHover = hoverT !== undefined ? layout.markers.find((m) => m.t === hoverT) : undefined;

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const t = layout.t0 + ((e.clientX - r.left - pad.l) / iw) * (layout.t1 - layout.t0);
    setHover(nearestIndex(times, t));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const cur = hover ?? (e.key === 'ArrowRight' ? -1 : times.length);
      setHover(Math.max(0, Math.min(times.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1))));
    } else if (e.key === 'Enter' && runsAtHover[0]) onSelectRun?.(runsAtHover[0].eval_run_id);
    else if (e.key === 'Escape') setHover(null);
  };

  // Direct end labels: nudge apart so they never collide (min 13px apart).
  const ends = layout.series
    .filter((s) => s.points.length)
    .map((s) => ({ s, y: y(s.points[s.points.length - 1]!.v) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i]!.y - ends[i - 1]!.y < 13) ends[i]!.y = ends[i - 1]!.y + 13;

  return (
    <div className="bb-trend">
      <style>{STYLE}</style>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        {layout.series.length >= 2 &&
          layout.series.map((s) => (
            <span key={s.variant} className="flex items-center gap-1.5">
              <svg width="14" height="4" aria-hidden>
                <line x1="1" y1="2" x2="13" y2="2" stroke={`var(--s${s.slot})`} strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="font-mono">{s.variant}</span>
            </span>
          ))}
        {layout.series.length === 1 && <span className="font-mono">{layout.series[0]!.variant}</span>}
        <span className="flex items-center gap-2 text-fg-subtle">
          {Object.values(MARKER_LABEL).map((m) => (
            <span key={m.short}>
              <b className="font-semibold text-fg-muted">{m.short}</b> {m.long}
            </span>
          ))}
        </span>
        {layout.overflow.length > 0 && <span className="text-fg-subtle">+{layout.overflow.length} more variant{layout.overflow.length > 1 ? 's' : ''} in table</span>}
        <button type="button" className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover" onClick={() => setTable(!table)} aria-pressed={table}>
          {table ? <LineIcon className="size-3.5" /> : <Table2 className="size-3.5" />}
          {table ? 'Chart' : 'Table'}
        </button>
      </div>

      {table ? (
        <TrendTable points={points} onSelectRun={onSelectRun} selectedRun={selectedRun} />
      ) : (
        <div ref={wrap} className="relative">
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`Eval mean aggregate score over time, ${layout.series.length} variant${layout.series.length === 1 ? '' : 's'}`}
            tabIndex={0}
            onKeyDown={onKey}
            onBlur={() => setHover(null)}
            className="block overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {[0, 0.25, 0.5, 0.75, 1].map((v) => (
              <g key={v}>
                <line x1={pad.l} x2={pad.l + iw} y1={y(v)} y2={y(v)} stroke="var(--color-chart-grid)" strokeWidth={1} />
                <text x={pad.l - 6} y={y(v)} dy="0.32em" textAnchor="end" className="fill-fg-subtle text-[10px] tabular-nums">
                  {v.toFixed(2)}
                </text>
              </g>
            ))}
            <line x1={pad.l} x2={pad.l + iw} y1={pad.t + ih} y2={pad.t + ih} stroke="var(--color-chart-axis)" strokeWidth={1} />
            {xTicks.map((t, i) => (
              <text key={i} x={x(t)} y={height - 6} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'} className="fill-fg-subtle text-[10px]">
                {fmtDate(t)}
              </text>
            ))}

            {layout.gate !== null && (
              <g>
                <line x1={pad.l} x2={pad.l + iw} y1={y(layout.gate)} y2={y(layout.gate)} stroke="var(--color-fg-subtle)" strokeWidth={1} strokeDasharray="4 3" />
                <text x={pad.l + 4} y={y(layout.gate) - 4} className="fill-fg-muted text-[10px]">
                  gate {layout.gate.toFixed(2)}
                </text>
              </g>
            )}

            {layout.markers.map((m) => (
              <g key={m.t}>
                <line x1={x(m.t)} x2={x(m.t)} y1={pad.t - 4} y2={pad.t + ih} stroke="var(--color-fg-subtle)" strokeWidth={1} strokeDasharray="2 3" />
                <text x={x(m.t)} y={pad.t - 8} textAnchor="middle" className="fill-fg-muted text-[10px] font-semibold">
                  {m.kinds.map((k) => MARKER_LABEL[k]?.short ?? '?').join('')}
                </text>
              </g>
            ))}

            {layout.series.map((s) => (
              <g key={s.variant}>
                {s.points.length > 1 && (
                  <polyline fill="none" stroke={`var(--s${s.slot})`} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" points={s.points.map((p) => `${x(p.t)},${y(p.v)}`).join(' ')} />
                )}
                {s.points.map((p) => (
                  <circle
                    key={p.eval_run_id}
                    cx={x(p.t)}
                    cy={y(p.v)}
                    r={p.eval_run_id === selectedRun ? 5.5 : 4}
                    fill={`var(--s${s.slot})`}
                    stroke="var(--color-surface)"
                    strokeWidth={2}
                  />
                ))}
              </g>
            ))}

            {direct &&
              ends.map(({ s, y: ly }) => (
                <g key={s.variant}>
                  <line x1={pad.l + iw + 6} x2={pad.l + iw + 14} y1={ly} y2={ly} stroke={`var(--s${s.slot})`} strokeWidth={2} strokeLinecap="round" />
                  <text x={pad.l + iw + 18} y={ly} dy="0.32em" className="fill-fg-muted font-mono text-[10px]">
                    {s.variant.length > 13 ? `${s.variant.slice(0, 12)}…` : s.variant}
                  </text>
                </g>
              ))}

            {hoverT !== undefined && <line x1={x(hoverT)} x2={x(hoverT)} y1={pad.t} y2={pad.t + ih} stroke="var(--color-fg-muted)" strokeWidth={1} pointerEvents="none" />}
            <rect
              x={pad.l - 8}
              y={0}
              width={iw + 16}
              height={height}
              fill="transparent"
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
              onClick={() => runsAtHover[0] && onSelectRun?.(runsAtHover[0].eval_run_id)}
              style={{ cursor: onSelectRun ? 'pointer' : 'default' }}
            />
          </svg>

          {hoverT !== undefined && (
            <div
              className="pointer-events-none absolute z-10 w-60 rounded-md border border-line bg-surface p-2 text-xs shadow-pop"
              style={{ left: Math.min(Math.max(0, x(hoverT) + 12), width - 248), top: 8 }}
            >
              <div className="mb-1 text-fg-muted">{fmtDateTime(hoverT)}</div>
              <ul className="space-y-0.5">
                {readout.map(({ series, point }) => (
                  <li key={series.variant} className="flex items-center gap-1.5">
                    <svg width="12" height="4" aria-hidden>
                      <line x1="1" y1="2" x2="11" y2="2" stroke={`var(--s${series.slot})`} strokeWidth="2" strokeLinecap="round" />
                    </svg>
                    <b className="w-10 font-semibold text-fg tabular-nums">{point ? fmtScore(point.v) : '–'}</b>
                    <span className={`truncate font-mono ${point?.t === hoverT ? 'text-fg' : 'text-fg-subtle'}`}>{series.variant}</span>
                  </li>
                ))}
              </ul>
              {runsAtHover.map((r) => (
                <div key={r.eval_run_id} className="mt-1.5 border-t border-line pt-1.5 text-fg-muted">
                  <div className="font-mono text-[11px] text-fg">{r.eval_run_id}</div>
                  <div>
                    circuit {shortCommit(r.circuit_commit)} · rubric {shortCommit(r.rubric_commit)}
                  </div>
                  <div>
                    pass {r.pass_rate === null ? 'n/a' : fmtPct(r.pass_rate)} · {r.mean_session_cost_usd === null ? '' : `${fmtUsd(r.mean_session_cost_usd)}/session`}
                  </div>
                </div>
              ))}
              {markerAtHover && <div className="mt-1.5 text-fg-muted">{markerAtHover.kinds.map((k) => MARKER_LABEL[k]?.long ?? k).join(' · ')}</div>}
              {onSelectRun && runsAtHover.length > 0 && <div className="mt-1 text-[11px] text-fg-subtle">Click to open run</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TrendTable({ points, onSelectRun, selectedRun }: { points: TrendPoint[]; onSelectRun?: (id: string) => void; selectedRun?: string | null }) {
  const rows = [...points].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return (
    <div className="max-h-72 overflow-auto rounded-md border border-line">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-sunken text-left text-fg-muted">
          <tr>
            <th className="px-2 py-1 font-medium">When</th>
            <th className="px-2 py-1 font-medium">Variant</th>
            <th className="px-2 py-1 text-right font-medium">Mean</th>
            <th className="px-2 py-1 text-right font-medium">Pass</th>
            <th className="px-2 py-1 text-right font-medium">$/session</th>
            <th className="px-2 py-1 font-medium">Circuit</th>
            <th className="px-2 py-1 font-medium">Changes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.eval_run_id} className={`border-t border-line ${onSelectRun ? 'cursor-pointer hover:bg-hover' : ''} ${p.eval_run_id === selectedRun ? 'bg-accent-soft' : ''}`} onClick={() => onSelectRun?.(p.eval_run_id)}>
              <td className="px-2 py-1">{fmtDateTime(Date.parse(p.created_at))}</td>
              <td className="px-2 py-1 font-mono">{p.variant}</td>
              <td className="px-2 py-1 text-right tabular-nums">{p.mean_aggregate === null ? '–' : fmtScore(p.mean_aggregate)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{p.pass_rate === null ? 'n/a' : fmtPct(p.pass_rate)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{p.mean_session_cost_usd === null ? '–' : fmtUsd(p.mean_session_cost_usd)}</td>
              <td className="px-2 py-1 font-mono">{shortCommit(p.circuit_commit)}</td>
              <td className="px-2 py-1 text-fg-muted">{p.markers.map((k) => MARKER_LABEL[k]?.long ?? k).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
