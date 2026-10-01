/** Helpers shared by the sandbox runners: runtime location, stdout protocol parsing, bounded log capture, proxy env. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerMessage } from '@breadboard/sandbox-runtime';
import type { ObjectStore } from '../../core/object-store.js';
import type { EgressProxy } from '../egress-proxy.js';
import type { SandboxRunInput } from '../../core/services.js';

export interface RuntimePaths {
  /** `<sandbox-runtime>/dist/runner-cli.js` */
  nodeRunner: string;
  /** `<sandbox-runtime>/python/breadboard_runtime.py` */
  pythonRunner: string;
}

/**
 * Locate `@breadboard/sandbox-runtime` on disk. Prefers `import.meta.resolve` (dist/index.js → sibling
 * runner-cli.js; python dir is `../python`), falling back to walking up for `node_modules/@breadboard/sandbox-runtime`
 * (test transformers do not always implement `import.meta.resolve`).
 */
export function resolveRuntimePaths(): RuntimePaths {
  let distDir: string | null = null;
  try {
    const resolver = (import.meta as { resolve?: (s: string) => string }).resolve;
    if (typeof resolver === 'function') distDir = dirname(fileURLToPath(resolver('@breadboard/sandbox-runtime')));
  } catch {
    distDir = null;
  }
  if (!distDir || !existsSync(join(distDir, 'runner-cli.js'))) {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
      const pkg = join(dir, 'node_modules', '@breadboard', 'sandbox-runtime', 'package.json');
      if (existsSync(pkg)) {
        const main = (JSON.parse(readFileSync(pkg, 'utf8')) as { main?: string }).main ?? './dist/index.js';
        distDir = dirname(resolve(dirname(pkg), main));
        break;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  if (!distDir) throw new Error('cannot locate @breadboard/sandbox-runtime (is the workspace installed?)');
  const nodeRunner = join(distDir, 'runner-cli.js');
  if (!existsSync(nodeRunner)) throw new Error(`sandbox runtime not built: ${nodeRunner} missing (run the sandbox-runtime build)`);
  return { nodeRunner, pythonRunner: join(distDir, '..', 'python', 'breadboard_runtime.py') };
}

/** Rolling tail of a byte stream. */
export class Tail {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private max: number) {}
  push(b: Buffer): void {
    this.chunks.push(b);
    this.size += b.length;
    while (this.size - (this.chunks[0]?.length ?? 0) >= this.max && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
  }
  toString(): string {
    const all = Buffer.concat(this.chunks);
    return all.subarray(Math.max(0, all.length - this.max)).toString('utf8');
  }
}

/** Full capture up to a cap (for spilling large logs to the object store). */
export class Capture {
  private chunks: Buffer[] = [];
  size = 0;
  truncated = false;
  constructor(private max: number) {}
  push(b: Buffer): void {
    if (this.size >= this.max) {
      this.truncated = true;
      return;
    }
    const take = b.subarray(0, this.max - this.size);
    if (take.length < b.length) this.truncated = true;
    this.chunks.push(take);
    this.size += take.length;
  }
  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/**
 * Incremental parser for the runner's stdout protocol (one JSON `RunnerMessage` per line).
 * Non-protocol lines (a tool's own `console.log`/`print`) become `info` log messages rather than corrupting the result.
 */
export class MessageParser {
  readonly messages: RunnerMessage[] = [];
  private buf = '';
  /** Messages beyond this are dropped (a runaway logger must not exhaust server memory). */
  constructor(private maxMessages = 5000) {}
  push(chunk: Buffer | string): void {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this.line(line);
    }
  }
  end(): void {
    if (this.buf.length) this.line(this.buf);
    this.buf = '';
  }
  private line(raw: string): void {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) return;
    let msg: RunnerMessage | null = null;
    if (line.startsWith('{')) {
      try {
        const v = JSON.parse(line) as RunnerMessage;
        if (v && typeof v === 'object' && (v.kind === 'log' || v.kind === 'result' || v.kind === 'error')) msg = v;
      } catch {
        msg = null;
      }
    }
    msg ??= { kind: 'log', level: 'info', message: line.slice(0, 4000), at: new Date().toISOString() };
    if (msg.kind !== 'log' || this.messages.length < this.maxMessages) this.messages.push(msg);
  }
}

/** Upload combined stdout/stderr when it exceeds `threshold` bytes; returns the object ref (or null). */
export async function spillLogs(objects: ObjectStore | null | undefined, stdout: Capture, stderr: Capture, threshold: number): Promise<string | null> {
  if (!objects || stdout.size + stderr.size <= threshold) return null;
  const doc = Buffer.concat([
    Buffer.from('--- stdout ---\n'),
    stdout.buffer(),
    Buffer.from(stdout.truncated ? '\n[truncated]\n' : '\n'),
    Buffer.from('--- stderr ---\n'),
    stderr.buffer(),
    Buffer.from(stderr.truncated ? '\n[truncated]\n' : '\n'),
  ]);
  return objects.put(doc, 'text/plain');
}

/**
 * Proxy env for a sandboxed process. If the toolbox has not already registered this execution with the proxy,
 * the runner registers it from the manifest egress (and reports that it must release it).
 */
export function proxyEnv(
  proxy: EgressProxy | null,
  input: SandboxRunInput,
  proxyHost: string,
  noProxy: string[],
): { env: Record<string, string>; registeredHere: boolean } {
  if (!proxy) return { env: {}, registeredHere: false };
  let registeredHere = false;
  if (!proxy.isRegistered(input.execution_key)) {
    proxy.register(input.execution_key, { allow: input.egress.allow, tool_uid: input.tool_uid });
    registeredHere = true;
  }
  const url = proxy.proxyUrlFor(input.execution_key, proxyHost)!;
  const np = noProxy.join(',');
  return {
    env: {
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      http_proxy: url,
      https_proxy: url,
      NO_PROXY: np,
      no_proxy: np,
      // Node's built-in fetch/http only honour *_PROXY with this switch (Node ≥24).
      NODE_USE_ENV_PROXY: '1',
    },
    registeredHere,
  };
}

/** Last protocol-level outcome in a message list. */
export function outcome(messages: RunnerMessage[]): Extract<RunnerMessage, { kind: 'result' | 'error' }> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === 'result' || m.kind === 'error') return m;
  }
  return null;
}
