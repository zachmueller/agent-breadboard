import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ZodType } from 'zod';
import { CONFIG_KINDS, SCHEMA_TAGS, type ConfigKind } from './common.js';
import { zCircuit } from './circuit.js';
import { zSubagent } from './subagent.js';
import { zTool } from './tool.js';
import { zMcpServer } from './mcp.js';
import { zPresets } from './presets.js';
import { zRubric } from './rubric.js';
import { zFixtures } from './fixtures.js';
import { zBreadboardConfig } from './breadboard.js';

export * from './common.js';
export * from './circuit.js';
export * from './subagent.js';
export * from './tool.js';
export * from './mcp.js';
export * from './presets.js';
export * from './rubric.js';
export * from './fixtures.js';
export * from './breadboard.js';

export const CONFIG_SCHEMAS: Record<Exclude<ConfigKind, 'tenets'>, ZodType> = {
  circuit: zCircuit,
  subagent: zSubagent,
  tool: zTool,
  mcp: zMcpServer,
  presets: zPresets,
  rubric: zRubric,
  fixtures: zFixtures,
  breadboard: zBreadboardConfig,
};

/** Config repo layout ([01] §6.1): paths are a pure function of UID. */
export const CONFIG_PATHS = {
  index: 'INDEX.md',
  breadboard: 'breadboard.yaml',
  tenets: 'tenets.md',
  presets: 'presets/models.yaml',
  subagent: (uid: string) => `subagents/${uid}.yaml`,
  circuitDir: (uid: string) => `circuits/${uid}`,
  circuit: (uid: string) => `circuits/${uid}/circuit.yaml`,
  circuitPrompt: (uid: string, stepId: string) => `circuits/${uid}/prompts/${stepId}.md`,
  rubric: (uid: string) => `circuits/${uid}/rubric.yaml`,
  fixtures: (uid: string) => `circuits/${uid}/fixtures.yaml`,
  toolDir: (uid: string) => `tools/${uid}`,
  tool: (uid: string) => `tools/${uid}/tool.yaml`,
  mcp: (uid: string) => `mcp/${uid}.yaml`,
} as const;

export interface ParsedPath {
  kind: ConfigKind;
  uid: string | null;
  /** For circuit/tool directories: the file within the definition dir (e.g. `prompts/gather.md`, `src/index.ts`). */
  sub: string | null;
}

/** Classify a repo-relative path. Returns null for files outside the known layout. */
export function parseConfigPath(path: string): ParsedPath | null {
  const p = path.replace(/^\/+/, '');
  if (p === CONFIG_PATHS.breadboard) return { kind: 'breadboard', uid: null, sub: null };
  if (p === CONFIG_PATHS.tenets) return { kind: 'tenets', uid: null, sub: null };
  if (p === CONFIG_PATHS.presets) return { kind: 'presets', uid: null, sub: null };
  let m = /^subagents\/([0-9A-HJKMNP-TV-Z]{20})\.yaml$/.exec(p);
  if (m) return { kind: 'subagent', uid: m[1]!, sub: null };
  m = /^mcp\/([0-9A-HJKMNP-TV-Z]{20})\.yaml$/.exec(p);
  if (m) return { kind: 'mcp', uid: m[1]!, sub: null };
  m = /^circuits\/([0-9A-HJKMNP-TV-Z]{20})\/(.+)$/.exec(p);
  if (m) {
    const sub = m[2]!;
    if (sub === 'circuit.yaml') return { kind: 'circuit', uid: m[1]!, sub: null };
    if (sub === 'rubric.yaml') return { kind: 'rubric', uid: m[1]!, sub: null };
    if (sub === 'fixtures.yaml') return { kind: 'fixtures', uid: m[1]!, sub: null };
    return { kind: 'circuit', uid: m[1]!, sub };
  }
  m = /^tools\/([0-9A-HJKMNP-TV-Z]{20})\/(.+)$/.exec(p);
  if (m) {
    const sub = m[2]!;
    if (sub === 'tool.yaml') return { kind: 'tool', uid: m[1]!, sub: null };
    return { kind: 'tool', uid: m[1]!, sub };
  }
  return null;
}

/** The editable definition a repo path belongs to: rubric, fixtures and prompts belong to their circuit, sources to their tool. */
export function owningDefinition(path: string): { kind: 'circuit' | 'tool' | 'subagent' | 'mcp'; uid: string } | null {
  const p = parseConfigPath(path);
  if (!p?.uid) return null;
  if (p.kind === 'rubric' || p.kind === 'fixtures') return { kind: 'circuit', uid: p.uid };
  if (p.kind === 'circuit' || p.kind === 'tool' || p.kind === 'subagent' || p.kind === 'mcp') return { kind: p.kind, uid: p.uid };
  return null;
}

export function definitionPath(kind: ConfigKind, uid?: string | null): string {
  switch (kind) {
    case 'breadboard':
      return CONFIG_PATHS.breadboard;
    case 'tenets':
      return CONFIG_PATHS.tenets;
    case 'presets':
      return CONFIG_PATHS.presets;
    case 'subagent':
      return CONFIG_PATHS.subagent(uid!);
    case 'mcp':
      return CONFIG_PATHS.mcp(uid!);
    case 'circuit':
      return CONFIG_PATHS.circuit(uid!);
    case 'rubric':
      return CONFIG_PATHS.rubric(uid!);
    case 'fixtures':
      return CONFIG_PATHS.fixtures(uid!);
    case 'tool':
      return CONFIG_PATHS.tool(uid!);
  }
}

export interface ParseResult<T = unknown> {
  ok: boolean;
  value?: T;
  errors: string[];
  kind?: ConfigKind;
}

/** Parse + validate a YAML config document against the schema its `schema:` tag declares. */
export function parseConfigYaml(text: string, expectKind?: Exclude<ConfigKind, 'tenets'>): ParseResult {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return { ok: false, errors: [`yaml parse error: ${(e as Error).message}`] };
  }
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['document must be a YAML mapping'] };
  const tag = (doc as any).schema;
  const kind = (Object.keys(SCHEMA_TAGS) as Array<Exclude<ConfigKind, 'tenets'>>).find((k) => SCHEMA_TAGS[k] === tag);
  if (!kind) return { ok: false, errors: [`unknown or missing schema tag: ${String(tag)} (expected one of ${Object.values(SCHEMA_TAGS).join(', ')})`] };
  if (expectKind && kind !== expectKind) return { ok: false, errors: [`expected ${SCHEMA_TAGS[expectKind]} but found ${tag}`], kind };
  const res = CONFIG_SCHEMAS[kind].safeParse(doc);
  if (!res.success) {
    return { ok: false, kind, errors: res.error.issues.map((i) => `${i.path.join('.') || '/'}: ${i.message}`) };
  }
  return { ok: true, kind, value: res.data, errors: [] };
}

export function toYaml(value: unknown): string {
  return stringifyYaml(value, { lineWidth: 0 });
}

export { CONFIG_KINDS };
