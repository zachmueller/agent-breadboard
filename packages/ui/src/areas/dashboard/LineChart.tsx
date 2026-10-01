/**
 * Hand-written SVG single-series line chart (no chart library): 2px line, ~10% area wash,
 * hairline horizontal grid, crosshair + tooltip on hover, direct end label. A single series
 * needs no legend — the panel title names it.
 */
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

export interface LinePoint {
  x: string; // ISO day
  y: number;
  /** Extra rows shown in the tooltip. */
  detail?: Array<{ label: string; value: ReactNode }>;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * exp;
}

const fmtDay = (iso: string) => {
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

export function LineChart({
  points,
  height = 188,
  formatY = (v) => v.toFixed(2),
  label,
}: {
  points: LinePoint[];
  height?: number;
  formatY?: (v: number) => string;
  /** Accessible name for the chart. */
  label: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    setWidth(Math.max(240, Math.floor(el.getBoundingClientRect().width)));
    return () => ro.disconnect();
  }, []);

  const pad = { l: 40, r: 56, t: 12, b: 24 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const max = useMemo(() => niceMax(Math.max(0, ...points.map((p) => p.y)) * 1.1), [points]);
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const xAt = (i: number) => pad.l + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const yAt = (v: number) => pad.t + ih - (v / max) * ih;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(p.y).toFixed(1)}`).join('');
  const area = points.length ? `${line}L${xAt(points.length - 1).toFixed(1)},${yAt(0)}L${xAt(0).toFixed(1)},${yAt(0)}Z` : '';
  const last = points[points.length - 1];
  const xLabelIdx = points.length > 2 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : points.map((_, i) => i);

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - r.left) / r.width;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(rel * (points.length - 1)))));
  };
  const onKey = (e: KeyboardEvent) => {
    if (!points.length) return;
    if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? points.length) - 1));
    else if (e.key === 'ArrowRight') setHover((h) => Math.min(points.length - 1, (h ?? -1) + 1));
    else if (e.key === 'Escape') setHover(null);
  };

  const hp = hover !== null ? points[hover] : null;
  const tipLeft = hover !== null ? Math.min(Math.max(xAt(hover) + 10, 0), width - 172) : 0;
  const tipFlip = hover !== null && xAt(hover) + 182 > width;

  return (
    <div ref={wrap} className="relative w-full select-none">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        className="block overflow-visible rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {/* grid + y axis labels */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={pad.l + iw} y1={yAt(t)} y2={yAt(t)} className={i === 0 ? 'stroke-chart-axis' : 'stroke-chart-grid'} strokeWidth={1} shapeRendering="crispEdges" />
            {i % 2 === 0 && (
              <text x={pad.l - 8} y={yAt(t)} dy="0.32em" textAnchor="end" className="fill-fg-subtle text-[10.5px] tabular">
                {formatY(t)}
              </text>
            )}
          </g>
        ))}
        {/* x labels */}
        {xLabelIdx.map((i) => (
          <text key={i} x={xAt(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'} className="fill-fg-subtle text-[10.5px]">
            {fmtDay(points[i]!.x)}
          </text>
        ))}
        {/* area wash + line */}
        {points.length > 0 && <path d={area} className="fill-accent" fillOpacity={0.1} />}
        {points.length > 0 && <path d={line} className="stroke-accent" fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {/* end label */}
        {last && (
          <g>
            <circle cx={xAt(points.length - 1)} cy={yAt(last.y)} r={4} className="fill-accent stroke-surface" strokeWidth={2} />
            <text x={xAt(points.length - 1) + 9} y={yAt(last.y)} dy="0.32em" className="fill-fg text-[11.5px] font-semibold tabular">
              {formatY(last.y)}
            </text>
          </g>
        )}
        {/* crosshair */}
        {hp && hover !== null && (
          <g pointerEvents="none">
            <line x1={xAt(hover)} x2={xAt(hover)} y1={pad.t} y2={pad.t + ih} className="stroke-fg-subtle" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={xAt(hover)} cy={yAt(hp.y)} r={4.5} className="fill-accent stroke-surface" strokeWidth={2} />
          </g>
        )}
        {/* hit area (larger than the mark) */}
        <rect x={pad.l} y={0} width={iw} height={height} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hp && hover !== null && (
        <div
          role="status"
          className="pointer-events-none absolute top-2 z-10 w-[164px] rounded-md border border-line bg-raised px-2.5 py-2 text-[12px] shadow-pop"
          style={{ left: tipFlip ? xAt(hover) - 174 : tipLeft }}
        >
          <div className="mb-1 font-medium text-fg">{fmtDay(hp.x)}</div>
          <div className="flex justify-between gap-3 text-fg-muted">
            <span>Rate</span>
            <span className="font-semibold text-fg tabular">{formatY(hp.y)}</span>
          </div>
          {hp.detail?.map((d) => (
            <div key={d.label} className="flex justify-between gap-3 text-fg-muted">
              <span>{d.label}</span>
              <span className="text-fg tabular">{d.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
