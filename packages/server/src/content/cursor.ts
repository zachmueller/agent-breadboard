/** Opaque cursor pagination ([11] §2): base64 of `created_at|key`. */
export interface Cursor {
  created_at: string;
  key: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.created_at}|${c.key}`, 'utf8').toString('base64url');
}

export function decodeCursor(s: string | undefined | null): Cursor | null {
  if (!s) return null;
  try {
    const raw = Buffer.from(s, 'base64url').toString('utf8');
    const i = raw.indexOf('|');
    if (i < 0) return null;
    return { created_at: raw.slice(0, i), key: raw.slice(i + 1) };
  } catch {
    return null;
  }
}

export function clampLimit(limit: unknown, def = 50, max = 200): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}
