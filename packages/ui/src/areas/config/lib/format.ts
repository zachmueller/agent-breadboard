export const shortCommit = (c: string | null | undefined) => (c ? c.slice(0, 8) : '—');

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return String(d);
  return t.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtRelative(d: string | null | undefined): string {
  if (!d) return '—';
  const t = new Date(d).getTime();
  if (Number.isNaN(t)) return String(d);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(d);
}

export const fmtUsd = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
export const fmtPct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
export const fmtScore = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(2));

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Config editor routes ([10] §2 deep links use the permanent UID). */
export function hrefFor(kind: string, uid: string | null | undefined): string | null {
  if (!uid) return null;
  switch (kind) {
    case 'circuit':
    case 'rubric':
    case 'fixtures':
      return `/circuits/${uid}`;
    case 'subagent':
      return `/subagents/${uid}`;
    case 'tool':
    case 'mcp':
      return `/toolbox/${uid}`;
    case 'knowledge':
      return `/knowledge/${uid}`;
    case 'session':
      return `/s/${uid}`;
    default:
      return `/n/${uid}`;
  }
}
