/**
 * Input validation and git pathspec building for repository mirrors ([06] §7.1). User paths are resolved through
 * the tree index and blobs are read by SHA, so a user path never reaches git's argv; user globs do, but only after
 * these checks and always behind `--` with explicit `:(glob)` magic, so no glob can carry its own magic or an option.
 */
import { BreadboardError } from '@breadboard/shared';

export const MAX_PATH_CHARS = 1024;
export const MAX_GLOB_CHARS = 256;
export const MAX_GLOBS = 20;
export const MAX_PATTERN_CHARS = 1000;
const CONTROL = /[\0\r\n]/;

const invalid = (msg: string) => new BreadboardError('validation-failed', msg);

/** A repo-relative file or directory path; `''`, `'.'` and `'/'` mean the root. Returns it without a trailing slash. */
export function repoPath(raw: string): string {
  if (raw === '' || raw === '.' || raw === '/') return '';
  if (raw.length > MAX_PATH_CHARS) throw invalid(`path is longer than ${MAX_PATH_CHARS} characters`);
  if (CONTROL.test(raw)) throw invalid('path contains a control character');
  if (raw.startsWith('/')) throw invalid('path must be relative to the repository root');
  const p = raw.replace(/\/+$/, '');
  if (p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw invalid(`path '${raw.slice(0, 200)}' has an empty, '.' or '..' segment`);
  return p;
}

/** A user glob: git glob syntax (`*` within a directory, `**` across directories); a plain directory covers its contents. */
export function glob(raw: string): string {
  if (!raw || raw.length > MAX_GLOB_CHARS) throw invalid(`glob must be 1-${MAX_GLOB_CHARS} characters`);
  if (CONTROL.test(raw)) throw invalid('glob contains a control character');
  if (raw.startsWith(':')) throw invalid(`glob '${raw.slice(0, 60)}' starts with ':' (pathspec magic is not allowed)`);
  if (raw.startsWith('/')) throw invalid('glob must be relative to the repository root');
  if (raw.replace(/\/+$/, '').split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw invalid(`glob '${raw.slice(0, 60)}' has an empty, '.' or '..' segment`);
  return raw.replace(/\/+$/, '');
}

export function globs(list: string[] | undefined, what: string): string[] {
  if (!list?.length) return [];
  if (list.length > MAX_GLOBS) throw invalid(`at most ${MAX_GLOBS} ${what} globs`);
  return list.map(glob);
}

export function pattern(raw: string): string {
  if (!raw || raw.length > MAX_PATTERN_CHARS) throw invalid(`pattern must be 1-${MAX_PATTERN_CHARS} characters`);
  if (CONTROL.test(raw)) throw invalid('pattern must be a single line (no NUL, CR or LF)');
  return raw;
}

/** An abbreviated or full commit SHA (resolved and verified against the mirror separately). */
export function commitRef(raw: string): string {
  if (!/^[0-9a-f]{7,64}$/i.test(raw)) throw invalid('commit must be a hexadecimal commit SHA (7-64 characters)');
  return raw.toLowerCase();
}

/** Pathspecs for `git grep` / `git diff-tree`: user includes and excludes plus internal literal excludes. */
export function pathspecs(o: { include: string[]; exclude: string[]; excludeRaw?: string[]; excludeLiteral?: string[] }): string[] {
  return [...o.include.map((g) => `:(glob)${g}`), ...o.exclude.map((g) => `:(exclude,glob)${g}`), ...(o.excludeRaw ?? []).map((p) => `:(exclude)${p}`), ...(o.excludeLiteral ?? []).map((p) => `:(exclude,literal)${p}`)];
}
