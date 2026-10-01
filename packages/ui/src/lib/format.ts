/** Display formatting helpers (cost, tokens, durations, ids). Pure. */

export function formatCost(usd: number | string | null | undefined): string {
  const n = typeof usd === 'string' ? Number(usd) : usd;
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  const abs = Math.abs(n);
  if (abs < 0.0001) return `${n < 0 ? '-' : ''}<$0.0001`;
  if (abs < 1) return `$${n.toFixed(4)}`;
  if (abs < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatNumber(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function formatPercent(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

/** Duration between two instants (or until now when `end` is null). */
export function durationMs(start: string | null | undefined, end: string | null | undefined, now = Date.now()): number | null {
  if (!start) return null;
  const s = Date.parse(start);
  const e = end ? Date.parse(end) : now;
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return Math.max(0, e - s);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return rm ? `${h}h ${rm}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatRelative(at: string | number | Date | null | undefined, now = Date.now()): string {
  if (at === null || at === undefined) return '—';
  const t = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(t)) return '—';
  const d = Math.round((now - t) / 1000);
  const future = d < 0;
  const a = Math.abs(d);
  let out: string;
  if (a < 45) return future ? 'in a moment' : 'just now';
  else if (a < 3600) out = `${Math.round(a / 60)}m`;
  else if (a < 86400) out = `${Math.round(a / 3600)}h`;
  else if (a < 86400 * 30) out = `${Math.round(a / 86400)}d`;
  else return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return future ? `in ${out}` : `${out} ago`;
}

export function formatDateTime(at: string | null | undefined): string {
  if (!at) return '—';
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return at;
  return new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** `ses_01J8FQ2ZK7XW9MBT4PVN` → `ses_01J8…4PVN` compact form for tables. */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  const us = id.indexOf('_');
  const prefix = us > 0 && us <= 4 ? id.slice(0, us + 1) : '';
  const rest = id.slice(prefix.length);
  if (rest.length <= 10) return id;
  return `${prefix}${rest.slice(0, 4)}…${rest.slice(-4)}`;
}

export function shortCommit(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : '—';
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Title-case a slug-ish token: `suspended-gate` → `Suspended gate`. */
export function humanize(s: string | null | undefined): string {
  if (!s) return '';
  const t = s.replace(/[-_]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
