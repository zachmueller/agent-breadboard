/** Test-only helpers for toolbox tests: temp tool directories, a fake ConfigService, and the runner under test. */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mintUid, parseConfigYaml, toYaml, zBreadboardConfig, type BreadboardConfig, type McpServer, type Tool } from '@breadboard/shared';
import type { ConfigService, LoadedTool, SandboxRunner } from '../core/services.js';
import type { Logger } from '../core/logger.js';
import type { ObjectStore } from '../core/object-store.js';
import type { EgressProxy } from './egress-proxy.js';
import { DockerSandboxRunner } from './sandbox/docker.js';
import { ProcessSandboxRunner } from './sandbox/process.js';

/**
 * `SANDBOX_RUNNER=docker` runs the toolbox suite against real containers (images from `deploy/sandbox`, network
 * `breadboard-sandbox`); anything else uses the process runner. Docker mode also reads `SANDBOX_DOCKER_SOCKET`,
 * `SANDBOX_EGRESS_PROXY_HOST`, and `SANDBOX_EGRESS_PROXY_PORT` (see `deploy/sandbox/README.md` for hosts where
 * the sandbox network cannot reach the host gateway).
 */
export const TEST_RUNNER: 'docker' | 'process' = process.env.SANDBOX_RUNNER === 'docker' ? 'docker' : 'process';

/** Proxy listen options: an ephemeral loopback port for the process runner, a fixed all-interfaces port for docker. */
export function testProxyListen(): { port: number; bindHost: string } {
  return TEST_RUNNER === 'docker' ? { port: Number(process.env.SANDBOX_EGRESS_PROXY_PORT ?? 4100), bindHost: '0.0.0.0' } : { port: 0, bindHost: '127.0.0.1' };
}

export function createTestSandboxRunner(o: { log: Logger; proxy: EgressProxy; apiUrl: string; objects: ObjectStore; pythonBin: string; images: BreadboardConfig['sandbox']['images'] }): SandboxRunner {
  if (TEST_RUNNER === 'docker') {
    return new DockerSandboxRunner({
      log: o.log,
      proxy: o.proxy,
      socket: process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock',
      images: async () => o.images,
      warmPoolSize: 1,
      proxyHost: process.env.SANDBOX_EGRESS_PROXY_HOST ?? 'host.docker.internal',
      objects: o.objects,
    });
  }
  return new ProcessSandboxRunner({ log: o.log, proxy: o.proxy, apiUrl: o.apiUrl, pythonBin: o.pythonBin, objects: o.objects, killGraceMs: 1000 });
}

export async function makeToolDir(manifest: Record<string, unknown>, files: Record<string, string>): Promise<LoadedTool> {
  const uid = (manifest.uid as string) ?? mintUid();
  const dir = await mkdtemp(join(tmpdir(), `bb-tooldir-`));
  const doc = { schema: 'breadboard/tool@v1', uid, slug: `t-${uid.slice(0, 6).toLowerCase()}`, title: 'Test tool', ...manifest };
  const yaml = toYaml(doc);
  await writeFile(join(dir, 'tool.yaml'), yaml);
  for (const [p, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), content);
  }
  const parsed = parseConfigYaml(yaml, 'tool');
  if (!parsed.ok) throw new Error(`bad test manifest: ${parsed.errors.join('; ')}`);
  return { uid, commit: 'c0ffee0000000000000000000000000000000000', tool: parsed.value as Tool, dir };
}

export function defaultSettings(patch: (s: BreadboardConfig) => void = () => undefined): BreadboardConfig {
  const s = zBreadboardConfig.parse({ schema: 'breadboard/breadboard@v1' });
  patch(s);
  return s;
}

export function fakeConfig(opts: { tools?: LoadedTool[]; mcp?: McpServer[]; settings?: BreadboardConfig }): ConfigService & { toolCalls: Array<{ uid: string; ref?: string }> } {
  const tools = new Map((opts.tools ?? []).map((t) => [t.uid, t]));
  const mcp = new Map((opts.mcp ?? []).map((m) => [m.uid, m]));
  const toolCalls: Array<{ uid: string; ref?: string }> = [];
  const impl: Partial<ConfigService> = {
    async mainCommit() {
      return 'c0ffee0000000000000000000000000000000000';
    },
    async settings() {
      return opts.settings ?? defaultSettings();
    },
    async tool(uid: string, ref?: string) {
      toolCalls.push({ uid, ref });
      const t = tools.get(uid);
      if (!t) throw new Error(`tool ${uid} not found`);
      return t;
    },
    async mcp(uid: string) {
      const m = mcp.get(uid);
      if (!m) throw new Error(`mcp ${uid} not found`);
      return m;
    },
    async tree() {
      return [...tools.values()].map((t) => ({ uid: t.uid, kind: 'tool', slug: t.tool.slug, title: t.tool.title, path: `tools/${t.uid}/tool.yaml` }));
    },
  };
  return Object.assign(impl as ConfigService, { toolCalls });
}
