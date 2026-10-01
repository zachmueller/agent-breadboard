/**
 * Docker sandbox runner ([06] §4, [12] §6): one fresh container per tool execution.
 *
 * Posture (all enforced here, per execution):
 *  - non-root (`10001:10001`), read-only root filesystem, tmpfs `/work` (noexec), all capabilities dropped,
 *    `no-new-privileges`; memory / CPU / pids limits from the tool manifest;
 *  - attached only to the internal-only network `breadboard-sandbox` (no external route); the sole way out is
 *    the egress proxy, addressed via `SANDBOX_EGRESS_PROXY_HOST` (default `host.docker.internal`, mapped to the
 *    host gateway through `ExtraHosts`). Tool code reaches the Breadboard API *through the proxy* (an implicit
 *    allowlist destination), so the container needs no other route;
 *  - configurable OCI runtime (`SANDBOX_OCI_RUNTIME=runsc` for gVisor);
 *  - the Docker socket is never mounted into tool containers.
 *
 * Warm pools hold pre-started, never-used containers per image; a container is removed after one execution
 * and never returned. Per-tool limits are applied to a warm container with `container.update()` before use
 * (falling back to a cold container if the daemon refuses). The tool directory is copied into an anonymous
 * volume at `/tool` with `putArchive` (root-owned, so read-only for the sandbox user; the root filesystem stays
 * read-only), or bind-mounted `:ro` when `bindToolDir` is set and the daemon shares the server's filesystem.
 */
import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import type { SandboxRunInput, SandboxRunResult, SandboxRunner } from '../../core/services.js';
import type { Logger } from '../../core/logger.js';
import type { ObjectStore } from '../../core/object-store.js';
import type { Tool } from '@breadboard/shared';
import type { EgressProxy } from '../egress-proxy.js';
import { Capture, MessageParser, Tail, outcome, proxyEnv, spillLogs } from './common.js';
import { tarDirectory } from './tar.js';

export const SANDBOX_NETWORK = 'breadboard-sandbox';
export const SANDBOX_USER = '10001:10001';
export const SANDBOX_LABEL = 'breadboard.sandbox';
export const WORK_TMPFS = 'rw,noexec,nosuid,nodev,size=256m,mode=1777';

type Language = 'typescript' | 'python';

export interface DockerSandboxOptions {
  log: Logger;
  proxy: EgressProxy | null;
  /** `SANDBOX_DOCKER_SOCKET`: a unix socket path, or `tcp://host:port` / `http(s)://host:port`. */
  socket: string;
  /** `settings.sandbox.images` (read at start and per run, so config changes apply without restart). */
  images: () => Promise<{ typescript: string; python: string }>;
  warmPoolSize: number;
  ociRuntime?: string | null;
  /** Hostname containers use to reach the egress proxy. */
  proxyHost?: string;
  /** API base URL given to tool code; defaults to the request's `api.base_url` (the server's public URL). */
  apiUrl?: string | null;
  network?: string;
  objects?: ObjectStore | null;
  logSpillBytes?: number;
  /** Bind-mount the tool dir read-only instead of copying it (local daemon only; bypasses the warm pool). */
  bindToolDir?: boolean;
  /** Injected for tests. */
  docker?: Docker;
}

/** Idle process for warm containers — no shell needed in the image. */
export function idleCommand(language: Language): string[] {
  return language === 'typescript' ? ['node', '-e', 'setInterval(() => {}, 1 << 30)'] : ['python3', '-c', 'import time\nwhile True: time.sleep(3600)'];
}

export function runnerCommand(language: Language): string[] {
  return language === 'typescript'
    ? ['node', '--disable-warning=ExperimentalWarning', '/runtime/runner-cli.js', '/tool']
    : ['python3', '-u', '/runtime/breadboard_runtime.py', '/tool'];
}

/** Resource limits from the manifest, in Docker's units (also used for `container.update`). */
export function resourceLimits(limits: Tool['limits']): { Memory: number; MemorySwap: number; NanoCpus: number; PidsLimit: number } {
  const mem = Math.round(limits.memory_mb * 1024 * 1024);
  return { Memory: mem, MemorySwap: mem, NanoCpus: Math.round(limits.cpus * 1e9), PidsLimit: limits.pids };
}

/** The security-relevant HostConfig of every tool container ([12] §6). */
export function buildHostConfig(o: { limits: Tool['limits']; network?: string; runtime?: string | null; binds?: string[] }): Docker.HostConfig {
  return {
    ...resourceLimits(o.limits),
    ReadonlyRootfs: true,
    Tmpfs: { '/work': WORK_TMPFS, '/tmp': 'rw,noexec,nosuid,nodev,size=64m,mode=1777' },
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    NetworkMode: o.network ?? SANDBOX_NETWORK,
    ExtraHosts: ['host.docker.internal:host-gateway'],
    IpcMode: 'private',
    Privileged: false,
    AutoRemove: false,
    ...(o.runtime ? { Runtime: o.runtime } : {}),
    ...(o.binds?.length ? { Binds: o.binds } : {}),
  };
}

export function buildCreateOptions(o: {
  image: string;
  language: Language;
  limits: Tool['limits'];
  network?: string;
  runtime?: string | null;
  bindToolDir?: string | null;
  state: 'warm' | 'cold';
}): Docker.ContainerCreateOptions {
  return {
    Image: o.image,
    Cmd: idleCommand(o.language),
    User: SANDBOX_USER,
    WorkingDir: '/work',
    Env: ['HOME=/work', 'TMPDIR=/work'],
    Labels: { [SANDBOX_LABEL]: '1', 'breadboard.language': o.language, 'breadboard.state': o.state },
    Tty: false,
    OpenStdin: false,
    StopSignal: 'SIGKILL',
    NetworkDisabled: false,
    ...(o.bindToolDir ? {} : { Volumes: { '/tool': {} } }),
    HostConfig: buildHostConfig({ limits: o.limits, network: o.network, runtime: o.runtime, binds: o.bindToolDir ? [`${o.bindToolDir}:/tool:ro`] : undefined }),
  };
}

/** Docker's multiplexed attach stream framing: [type(1) 0 0 0 size(4 BE)] payload. */
export class DockerStreamDemuxer {
  private buf: Buffer = Buffer.alloc(0);
  constructor(
    private onStdout: (b: Buffer) => void,
    private onStderr: (b: Buffer) => void,
  ) {}
  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 8) {
      const type = this.buf[0]!;
      const size = this.buf.readUInt32BE(4);
      if (this.buf.length < 8 + size) break;
      const payload = this.buf.subarray(8, 8 + size);
      this.buf = this.buf.subarray(8 + size);
      if (type === 2) this.onStderr(payload);
      else this.onStdout(payload);
    }
  }
}

export function dockerConnection(socket: string): Docker.DockerOptions {
  const m = /^(tcp|http|https):\/\/([^:/]+)(?::(\d+))?/.exec(socket);
  if (m) return { protocol: m[1] === 'https' ? 'https' : 'http', host: m[2], port: Number(m[3] ?? (m[1] === 'https' ? 2376 : 2375)) };
  return { socketPath: socket.replace(/^unix:\/\//, '') };
}

const DEFAULT_LIMITS: Tool['limits'] = { timeout_s: 120, memory_mb: 512, cpus: 1, pids: 256, max_cost_units: 1 };
const TAIL_BYTES = 16 * 1024;
const CAPTURE_MAX = 8 * 1024 * 1024;

export class DockerSandboxRunner implements SandboxRunner {
  readonly kind = 'docker' as const;
  private docker: Docker;
  private pools = new Map<Language, Docker.Container[]>([
    ['typescript', []],
    ['python', []],
  ]);
  private filling = new Map<Language, Promise<void>>();
  private stopped = false;
  private network: string;

  constructor(private opts: DockerSandboxOptions) {
    this.docker = opts.docker ?? new Docker(dockerConnection(opts.socket));
    this.network = opts.network ?? SANDBOX_NETWORK;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.docker.ping();
    await this.ensureNetwork();
    await this.removeStale();
    if (!this.opts.bindToolDir) for (const lang of ['typescript', 'python'] as const) void this.refill(lang);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.filling.values()]);
    const all = [...this.pools.values()].flat();
    for (const p of this.pools.values()) p.length = 0;
    await Promise.allSettled(all.map((c) => c.remove({ force: true, v: true })));
  }

  async health(): Promise<{ ok: boolean; detail: string; warm: Record<string, number> }> {
    const warm = { typescript: this.pools.get('typescript')!.length, python: this.pools.get('python')!.length };
    try {
      await this.docker.ping();
      return { ok: true, detail: `docker daemon reachable; network ${this.network}${this.opts.ociRuntime ? `; runtime ${this.opts.ociRuntime}` : ''}`, warm };
    } catch (e) {
      return { ok: false, detail: `docker daemon unreachable: ${(e as Error).message}`, warm };
    }
  }

  private async ensureNetwork(): Promise<void> {
    const nets = await this.docker.listNetworks({ filters: { name: [this.network] } });
    const existing = nets.find((n) => n.Name === this.network);
    if (existing) {
      if (!existing.Internal) this.opts.log.error({ network: this.network }, 'sandbox network is NOT internal — containers may have a direct route out; recreate it with --internal');
      return;
    }
    await this.docker.createNetwork({ Name: this.network, Driver: 'bridge', Internal: true, Labels: { [SANDBOX_LABEL]: '1' } });
    this.opts.log.info({ network: this.network }, 'created internal sandbox network');
  }

  /** Containers left behind by a previous process (crash) are never reused. */
  private async removeStale(): Promise<void> {
    const stale = await this.docker.listContainers({ all: true, filters: { label: [`${SANDBOX_LABEL}=1`] } });
    await Promise.allSettled(stale.map((c) => this.docker.getContainer(c.Id).remove({ force: true, v: true })));
    if (stale.length) this.opts.log.info({ count: stale.length }, 'removed stale sandbox containers');
  }

  private async image(language: Language): Promise<string> {
    const images = await this.opts.images();
    return language === 'typescript' ? images.typescript : images.python;
  }

  private async createContainer(language: Language, limits: Tool['limits'], state: 'warm' | 'cold', bindToolDir: string | null = null): Promise<Docker.Container> {
    const c = await this.docker.createContainer(
      buildCreateOptions({ image: await this.image(language), language, limits, network: this.network, runtime: this.opts.ociRuntime, bindToolDir, state }),
    );
    try {
      await c.start();
    } catch (e) {
      await c.remove({ force: true, v: true }).catch(() => undefined);
      throw e;
    }
    return c;
  }

  private refill(language: Language): Promise<void> {
    const inflight = this.filling.get(language);
    if (inflight) return inflight;
    const p = (async () => {
      const pool = this.pools.get(language)!;
      while (!this.stopped && pool.length < this.opts.warmPoolSize) {
        try {
          pool.push(await this.createContainer(language, DEFAULT_LIMITS, 'warm'));
        } catch (e) {
          this.opts.log.error({ err: (e as Error).message, language }, 'warm pool refill failed');
          break;
        }
      }
    })().finally(() => this.filling.delete(language));
    this.filling.set(language, p);
    return p;
  }

  /** A pre-started, never-used container with this tool's limits applied; cold-started when the pool is empty. */
  private async acquire(language: Language, limits: Tool['limits']): Promise<Docker.Container> {
    const pool = this.pools.get(language)!;
    const warm = pool.shift();
    void this.refill(language);
    if (warm) {
      try {
        await warm.update(resourceLimits(limits));
        return warm;
      } catch (e) {
        this.opts.log.warn({ err: (e as Error).message }, 'could not apply limits to warm container; cold-starting');
        await warm.remove({ force: true, v: true }).catch(() => undefined);
      }
    }
    return this.createContainer(language, limits, 'cold');
  }

  async run(input: SandboxRunInput): Promise<SandboxRunResult> {
    const started = Date.now();
    const container = this.opts.bindToolDir
      ? await this.createContainer(input.language, input.limits, 'cold', input.toolDir)
      : await this.acquire(input.language, input.limits);
    const { env: pEnv, registeredHere } = proxyEnv(this.opts.proxy, input, this.opts.proxyHost ?? 'host.docker.internal', []);
    const request = this.opts.apiUrl ? { ...input.request, api: { ...input.request.api, base_url: this.opts.apiUrl } } : input.request;
    const parser = new MessageParser();
    const stdoutTail = new Tail(TAIL_BYTES);
    const stderrTail = new Tail(TAIL_BYTES);
    const stdoutAll = new Capture(CAPTURE_MAX);
    const stderrAll = new Capture(CAPTURE_MAX);
    let timedOut = false;
    let exitCode = 1;
    try {
      if (!this.opts.bindToolDir) {
        const tar = await tarDirectory(input.toolDir, { skip: (rel) => rel === '.git' || rel.endsWith('/__pycache__') || rel === '__pycache__' });
        await container.putArchive(tar, { path: '/tool' });
      }
      const env = [
        'HOME=/work',
        'TMPDIR=/work',
        'PYTHONDONTWRITEBYTECODE=1',
        'PYTHONUNBUFFERED=1',
        `BREADBOARD_API_URL=${request.api.base_url}`,
        `BREADBOARD_EXECUTION_KEY=${input.execution_key}`,
        ...Object.entries(pEnv).map(([k, v]) => `${k}=${v}`),
      ];
      const exec = await container.exec({
        Cmd: runnerCommand(input.language),
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        User: SANDBOX_USER,
        WorkingDir: '/work',
        Env: env,
      });
      const stream = (await exec.start({ hijack: true, stdin: true })) as unknown as NodeJS.ReadWriteStream & { destroy?: () => void };
      const demux = new DockerStreamDemuxer(
        (b) => {
          parser.push(b);
          stdoutTail.push(b);
          stdoutAll.push(b);
        },
        (b) => {
          stderrTail.push(b);
          stderrAll.push(b);
        },
      );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          void container.kill().catch(() => undefined);
          stream.destroy?.();
          resolve();
        }, input.request.timeout_ms + 2000);
        const sink = new PassThrough();
        sink.on('data', (b: Buffer) => {
          demux.push(b);
          if (stdoutAll.truncated) {
            void container.kill().catch(() => undefined);
            stream.destroy?.();
          }
        });
        stream.pipe(sink);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        stream.on('end', done);
        stream.on('close', done);
        stream.on('error', done);
        stream.write(JSON.stringify(request));
        stream.end();
      });
      if (!timedOut) {
        for (let i = 0; i < 50; i++) {
          const info = await exec.inspect();
          if (!info.Running) {
            exitCode = info.ExitCode ?? 1;
            break;
          }
          await new Promise((r) => setTimeout(r, 20));
        }
      } else exitCode = 137;
    } catch (e) {
      parser.messages.push({ kind: 'error', message: `sandbox error: ${(e as Error).message}` });
    } finally {
      if (registeredHere) this.opts.proxy?.release(input.execution_key);
      // Never reused: removed after exactly one execution ([06] §4).
      void container.remove({ force: true, v: true }).catch((e) => this.opts.log.warn({ err: (e as Error).message }, 'sandbox container removal failed'));
    }
    parser.end();
    const messages = parser.messages;
    if (timedOut && !outcome(messages)) messages.push({ kind: 'error', message: `tool timed out after ${input.limits.timeout_s}s (killed)` });
    else if (!outcome(messages)) messages.push({ kind: 'error', message: `tool runner exited without a result (exit ${exitCode})` });
    const log_ref = await spillLogs(this.opts.objects, stdoutAll, stderrAll, this.opts.logSpillBytes ?? 64 * 1024);
    return { exit_code: exitCode, messages, stdout_tail: stdoutTail.toString(), stderr_tail: stderrTail.toString(), duration_ms: Date.now() - started, log_ref };
  }
}
