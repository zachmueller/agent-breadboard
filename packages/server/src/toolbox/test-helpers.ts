/** Test-only helpers for toolbox tests: temp tool directories and a fake ConfigService. */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mintUid, parseConfigYaml, toYaml, zBreadboardConfig, type BreadboardConfig, type McpServer, type Tool } from '@breadboard/shared';
import type { ConfigService, LoadedTool } from '../core/services.js';

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
