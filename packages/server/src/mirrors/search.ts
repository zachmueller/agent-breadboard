/**
 * Searching a repository mirror with `git grep` ([06] §7.1): output parsing, the grep invocation, batch blob reads
 * and grep-style snippets. Regular files are searched in the commit's tree; notebooks are searched with the same
 * flags over their rendered cell sources (`--no-index` in the notebook cache), so one regex flavour (PCRE with
 * `regex: true`, otherwise a fixed string) applies to both and no user regex ever runs in JavaScript.
 */
import type { GitRunner } from './git.js';

export interface GrepHit {
  path: string;
  line: number;
  /** 1-based character column of the first match on the line. */
  column: number;
}

export interface GrepFlags {
  pattern: string;
  regex: boolean;
  ignore_case: boolean;
  word: boolean;
}

/**
 * Incremental parser for `git grep -n -z --column` output: `<prefix><path>\0<line>\0<byte col>\0<text>\n`. Paths
 * may contain any byte but NUL; the text runs to the newline. `prefix` is the `<tree>:` git prepends in tree mode.
 */
export class GrepZParser {
  private rest: Buffer = Buffer.alloc(0);

  constructor(private readonly prefix: string) {}

  push(chunk: Buffer): GrepHit[] {
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const hits: GrepHit[] = [];
    let at = 0;
    for (;;) {
      const a = buf.indexOf(0, at);
      const b = a < 0 ? -1 : buf.indexOf(0, a + 1);
      const c = b < 0 ? -1 : buf.indexOf(0, b + 1);
      const nl = c < 0 ? -1 : buf.indexOf(10, c + 1);
      if (nl < 0) break;
      let path = buf.subarray(at, a).toString('utf8');
      if (this.prefix && path.startsWith(this.prefix)) path = path.slice(this.prefix.length);
      const line = Number(buf.subarray(a + 1, b).toString('latin1'));
      const byteCol = Number(buf.subarray(b + 1, c).toString('latin1'));
      const text = buf.subarray(c + 1, nl);
      const column = Number.isFinite(byteCol) && byteCol > 0 ? text.subarray(0, byteCol - 1).toString('utf8').length + 1 : 1;
      if (Number.isFinite(line) && line > 0) hits.push({ path, line, column });
      at = nl + 1;
    }
    this.rest = Buffer.from(buf.subarray(at));
    return hits;
  }
}

/** Parse `git grep -c -z` output: `<prefix><path>\0<count>\n`. */
export function parseGrepCounts(buf: Buffer, prefix: string): Array<{ path: string; count: number }> {
  const out: Array<{ path: string; count: number }> = [];
  let at = 0;
  for (;;) {
    const z = buf.indexOf(0, at);
    const nl = z < 0 ? -1 : buf.indexOf(10, z + 1);
    if (nl < 0) break;
    let path = buf.subarray(at, z).toString('utf8');
    if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
    out.push({ path, count: Number(buf.subarray(z + 1, nl).toString('latin1')) || 0 });
    at = nl + 1;
  }
  return out;
}

function flagArgs(f: GrepFlags): string[] {
  return [...(f.ignore_case ? ['-i'] : []), ...(f.word ? ['-w'] : []), f.regex ? '-P' : '-F', '-e', f.pattern];
}

export interface GrepRun {
  git: GitRunner;
  env: Record<string, string>;
  timeoutMs: number;
  /** Tree mode: the bare repo and the commit SHA. */
  gitDir?: string;
  sha?: string;
  /** No-index mode: the directory searched, and paths relative to it. */
  cwd?: string;
  specs: string[];
}

export interface GrepResult<T> {
  items: T[];
  timedOut: boolean;
  /** Stopped at the cap: there may be more. */
  capped: boolean;
  error: string | null;
}

/** Matching lines, at most `perFile` per file and `max` in total (the process is stopped once it has them). */
export async function grepLines(run: GrepRun, flags: GrepFlags, perFile: number, max: number): Promise<GrepResult<GrepHit>> {
  const parser = new GrepZParser(run.sha ? `${run.sha}:` : '');
  const items: GrepHit[] = [];
  const args = ['grep', '--no-color', '-I', '-n', '-z', '--column', `--max-count=${perFile}`, ...(run.sha ? [] : ['--no-index']), ...flagArgs(flags), ...(run.sha ? [run.sha] : []), '--', ...run.specs];
  const r = await run.git({
    args,
    gitDir: run.gitDir,
    cwd: run.cwd,
    env: run.env,
    timeoutMs: run.timeoutMs,
    onStdout: (chunk) => {
      for (const h of parser.push(chunk)) {
        if (items.length >= max) return false;
        items.push(h);
      }
      return items.length < max;
    },
  });
  return { items, timedOut: r.timedOut, capped: r.stopped, error: grepError(r) };
}

/** Matching-line counts per file. */
export async function grepCounts(run: GrepRun, flags: GrepFlags, maxFiles: number): Promise<GrepResult<{ path: string; count: number }>> {
  const args = ['grep', '--no-color', '-I', '-c', '-z', ...(run.sha ? [] : ['--no-index']), ...flagArgs(flags), ...(run.sha ? [run.sha] : []), '--', ...run.specs];
  const r = await run.git({ args, gitDir: run.gitDir, cwd: run.cwd, env: run.env, timeoutMs: run.timeoutMs, maxStdoutBytes: 16 * 1024 * 1024 });
  const all = parseGrepCounts(r.stdout, run.sha ? `${run.sha}:` : '');
  return { items: all.slice(0, maxFiles), timedOut: r.timedOut, capped: r.stopped || all.length > maxFiles, error: grepError(r) };
}

/** git grep exits 1 for "no match"; anything else (bad regex, missing PCRE) is an error worth reporting. */
function grepError(r: { code: number | null; stderr: string; timedOut: boolean; stopped: boolean }): string | null {
  if (r.timedOut || r.stopped || r.code === 0 || r.code === 1) return null;
  return r.stderr.trim().split('\n').slice(0, 3).join(' ').slice(0, 300) || `git grep exited with ${r.code}`;
}

/** Read blobs by SHA with one `git cat-file --batch` (binary-safe). Missing objects are left out. */
export async function readBlobs(git: GitRunner, gitDir: string, env: Record<string, string>, shas: string[], timeoutMs: number, maxBytes = 256 * 1024 * 1024): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const unique = [...new Set(shas)];
  if (!unique.length) return out;
  const r = await git({ args: ['cat-file', '--batch'], gitDir, env, input: unique.join('\n') + '\n', timeoutMs, maxStdoutBytes: maxBytes });
  const buf = r.stdout;
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const header = buf.subarray(at, nl).toString('latin1').split(' ');
    at = nl + 1;
    if (header[1] === 'missing') continue;
    const size = Number(header[2]);
    if (!Number.isFinite(size) || at + size > buf.length) break;
    out.set(header[0]!, buf.subarray(at, at + size));
    at += size + 1;
  }
  return out;
}

/** git's binary heuristic: a NUL byte in the first 8000 bytes. */
export function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

const MAX_LINE_CHARS = 240;

/** Clip a long line to `MAX_LINE_CHARS` characters, keeping `column` (1-based) in view. */
export function clipLine(text: string, column = 1): string {
  if (text.length <= MAX_LINE_CHARS) return text;
  const start = Math.max(0, Math.min(column - 1 - Math.floor(MAX_LINE_CHARS / 3), text.length - MAX_LINE_CHARS));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + MAX_LINE_CHARS)}${start + MAX_LINE_CHARS < text.length ? '…' : ''}`;
}

/** grep -C style hunks: `12:` matching lines, `11-` context lines, `--` between hunks. */
export function snippet(lines: string[], hits: Array<{ line: number; column: number }>, context: number): string {
  const byLine = new Map(hits.map((h) => [h.line, h.column]));
  const ranges: Array<[number, number]> = [];
  for (const h of [...byLine.keys()].sort((a, b) => a - b)) {
    const lo = Math.max(1, h - context);
    const hi = Math.min(lines.length, h + context);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }
  const out: string[] = [];
  ranges.forEach(([lo, hi], i) => {
    if (i) out.push('--');
    for (let n = lo; n <= hi; n++) {
      const col = byLine.get(n);
      out.push(`${n}${col !== undefined ? ':' : '-'}${clipLine(lines[n - 1] ?? '', col ?? 1)}`);
    }
  });
  return out.join('\n');
}

/** Split text into lines the way grep numbers them (a trailing newline does not start a new line). */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
