import { ChevronLeft, ChevronRight } from 'lucide-react';
import { PAGE_SIZES, pageCount, pageWindow, rangeLabel } from '../lib/paging';
import { cn } from './cn';

export interface PagerProps {
  /** 1-based current page. */
  page: number;
  size: number;
  total: number;
  /** Rows on the current page. */
  shown: number;
  onPage: (page: number) => void;
  onSize?: (size: number) => void;
  /** A page change is in flight (the previous rows stay on screen). */
  loading?: boolean;
  className?: string;
}

const cell = 'inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-[13px] tabular';

/** Numbered pages with a total ([11] §2 offset paging): "1–50 of 3,214", Prev/Next, page numbers, page size. */
export function Pager({ page, size, total, shown, onPage, onSize, loading, className }: PagerProps) {
  const pages = pageCount(total, size);
  const go = (p: number) => p >= 1 && p <= pages && p !== page && onPage(p);
  return (
    <nav aria-label="Pagination" className={cn('flex flex-wrap items-center justify-between gap-3 py-3 text-[13px] text-fg-subtle', className)}>
      <span className={cn('tabular', loading && 'opacity-60')} aria-live="polite">
        {rangeLabel((page - 1) * size, shown, total)}
      </span>
      {pages > 1 && (
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Previous page" className={cn(cell, 'text-fg-muted hover:bg-hover disabled:pointer-events-none disabled:opacity-40')}>
            <ChevronLeft size={14} />
          </button>
          {pageWindow(page, pages).map((p, i) =>
            p === 'gap' ? (
              <span key={`gap-${i}`} className={cn(cell, 'text-fg-subtle')} aria-hidden>
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => go(p)}
                aria-label={`Page ${p}`}
                aria-current={p === page ? 'page' : undefined}
                className={cn(cell, p === page ? 'bg-accent-soft font-medium text-accent-text' : 'text-fg-muted hover:bg-hover')}
              >
                {p.toLocaleString()}
              </button>
            ),
          )}
          <button type="button" onClick={() => go(page + 1)} disabled={page >= pages} aria-label="Next page" className={cn(cell, 'text-fg-muted hover:bg-hover disabled:pointer-events-none disabled:opacity-40')}>
            <ChevronRight size={14} />
          </button>
        </div>
      )}
      {onSize && (
        <label className="inline-flex items-center gap-1.5">
          <span>Per page</span>
          <select aria-label="Rows per page" value={size} onChange={(e) => onSize(Number(e.target.value))} className="h-7 rounded-md border border-line-strong bg-surface px-1.5 text-[13px] text-fg outline-none focus:border-accent">
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}
    </nav>
  );
}
