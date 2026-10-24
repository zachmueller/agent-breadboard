/** Numbered-page plumbing ([11] §2 offset paging): page window, URL page state, and local-day date bounds. */

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 50;

/** `?page=&size=` from the URL: 1-based page, a known size, and the matching offset. */
export function pageState(s: { page?: string; size?: string }): { page: number; size: number; offset: number } {
  const size = (PAGE_SIZES as readonly number[]).includes(Number(s.size)) ? Number(s.size) : DEFAULT_PAGE_SIZE;
  const n = Math.floor(Number(s.page));
  const page = Number.isFinite(n) && n >= 1 ? n : 1;
  return { page, size, offset: (page - 1) * size };
}

export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

/** Page numbers to show around `page`, with `'gap'` for elided runs: 1 … 4 5 [6] 7 8 … 65. */
export function pageWindow(page: number, pages: number, span = 2): Array<number | 'gap'> {
  const lo = Math.max(1, page - span);
  const hi = Math.min(pages, page + span);
  const out: Array<number | 'gap'> = [];
  if (lo > 1) out.push(1);
  if (lo > 2) out.push(lo === 3 ? 2 : 'gap');
  for (let i = lo; i <= hi; i++) out.push(i);
  if (hi < pages - 1) out.push(hi === pages - 2 ? pages - 1 : 'gap');
  if (hi < pages) out.push(pages);
  return out;
}

/** "1–50 of 3,214" for the rows on screen. */
export function rangeLabel(offset: number, shown: number, total: number): string {
  if (total === 0 || shown === 0) return `0 of ${total.toLocaleString()}`;
  return `${(offset + 1).toLocaleString()}–${(offset + shown).toLocaleString()} of ${total.toLocaleString()}`;
}

function localDay(day: string | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Start of a `YYYY-MM-DD` day in the viewer's time zone, as an ISO instant (a date input's "From"). */
export function dayStartIso(day: string | undefined): string | undefined {
  return localDay(day)?.toISOString();
}

/** Last millisecond of a `YYYY-MM-DD` local day (a date input's inclusive "To"). */
export function dayEndIso(day: string | undefined): string | undefined {
  const d = localDay(day);
  if (!d) return undefined;
  d.setDate(d.getDate() + 1);
  return new Date(d.getTime() - 1).toISOString();
}
