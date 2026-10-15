#!/usr/bin/env node
/**
 * Offline validator for the shipped configuration seed.
 *
 *   node config-seed/validate.mjs                 # validate; exit 1 on any error
 *   node config-seed/validate.mjs --write-index   # also regenerate INDEX.md
 *   node config-seed/validate.mjs --quiet         # errors only
 *
 * Runs the same zod schemas the server uses (from the built @breadboard/shared package; run
 * `npm run build -w @breadboard/shared` first). It adds the cross-reference, circuit-graph, template,
 * and seed-policy checks listed in README.md, then syntax-checks tool sources with `node --check` (TypeScript)
 * and `python3 -m py_compile` (Python).
 *
 * This file and README.md are tooling, not configuration. The server ignores them (and warns that they are
 * outside the configuration layout) if they get copied into the config repo.
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SHARED = join(ROOT, '..', 'packages', 'shared', 'dist', 'index.js');
if (!existsSync(SHARED)) {
  console.error(`error: ${relative(process.cwd(), SHARED)} not found. Build it first: npm run build -w @breadboard/shared`);
  process.exit(2);
}
const S = await import(pathToFileURL(SHARED).href);
const { parseConfigYaml, parseConfigPath, CONFIG_PATHS, compileTemplate, templateReferences, schemaCompileError,
  schemaRequiredSubset, validateAgainst, isUid } = S;

const args = new Set(process.argv.slice(2));
const WRITE_INDEX = args.has('--write-index');
const QUIET = args.has('--quiet');

// ---------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------

/** Breadboard MCP primitive catalog ([11] §3; server: packages/server/src/toolbox/primitives.ts). */
const PRIMITIVES = new Set([
  'create_artifact', 'update_artifact', 'read_node', 'add_comment', 'emit_edge', 'tag_need_input', 'resolve_need_input',
  'query_knowledge', 'read_note', 'propose_note_edit', 'create_task', 'find_similar_tasks', 'run_circuit',
  'get_session_summary', 'run_tool', 'broker_fetch', 'record_score', 'get_rubric', 'get_fixture_output', 'read_config',
  'search_config', 'validate_config', 'propose_config_change',
]);
const AMBIENT_KEYS = new Set(['task', 'session_id', 'budget', 'artifacts']); // [03] §4: closed ambient channel
const BUILTIN_ASSERTIONS = new Set(['assert-output-schema', 'assert-citations-exist', 'assert-exit']);
const EXTERNAL_MCP_ALLOWED = new Set(['echo', 'check-citations']); // seed policy
const TOOLING_FILES = new Set(['README.md', 'validate.mjs', CONFIG_PATHS.index]);
const PROMPT_LINES = { min: 10, max: 40 };
const TENETS_SOFT_MAX = 1500;
/** Any knowledge-token-shaped text, valid UID or not (the server rejects malformed ones; the seed has no Notes). */
const hasKnowledgeToken = (s) => /\{\{\s*knowledge:/.test(s);

// ---------------------------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------------------------

const errors = [];
const warnings = [];
const err = (path, msg) => errors.push(`${path}: ${msg}`);
const warn = (path, msg) => warnings.push(`${path}: ${msg}`);

// ---------------------------------------------------------------------------------------------------------------
// Load the tree
// ---------------------------------------------------------------------------------------------------------------

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === '.DS_Store' || name === '__pycache__' || name === '.git' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out;
}

const files = walk(ROOT);
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const has = (p) => files.includes(p);

/** kind → Map<uid, {path, def, raw}> */
const defs = { circuit: new Map(), subagent: new Map(), tool: new Map(), mcp: new Map() };
const rubrics = new Map();
const fixtureSets = new Map();
let breadboard = null;
let presets = null;
let tenets = null;
const allUids = new Map();

for (const path of files) {
  if (TOOLING_FILES.has(path)) continue;
  const pp = parseConfigPath(path);
  if (!pp) {
    err(path, 'file is outside the configuration layout');
    continue;
  }
  if (pp.sub !== null) continue; // prompt / source sub-file: checked from its definition
  if (pp.kind === 'tenets') {
    tenets = read(path);
    continue;
  }
  const raw = read(path);
  const r = parseConfigYaml(raw, pp.kind);
  if (!r.ok) {
    for (const e of r.errors) err(path, e);
    continue;
  }
  const def = r.value;
  if (pp.uid && def.uid !== undefined && def.uid !== pp.uid) err(path, `uid '${def.uid}' does not match its path uid '${pp.uid}'`);
  if (pp.kind === 'breadboard') breadboard = def;
  else if (pp.kind === 'presets') presets = def;
  else if (pp.kind === 'rubric') rubrics.set(pp.uid, { path, def, raw });
  else if (pp.kind === 'fixtures') fixtureSets.set(pp.uid, { path, def, raw });
  else {
    defs[pp.kind].set(pp.uid, { path, def, raw });
    if (allUids.has(pp.uid)) err(path, `duplicate uid ${pp.uid} (also ${allUids.get(pp.uid)})`);
    else allUids.set(pp.uid, path);
  }
}

if (!breadboard) err(CONFIG_PATHS.breadboard, 'missing or invalid');
if (!presets) err(CONFIG_PATHS.presets, 'missing or invalid');
if (tenets === null) err(CONFIG_PATHS.tenets, 'missing');

// Duplicate slugs per kind.
for (const [kind, map] of Object.entries(defs)) {
  const seen = new Map();
  for (const { path, def } of map.values()) {
    if (seen.has(def.slug)) err(path, `duplicate ${kind} slug '${def.slug}' (also ${seen.get(def.slug)})`);
    else seen.set(def.slug, path);
  }
}

const domains = new Set((breadboard?.knowledge?.domains ?? []).map((d) => d.slug));
const presetTiers = new Set(Object.keys(presets?.presets ?? {}));

function expectRef(path, what, kind, uid) {
  if (typeof uid !== 'string' || !isUid(uid)) return err(path, `${what}: '${uid}' is not a UID`), null;
  const hit = defs[kind].get(uid);
  if (!hit) {
    const other = Object.entries(defs).find(([, m]) => m.has(uid));
    err(path, other ? `${what}: ${uid} is a ${other[0]}, not a ${kind}` : `${what}: ${kind} ${uid} does not exist`);
    return null;
  }
  return hit.def;
}

function checkSchema(path, what, schema) {
  if (schema === undefined) return;
  const e = schemaCompileError(schema);
  if (e) err(path, `${what}: schema does not compile: ${e}`);
}

function checkDomains(path, what, list) {
  for (const d of list ?? []) if (!domains.has(d)) err(path, `${what}: knowledge domain '${d}' is not declared in breadboard.yaml`);
}

function checkSettings(path, what, tool, settings) {
  if (!tool || !settings) return;
  for (const [k, v] of Object.entries(settings)) {
    const decl = tool.settings?.[k];
    if (!decl) {
      err(path, `${what}: setting '${k}' is not declared by tool ${tool.slug}`);
      continue;
    }
    if (!settingTypeOk(decl.type, v)) err(path, `${what}: setting '${k}' should be ${decl.type}`);
    if (decl.enum && !decl.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) err(path, `${what}: setting '${k}' must be one of ${JSON.stringify(decl.enum)}`);
  }
}

function settingTypeOk(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number';
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    default: return true;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// breadboard.yaml, tenets, presets
// ---------------------------------------------------------------------------------------------------------------

if (breadboard) {
  const P = CONFIG_PATHS.breadboard;
  const raw = read(P);
  if (breadboard.intake.triage_circuit) expectRef(P, 'intake.triage_circuit', 'circuit', breadboard.intake.triage_circuit);
  else warn(P, 'intake.triage_circuit is not set; Tasks will not auto-dispatch');
  if (breadboard.intake.shaper_subagent) expectRef(P, 'intake.shaper_subagent', 'subagent', breadboard.intake.shaper_subagent);
  for (const k of ['circuit', 'tool', 'subagent']) {
    if (breadboard.designers[k]) expectRef(P, `designers.${k}`, 'subagent', breadboard.designers[k]);
    else warn(P, `designers.${k} is not set`);
  }
  for (const [i, rule] of breadboard.knowledge_injection.entries()) {
    checkDomains(P, `knowledge_injection[${i}]`, [rule.domain]);
    try {
      new RegExp(rule.trigger.pattern);
    } catch (e) {
      err(P, `knowledge_injection[${i}].trigger.pattern does not compile: ${e.message}`);
    }
  }
  for (const [i, c] of breadboard.connectors.entries()) {
    const t = expectRef(P, `connectors[${i}].tool`, 'tool', c.tool);
    if (t && !t.connector) err(P, `connectors[${i}]: tool ${t.slug} has no connector block`);
    checkDomains(P, `connectors[${i}]`, c.domains);
    checkSettings(P, `connectors[${i}]`, t, c.settings);
  }
  if (breadboard.auth.mode === 'local' && breadboard.auth.local_users.length && !/dev[- ]only/i.test(raw)) warn(P, 'local_users are configured but there is no dev-only warning comment');
  const handles = new Set();
  for (const u of breadboard.auth.local_users) {
    if (handles.has(u.handle)) err(P, `duplicate local user handle '${u.handle}'`);
    handles.add(u.handle);
  }
}

if (tenets !== null) {
  const max = Math.min(breadboard?.tenets?.max_chars ?? 2000, 2000);
  const n = tenets.trim().length;
  if (n > max) err(CONFIG_PATHS.tenets, `${n} chars exceeds tenets.max_chars (${max})`);
  else if (n > TENETS_SOFT_MAX) warn(CONFIG_PATHS.tenets, `${n} chars; keep tenets under ${TENETS_SOFT_MAX}`);
  if (hasKnowledgeToken(tenets)) err(CONFIG_PATHS.tenets, 'contains {{knowledge:...}} tokens (the seed has no content nodes)');
}

if (presets) {
  for (const [tier, list] of Object.entries(presets.presets)) if (!list.length) err(CONFIG_PATHS.presets, `preset '${tier}' has no models`);
}

// ---------------------------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------------------------

/** Exit-name literals that appear in a tool's source, used to sanity-check code-step exits. */
const toolSource = new Map();

for (const [uid, { path, def: t }] of defs.tool) {
  const dir = CONFIG_PATHS.toolDir(uid);
  const entry = `${dir}/${t.entrypoint}`;
  if (!has(entry)) err(path, `entrypoint ${t.entrypoint} does not exist (${entry})`);
  const sources = files.filter((f) => f.startsWith(`${dir}/`) && /\.(ts|mts|js|mjs|py)$/.test(f));
  const text = sources.map(read).join('\n');
  toolSource.set(uid, text);
  const want = t.language === 'python' ? /\.py$/ : /\.(ts|mts|js|mjs)$/;
  if (!want.test(t.entrypoint)) err(path, `entrypoint ${t.entrypoint} does not match language ${t.language}`);
  if (has(entry)) {
    const src = read(entry);
    const handler = t.language === 'python' ? /^def handler\s*\(/m : /export\s+(async\s+)?function\s+handler\b|export\s+(const|let)\s+handler\b/;
    if (!handler.test(src)) err(entry, 'does not define a `handler` entry function');
    if (t.connector) {
      for (const fn of ['list', 'fetch']) {
        const re = t.language === 'python' ? new RegExp(`^def ${fn}\\s*\\(`, 'm') : new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\b`);
        if (!re.test(src)) err(entry, `connector tool must define \`${fn}\``);
      }
      checkDomains(path, 'connector.domains', t.connector.domains);
    }
  }
  checkSchema(path, 'input', t.input);
  checkSchema(path, 'output', t.output);
  if (!t.output) warn(path, 'no output schema declared');
  for (const [k, s] of Object.entries(t.settings)) {
    if (s.default !== undefined && !settingTypeOk(s.type, s.default)) err(path, `settings.${k}.default is not a ${s.type}`);
    if (s.enum && s.default !== undefined && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(s.default))) err(path, `settings.${k}.default is not in its enum`);
    if (s.default === undefined) warn(path, `settings.${k} has no default`);
  }
  if (!t.builtin) err(path, 'seed tools must be `builtin: true`');
  if (t.exposure.external_mcp && !EXTERNAL_MCP_ALLOWED.has(t.slug)) err(path, 'exposure.external_mcp is reserved for echo and check-citations in the seed');
  for (const r of t.egress.allow) {
    const h = r.host;
    if (h === '*' || (h.includes('*') && !/^\*\.[^*]+$/.test(h))) err(path, `egress host '${h}': only exact hosts or a leading '*.' wildcard are supported`);
  }
  if (t.capabilities.length && !t.egress.allow.length) warn(path, 'declares capabilities but no egress hosts');
  const usesFetch = /ctx\.fetch\s*\(/.test(text);
  if (usesFetch && !t.capabilities.length) err(path, 'source calls ctx.fetch but no capabilities are declared');
  // Brokered-fetch capabilities should be named in source; others (e.g. sandbox-injected credentials) need not be.
  if (usesFetch) for (const c of t.capabilities) if (!text.includes(c.name)) warn(path, `capability '${c.name}' is never passed to ctx.fetch`);
}

// ---------------------------------------------------------------------------------------------------------------
// MCP onboarding
// ---------------------------------------------------------------------------------------------------------------

for (const [, { path, def: m }] of defs.mcp) {
  if (m.transport === 'stdio' && !m.command) err(path, 'stdio transport needs `command`');
  if (m.transport !== 'stdio' && !m.endpoint) err(path, `${m.transport} transport needs \`endpoint\``);
}

// ---------------------------------------------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------------------------------------------

for (const [, { path, def: s }] of defs.subagent) {
  if (!presetTiers.has(s.model_preset)) err(path, `model_preset '${s.model_preset}' is not defined in ${CONFIG_PATHS.presets}`);
  const lines = s.system_prompt.replace(/\s+$/, '').split('\n').length;
  if (lines < PROMPT_LINES.min || lines > PROMPT_LINES.max) err(path, `system_prompt is ${lines} lines (want ${PROMPT_LINES.min}-${PROMPT_LINES.max})`);
  if (hasKnowledgeToken(s.system_prompt)) err(path, 'system_prompt contains {{knowledge:...}} tokens (the seed has no content nodes)');
  for (const [i, g] of s.tools.entries()) {
    if ('tool' in g) {
      const t = expectRef(path, `tools[${i}]`, 'tool', g.tool);
      checkSettings(path, `tools[${i}]`, t, g.settings);
    } else {
      expectRef(path, `tools[${i}]`, 'mcp', g.mcp);
      err(path, `tools[${i}]: seed subagents must not reference MCP servers (they may not be installed)`);
    }
  }
  const toolUids = s.tools.filter((g) => 'tool' in g).map((g) => g.tool);
  if (new Set(toolUids).size !== toolUids.length) err(path, 'duplicate tool grants');
  for (const [i, g] of s.circuits.entries()) expectRef(path, `circuits[${i}]`, 'circuit', g.circuit);
  checkDomains(path, 'knowledge.read', s.knowledge.read);
  checkDomains(path, 'knowledge.write', s.knowledge.write);
  for (const d of s.knowledge.write) if (!s.knowledge.read.includes(d)) warn(path, `knowledge.write '${d}' without read access`);
  if (s.primitives === undefined) warn(path, 'primitives omitted; the server default set applies');
  for (const p of s.primitives ?? []) if (!PRIMITIVES.has(p)) err(path, `unknown primitive '${p}'`);
  const prims = new Set(s.primitives ?? []);
  if (s.circuits.some((g) => g.access === 'execute') && s.primitives && !prims.has('run_circuit')) err(path, 'has execute circuit grants but not the run_circuit primitive');
  if (s.knowledge.write.length && s.primitives && !prims.has('propose_note_edit')) warn(path, 'has knowledge write access but not the propose_note_edit primitive');
  if (prims.has('propose_note_edit') && !s.knowledge.write.length) warn(path, 'has propose_note_edit but no knowledge.write domains');
}

// ---------------------------------------------------------------------------------------------------------------
// Circuits
// ---------------------------------------------------------------------------------------------------------------

const EXPR_RE = /^\$(input|steps|ambient)(\.|$)/;

/** Validate a `$input.x` / `$steps.<id>.output.x` / `$ambient.x` expression (or template path without `$`). */
function checkExpr(path, what, expr, circuit, stepIds) {
  const p = expr.replace(/^\$/, '');
  const segs = p.split('.');
  const root = segs[0];
  if (root === 'input') {
    const prop = segs[1];
    if (prop && !(circuit.input?.properties && prop in circuit.input.properties)) err(path, `${what}: '${expr}' refers to undeclared input property '${prop}'`);
  } else if (root === 'steps') {
    const id = segs[1];
    if (!id || !stepIds.has(id)) err(path, `${what}: '${expr}' refers to unknown step '${id}'`);
    else if (segs.length > 2 && segs[2] !== 'output') err(path, `${what}: '${expr}' must go through '.output'`);
  } else if (root === 'ambient') {
    if (!segs[1] || !AMBIENT_KEYS.has(segs[1])) err(path, `${what}: '${expr}' is not an ambient key (${[...AMBIENT_KEYS].join(', ')})`);
  } else {
    err(path, `${what}: '${expr}' has unknown root '${root}' (want input, steps, ambient)`);
  }
}

function walkInputMap(path, what, value, circuit, stepIds) {
  if (typeof value === 'string') {
    if (value.startsWith('$')) {
      if (!EXPR_RE.test(value)) err(path, `${what}: '${value}' is not a valid expression`);
      else checkExpr(path, what, value, circuit, stepIds);
    }
  } else if (Array.isArray(value)) value.forEach((v, i) => walkInputMap(path, `${what}[${i}]`, v, circuit, stepIds));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walkInputMap(path, `${what}.${k}`, v, circuit, stepIds);
}

const circuitChildren = new Map();

for (const [uid, { path, def: c }] of defs.circuit) {
  const dir = CONFIG_PATHS.circuitDir(uid);
  if (!c.budget) err(path, 'seed circuits must declare `budget`');
  checkSchema(path, 'input', c.input);
  checkDomains(path, 'knowledge.read', c.knowledge?.read);
  const exitNames = new Set();
  for (const x of c.exits) {
    if (exitNames.has(x.name)) err(path, `duplicate circuit exit '${x.name}'`);
    exitNames.add(x.name);
    if (!x.output) err(path, `circuit exit '${x.name}' must declare an output schema`);
    checkSchema(path, `exits.${x.name}.output`, x.output);
  }
  const exitByName = new Map(c.exits.map((x) => [x.name, x]));

  const stepIds = new Set();
  for (const st of c.steps) {
    if (stepIds.has(st.id)) err(path, `duplicate step id '${st.id}'`);
    stepIds.add(st.id);
  }
  const byId = new Map(c.steps.map((s) => [s.id, s]));
  if (!stepIds.has(c.entry)) err(path, `entry '${c.entry}' is not a step`);

  const routed = new Set();
  const children = new Set();
  for (const st of c.steps) {
    const at = `${path} [step ${st.id}]`;
    const names = new Set();
    for (const x of st.exits) {
      if (names.has(x.name)) err(at, `duplicate exit '${x.name}'`);
      names.add(x.name);
      if (x.to.startsWith('$exit.')) {
        const n = x.to.slice(6);
        if (!exitByName.has(n)) err(at, `exit '${x.name}' routes to undeclared circuit exit '${n}'`);
        else routed.add(n);
      } else if (!stepIds.has(x.to)) err(at, `exit '${x.name}' routes to unknown step '${x.to}'`);
    }
    if (st.max_visits === undefined && st.exits.some((x) => x.to === st.id)) warn(at, 'self-loop without max_visits');

    if (st.kind === 'llm' || st.kind === 'gate' || (st.kind === 'code' && st.output)) checkSchema(at, 'output', st.output);

    if (st.kind === 'llm') {
      const sa = expectRef(at, 'subagent', 'subagent', st.subagent);
      if (!st.prompt && !st.prompt_inline) err(at, 'llm step needs `prompt` or `prompt_inline`');
      if (st.prompt && st.prompt_inline) err(at, 'set only one of `prompt` / `prompt_inline`');
      let tpl = st.prompt_inline ?? null;
      if (st.prompt) {
        const pp = `${dir}/${st.prompt}`;
        if (!has(pp)) err(at, `prompt file ${st.prompt} does not exist`);
        else tpl = read(pp);
      }
      if (tpl !== null) {
        try {
          compileTemplate(tpl);
        } catch (e) {
          err(at, `prompt template does not compile: ${e.message}`);
        }
        for (const ref of templateReferences(tpl)) checkExpr(at, 'prompt', ref, c, stepIds);
        if (hasKnowledgeToken(tpl)) err(at, 'prompt contains {{knowledge:...}} tokens (the seed has no content nodes)');
      }
      if (st.tools_override && sa) {
        const granted = new Set(sa.tools.filter((g) => 'tool' in g).map((g) => g.tool));
        for (const t of st.tools_override) {
          expectRef(at, 'tools_override', 'tool', t);
          if (!granted.has(t)) err(at, `tools_override ${t} is not granted to subagent ${sa.slug} (overrides only narrow)`);
        }
      }
    } else if (st.kind === 'code') {
      const t = expectRef(at, 'tool', 'tool', st.tool);
      if (!st.output) err(at, 'seed code steps must declare an output schema');
      const im = st.input_map ?? {};
      walkInputMap(at, 'input_map', im, c, stepIds);
      if (t) {
        for (const r of t.input?.required ?? []) if (!(r in im)) err(at, `input_map does not provide required tool input '${r}'`);
        const props = t.input?.properties ?? {};
        for (const k of Object.keys(im)) if (Object.keys(props).length && !(k in props)) warn(at, `input_map key '${k}' is not a declared input of tool ${t.slug}`);
        checkSettings(at, 'settings', t, st.settings);
        const src = toolSource.get(st.tool) ?? '';
        for (const x of st.exits) if (!new RegExp(`['"]${x.name}['"]`).test(src)) warn(at, `exit '${x.name}' never appears as a string literal in tool ${t.slug}'s source`);
      }
    } else if (st.kind === 'circuit') {
      children.add(st.circuit);
      const child = expectRef(at, 'circuit', 'circuit', st.circuit);
      const im = st.input_map ?? {};
      walkInputMap(at, 'input_map', im, c, stepIds);
      if (child) {
        for (const r of child.input?.required ?? []) if (!(r in im)) err(at, `input_map does not provide required child input '${r}'`);
        const childExits = child.exits.map((x) => x.name);
        const map = st.exit_map ?? {};
        for (const k of Object.keys(map)) if (!childExits.includes(k)) err(at, `exit_map key '${k}' is not an exit of ${child.slug}`);
        const expected = childExits.map((n) => map[n] ?? n).sort();
        const actual = st.exits.map((x) => x.name).sort();
        if (JSON.stringify(expected) !== JSON.stringify(actual)) err(at, `exits [${actual}] must map 1:1 to ${child.slug}'s exits [${expected}]`);
        // Conformance of child exit payloads to the parent exits they route to.
        for (const x of st.exits) {
          if (!x.to.startsWith('$exit.')) continue;
          const childName = Object.entries(map).find(([, v]) => v === x.name)?.[0] ?? x.name;
          const cx = child.exits.find((e) => e.name === childName);
          const px = exitByName.get(x.to.slice(6));
          for (const p of schemaRequiredSubset(cx?.output, px?.output)) warn(at, `exit '${x.name}' → ${x.to}: ${p}`);
        }
      }
    } else if (st.kind === 'gate') {
      if (!names.has('approve') || !names.has('changes')) err(at, 'gate steps must declare both `approve` and `changes` exits');
      for (const n of names) if (n !== 'approve' && n !== 'changes') warn(at, `gate exit '${n}' will never be taken (gates resolve via approve/changes)`);
      for (const a of st.review.artifacts) {
        if (!/^\$steps\.[a-z0-9-]+\.output(\.|$)/.test(a)) err(at, `review.artifacts '${a}' must be a $steps.<id>.output expression`);
        else checkExpr(at, 'review.artifacts', a, c, stepIds);
      }
      const r = st.review.reviewers;
      if (!r.role && !r.username && !(r.any_of && r.any_of.length)) err(at, 'review.reviewers targets nobody');
    }

    // Static conformance of step output → circuit exit (warning: one schema may serve several exits).
    if (st.kind !== 'circuit' && st.output) {
      for (const x of st.exits) {
        if (!x.to.startsWith('$exit.')) continue;
        const px = exitByName.get(x.to.slice(6));
        for (const p of schemaRequiredSubset(st.output, px?.output)) warn(at, `exit '${x.name}' → ${x.to}: ${p}`);
      }
    }
  }
  for (const n of exitNames) if (!routed.has(n)) err(path, `circuit exit '${n}' is never routed to`);

  // Reachability from entry.
  const seen = new Set();
  const stack = byId.has(c.entry) ? [c.entry] : [];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const x of byId.get(id)?.exits ?? []) if (byId.has(x.to)) stack.push(x.to);
  }
  for (const id of stepIds) if (!seen.has(id)) err(path, `step '${id}' is unreachable from entry '${c.entry}'`);

  // Orphan prompt files.
  for (const f of files.filter((f) => f.startsWith(`${dir}/prompts/`))) {
    const rel = f.slice(dir.length + 1);
    if (!c.steps.some((s) => s.kind === 'llm' && s.prompt === rel)) warn(f, 'prompt file is not used by any step');
  }
  const extra = files.filter((f) => f.startsWith(`${dir}/`) && !f.startsWith(`${dir}/prompts/`) && !['circuit.yaml', 'rubric.yaml', 'fixtures.yaml'].includes(f.slice(dir.length + 1)));
  for (const f of extra) warn(f, 'unexpected file in circuit directory');
  circuitChildren.set(uid, children);
}

// Sub-circuit cycles.
{
  const state = new Map();
  const visit = (uid, trail) => {
    if (state.get(uid) === 'done') return;
    if (state.get(uid) === 'active') return err(defs.circuit.get(uid)?.path ?? uid, `sub-circuit cycle: ${[...trail, uid].map((u) => defs.circuit.get(u)?.def.slug ?? u).join(' → ')}`);
    state.set(uid, 'active');
    for (const ch of circuitChildren.get(uid) ?? []) if (defs.circuit.has(ch)) visit(ch, [...trail, uid]);
    state.set(uid, 'done');
  };
  for (const uid of defs.circuit.keys()) visit(uid, []);
}

// ---------------------------------------------------------------------------------------------------------------
// Rubrics & fixtures
// ---------------------------------------------------------------------------------------------------------------

for (const [dirUid, { path, def: r }] of rubrics) {
  if (r.circuit !== dirUid) err(path, `circuit '${r.circuit}' does not match its directory (${dirUid})`);
  if (!defs.circuit.has(dirUid)) err(path, 'rubric for a circuit that does not exist');
  expectRef(path, 'judge.subagent', 'subagent', r.judge.subagent);
  const keys = new Set();
  for (const d of r.dimensions) {
    if (keys.has(d.key)) err(path, `duplicate dimension '${d.key}'`);
    keys.add(d.key);
    if (d.type === 'numeric' && d.scale.min >= d.scale.max) err(path, `dimension '${d.key}': scale.min must be < scale.max`);
    if (d.type === 'programmatic') {
      if (isUid(d.tool)) checkSettings(path, `dimension '${d.key}'`, expectRef(path, `dimension '${d.key}'.tool`, 'tool', d.tool), d.settings);
      else if (!BUILTIN_ASSERTIONS.has(d.tool)) err(path, `dimension '${d.key}': tool '${d.tool}' is neither a UID nor a built-in assertion`);
    }
  }
  for (const w of Object.keys(r.aggregate.weights)) if (!keys.has(w)) err(path, `aggregate.weights refers to unknown dimension '${w}'`);
  for (const k of Object.keys(r.aggregate.ordinal_map ?? {})) if (!keys.has(k)) err(path, `aggregate.ordinal_map refers to unknown dimension '${k}'`);
}

for (const [dirUid, { path, def: fx }] of fixtureSets) {
  if (fx.circuit !== dirUid) err(path, `circuit '${fx.circuit}' does not match its directory (${dirUid})`);
  const c = defs.circuit.get(dirUid)?.def;
  if (!c) {
    err(path, 'fixtures for a circuit that does not exist');
    continue;
  }
  const ids = new Set();
  for (const f of fx.fixtures) {
    if (ids.has(f.fixture_id)) err(path, `duplicate fixture_id '${f.fixture_id}'`);
    ids.add(f.fixture_id);
    const v = validateAgainst(c.input, f.input);
    if (!v.ok) err(path, `fixture '${f.fixture_id}': input does not match the circuit input schema: ${v.errors.join('; ')}`);
    for (const t of f.tags) {
      const m = /^expect-exit:(.+)$/.exec(t);
      if (m && !c.exits.some((x) => x.name === m[1])) err(path, `fixture '${f.fixture_id}': tag '${t}' names an undeclared exit`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// MCP must not be referenced (seed policy) — covered above; also note unused MCP onboarding.
// ---------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------
// INDEX.md (same format the server regenerates on every commit to main)
// ---------------------------------------------------------------------------------------------------------------

function renderIndex() {
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = ['# Configuration index', '', '_Auto-generated by Breadboard on every commit to `main`; informational only ([01] §6.1). Slugs and titles live in each definition — edit them there._', ''];
  const sections = [['Circuits', 'circuit'], ['Subagents', 'subagent'], ['Tools', 'tool'], ['MCP servers', 'mcp']];
  for (const [heading, kind] of sections) {
    const list = [...defs[kind].values()].sort((a, b) => (a.def.slug ?? '').localeCompare(b.def.slug ?? '') || a.path.localeCompare(b.path));
    lines.push(`## ${heading}`, '');
    if (!list.length) {
      lines.push('_none_', '');
      continue;
    }
    lines.push('| Slug | Title | UID | Path |', '|---|---|---|---|');
    for (const { path, def } of list) lines.push(`| ${cell(def.slug)} | ${cell(def.title)} | \`${def.uid}\` | \`${path}\` |`);
    lines.push('');
  }
  lines.push('## Instance', '', '| File | Present |', '|---|---|');
  for (const p of [CONFIG_PATHS.breadboard, CONFIG_PATHS.tenets, CONFIG_PATHS.presets]) lines.push(`| \`${p}\` | ${has(p) ? 'yes' : 'no'} |`);
  lines.push('');
  return lines.join('\n');
}

const index = renderIndex();
if (WRITE_INDEX) {
  writeFileSync(join(ROOT, CONFIG_PATHS.index), index);
  if (!QUIET) console.log(`wrote ${CONFIG_PATHS.index}`);
} else if (!has(CONFIG_PATHS.index)) err(CONFIG_PATHS.index, 'missing (run with --write-index)');
else if (read(CONFIG_PATHS.index) !== index) err(CONFIG_PATHS.index, 'out of date (run with --write-index)');

// ---------------------------------------------------------------------------------------------------------------
// Source syntax checks
// ---------------------------------------------------------------------------------------------------------------

const { stripTypeScriptTypes } = await import('node:module');
const pycache = mkdtempSync(join(tmpdir(), 'bb-seed-pyc-'));
let checkedTs = 0;
let checkedPy = 0;
for (const f of files) {
  if (!f.startsWith('tools/')) continue;
  try {
    if (/\.(ts|mts)$/.test(f) && typeof stripTypeScriptTypes === 'function') {
      // What the sandbox executes: rejects syntax errors and non-erasable TS (enums, namespaces, parameter properties).
      const prev = process.emitWarning;
      process.emitWarning = () => {};
      try {
        stripTypeScriptTypes(read(f), { mode: 'strip' });
      } catch (e) {
        err(f, `TypeScript strip check failed: ${e.message}`);
        continue;
      } finally {
        process.emitWarning = prev;
      }
    }
    if (/\.(ts|mts|js|mjs)$/.test(f)) {
      execFileSync(process.execPath, ['--check', join(ROOT, f)], { stdio: 'pipe' });
      checkedTs++;
    } else if (/\.py$/.test(f)) {
      execFileSync('python3', ['-m', 'py_compile', join(ROOT, f)], { stdio: 'pipe', env: { ...process.env, PYTHONPYCACHEPREFIX: pycache } });
      checkedPy++;
    }
  } catch (e) {
    if (e.code === 'ENOENT') warn(f, 'python3 not found; skipped syntax check');
    else err(f, `syntax check failed:\n${String(e.stderr ?? e.message).trim()}`);
  }
}
rmSync(pycache, { recursive: true, force: true });

// ---------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------

const count = (k) => defs[k].size;
if (!QUIET) {
  console.log(`config-seed: ${count('circuit')} circuits, ${count('subagent')} subagents, ${count('tool')} tools, ${count('mcp')} MCP servers, ${rubrics.size} rubrics, ${fixtureSets.size} fixture sets`);
  console.log(`syntax-checked ${checkedTs} TypeScript/JS and ${checkedPy} Python files (node ${process.versions.node})`);
  for (const w of warnings) console.log(`warning  ${w}`);
}
for (const e of errors) console.log(`error    ${e}`);
console.log(`${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
