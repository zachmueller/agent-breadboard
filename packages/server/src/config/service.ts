/**
 * ConfigServiceImpl — loaders, validation, proposals (propose-review-commit), INDEX.md, skeletons.
 *
 * Everything here is commit-addressed: a `ref` (default `main`) is resolved to a commit once, and all reads,
 * caches, and validation reports hang off that commit. The service never holds a checkout; it reads blobs via
 * the `ConfigRepo` seam and only asks for `materializeTree` when a filesystem view is genuinely needed
 * (tool source directories).
 *
 * Validation operates on a `VirtualTree` — either a commit's listing or a base listing with a prospective
 * change set applied over it — so `validateTree` and `validateChanges` share one rule set ([01] §6.2,
 * [03] §2, [05] §2.1/§4/§5, [06] §2, [04] §2–3).
 */
import {
  BreadboardError,
  CONFIG_PATHS,
  SCHEMA_TAGS,
  actorLabel,
  circuitExitName,
  definitionPath,
  isCircuitExitTarget,
  isUid,
  mintProposalId,
  mintUid,
  owningDefinition,
  parseConfigPath,
  parseConfigYaml,
  schemaCompileError,
  templateReferences,
  toYaml,
  zBreadboardConfig,
  type BreadboardConfig,
  type Circuit,
  type ConfigDefinitionDto,
  type ConfigKind,
  type ConfigTreeEntry,
  type Fixtures,
  type McpServer,
  type Presets,
  type ProposalDto,
  type Rubric,
  type Step,
  type Subagent,
  type Tool,
} from '@breadboard/shared';
import type { Db } from '../db/index.js';
import type { Logger } from '../core/logger.js';
import type { Principal } from '../core/principal.js';
import type { CommitInfo, ConfigRepo, ConfigService, DefinitionLookupOptions, EventBus, FileChange, GitAuthor, LoadedCircuit, LoadedTool, ValidationReport } from '../core/services.js';
import { DEFAULT_BRANCH, normalizePath } from './repo.js';

const MAIN_TTL_MS = 5_000;
const MODEL_CACHE_SIZE = 12;
const FILE_CACHE_SIZE = 4_000;
const PROPOSAL_BRANCH_PREFIX = 'proposals/';
const DEFAULT_PROVIDERS = ['bedrock', 'mock'];
const INDEX_HEADER = '# Configuration index';

export interface ConfigServiceDeps {
  repo: ConfigRepo;
  db: Db;
  team_id: string;
  log: Logger;
  events?: EventBus | null;
  /** Installed model-gateway provider adapters; preset `provider` values must be among them ([05] §4). */
  gatewayProviders?: () => string[];
}

export interface ValidateOptions {
  /** Work-in-progress branch: unreachable steps are warnings instead of errors ([03] §2). */
  nonMain?: boolean;
}

// -----------------------------------------------------------------------------------------------
// Tree model
// -----------------------------------------------------------------------------------------------

interface VirtualTree {
  /** Commit the tree is read from, or null for an overlay. */
  commit: string | null;
  files: string[];
  read(path: string): Promise<string | null>;
}

interface DefEntry {
  path: string;
  kind: ConfigKind;
  /** UID derived from the path (circuit/subagent/tool/mcp; also rubric/fixtures = their circuit UID). Null for singletons. */
  uid: string | null;
  raw: string;
  parsed: unknown | null;
  parseErrors: string[];
  slug: string | null;
  title: string | null;
  /** The definition's `description`, searched by `search` only. */
  description: string | null;
}

interface Reference {
  from: DefEntry;
  to: string;
  expect: ConfigKind;
  what: string;
}

interface TreeModel {
  commit: string | null;
  files: string[];
  defs: DefEntry[];
  /** Definitions addressable by UID (circuit/subagent/tool/mcp). */
  byUid: Map<string, DefEntry>;
  byPath: Map<string, DefEntry>;
  settings: BreadboardConfig;
  presets: Presets | null;
  tenets: string | null;
  refs: Reference[];
  unknownFiles: string[];
  /** Text of every file under `circuits/<uid>/prompts/`. */
  prompts: Map<string, string>;
}

const UID_KINDS: ConfigKind[] = ['circuit', 'subagent', 'tool', 'mcp'];
const SINGLETONS: ConfigKind[] = ['breadboard', 'tenets', 'presets'];
const KIND_LABEL: Record<ConfigKind, string> = {
  circuit: 'circuit',
  subagent: 'subagent',
  tool: 'tool',
  mcp: 'MCP server',
  presets: 'model presets',
  tenets: 'tenets',
  breadboard: 'instance settings',
  rubric: 'rubric',
  fixtures: 'fixtures',
};

function defaultSettings(): BreadboardConfig {
  return zBreadboardConfig.parse({ schema: SCHEMA_TAGS.breadboard });
}

/** Does this file hold a parseable definition document (vs. a prompt/source/other sub-file)? */
function isDefinitionFile(path: string): ConfigKind | null {
  const p = parseConfigPath(path);
  if (!p) return null;
  if (p.sub !== null) return null;
  return p.kind;
}

async function buildModel(vt: VirtualTree): Promise<TreeModel> {
  const model: TreeModel = {
    commit: vt.commit,
    files: vt.files,
    defs: [],
    byUid: new Map(),
    byPath: new Map(),
    settings: defaultSettings(),
    presets: null,
    tenets: null,
    refs: [],
    unknownFiles: [],
    prompts: new Map(),
  };
  for (const path of vt.files) {
    if (path === CONFIG_PATHS.index) continue;
    const parsedPath = parseConfigPath(path);
    if (!parsedPath) {
      model.unknownFiles.push(path);
      continue;
    }
    if (parsedPath.kind === 'circuit' && parsedPath.sub?.startsWith('prompts/')) {
      const text = await vt.read(path);
      if (text !== null) model.prompts.set(path, text);
      continue;
    }
    const kind = isDefinitionFile(path);
    if (!kind) continue;
    const raw = (await vt.read(path)) ?? '';
    const entry: DefEntry = { path, kind, uid: parsedPath.uid, raw, parsed: null, parseErrors: [], slug: null, title: null, description: null };
    if (kind === 'tenets') {
      model.tenets = raw;
      entry.parsed = raw;
    } else {
      const res = parseConfigYaml(raw, kind);
      if (res.ok) {
        entry.parsed = res.value;
        const v = res.value as any;
        entry.slug = typeof v.slug === 'string' ? v.slug : null;
        entry.title = typeof v.title === 'string' ? v.title : null;
        entry.description = typeof v.description === 'string' && v.description.trim() ? v.description : null;
        if (kind === 'breadboard') model.settings = v as BreadboardConfig;
        if (kind === 'presets') model.presets = v as Presets;
      } else {
        entry.parseErrors = res.errors;
      }
    }
    model.defs.push(entry);
    model.byPath.set(path, entry);
    if (entry.uid && UID_KINDS.includes(kind) && entry.parsed) {
      // Only path-consistent definitions are addressable; mismatches are reported by validation.
      if ((entry.parsed as any).uid === entry.uid) model.byUid.set(entry.uid, entry);
    }
  }
  for (const def of model.defs) collectRefs(model, def);
  return model;
}

function addRef(model: TreeModel, from: DefEntry, to: unknown, expect: ConfigKind, what: string): void {
  if (typeof to !== 'string' || !to) return;
  model.refs.push({ from, to, expect, what });
}

function collectRefs(model: TreeModel, def: DefEntry): void {
  const v = def.parsed as any;
  if (!v) return;
  switch (def.kind) {
    case 'circuit': {
      const c = v as Circuit;
      for (const s of c.steps) {
        if (s.kind === 'llm') {
          addRef(model, def, s.subagent, 'subagent', `step '${s.id}' subagent`);
          for (const t of s.tools_override ?? []) addRef(model, def, t, 'tool', `step '${s.id}' tools_override`);
        } else if (s.kind === 'code') addRef(model, def, s.tool, 'tool', `step '${s.id}' tool`);
        else if (s.kind === 'circuit') addRef(model, def, s.circuit, 'circuit', `step '${s.id}' sub-circuit`);
      }
      break;
    }
    case 'subagent': {
      const s = v as Subagent;
      for (const t of s.tools) {
        if ('tool' in t) addRef(model, def, t.tool, 'tool', 'tool grant');
        else addRef(model, def, t.mcp, 'mcp', 'MCP grant');
      }
      for (const c of s.circuits) addRef(model, def, c.circuit, 'circuit', `circuit grant (${c.access})`);
      break;
    }
    case 'breadboard': {
      const b = v as BreadboardConfig;
      addRef(model, def, b.intake.triage_circuit, 'circuit', 'intake.triage_circuit');
      addRef(model, def, b.intake.shaper_subagent, 'subagent', 'intake.shaper_subagent');
      addRef(model, def, b.designers.circuit, 'subagent', 'designers.circuit');
      addRef(model, def, b.designers.tool, 'subagent', 'designers.tool');
      addRef(model, def, b.designers.subagent, 'subagent', 'designers.subagent');
      for (const c of b.connectors) addRef(model, def, c.tool, 'tool', 'connector tool');
      break;
    }
    case 'rubric': {
      const r = v as Rubric;
      addRef(model, def, r.circuit, 'circuit', 'rubric circuit');
      addRef(model, def, r.judge.subagent, 'subagent', 'judge subagent');
      for (const d of r.dimensions) if (d.type === 'programmatic' && isUid(d.tool)) addRef(model, def, d.tool, 'tool', `dimension '${d.key}' tool`);
      break;
    }
    case 'fixtures':
      addRef(model, def, (v as Fixtures).circuit, 'circuit', 'fixtures circuit');
      break;
    default:
      break;
  }
}

// -----------------------------------------------------------------------------------------------
// Validation rules
// -----------------------------------------------------------------------------------------------

class Report {
  errors: string[] = [];
  warnings: string[] = [];
  error(path: string, msg: string) {
    this.errors.push(`${path}: ${msg}`);
  }
  warn(path: string, msg: string) {
    this.warnings.push(`${path}: ${msg}`);
  }
  done(): ValidationReport {
    return { ok: this.errors.length === 0, errors: dedupe(this.errors), warnings: dedupe(this.warnings) };
  }
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function validateModel(model: TreeModel, opts: ValidateOptions, providers: string[]): ValidationReport {
  const rep = new Report();

  for (const f of model.unknownFiles) rep.warn(f, 'file is outside the configuration layout and is ignored');

  // Schema validity + path/uid agreement.
  const seenUids = new Map<string, DefEntry[]>();
  const seenSlugs = new Map<string, DefEntry[]>();
  for (const def of model.defs) {
    for (const e of def.parseErrors) rep.error(def.path, e);
    if (!def.parsed || def.kind === 'tenets') continue;
    const v = def.parsed as any;
    if (UID_KINDS.includes(def.kind)) {
      if (v.uid !== def.uid) rep.error(def.path, `file name is derived from uid '${def.uid}' but the document declares uid '${v.uid}' ([01] §6.2)`);
      const list = seenUids.get(v.uid) ?? [];
      list.push(def);
      seenUids.set(v.uid, list);
      if (def.slug) {
        const key = `${def.kind}:${def.slug}`;
        const sl = seenSlugs.get(key) ?? [];
        sl.push(def);
        seenSlugs.set(key, sl);
      }
    } else if (def.kind === 'rubric' || def.kind === 'fixtures') {
      if (v.circuit !== def.uid) rep.error(def.path, `'circuit' must be the enclosing circuit UID '${def.uid}' but is '${v.circuit}'`);
    }
  }
  for (const [uid, defs] of seenUids) if (defs.length > 1) for (const d of defs) rep.error(d.path, `duplicate uid '${uid}' (also in ${defs.filter((x) => x !== d).map((x) => x.path).join(', ')})`);
  for (const [key, defs] of seenSlugs) if (defs.length > 1) for (const d of defs) rep.error(d.path, `duplicate slug '${key.split(':')[1]}' among ${KIND_LABEL[d.kind]}s (also in ${defs.filter((x) => x !== d).map((x) => x.path).join(', ')})`);
  // Cross-kind slug collisions are a display nuisance, not a hard failure.
  const slugKinds = new Map<string, Set<string>>();
  for (const def of model.defs) if (def.slug && UID_KINDS.includes(def.kind)) slugKinds.set(def.slug, (slugKinds.get(def.slug) ?? new Set()).add(def.kind));
  for (const [slug, kinds] of slugKinds) if (kinds.size > 1) rep.warn('(tree)', `slug '${slug}' is used by more than one kind (${[...kinds].join(', ')})`);

  // Orphan sub-files (prompts/src without their definition).
  for (const f of model.files) {
    const p = parseConfigPath(f);
    if (!p || p.sub === null || !p.uid) continue;
    const defPath = definitionPath(p.kind, p.uid);
    if (!model.byPath.has(defPath)) rep.warn(f, `orphan file: ${defPath} does not exist`);
  }

  // Dangling references.
  for (const r of model.refs) {
    const target = model.byUid.get(r.to);
    if (!target) rep.error(r.from.path, `${r.what} references ${KIND_LABEL[r.expect]} '${r.to}' which does not exist (${definitionPath(r.expect, r.to)})`);
    else if (target.kind !== r.expect) rep.error(r.from.path, `${r.what} references '${r.to}' which is a ${KIND_LABEL[target.kind]}, not a ${KIND_LABEL[r.expect]}`);
  }

  // Singletons.
  if (!model.byPath.has(CONFIG_PATHS.breadboard)) rep.warn(CONFIG_PATHS.breadboard, 'missing; built-in defaults apply');
  if (!model.presets) rep.warn(CONFIG_PATHS.presets, 'missing; no model presets are defined');
  if (model.presets) {
    for (const [tier, entries] of Object.entries(model.presets.presets)) {
      entries.forEach((e, i) => {
        if (!providers.includes(e.provider)) rep.error(CONFIG_PATHS.presets, `preset '${tier}' entry ${i}: provider '${e.provider}' has no installed adapter (available: ${providers.join(', ')})`);
      });
    }
    if (model.presets.embeddings && !providers.includes(model.presets.embeddings.provider)) rep.error(CONFIG_PATHS.presets, `embeddings: provider '${model.presets.embeddings.provider}' has no installed adapter`);
  }
  if (model.tenets !== null) {
    const max = model.settings.tenets.max_chars;
    if (model.tenets.length > max) rep.error(CONFIG_PATHS.tenets, `tenets are ${model.tenets.length} characters; the cap is ${max} ([05] §5)`);
  }

  // Per-kind semantic rules.
  for (const def of model.defs) {
    if (!def.parsed) continue;
    switch (def.kind) {
      case 'circuit':
        validateCircuit(model, def, def.parsed as Circuit, rep, opts);
        break;
      case 'subagent':
        validateSubagent(model, def, def.parsed as Subagent, rep);
        break;
      case 'tool':
        validateTool(model, def, def.parsed as Tool, rep);
        break;
      case 'rubric':
        validateRubric(def, def.parsed as Rubric, rep);
        break;
      case 'breadboard':
      case 'mcp':
      case 'fixtures':
      case 'presets':
      case 'tenets':
        break;
    }
  }
  return rep.done();
}

function stepRefsIn(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    const m = /^\$steps\.([a-z0-9][a-z0-9-]*)/.exec(value.trim());
    if (m) out.add(m[1]!);
    return;
  }
  if (Array.isArray(value)) for (const v of value) stepRefsIn(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stepRefsIn(v, out);
}

function validateCircuit(model: TreeModel, def: DefEntry, c: Circuit, rep: Report, opts: ValidateOptions): void {
  const dir = CONFIG_PATHS.circuitDir(def.uid!);
  const stepIds = new Set<string>();
  const dupIds = new Set<string>();
  for (const s of c.steps) {
    if (stepIds.has(s.id)) dupIds.add(s.id);
    stepIds.add(s.id);
  }
  for (const id of dupIds) rep.error(def.path, `duplicate step id '${id}'`);
  const exitNames = new Set(c.exits.map((e) => e.name));
  const seenExits = new Set<string>();
  for (const e of c.exits) {
    if (seenExits.has(e.name)) rep.error(def.path, `duplicate declared exit '${e.name}'`);
    seenExits.add(e.name);
    if (e.output) {
      const err = schemaCompileError(e.output);
      if (err) rep.error(def.path, `exit '${e.name}' output schema does not compile: ${err}`);
    }
  }
  const inputErr = schemaCompileError(c.input);
  if (inputErr) rep.error(def.path, `input schema does not compile: ${inputErr}`);

  if (!stepIds.has(c.entry)) rep.error(def.path, `entry '${c.entry}' is not a step`);

  const routedExits = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const s of c.steps) {
    const next: string[] = [];
    const exitNamesSeen = new Set<string>();
    for (const ex of s.exits) {
      if (exitNamesSeen.has(ex.name)) rep.error(def.path, `step '${s.id}' declares exit '${ex.name}' twice`);
      exitNamesSeen.add(ex.name);
      if (isCircuitExitTarget(ex.to)) {
        const name = circuitExitName(ex.to);
        if (!exitNames.has(name)) rep.error(def.path, `step '${s.id}' exit '${ex.name}' routes to undeclared circuit exit '${ex.to}'`);
        else routedExits.add(name);
      } else if (!stepIds.has(ex.to)) rep.error(def.path, `step '${s.id}' exit '${ex.name}' routes to unknown step '${ex.to}'`);
      else next.push(ex.to);
    }
    adjacency.set(s.id, next);

    if (s.kind === 'gate') {
      if (!exitNamesSeen.has('approve')) rep.error(def.path, `gate '${s.id}' must declare an 'approve' exit ([02] §5.4)`);
      if (!exitNamesSeen.has('changes')) rep.error(def.path, `gate '${s.id}' must declare a 'changes' exit ([02] §5.4)`);
      const refs = new Set<string>();
      stepRefsIn(s.review.artifacts, refs);
      for (const r of refs) if (!stepIds.has(r)) rep.error(def.path, `gate '${s.id}' review.artifacts references unknown step '${r}'`);
      if (refs.size === 0) rep.warn(def.path, `gate '${s.id}' review.artifacts does not reference any step output`);
    }

    const output = (s as Step & { output?: Record<string, any> }).output;
    if (output) {
      const err = schemaCompileError(output);
      if (err) rep.error(def.path, `step '${s.id}' output schema does not compile: ${err}`);
    }

    if (s.kind === 'llm') {
      if (!s.prompt && s.prompt_inline === undefined) rep.error(def.path, `llm step '${s.id}' needs 'prompt' (file) or 'prompt_inline'`);
      let template: string | null = s.prompt_inline ?? null;
      if (s.prompt) {
        const promptPath = `${dir}/${normalizePath(s.prompt)}`;
        if (!model.files.includes(promptPath)) rep.error(def.path, `llm step '${s.id}' prompt file '${s.prompt}' does not exist (${promptPath})`);
        else template = model.prompts.get(promptPath) ?? null;
      }
      if (template !== null) checkTemplate(def, s.id, template, stepIds, rep);
    }
    if (s.kind === 'code' || s.kind === 'circuit') {
      const refs = new Set<string>();
      stepRefsIn(s.input_map ?? {}, refs);
      for (const r of refs) if (!stepIds.has(r)) rep.error(def.path, `step '${s.id}' input_map references unknown step '${r}'`);
    }
    if (s.kind === 'circuit') {
      const child = model.byUid.get(s.circuit);
      if (child && child.kind === 'circuit' && child.parsed) {
        const childExits = (child.parsed as Circuit).exits.map((e) => e.name);
        const map = s.exit_map ?? {};
        for (const k of Object.keys(map)) if (!childExits.includes(k)) rep.error(def.path, `step '${s.id}' exit_map key '${k}' is not an exit of sub-circuit '${child.slug ?? s.circuit}' (exits: ${childExits.join(', ')})`);
        const mapped = childExits.map((e) => map[e] ?? e);
        if (new Set(mapped).size !== mapped.length) rep.error(def.path, `step '${s.id}' exit_map collapses two child exits onto one name`);
        const declared = s.exits.map((e) => e.name);
        for (const m of mapped) if (!declared.includes(m)) rep.error(def.path, `step '${s.id}' is missing exit '${m}' required by sub-circuit '${child.slug ?? s.circuit}' ([03] §3.3)`);
        for (const d of declared) if (!mapped.includes(d)) rep.error(def.path, `step '${s.id}' exit '${d}' has no corresponding exit on sub-circuit '${child.slug ?? s.circuit}' ([03] §3.3)`);
      }
    }
  }
  for (const name of exitNames) if (!routedExits.has(name)) rep.error(def.path, `declared exit '${name}' is not routable-to from any step`);

  // Reachability from entry.
  if (stepIds.has(c.entry)) {
    const seen = new Set<string>([c.entry]);
    const queue = [c.entry];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const n of adjacency.get(cur) ?? []) if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
    for (const id of stepIds) {
      if (seen.has(id)) continue;
      const msg = `step '${id}' is unreachable from entry '${c.entry}'`;
      if (opts.nonMain) rep.warn(def.path, msg);
      else rep.error(def.path, msg);
    }
  }
}

function checkTemplate(def: DefEntry, stepId: string, template: string, stepIds: Set<string>, rep: Report): void {
  let refs: string[];
  try {
    refs = templateReferences(template);
  } catch (e) {
    rep.error(def.path, `step '${stepId}' prompt template does not parse: ${(e as Error).message}`);
    return;
  }
  for (const r of refs) {
    const [root, second] = r.split('.');
    if (root === 'steps') {
      if (!second) rep.warn(def.path, `step '${stepId}' prompt references bare '{{steps}}'`);
      else if (!stepIds.has(second)) rep.error(def.path, `step '${stepId}' prompt references unknown step '$steps.${second}'`);
    } else if (root !== 'input' && root !== 'ambient') {
      rep.warn(def.path, `step '${stepId}' prompt references '${r}', which is not under input/steps/ambient and will render empty`);
    }
  }
}

const KNOWLEDGE_TOKEN_LOOSE = /\{\{\s*knowledge:([^}]*?)\s*\}\}/g;

function validateSubagent(model: TreeModel, def: DefEntry, s: Subagent, rep: Report): void {
  if (model.presets) {
    if (!(s.model_preset in model.presets.presets)) rep.error(def.path, `model_preset '${s.model_preset}' is not defined in ${CONFIG_PATHS.presets} (available: ${Object.keys(model.presets.presets).join(', ') || 'none'})`);
  } else rep.error(def.path, `model_preset '${s.model_preset}' cannot be resolved: ${CONFIG_PATHS.presets} is missing`);
  const valid: string[] = [];
  for (const m of s.system_prompt.matchAll(KNOWLEDGE_TOKEN_LOOSE)) {
    const uid = m[1]!.trim();
    if (!isUid(uid)) rep.error(def.path, `system_prompt token '{{knowledge:${uid}}}' is not a valid 20-char UID ([05] §2.1)`);
    else valid.push(uid);
  }
  if (valid.length) rep.warn(def.path, `knowledge token(s) ${valid.join(', ')} are not verified against readable domains at commit time (checked by the knowledge service at resolution)`);
  const domains = new Set(model.settings.knowledge.domains.map((d) => d.slug));
  if (domains.size) {
    for (const d of [...s.knowledge.read, ...s.knowledge.write]) if (!domains.has(d)) rep.warn(def.path, `knowledge domain '${d}' is not declared in ${CONFIG_PATHS.breadboard}`);
  }
}

function validateTool(model: TreeModel, def: DefEntry, t: Tool, rep: Report): void {
  const dir = CONFIG_PATHS.toolDir(def.uid!);
  const entry = `${dir}/${normalizePath(t.entrypoint)}`;
  if (!model.files.includes(entry)) rep.error(def.path, `entrypoint '${t.entrypoint}' does not exist (${entry})`);
  else {
    const ext = entry.split('.').pop();
    if (t.language === 'typescript' && !['ts', 'js', 'mts', 'mjs'].includes(ext ?? '')) rep.warn(def.path, `entrypoint '${t.entrypoint}' does not look like a TypeScript module`);
    if (t.language === 'python' && ext !== 'py') rep.warn(def.path, `entrypoint '${t.entrypoint}' does not look like a Python module`);
  }
  const inErr = schemaCompileError(t.input);
  if (inErr) rep.error(def.path, `input schema does not compile: ${inErr}`);
  if (t.output) {
    const outErr = schemaCompileError(t.output);
    if (outErr) rep.error(def.path, `output schema does not compile: ${outErr}`);
  }
  for (const [name, s] of Object.entries(t.settings)) {
    if (s.default !== undefined && s.type !== 'array' && s.type !== 'object' && typeof s.default !== s.type) rep.error(def.path, `setting '${name}' default is not of type ${s.type}`);
  }
}

function validateRubric(def: DefEntry, r: Rubric, rep: Report): void {
  const keys = new Set<string>();
  for (const d of r.dimensions) {
    if (keys.has(d.key)) rep.error(def.path, `duplicate dimension key '${d.key}'`);
    keys.add(d.key);
    if (d.type === 'numeric' && d.scale.min >= d.scale.max) rep.error(def.path, `dimension '${d.key}' scale.min must be < scale.max`);
  }
  for (const w of Object.keys(r.aggregate.weights)) if (!keys.has(w)) rep.error(def.path, `aggregate.weights refers to unknown dimension '${w}'`);
  if (r.aggregate.ordinal_map) for (const k of Object.keys(r.aggregate.ordinal_map)) if (!keys.has(k)) rep.error(def.path, `aggregate.ordinal_map refers to unknown dimension '${k}'`);
}

// -----------------------------------------------------------------------------------------------
// INDEX.md
// -----------------------------------------------------------------------------------------------

function renderIndexFromModel(model: TreeModel): string {
  const lines: string[] = [INDEX_HEADER, '', '_Auto-generated by Breadboard on every commit to `main`; informational only ([01] §6.1). Slugs and titles live in each definition — edit them there._', ''];
  const sections: Array<[string, ConfigKind]> = [
    ['Circuits', 'circuit'],
    ['Subagents', 'subagent'],
    ['Tools', 'tool'],
    ['MCP servers', 'mcp'],
  ];
  for (const [heading, kind] of sections) {
    const defs = model.defs.filter((d) => d.kind === kind).sort((a, b) => (a.slug ?? '').localeCompare(b.slug ?? '') || a.path.localeCompare(b.path));
    lines.push(`## ${heading}`, '');
    if (defs.length === 0) {
      lines.push('_none_', '');
      continue;
    }
    lines.push('| Slug | Title | UID | Path |', '|---|---|---|---|');
    for (const d of defs) lines.push(`| ${cell(d.slug ?? '')} | ${cell(d.title ?? '')} | \`${d.uid}\` | \`${d.path}\` |`);
    lines.push('');
  }
  lines.push('## Instance', '');
  lines.push('| File | Present |', '|---|---|');
  for (const kind of SINGLETONS) {
    const path = definitionPath(kind);
    lines.push(`| \`${path}\` | ${model.byPath.has(path) ? 'yes' : 'no'} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// -----------------------------------------------------------------------------------------------
// Listing and lookup
// -----------------------------------------------------------------------------------------------

type UidKind = 'circuit' | 'subagent' | 'tool' | 'mcp';
const TREE_ORDER: ConfigKind[] = ['breadboard', 'tenets', 'presets', 'circuit', 'subagent', 'tool', 'mcp'];
const KIND_OF_DIR: Record<string, UidKind> = { circuits: 'circuit', subagents: 'subagent', tools: 'tool', mcp: 'mcp' };
const MAX_CANDIDATES = 10;
const MAX_SUGGESTIONS = 5;

function entryOf(def: DefEntry): ConfigTreeEntry {
  return { uid: UID_KINDS.includes(def.kind) ? def.uid : null, kind: def.kind, slug: def.slug, title: def.title, path: def.path };
}

function treeDefs(model: TreeModel): DefEntry[] {
  return model.defs
    .filter((d) => TREE_ORDER.includes(d.kind))
    .sort((a, b) => TREE_ORDER.indexOf(a.kind) - TREE_ORDER.indexOf(b.kind) || (a.slug ?? '').localeCompare(b.slug ?? '') || a.path.localeCompare(b.path));
}

function treeEntries(model: TreeModel): ConfigTreeEntry[] {
  return treeDefs(model).map(entryOf);
}

/** Rank of `e` for a lowercase `needle`: 0 exact slug or UID … 4 path or kind, 5 description (when given); -1 when it does not match. */
function searchScore(e: ConfigTreeEntry, needle: string, description?: string | null): number {
  const slug = (e.slug ?? '').toLowerCase();
  const title = (e.title ?? '').toLowerCase();
  if (slug === needle || e.uid === needle.toUpperCase()) return 0;
  if (slug.startsWith(needle)) return 1;
  if (title.startsWith(needle)) return 2;
  if (slug.includes(needle) || title.includes(needle)) return 3;
  if (e.path.toLowerCase().includes(needle) || e.kind.includes(needle)) return 4;
  if (description?.toLowerCase().includes(needle)) return 5;
  return -1;
}

const SEARCH_STOPWORDS = new Set(['and', 'for', 'the', 'that', 'this', 'with', 'from', 'into', 'any', 'all']);

/**
 * `search`'s ranking: a whole-query match ranks by its tier; otherwise the query's words (3+ characters, no stopwords)
 * rank by how many match, then by the best tier. A word matching only a path or kind does not count (it would list
 * every definition of that kind). Returns null when nothing matches.
 */
function searchRank(def: DefEntry, needle: string, words: string[]): [number, number, number] | null {
  const e = entryOf(def);
  const whole = searchScore(e, needle, def.description);
  if (whole >= 0) return [0, 0, whole];
  const scores = words.map((w) => searchScore(e, w, def.description)).filter((s) => s >= 0 && s !== 4);
  return scores.length ? [1, -scores.length, Math.min(...scores)] : null;
}

/** The forms every caller may use: a UID, a singleton name, or a repo path (a sub-file resolves to its definition). */
function strictLookup(model: TreeModel, key: string): DefEntry | undefined {
  if (isUid(key)) return model.byUid.get(key) ?? model.defs.find((d) => d.uid === key && UID_KINDS.includes(d.kind));
  if (SINGLETONS.includes(key as ConfigKind)) return model.byPath.get(definitionPath(key as ConfigKind));
  const p = normalizePath(key);
  let def = model.byPath.get(p);
  if (!def) {
    const parsedPath = parseConfigPath(p);
    if (parsedPath?.uid) def = model.byPath.get(definitionPath(parsedPath.kind, parsedPath.uid));
  }
  if (!def) {
    // A definition's directory or extensionless name (`tools/<UID>`, `subagents/<UID>`), as agents often write it.
    const m = /^(tools|circuits|subagents|mcp)\/([0-9A-HJKMNP-TV-Z]{20})(?:\.yaml)?\/?$/.exec(p);
    const kind = m && KIND_OF_DIR[m[1]!];
    if (m && kind) def = model.byPath.get(definitionPath(kind, m[2]!));
  }
  return def;
}

/** A slug as agents write it: bare, `<kind>:<slug>`, or in place of the UID in a definition path (any file under it). */
function slugRef(p: string): { kind: UidKind | null; slug: string } | null {
  const qualified = /^(circuit|subagent|tool|mcp):(.+)$/i.exec(p);
  if (qualified) return { kind: qualified[1]!.toLowerCase() as UidKind, slug: qualified[2]!.trim() };
  const inPath = /^(circuits?|subagents?|tools?|mcp)\/([^/]+?)(?:\.ya?ml)?(?:\/.*)?$/i.exec(p);
  if (inPath) return { kind: inPath[1]!.toLowerCase().replace(/s$/, '') as UidKind, slug: inPath[2]! };
  return /^[a-z0-9][a-z0-9-]*$/i.test(p) ? { kind: null, slug: p } : null;
}

/** Entries resembling `needle` (whole, or any word of 3+ characters), best first; another kind ranks one tier lower. */
function nearMatches(entries: ConfigTreeEntry[], needle: string, kind: ConfigKind | null): ConfigTreeEntry[] {
  const whole = needle.trim().toLowerCase();
  const words = whole.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && w !== whole);
  return entries
    .map((e) => {
      // A single word matching only a path or kind would list every definition of that kind.
      const scores = [searchScore(e, whole), ...words.map((w) => searchScore(e, w)).filter((s) => s < 4)].filter((s) => s >= 0);
      return { e, s: scores.length ? Math.min(...scores) + (kind && e.kind !== kind ? 1 : 0) : -1 };
    })
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s)
    .map((x) => x.e);
}

function entryLabel(e: ConfigTreeEntry): string {
  return `${e.kind} ${e.slug ?? e.path}${e.uid ? ` (${e.uid})` : ''}`;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * `read_config`'s lookup after the strict forms miss: a leading `config/` (the specs draw the repo root that way,
 * [01] §6.1), then a slug. Throws `validation-failed` when a slug names several definitions and `not-found` with the
 * closest definitions otherwise; the message carries everything, since a model sees only code and message.
 */
function lenientLookup(model: TreeModel, key: string, commit: string): DefEntry {
  let p = normalizePath(key);
  if (/^config\//i.test(p)) {
    p = p.slice('config/'.length);
    const def = strictLookup(model, p);
    if (def) return def;
  }
  const ref = slugRef(p);
  if (ref && isUid(ref.slug)) {
    const def = model.byUid.get(ref.slug);
    if (def && (!ref.kind || def.kind === ref.kind)) return def;
  } else if (ref) {
    const slug = ref.slug.toLowerCase();
    const hits = [...model.byUid.values()].filter((d) => d.slug?.toLowerCase() === slug && (!ref.kind || d.kind === ref.kind));
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) {
      const candidates = hits.map(entryOf);
      const qualify = new Set(hits.map((d) => d.kind)).size > 1 ? `, or <kind>:<slug> (e.g. ${hits[0]!.kind}:${hits[0]!.slug})` : '';
      throw new BreadboardError(
        'validation-failed',
        `'${clip(key, 200)}' matches more than one definition: ${candidates.slice(0, MAX_CANDIDATES).map(entryLabel).join(', ')}. Pass the UID${qualify}.`,
        { candidates },
      );
    }
  }
  const suggestions = nearMatches(treeEntries(model), ref?.slug ?? p, ref?.kind ?? null).slice(0, MAX_SUGGESTIONS);
  const near = suggestions.length ? `Closest: ${suggestions.map((e) => `${entryLabel(e)}${e.title ? ` "${clip(e.title, 60)}"` : ''}`).join('; ')}.` : 'Nothing similar.';
  throw new BreadboardError('not-found', `no definition '${clip(key, 200)}' at ${commit.slice(0, 12)}. ${near} Find definitions with search_config.`, { suggestions });
}

// -----------------------------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------------------------

type RepoDiff = Awaited<ReturnType<ConfigRepo['diff']>>;

interface ProposalRow {
  proposal_id: string;
  team_id: string;
  branch: string;
  base_commit: string;
  head_commit: string;
  message: string;
  status: 'open' | 'merged' | 'discarded';
  created_by: unknown;
  created_at: string | Date;
  session_id: string | null;
  merged_commit: string | null;
  merged_by: unknown;
  merged_at: string | Date | null;
  discarded_at: string | Date | null;
  eval_run_ids: string[] | null;
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class ConfigServiceImpl implements ConfigService {
  private readonly repo: ConfigRepo;
  private readonly db: Db;
  private readonly teamId: string;
  private readonly log: Logger;
  private readonly events: EventBus | null;
  private readonly gatewayProviders: () => string[];
  private readonly writes = new Mutex();

  private mainCache: { commit: string; at: number } | null = null;
  private readonly fileCache = new Map<string, string | null>();
  private readonly models = new Map<string, Promise<TreeModel>>();
  private readonly validations = new Map<string, ValidationReport>();

  constructor(deps: ConfigServiceDeps) {
    this.repo = deps.repo;
    this.db = deps.db;
    this.teamId = deps.team_id;
    this.log = deps.log;
    this.events = deps.events ?? null;
    this.gatewayProviders = deps.gatewayProviders ?? (() => DEFAULT_PROVIDERS);
  }

  // --- commits & caches -------------------------------------------------------------------------

  async mainCommit(): Promise<string> {
    const now = Date.now();
    if (this.mainCache && now - this.mainCache.at < MAIN_TTL_MS) return this.mainCache.commit;
    const commit = await this.repo.resolve(DEFAULT_BRANCH);
    this.mainCache = { commit, at: now };
    return commit;
  }

  private invalidateMain(commit?: string): void {
    this.mainCache = commit ? { commit, at: Date.now() } : null;
  }

  private async resolveRef(ref?: string): Promise<string> {
    if (!ref || ref === DEFAULT_BRANCH) return this.mainCommit();
    return this.repo.resolve(ref);
  }

  private async readCached(commit: string, path: string): Promise<string | null> {
    const key = `${commit}\0${path}`;
    if (this.fileCache.has(key)) return this.fileCache.get(key)!;
    const text = await this.repo.readFile(commit, path);
    if (this.fileCache.size >= FILE_CACHE_SIZE) this.fileCache.clear();
    this.fileCache.set(key, text);
    return text;
  }

  private async commitTree(commit: string): Promise<VirtualTree> {
    const files = await this.repo.listFiles(commit);
    return { commit, files, read: (p) => this.readCached(commit, p) };
  }

  private model(commit: string): Promise<TreeModel> {
    const hit = this.models.get(commit);
    if (hit) return hit;
    const p = this.commitTree(commit).then(buildModel);
    if (this.models.size >= MODEL_CACHE_SIZE) this.models.delete(this.models.keys().next().value!);
    this.models.set(commit, p);
    p.catch(() => this.models.delete(commit));
    return p;
  }

  /** A base commit's listing with `changes` applied over it (never cached). */
  private async overlayTree(base: string, changes: FileChange[]): Promise<VirtualTree> {
    const files = new Set(await this.repo.listFiles(base));
    const overlay = new Map<string, string | null>();
    for (const ch of changes) {
      const p = normalizePath(ch.path);
      if (!p) throw new BreadboardError('validation-failed', 'change has an empty path');
      overlay.set(p, ch.content);
      if (ch.content === null) files.delete(p);
      else files.add(p);
    }
    return {
      commit: null,
      files: [...files].sort(),
      read: async (p) => (overlay.has(p) ? overlay.get(p)! : this.readCached(base, p)),
    };
  }

  private async parsed<T>(commit: string, path: string, kind: Exclude<ConfigKind, 'tenets'>): Promise<T | null> {
    const text = await this.readCached(commit, path);
    if (text === null) return null;
    const res = parseConfigYaml(text, kind);
    if (!res.ok) throw new BreadboardError('validation-failed', `${path} at ${commit.slice(0, 12)} is invalid`, { errors: res.errors });
    return res.value as T;
  }

  // --- loaders ----------------------------------------------------------------------------------

  async settings(ref?: string): Promise<BreadboardConfig> {
    const commit = await this.resolveRef(ref);
    return (await this.parsed<BreadboardConfig>(commit, CONFIG_PATHS.breadboard, 'breadboard')) ?? defaultSettings();
  }

  async presets(ref?: string): Promise<Presets> {
    const commit = await this.resolveRef(ref);
    return (await this.parsed<Presets>(commit, CONFIG_PATHS.presets, 'presets')) ?? { schema: SCHEMA_TAGS.presets as Presets['schema'], presets: {} };
  }

  async tenets(ref?: string): Promise<string> {
    const commit = await this.resolveRef(ref);
    return (await this.readCached(commit, CONFIG_PATHS.tenets)) ?? '';
  }

  async circuit(uid: string, ref?: string): Promise<LoadedCircuit> {
    const commit = await this.resolveRef(ref);
    const circuit = await this.parsed<Circuit>(commit, CONFIG_PATHS.circuit(uid), 'circuit');
    if (!circuit) throw new BreadboardError('not-found', `circuit ${uid} not found at ${commit.slice(0, 12)}`);
    const dir = CONFIG_PATHS.circuitDir(uid);
    const prompts: Record<string, string> = {};
    for (const f of await this.repo.listFiles(commit, `${dir}/prompts/`)) {
      const text = await this.readCached(commit, f);
      if (text !== null) prompts[f.slice(dir.length + 1)] = text;
    }
    for (const s of circuit.steps) {
      if (s.kind === 'llm' && s.prompt_inline !== undefined && !s.prompt) prompts[`prompts/${s.id}.md`] = prompts[`prompts/${s.id}.md`] ?? s.prompt_inline;
    }
    const [rubric, fixtures] = await Promise.all([this.parsed<Rubric>(commit, CONFIG_PATHS.rubric(uid), 'rubric'), this.parsed<Fixtures>(commit, CONFIG_PATHS.fixtures(uid), 'fixtures')]);
    return { uid, commit, circuit, prompts, rubric, fixtures };
  }

  async subagent(uid: string, ref?: string): Promise<Subagent> {
    const commit = await this.resolveRef(ref);
    const s = await this.parsed<Subagent>(commit, CONFIG_PATHS.subagent(uid), 'subagent');
    if (!s) throw new BreadboardError('not-found', `subagent ${uid} not found at ${commit.slice(0, 12)}`);
    return s;
  }

  async tool(uid: string, ref?: string): Promise<LoadedTool> {
    const commit = await this.resolveRef(ref);
    const tool = await this.parsed<Tool>(commit, CONFIG_PATHS.tool(uid), 'tool');
    if (!tool) throw new BreadboardError('not-found', `tool ${uid} not found at ${commit.slice(0, 12)}`);
    const root = await this.repo.materializeTree(commit);
    return { uid, commit, tool, dir: `${root}/${CONFIG_PATHS.toolDir(uid)}` };
  }

  async mcp(uid: string, ref?: string): Promise<McpServer> {
    const commit = await this.resolveRef(ref);
    const m = await this.parsed<McpServer>(commit, CONFIG_PATHS.mcp(uid), 'mcp');
    if (!m) throw new BreadboardError('not-found', `mcp server ${uid} not found at ${commit.slice(0, 12)}`);
    return m;
  }

  async rubric(circuitUid: string, ref?: string): Promise<Rubric | null> {
    return this.parsed<Rubric>(await this.resolveRef(ref), CONFIG_PATHS.rubric(circuitUid), 'rubric');
  }

  async fixtures(circuitUid: string, ref?: string): Promise<Fixtures | null> {
    return this.parsed<Fixtures>(await this.resolveRef(ref), CONFIG_PATHS.fixtures(circuitUid), 'fixtures');
  }

  // --- listing ----------------------------------------------------------------------------------

  async tree(ref?: string): Promise<ConfigTreeEntry[]> {
    return treeEntries(await this.model(await this.resolveRef(ref)));
  }

  async search(q: string, ref?: string): Promise<ConfigTreeEntry[]> {
    const needle = q.trim().toLowerCase();
    const defs = treeDefs(await this.model(await this.resolveRef(ref)));
    if (!needle) return defs.map(entryOf);
    const words = [...new Set(needle.split(/[^a-z0-9]+/))].filter((w) => w.length >= 3 && !SEARCH_STOPWORDS.has(w));
    return defs
      .map((d) => ({ d, r: searchRank(d, needle, words) }))
      .filter((x): x is { d: DefEntry; r: [number, number, number] } => x.r !== null)
      .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2])
      .map((x) => entryOf(x.d));
  }

  async referencedBy(uid: string, ref?: string): Promise<ConfigTreeEntry[]> {
    const model = await this.model(await this.resolveRef(ref));
    const seen = new Set<string>();
    const out: ConfigTreeEntry[] = [];
    for (const r of model.refs) {
      if (r.to !== uid || seen.has(r.from.path)) continue;
      // A circuit's own rubric/fixtures name it by construction; that is not a backlink.
      if ((r.from.kind === 'rubric' || r.from.kind === 'fixtures') && r.from.uid === uid) continue;
      seen.add(r.from.path);
      out.push(entryOf(r.from));
    }
    return out;
  }

  async definition(uidOrPath: string, ref?: string, opts: DefinitionLookupOptions = {}): Promise<ConfigDefinitionDto> {
    const commit = await this.resolveRef(ref);
    const model = await this.model(commit);
    const key = uidOrPath.trim();
    let def = strictLookup(model, key);
    if (!def && opts.lenient) def = lenientLookup(model, key, commit);
    if (!def) throw new BreadboardError('not-found', `no definition '${uidOrPath}' at ${commit.slice(0, 12)}`);

    let files: Record<string, string> | undefined;
    if (def.kind === 'circuit' || def.kind === 'tool') {
      const dir = def.kind === 'circuit' ? CONFIG_PATHS.circuitDir(def.uid!) : CONFIG_PATHS.toolDir(def.uid!);
      files = {};
      for (const f of model.files) {
        if (!f.startsWith(dir + '/') || f === def.path) continue;
        const text = await this.readCached(commit, f);
        if (text !== null) files[f.slice(dir.length + 1)] = text;
      }
    }
    const full = await this.validateModelCached(commit, model, {});
    const scope = def.kind === 'circuit' || def.kind === 'tool' ? (def.kind === 'circuit' ? CONFIG_PATHS.circuitDir(def.uid!) : CONFIG_PATHS.toolDir(def.uid!)) + '/' : def.path + ':';
    const mine = (m: string) => m.startsWith(scope) || m.startsWith(def!.path + ':');
    const validation: ValidationReport = { errors: full.errors.filter(mine), warnings: full.warnings.filter(mine), ok: true };
    validation.ok = validation.errors.length === 0;
    return {
      uid: UID_KINDS.includes(def.kind) ? def.uid : null,
      kind: def.kind,
      path: def.path,
      commit,
      slug: def.slug,
      title: def.title,
      definition: def.parsed,
      raw: def.raw,
      files,
      validation,
      referenced_by: def.uid && UID_KINDS.includes(def.kind) ? await this.referencedBy(def.uid, commit) : [],
    };
  }

  // --- validation -------------------------------------------------------------------------------

  private async validateModelCached(commit: string, model: TreeModel, opts: ValidateOptions): Promise<ValidationReport> {
    const key = `${commit}:${opts.nonMain ? 'wip' : 'strict'}`;
    const hit = this.validations.get(key);
    if (hit) return hit;
    const rep = validateModel(model, opts, this.gatewayProviders());
    if (this.validations.size >= MODEL_CACHE_SIZE * 2) this.validations.delete(this.validations.keys().next().value!);
    this.validations.set(key, rep);
    return rep;
  }

  async validateTree(ref?: string, opts: ValidateOptions = {}): Promise<ValidationReport> {
    const commit = await this.resolveRef(ref);
    let nonMain = opts.nonMain;
    if (nonMain === undefined && ref && ref !== DEFAULT_BRANCH && !/^[0-9a-f]{40,64}$/.test(ref)) nonMain = await this.repo.branchExists(ref);
    return this.validateModelCached(commit, await this.model(commit), { nonMain: !!nonMain });
  }

  async validateChanges(changes: FileChange[], base?: string, opts: ValidateOptions = {}): Promise<ValidationReport> {
    const baseCommit = await this.resolveRef(base);
    const { report } = await this.validateOverlay(baseCommit, changes, opts);
    return report;
  }

  /** Validate the tree that would result from `changes` over `baseCommit`; returns the model too (for INDEX.md). */
  private async validateOverlay(baseCommit: string, changes: FileChange[], opts: ValidateOptions): Promise<{ report: ValidationReport; model: TreeModel; vt: VirtualTree }> {
    for (const ch of changes) {
      const p = normalizePath(ch.path);
      if (!p || p.split('/').some((s) => s === '..' || s === '' || s === '.git')) throw new BreadboardError('validation-failed', `invalid path '${ch.path}'`);
      if (ch.content !== null && typeof ch.content !== 'string') throw new BreadboardError('validation-failed', `content of '${ch.path}' must be a string or null`);
    }
    const vt = await this.overlayTree(baseCommit, changes);
    const [baseModel, model] = await Promise.all([this.model(baseCommit), buildModel(vt)]);
    const report = validateModel(model, opts, this.gatewayProviders());
    const errors = [...report.errors];
    const warnings = [...report.warnings];
    const changedPaths = new Map(changes.map((c) => [normalizePath(c.path), c.content] as const));
    for (const [uid, def] of baseModel.byUid) {
      if (model.byUid.has(uid)) continue;
      const explicit = changedPaths.has(def.path) && changedPaths.get(def.path) === null;
      if (!explicit) {
        errors.push(`${def.path}: ${KIND_LABEL[def.kind]} '${uid}' would disappear from the tree without an explicit delete ([01] §6.2)`);
        continue;
      }
      const referrers = model.refs.filter((r) => r.to === uid).map((r) => r.from.path);
      if (referrers.length) errors.push(`${def.path}: cannot delete ${KIND_LABEL[def.kind]} '${def.slug ?? uid}'; still referenced by ${dedupe(referrers).join(', ')}`);
    }
    if (changes.length === 0) warnings.push('(changes): the change set is empty');
    return { report: { ok: errors.length === 0, errors: dedupe(errors), warnings: dedupe(warnings) }, model, vt };
  }

  // --- writes -----------------------------------------------------------------------------------

  private authorOf(by: Principal): GitAuthor {
    if (by.user) return { name: by.user.display_name || by.user.handle, email: `${by.user.handle}@breadboard.local` };
    return { name: actorLabel(by.actor), email: `${by.actor.kind}.${by.actor.id.toLowerCase()}@breadboard.local` };
  }

  private async publishCommitted(payload: Record<string, unknown>): Promise<void> {
    if (!this.events) return;
    try {
      await this.events.publish('config.committed', payload, { scope: 'team' });
    } catch (e) {
      this.log.warn({ err: e }, 'failed to publish config.committed');
    }
  }

  private afterMainChanged(commit: string): void {
    this.invalidateMain(commit);
  }

  /** The INDEX.md change for a prospective tree, or null when the file is already current. */
  private async indexChange(model: TreeModel, vt: VirtualTree): Promise<FileChange | null> {
    const rendered = renderIndexFromModel(model);
    const current = await vt.read(CONFIG_PATHS.index);
    return current === rendered ? null : { path: CONFIG_PATHS.index, content: rendered };
  }

  async commitDirect(opts: { changes: FileChange[]; message: string; by: Principal }): Promise<{ commit: string; validation: ValidationReport }> {
    return this.writes.run(async () => {
      const main = await this.repo.resolve(DEFAULT_BRANCH);
      const { report, model, vt } = await this.validateOverlay(main, opts.changes, {});
      if (!report.ok) throw new BreadboardError('validation-failed', `configuration change rejected: ${report.errors[0]}`, report);
      const idx = await this.indexChange(model, vt);
      const changes = idx ? [...opts.changes, idx] : opts.changes;
      if (changes.length === 0) return { commit: main, validation: report };
      const commit = await this.repo.commit({ branch: DEFAULT_BRANCH, changes, message: opts.message, author: this.authorOf(opts.by) });
      this.afterMainChanged(commit);
      await this.publishCommitted({ commit, message: opts.message, by: opts.by.actor, paths: opts.changes.map((c) => normalizePath(c.path)), kind: 'direct' });
      return { commit, validation: report };
    });
  }

  async propose(opts: { changes: FileChange[]; message: string; by: Principal; base?: string; session_id?: string | null }): Promise<ProposalDto> {
    return this.writes.run(async () => {
      const base = await this.repo.resolve(opts.base ?? DEFAULT_BRANCH);
      const { report } = await this.validateOverlay(base, opts.changes, { nonMain: true });
      if (!report.ok) throw new BreadboardError('validation-failed', `proposal rejected: ${report.errors[0]}`, report);
      if (opts.changes.length === 0) throw new BreadboardError('validation-failed', 'a proposal needs at least one change');
      const id = mintProposalId();
      const branch = `${PROPOSAL_BRANCH_PREFIX}${id}`;
      const head = await this.repo.commit({ branch, base, changes: opts.changes, message: opts.message, author: this.authorOf(opts.by) });
      await this.db.query(
        `INSERT INTO config_proposals (proposal_id, team_id, branch, base_commit, head_commit, message, status, created_by, session_id) VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8)`,
        [id, this.teamId, branch, base, head, opts.message, JSON.stringify(opts.by.actor), opts.session_id ?? null],
      );
      this.log.info({ proposal: id, branch, head }, 'config proposal opened');
      return this.getProposal(id);
    });
  }

  private async row(id: string): Promise<ProposalRow> {
    const r = await this.db.query<ProposalRow>(`SELECT * FROM config_proposals WHERE proposal_id=$1 AND team_id=$2`, [id, this.teamId]);
    if (!r.rows[0]) throw new BreadboardError('not-found', `proposal ${id} not found`);
    return r.rows[0];
  }

  private async rowDiff(row: ProposalRow): Promise<RepoDiff | null> {
    try {
      return await this.repo.diff(row.base_commit, row.head_commit);
    } catch (e) {
      // Discarded proposals may have had their commits pruned; the record is still worth returning.
      this.log.debug({ err: e, proposal: row.proposal_id }, 'proposal diff unavailable');
      return null;
    }
  }

  private async toDto(row: ProposalRow, known?: RepoDiff | null): Promise<ProposalDto> {
    const diff = (known === undefined ? await this.rowDiff(row) : known) ?? { patch: '', files: [] };
    let validation: ValidationReport = { ok: true, errors: [], warnings: [] };
    try {
      validation = await this.validateTree(row.head_commit, { nonMain: row.status === 'open' });
    } catch (e) {
      this.log.debug({ err: e, proposal: row.proposal_id }, 'proposal validation unavailable');
    }
    return {
      proposal_id: row.proposal_id,
      branch: row.branch,
      base_commit: row.base_commit,
      head_commit: row.head_commit,
      message: row.message,
      status: row.status,
      created_by: row.created_by,
      created_at: toIso(row.created_at),
      session_id: row.session_id ? String(row.session_id).trim() : null,
      merged_commit: row.merged_commit ?? null,
      changes: diff.files.map((f) => ({ path: f.path, status: f.status === 'renamed' ? 'modified' : f.status })),
      diff: diff.patch,
      validation,
      eval_runs: row.eval_run_ids ?? [],
    };
  }

  async getProposal(id: string): Promise<ProposalDto> {
    return this.toDto(await this.row(id));
  }

  async listProposals(opts: { status?: string; limit?: number; session_id?: string; definition?: string } = {}): Promise<ProposalDto[]> {
    const params: unknown[] = [this.teamId];
    let where = `team_id=$1`;
    if (opts.status) {
      params.push(opts.status);
      where += ` AND status=$${params.length}`;
    }
    if (opts.session_id) {
      params.push(opts.session_id);
      where += ` AND session_id=$${params.length}`;
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    if (!opts.definition) {
      params.push(limit);
      const r = await this.db.query<ProposalRow>(`SELECT * FROM config_proposals WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
      return Promise.all(r.rows.map((row) => this.toDto(row)));
    }
    // The changed paths live in git, not the row: diff a wider window, keep the proposals touching the definition.
    params.push(500);
    const r = await this.db.query<ProposalRow>(`SELECT * FROM config_proposals WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    const diffs = await Promise.all(r.rows.map((row) => this.rowDiff(row)));
    const hits = r.rows.flatMap((row, i) => (diffs[i]?.files.some((f) => owningDefinition(f.path)?.uid === opts.definition) ? [{ row, diff: diffs[i] }] : [])).slice(0, limit);
    return Promise.all(hits.map((h) => this.toDto(h.row, h.diff)));
  }

  async amendProposal(id: string, changes: FileChange[], message: string, by: Principal): Promise<ProposalDto> {
    return this.writes.run(async () => {
      const row = await this.row(id);
      if (row.status !== 'open') throw new BreadboardError('invalid-state', `proposal ${id} is ${row.status}`);
      const { report } = await this.validateOverlay(row.head_commit, changes, { nonMain: true });
      if (!report.ok) throw new BreadboardError('validation-failed', `amendment rejected: ${report.errors[0]}`, report);
      const head = await this.repo.commit({ branch: row.branch, changes, message, author: this.authorOf(by) });
      await this.db.query(`UPDATE config_proposals SET head_commit=$2 WHERE proposal_id=$1`, [id, head]);
      return this.getProposal(id);
    });
  }

  async mergeProposal(id: string, by: Principal): Promise<ProposalDto> {
    return this.writes.run(async () => {
      const row = await this.row(id);
      if (row.status !== 'open') throw new BreadboardError('invalid-state', `proposal ${id} is ${row.status}`);
      const head = await this.repo.resolve(row.branch);
      const main = await this.repo.resolve(DEFAULT_BRANCH);

      // Strict validation of the branch head, then of the branch's changes replayed over current main.
      const headReport = await this.validateTree(head, { nonMain: false });
      if (!headReport.ok) throw new BreadboardError('validation-failed', `proposal ${id} fails validation: ${headReport.errors[0]}`, headReport);
      if (main !== row.base_commit && main !== head) {
        const branchDiff = await this.repo.diff(row.base_commit, head);
        const replay: FileChange[] = [];
        for (const f of branchDiff.files) replay.push({ path: f.path, content: f.status === 'deleted' ? null : await this.repo.readFile(head, f.path) });
        const pre = await this.validateOverlay(main, replay, {});
        if (!pre.report.ok) throw new BreadboardError('validation-failed', `proposal ${id} no longer validates against current main: ${pre.report.errors[0]}`, pre.report);
      }

      const author = this.authorOf(by);
      const merged = await this.repo.merge({ branch: row.branch, into: DEFAULT_BRANCH, message: `Merge proposal ${id}: ${row.message}`, author });
      if (!merged.commit) throw new BreadboardError('conflict', `proposal ${id} conflicts with main on ${merged.conflicts.join(', ')}`, { conflicts: merged.conflicts });
      let final = merged.commit;
      this.afterMainChanged(final);

      // Post-merge check of the actual merged tree (only differs from the pre-check when hunks interleaved).
      if (final !== head) {
        const post = await this.validateTree(final, { nonMain: false });
        if (!post.ok) {
          final = await this.restoreTree(main, final, `Roll back merge of ${id}: ${post.errors[0]}`, author);
          this.afterMainChanged(final);
          throw new BreadboardError('validation-failed', `merged tree fails validation; main restored: ${post.errors[0]}`, post);
        }
      }

      final = await this.regenerateIndex(final, author);
      await this.db.query(`UPDATE config_proposals SET status='merged', merged_commit=$2, merged_by=$3, merged_at=now() WHERE proposal_id=$1`, [id, final, JSON.stringify(by.actor)]);
      await this.repo.deleteBranch(row.branch).catch((e) => this.log.warn({ err: e, branch: row.branch }, 'could not delete merged proposal branch'));
      this.log.info({ proposal: id, commit: final }, 'config proposal merged');
      await this.publishCommitted({ commit: final, message: row.message, by: by.actor, proposal_id: id, kind: 'merge' });
      return this.getProposal(id);
    });
  }

  /** Forward commit on main that restores the tree at `wanted` (used to undo a merge that validated badly). */
  private async restoreTree(wanted: string, current: string, message: string, author: GitAuthor): Promise<string> {
    const d = await this.repo.diff(current, wanted);
    const changes: FileChange[] = [];
    for (const f of d.files) changes.push({ path: f.path, content: f.status === 'deleted' ? null : await this.repo.readFile(wanted, f.path) });
    return this.repo.commit({ branch: DEFAULT_BRANCH, changes, message, author });
  }

  private async regenerateIndex(commit: string, author: GitAuthor): Promise<string> {
    const model = await this.model(commit);
    const idx = await this.indexChange(model, { commit, files: model.files, read: (p) => this.readCached(commit, p) });
    if (!idx) return commit;
    const next = await this.repo.commit({ branch: DEFAULT_BRANCH, changes: [idx], message: 'Regenerate INDEX.md', author });
    this.afterMainChanged(next);
    return next;
  }

  async discardProposal(id: string, by: Principal): Promise<ProposalDto> {
    return this.writes.run(async () => {
      const row = await this.row(id);
      if (row.status !== 'open') throw new BreadboardError('invalid-state', `proposal ${id} is ${row.status}`);
      await this.repo.deleteBranch(row.branch);
      await this.db.query(`UPDATE config_proposals SET status='discarded', discarded_at=now(), merged_by=$2 WHERE proposal_id=$1`, [id, JSON.stringify(by.actor)]);
      this.log.info({ proposal: id, by: actorLabel(by.actor) }, 'config proposal discarded');
      return this.getProposal(id);
    });
  }

  async attachEvalRun(proposalId: string, evalRunId: string): Promise<void> {
    await this.row(proposalId);
    await this.db.query(`UPDATE config_proposals SET eval_run_ids = array_append(array_remove(eval_run_ids, $2), $2) WHERE proposal_id=$1`, [proposalId, evalRunId]);
  }

  async revert(opts: { path?: string; to_commit: string; by: Principal; message?: string }): Promise<{ commit: string }> {
    return this.writes.run(async () => {
      const to = await this.repo.resolve(opts.to_commit);
      const author = this.authorOf(opts.by);
      const message = opts.message ?? (opts.path ? `Revert ${opts.path} to ${to.slice(0, 12)}` : `Revert commit ${to.slice(0, 12)}`);
      const commit = await this.repo.revert({ toCommit: to, path: opts.path, message, author });
      this.afterMainChanged(commit);
      const report = await this.validateTree(commit, { nonMain: false });
      if (!report.ok) this.log.warn({ commit, errors: report.errors }, 'revert produced a tree with validation errors');
      const final = await this.regenerateIndex(commit, author);
      await this.publishCommitted({ commit: final, message, by: opts.by.actor, kind: 'revert', to_commit: to, path: opts.path ?? null });
      return { commit: final };
    });
  }

  history(opts: { path?: string; ref?: string; limit?: number } = {}): Promise<CommitInfo[]> {
    return this.repo.log(opts);
  }

  async diff(base: string, head: string): Promise<{ patch: string; files: Array<{ path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' }> }> {
    return this.repo.diff(await this.resolveRef(base), await this.resolveRef(head));
  }

  async renderIndex(ref?: string): Promise<string> {
    return renderIndexFromModel(await this.model(await this.resolveRef(ref)));
  }

  // --- skeletons --------------------------------------------------------------------------------

  newDefinitionSkeleton(kind: 'circuit' | 'subagent' | 'tool' | 'mcp', slug: string, title: string, opts: Record<string, unknown> = {}): FileChange[] {
    const uid = mintUid();
    const safeSlug = slug.trim().toLowerCase();
    const safeTitle = title.trim() || safeSlug;
    switch (kind) {
      case 'circuit': {
        const subagent = typeof opts.subagent === 'string' && isUid(opts.subagent) ? opts.subagent : '00000000000000000000';
        const circuit = {
          schema: SCHEMA_TAGS.circuit,
          uid,
          slug: safeSlug,
          title: safeTitle,
          description: '',
          tags: [],
          input: { type: 'object', properties: { request: { type: 'string' } } },
          exits: [{ name: 'done', output: { type: 'object', properties: { summary: { type: 'string' } } } }],
          entry: 'draft',
          steps: [
            {
              id: 'draft',
              kind: 'llm',
              subagent,
              prompt: 'prompts/draft.md',
              output: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } },
              exits: [{ name: 'done', to: '$exit.done' }],
            },
          ],
        };
        const header = subagent === '00000000000000000000' ? '# TODO: replace the placeholder subagent UID on step `draft` with a real one.\n' : '';
        return [
          { path: CONFIG_PATHS.circuit(uid), content: header + toYaml(circuit) },
          { path: CONFIG_PATHS.circuitPrompt(uid, 'draft'), content: `You are working on: {{input.request}}\n\nTask: {{ambient.task.uid}}\n\nProduce a short summary of what you did.\n` },
        ];
      }
      case 'subagent': {
        const subagent = {
          schema: SCHEMA_TAGS.subagent,
          uid,
          slug: safeSlug,
          title: safeTitle,
          description: '',
          model_preset: typeof opts.model_preset === 'string' ? opts.model_preset : 'medium',
          system_prompt: `You are ${safeTitle}. Describe the expertise and mindset here.\n`,
          tools: [],
          circuits: [],
          knowledge: { read: [], write: [] },
        };
        return [{ path: CONFIG_PATHS.subagent(uid), content: toYaml(subagent) }];
      }
      case 'tool': {
        const python = opts.language === 'python';
        const tool = {
          schema: SCHEMA_TAGS.tool,
          uid,
          slug: safeSlug,
          title: safeTitle,
          description: '',
          language: python ? 'python' : 'typescript',
          entrypoint: python ? 'src/main.py' : 'src/index.ts',
          input: { type: 'object', properties: { message: { type: 'string' } } },
          output: { type: 'object', required: ['echo'], properties: { echo: { type: 'string' } } },
          settings: {},
          limits: { timeout_s: 60, memory_mb: 256, max_cost_units: 1 },
          egress: { allow: [] },
          capabilities: [],
        };
        const src = python
          ? `"""${safeTitle} — tool extension entrypoint ([06] §2.1).\n\nhandler(input, ctx) receives the validated input and the BreadboardContext; when invoked as a circuit\ncode step return {"exit": ..., "output": ...}; as an LLM tool call the output payload alone is fine.\n"""\n\n\ndef handler(input, ctx):\n    ctx.log("info", "${safeSlug} invoked", {"session": ctx.ambient["session_id"]})\n    message = input.get("message") or ""\n    return {"exit": "done", "output": {"echo": message}}\n`
          : `import type { BreadboardContext, StepResult } from '@breadboard/sandbox-runtime';\n\ninterface Input {\n  message?: string;\n}\ninterface Output {\n  echo: string;\n}\n\n/** ${safeTitle} — tool extension entrypoint ([06] §2.1). */\nexport async function handler(input: Input, ctx: BreadboardContext): Promise<StepResult<Output>> {\n  ctx.log('info', '${safeSlug} invoked', { session: ctx.ambient.session_id });\n  return { exit: 'done', output: { echo: input.message ?? '' } };\n}\n`;
        return [
          { path: CONFIG_PATHS.tool(uid), content: toYaml(tool) },
          { path: `${CONFIG_PATHS.toolDir(uid)}/${tool.entrypoint}`, content: src },
        ];
      }
      case 'mcp': {
        const mcp = {
          schema: SCHEMA_TAGS.mcp,
          uid,
          slug: safeSlug,
          title: safeTitle,
          description: '',
          transport: 'http',
          endpoint: typeof opts.endpoint === 'string' ? opts.endpoint : 'https://mcp.example.com/mcp',
          tools: { allow: [] },
        };
        return [{ path: CONFIG_PATHS.mcp(uid), content: toYaml(mcp) }];
      }
    }
  }
}

function toIso(v: string | Date | null | undefined): string {
  if (!v) return new Date(0).toISOString();
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

export function createConfigService(deps: ConfigServiceDeps): ConfigServiceImpl {
  return new ConfigServiceImpl(deps);
}

