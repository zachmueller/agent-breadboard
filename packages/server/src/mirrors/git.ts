/**
 * The git runner for repository mirrors ([06] §7.1). Unlike the config repo's helpers it streams output, enforces a
 * timeout and an output cap, kills the whole process group (git spawns `git-remote-https`, `index-pack`, …), and
 * starts from an allowlisted environment, so no operator `GIT_*` setting (trace, credential helpers, config) leaks in.
 * Auth headers travel only as env-based config (`GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`): never argv, never a file.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

export interface GitRunOptions {
  args: string[];
  /** Passed as `--git-dir`; omit for `--no-index` runs in `cwd`. */
  gitDir?: string;
  cwd?: string;
  env: Record<string, string>;
  input?: string | Buffer;
  timeoutMs: number;
  /** Buffered stdout cap (default 64 MiB); beyond it the process is killed and `stopped` is set. */
  maxStdoutBytes?: number;
  /** Streaming consumer instead of buffering; return `false` to stop the process early. */
  onStdout?: (chunk: Buffer) => boolean | void;
}

export interface GitRunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  /** Killed because the consumer stopped it or the output cap was reached. */
  stopped: boolean;
}

export type GitRunner = (o: GitRunOptions) => Promise<GitRunResult>;

const DEFAULT_MAX_STDOUT = 64 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
/** Environment a mirror's git may inherit: the binary path, temp dirs, proxies and CA bundles. */
const PASS_ENV = ['PATH', 'TMPDIR', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

export const runGit: GitRunner = (o) =>
  new Promise((resolvePromise) => {
    const args = o.gitDir ? ['--git-dir', o.gitDir, ...o.args] : o.args;
    const child = spawn('git', args, { cwd: o.cwd, env: o.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = '';
    let timedOut = false;
    let stopped = false;
    let done = false;
    const max = o.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return;
      if (o.onStdout) {
        if (o.onStdout(chunk) === false) {
          stopped = true;
          kill();
        }
        return;
      }
      outBytes += chunk.length;
      if (outBytes > max) {
        stopped = true;
        kill();
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8').slice(0, MAX_STDERR - stderr.length);
    });
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout: Buffer.concat(out), stderr, timedOut, stopped });
    };
    child.on('error', (e) => {
      stderr += String(e.message);
      finish(null);
    });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {}); // EPIPE when git exits before reading all input
    if (o.input !== undefined) child.stdin.end(o.input);
    else child.stdin.end();
  });

/**
 * The environment for every mirror git process. `headers` become `http.extraHeader` entries after an empty one that
 * resets any inherited list; credential helpers, askpass, hooks and redirects are switched off, and a stalled
 * transfer (under 1 KB/s for 60 s) aborts instead of hanging until the timeout.
 */
export function mirrorGitEnv(opts: { headers?: Record<string, string>; allowFileUrls?: boolean } = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  Object.assign(env, {
    HOME: process.env.HOME || tmpdir(),
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ALLOW_PROTOCOL: opts.allowFileUrls ? 'https:http:file' : 'https',
  });
  const pairs: Array<[string, string]> = [
    ['credential.helper', ''],
    ['core.askPass', ''],
    ['core.hooksPath', '/dev/null'],
    ['http.followRedirects', 'false'],
    ['http.lowSpeedLimit', '1000'],
    ['http.lowSpeedTime', '60'],
    ['http.extraHeader', ''],
  ];
  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value) || !/^[A-Za-z0-9-]+$/.test(name)) throw new Error(`invalid auth header '${name.slice(0, 40)}'`);
    pairs.push(['http.extraHeader', `${name}: ${value}`]);
  }
  env.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/** Mirrors need git ≥ 2.38 (`GIT_CONFIG_COUNT` since 2.31, `grep -m` since 2.38). */
export const MIN_GIT_VERSION: [number, number] = [2, 38];

export async function gitVersion(git: GitRunner = runGit): Promise<{ version: string; ok: boolean }> {
  const r = await git({ args: ['--version'], env: mirrorGitEnv(), timeoutMs: 10_000 });
  const m = /git version (\d+)\.(\d+)/.exec(r.stdout.toString('utf8'));
  if (!m) return { version: r.stdout.toString('utf8').trim() || 'unknown', ok: false };
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return { version: `${maj}.${min}`, ok: maj > MIN_GIT_VERSION[0] || (maj === MIN_GIT_VERSION[0] && min >= MIN_GIT_VERSION[1]) };
}

/** git's stderr with anything that looks like a credential removed, clipped for logs and status. */
export function cleanGitError(stderr: string, max = 500): string {
  const s = stderr
    .replace(/Authorization:[^\n]*/gi, 'Authorization: <redacted>')
    .replace(/https?:\/\/[^\s/@]+@/g, 'https://<redacted>@')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
