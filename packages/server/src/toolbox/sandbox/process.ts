/**
 * Local-process sandbox runner — the UNISOLATED fallback for dev/test machines without Docker.
 *
 * It spawns the sandbox-runtime CLI as a child process with a scrubbed environment, a throwaway working
 * directory, a wall-clock kill, and HTTP(S)_PROXY pointing at the egress proxy so well-behaved HTTP clients
 * still honour the tool's allowlist. It does NOT provide filesystem, memory, pid, or network isolation:
 * tool code runs with the server's OS user. Never use it for untrusted tools.
 *
 * TypeScript tools run directly from `.ts` sources via Node's built-in type stripping (on by default since
 * Node 23.6): the runner imports the entrypoint by file URL. Tool code must therefore use *erasable* TS syntax
 * only (no `enum`, `namespace`, parameter properties, or `import x = require()`), and relative imports must
 * carry their real extension (`./util.ts`). `Toolbox.ci()` checks this.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxRunInput, SandboxRunResult, SandboxRunner } from '../../core/services.js';
import type { Logger } from '../../core/logger.js';
import type { ObjectStore } from '../../core/object-store.js';
import type { EgressProxy } from '../egress-proxy.js';
import { Capture, MessageParser, Tail, outcome, proxyEnv, resolveRuntimePaths, spillLogs, type RuntimePaths } from './common.js';

export interface ProcessSandboxOptions {
  log: Logger;
  proxy: EgressProxy | null;
  /** Breadboard API base URL handed to tool code (`BREADBOARD_API_URL`); its host bypasses the proxy. */
  apiUrl: string;
  pythonBin?: string;
  nodeBin?: string;
  objects?: ObjectStore | null;
  runtime?: RuntimePaths;
  /** Combined log size above which stdout/stderr spill to the object store. */
  logSpillBytes?: number;
  /** Grace period after `timeout_ms` before SIGKILL (the in-process runner timer fires first). */
  killGraceMs?: number;
}

const TAIL_BYTES = 16 * 1024;
const CAPTURE_MAX = 8 * 1024 * 1024;

export class ProcessSandboxRunner implements SandboxRunner {
  readonly kind = 'process' as const;
  private runtime: RuntimePaths | null;
  private warned = false;
  private active = new Set<number>();

  constructor(private opts: ProcessSandboxOptions) {
    this.runtime = opts.runtime ?? null;
  }

  private paths(): RuntimePaths {
    this.runtime ??= resolveRuntimePaths();
    return this.runtime;
  }

  async start(): Promise<void> {
    this.paths();
    if (!this.warned) {
      this.warned = true;
      this.opts.log.warn(
        'SANDBOX_RUNNER=process: tool code runs as unisolated local child processes (no filesystem, memory, pid, or network isolation). Development/test only — use SANDBOX_RUNNER=docker in production.',
      );
    }
  }

  async stop(): Promise<void> {
    for (const pid of this.active) killTree(pid);
    this.active.clear();
  }

  async health(): Promise<{ ok: boolean; detail: string; warm: Record<string, number> }> {
    try {
      this.paths();
      return { ok: true, detail: 'process runner (unisolated local fallback)', warm: {} };
    } catch (e) {
      return { ok: false, detail: (e as Error).message, warm: {} };
    }
  }

  async run(input: SandboxRunInput): Promise<SandboxRunResult> {
    const started = Date.now();
    const paths = this.paths();
    const [cmd, args] =
      input.language === 'typescript'
        ? [this.opts.nodeBin ?? process.execPath, ['--disable-warning=ExperimentalWarning', paths.nodeRunner, input.toolDir]]
        : [this.opts.pythonBin ?? 'python3', ['-u', paths.pythonRunner, input.toolDir]];

    const workdir = await mkdtemp(join(tmpdir(), 'bb-tool-'));
    const apiHost = safeHostname(this.opts.apiUrl);
    const { env: pEnv, registeredHere } = proxyEnv(this.opts.proxy, input, '127.0.0.1', apiHost ? [apiHost] : []);
    // Scrubbed env: never leak server secrets (DATABASE_URL, BROKER_MASTER_KEY, …) into tool code.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: workdir,
      TMPDIR: workdir,
      LANG: process.env.LANG ?? 'C.UTF-8',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUNBUFFERED: '1',
      BREADBOARD_API_URL: this.opts.apiUrl,
      BREADBOARD_EXECUTION_KEY: input.execution_key,
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
      ...pEnv,
    };

    const parser = new MessageParser();
    const stdoutTail = new Tail(TAIL_BYTES);
    const stderrTail = new Tail(TAIL_BYTES);
    const stdoutAll = new Capture(CAPTURE_MAX);
    const stderrAll = new Capture(CAPTURE_MAX);
    let timedOut = false;

    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>((resolve) => {
        const child = spawn(cmd, args, { cwd: workdir, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
        if (child.pid) this.active.add(child.pid);
        const timeoutMs = input.request.timeout_ms + (this.opts.killGraceMs ?? 2000);
        const timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) killTree(child.pid);
        }, timeoutMs);
        child.stdout.on('data', (b: Buffer) => {
          parser.push(b);
          stdoutTail.push(b);
          stdoutAll.push(b);
          if (stdoutAll.truncated && child.pid) killTree(child.pid); // runaway output
        });
        child.stderr.on('data', (b: Buffer) => {
          stderrTail.push(b);
          stderrAll.push(b);
        });
        child.on('error', (e) => {
          clearTimeout(timer);
          resolve({ code: null, signal: null, spawnError: e });
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (child.pid) this.active.delete(child.pid);
          resolve({ code, signal });
        });
        child.stdin.on('error', () => undefined); // child may exit before reading stdin
        child.stdin.end(JSON.stringify(input.request));
      });
      parser.end();
      const messages = parser.messages;
      if (exit.spawnError) messages.push({ kind: 'error', message: `failed to start ${input.language} runner (${cmd}): ${exit.spawnError.message}` });
      else if (timedOut && !outcome(messages)) messages.push({ kind: 'error', message: `tool timed out after ${input.limits.timeout_s}s (killed)` });
      else if (!outcome(messages)) messages.push({ kind: 'error', message: `tool runner exited without a result (exit ${exit.code ?? exit.signal})` });
      const log_ref = await spillLogs(this.opts.objects, stdoutAll, stderrAll, this.opts.logSpillBytes ?? 64 * 1024);
      return {
        exit_code: exit.code ?? (exit.signal ? 137 : 1),
        messages,
        stdout_tail: stdoutTail.toString(),
        stderr_tail: stderrTail.toString(),
        duration_ms: Date.now() - started,
        log_ref,
      };
    } finally {
      if (registeredHere) this.opts.proxy?.release(input.execution_key);
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function killTree(pid: number): void {
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
    else process.kill(pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}
