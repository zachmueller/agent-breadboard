/**
 * Toolbox ([06]): grant-checked, journaled, budgeted execution of tool extensions in the sandbox.
 *
 * `invoke()` pipeline:
 *  1. grant check — subagent/code-step principals may only invoke tools in `grants.tools` (narrowed by
 *     `tools_override` when set); users/services may invoke anything (the MCP layer additionally restricts
 *     external users to `exposure.external_mcp` tools);
 *  2. load the tool at `inv.commit ?? main`; merge settings manifest defaults ← grant settings ← caller settings
 *     (callers can never set `hidden` settings — those come only from the manifest default or the grant);
 *  3. validate input (defaults applied);
 *  4. idempotency journal ([06] §4.4): a completed row with the same key + input hash is returned as `replayed`;
 *  5. nesting-depth cap and per-run tool cost ceiling;
 *  6. mint a short-lived actor token for the principal, register the egress allowlist, run, release, journal.
 */
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BreadboardError, parseConfigYaml, schemaCompileError, validateAgainst, type BreadboardConfig, type Tool } from '@breadboard/shared';
import type { RunnerRequest, BreadboardAmbient } from '@breadboard/sandbox-runtime';
import type { Db } from '../db/index.js';
import type { Logger } from '../core/logger.js';
import type { ObjectStore } from '../core/object-store.js';
import type { Principal } from '../core/principal.js';
import type { AuthService, ConfigService, LoadedTool, SandboxRunner, Toolbox, ToolInvocation, ToolResult, ValidationReport } from '../core/services.js';
import type { EgressProxy } from './egress-proxy.js';
import { ToolJournal, executionKey, inputHash, isAdhocKey } from './journal.js';
import { outcome } from './sandbox/common.js';

const execFileP = promisify(execFile);

export interface ToolboxDeps {
  config: ConfigService;
  sandbox: SandboxRunner;
  proxy: EgressProxy | null;
  auth: AuthService;
  objects: ObjectStore;
  db: Db;
  team_id: string;
  publicUrl: string;
  log: Logger;
  settings: () => Promise<BreadboardConfig>;
  /** Python interpreter used by `ci()` for syntax checks (`PYTHON_BIN`). */
  pythonBin?: string;
}

/** Can this principal invoke the tool at all? (Exported for the subagent tool surface / MCP layer.) */
export function canInvokeTool(p: Principal, toolUid: string): boolean {
  // A circuit code step invoking its own declared tool needs no grant: the circuit's flow is the authority
  // ([05] §2.3 — grants govern a Subagent's *discretionary* invocations, not the orchestration layer's).
  if (p.actor.kind === 'code-step' && p.actor.id === toolUid && !p.grants) return true;
  if (p.actor.kind === 'subagent' || p.actor.kind === 'code-step') {
    if (!p.grants) return false; // AI principals without resolved grants are fail-closed
    if (!p.grants.tools.has(toolUid)) return false;
    if (p.grants.tools_override && !p.grants.tools_override.has(toolUid)) return false;
    return true;
  }
  return true;
}

function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return !!v && typeof v === 'object' && !Array.isArray(v);
    default:
      return true;
  }
}

/**
 * Merge settings: manifest defaults ← grant settings ← caller settings. Hidden settings may come only from the
 * manifest default or the grant; a caller attempting to set one is rejected (`validation-failed`).
 */
export function mergeSettings(tool: Tool, grant: Record<string, unknown> | undefined, caller: Record<string, unknown> | undefined): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [k, def] of Object.entries(tool.settings)) if (def.default !== undefined) merged[k] = structuredClone(def.default);
  for (const [k, v] of Object.entries(grant ?? {})) if (k in tool.settings && v !== undefined) merged[k] = v;
  for (const [k, v] of Object.entries(caller ?? {})) {
    if (v === undefined) continue;
    const def = tool.settings[k];
    if (!def) throw new BreadboardError('validation-failed', `unknown setting '${k}' for tool ${tool.slug}`);
    if (def.hidden) throw new BreadboardError('validation-failed', `setting '${k}' of tool ${tool.slug} is hidden and cannot be overridden by the caller`);
    merged[k] = v;
  }
  for (const [k, v] of Object.entries(merged)) {
    const def = tool.settings[k]!;
    if (!typeOk(def.type, v)) throw new BreadboardError('validation-failed', `setting '${k}' must be of type ${def.type}`);
    if (def.enum && !def.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) throw new BreadboardError('validation-failed', `setting '${k}' must be one of ${JSON.stringify(def.enum)}`);
  }
  return merged;
}

export class ToolboxImpl implements Toolbox {
  readonly journal: ToolJournal;

  constructor(private deps: ToolboxDeps) {
    this.journal = new ToolJournal(deps.db, deps.objects);
  }

  async invoke(inv: ToolInvocation): Promise<ToolResult> {
    const p = inv.principal;
    const uid = inv.tool_uid;
    if (!canInvokeTool(p, uid)) throw new BreadboardError('grant-denied', `${p.actor.kind} ${p.actor.id} is not granted tool ${uid}`, { tool: uid });

    const loaded = await this.deps.config.tool(uid, inv.commit ?? undefined);
    const tool = loaded.tool;
    const settings = await this.deps.settings();

    const merged = mergeSettings(tool, p.grants?.tools.get(uid), inv.settings);
    const exportName = inv.export ?? 'handler';
    let input: unknown = inv.input;
    if (exportName === 'handler') {
      const v = validateAgainst(tool.input, inv.input ?? {});
      if (!v.ok) throw new BreadboardError('validation-failed', `input for tool ${tool.slug} is invalid: ${v.errors.join('; ')}`, { errors: v.errors });
      input = v.value;
    }

    const session_id = inv.session_id ?? null;
    const key = executionKey({ session_id, step_id: inv.step_id, attempt: inv.attempt, call_index: inv.call_index });
    const hash = inputHash({ export: exportName, input });

    // Idempotency journal: replay a completed execution instead of re-running it.
    if (!isAdhocKey(key)) {
      const prior = await this.journal.lookup(key);
      if (prior?.status === 'completed') {
        if (prior.input_hash !== hash) {
          throw new BreadboardError('idempotency-mismatch', `execution ${key} was journaled with different input`, { execution_key: key });
        }
        this.deps.log.debug({ execution_key: key, tool: uid }, 'tool execution replayed from journal');
        return { output: await this.journal.output(prior), logs: [], execution_key: key, replayed: true, cost_units: prior.cost_units, duration_ms: 0 };
      }
    }

    const depth = inv.depth ?? 0;
    if (depth > settings.sandbox.nesting_depth_cap) {
      throw new BreadboardError('invalid-state', `tool nesting depth ${depth} exceeds the cap of ${settings.sandbox.nesting_depth_cap}`, { depth, cap: settings.sandbox.nesting_depth_cap });
    }
    // Per-run tool budget ([06] §4). The circuit's own `max_tool_cost_units` is not visible here; the
    // Breadboard default applies (the orchestrator may enforce a tighter circuit ceiling before invoking).
    if (session_id) {
      const ceiling = settings.defaults.max_tool_cost_units;
      const spent = await this.journal.sessionCostUnits(session_id);
      if (spent + tool.limits.max_cost_units > ceiling) {
        throw new BreadboardError('budget-exceeded', `tool cost ceiling reached for session ${session_id}: ${spent} + ${tool.limits.max_cost_units} > ${ceiling} units`, {
          spent,
          requested: tool.limits.max_cost_units,
          ceiling,
        });
      }
    }

    await this.journal.begin({ execution_key: key, session_id, step_id: inv.step_id, attempt: inv.attempt, call_index: inv.call_index, tool_uid: uid, tool_commit: loaded.commit, input_hash: hash });
    const cost = tool.limits.max_cost_units;
    try {
      const token = await this.deps.auth.mintActorToken({ principal: p, ttlSeconds: Math.ceil(tool.limits.timeout_s) + 60, execution_key: key });
      const ambient: BreadboardAmbient = {
        session_id: session_id ?? p.session_id ?? null,
        step_id: inv.step_id ?? null,
        attempt: inv.attempt ?? null,
        budget_remaining: null,
        task: null,
        ...inv.ambient,
        execution_key: key,
        tool_uid: uid,
        // Hidden settings included: tool code may see them; it is the *model* that must not (enforced by the tool surface).
        settings: merged,
      };
      const request: RunnerRequest = {
        entrypoint: tool.entrypoint,
        export: exportName,
        input,
        ambient,
        api: { base_url: this.deps.publicUrl, token },
        timeout_ms: Math.round(tool.limits.timeout_s * 1000),
      };
      this.deps.proxy?.register(key, { allow: tool.egress.allow, tool_uid: uid });
      let run;
      try {
        run = await this.deps.sandbox.run({ language: tool.language, toolDir: loaded.dir, request, limits: tool.limits, egress: tool.egress, execution_key: key, tool_uid: uid });
      } finally {
        this.deps.proxy?.release(key);
      }
      const logs = run.messages.filter((m) => m.kind === 'log').map((m) => ({ level: m.level, message: m.message, ...(m.data !== undefined ? { data: m.data } : {}), at: m.at }));
      const last = outcome(run.messages);
      if (!last || last.kind === 'error') {
        const message = last?.message ?? 'tool produced no result';
        await this.journal.fail(key, { error: message, cost_units: cost, log_ref: run.log_ref });
        throw new BreadboardError('internal', message, {
          execution_key: key,
          tool: uid,
          exit_code: run.exit_code,
          timed_out: /timed out/.test(message),
          stderr_tail: run.stderr_tail.slice(-4000),
          log_ref: run.log_ref,
          logs: logs.slice(-50),
        });
      }
      const output = last.value;
      if (exportName === 'handler' && tool.output) {
        const isStep = inv.ambient.invocation === 'code-step' && !!output && typeof output === 'object' && typeof (output as any).exit === 'string' && 'output' in (output as any);
        const v = validateAgainst(tool.output, isStep ? (output as any).output : output);
        if (!v.ok) {
          const message = `tool ${tool.slug} returned output that does not match its output schema: ${v.errors.join('; ')}`;
          await this.journal.fail(key, { error: message, cost_units: cost, log_ref: run.log_ref });
          throw new BreadboardError('validation-failed', message, { execution_key: key, errors: v.errors });
        }
      }
      await this.journal.complete(key, { output, cost_units: cost, log_ref: run.log_ref });
      return { output, logs, execution_key: key, replayed: false, cost_units: cost, duration_ms: run.duration_ms };
    } catch (e) {
      if (!(e instanceof BreadboardError)) {
        await this.journal.fail(key, { error: (e as Error).message ?? String(e), cost_units: 0 }).catch(() => undefined);
        throw new BreadboardError('internal', `tool execution failed: ${(e as Error).message}`, { execution_key: key, tool: uid });
      }
      // BreadboardErrors raised above already journaled their failure; anything else (e.g. token minting) needs a row update.
      const row = await this.journal.lookup(key).catch(() => null);
      if (row?.status === 'running') await this.journal.fail(key, { error: e.message, cost_units: 0 }).catch(() => undefined);
      throw e;
    }
  }

  async externalTools(ref?: string): Promise<Array<{ tool: Tool; commit: string }>> {
    const entries = await this.deps.config.tree(ref);
    const out: Array<{ tool: Tool; commit: string }> = [];
    for (const e of entries) {
      if (e.kind !== 'tool' || !e.uid) continue;
      try {
        const t = await this.deps.config.tool(e.uid, ref);
        if (t.tool.exposure.external_mcp) out.push({ tool: t.tool, commit: t.commit });
      } catch (err) {
        this.deps.log.warn({ uid: e.uid, err: (err as Error).message }, 'skipping unloadable tool in external tool listing');
      }
    }
    return out;
  }

  async ci(toolUid: string, ref: string): Promise<ValidationReport> {
    const errors: string[] = [];
    const warnings: string[] = [];
    let loaded: LoadedTool;
    try {
      loaded = await this.deps.config.tool(toolUid, ref);
    } catch (e) {
      return { ok: false, errors: [`manifest: ${(e as Error).message}`], warnings };
    }
    const { tool, dir } = loaded;

    // Manifest: reparse the file itself so CI sees exactly what is committed.
    try {
      const parsed = parseConfigYaml(await readFile(join(dir, 'tool.yaml'), 'utf8'), 'tool');
      if (!parsed.ok) errors.push(...parsed.errors.map((x) => `tool.yaml: ${x}`));
    } catch (e) {
      errors.push(`tool.yaml: ${(e as Error).message}`);
    }
    if (tool.uid !== toolUid) errors.push(`tool.yaml: uid ${tool.uid} does not match directory ${toolUid}`);
    for (const [name, schema] of [['input', tool.input], ['output', tool.output]] as const) {
      if (!schema) continue;
      const err = schemaCompileError(schema);
      if (err) errors.push(`tool.yaml: ${name} schema does not compile: ${err}`);
    }
    const entry = resolve(dir, tool.entrypoint);
    const rel = relative(dir, entry);
    if (isAbsolute(tool.entrypoint) || rel.startsWith('..') || rel.startsWith(sep)) {
      errors.push(`entrypoint ${tool.entrypoint} escapes the tool directory`);
      return { ok: false, errors, warnings };
    }
    const expectedExt = tool.language === 'typescript' ? /\.(ts|mts|js|mjs)$/ : /\.py$/;
    if (!expectedExt.test(tool.entrypoint)) errors.push(`entrypoint ${tool.entrypoint} does not match language ${tool.language}`);
    for (const r of tool.egress.allow) if (r.host.startsWith('*.')) warnings.push(`egress: wildcard host ${r.host} allows every subdomain`);
    if (tool.exposure.external_mcp) warnings.push('exposure: tool is exposed to external MCP clients');

    const files = await listFiles(dir);
    if (!files.includes(rel.split(sep).join('/'))) {
      errors.push(`entrypoint ${tool.entrypoint} does not exist`);
      return { ok: false, errors, warnings };
    }
    if (tool.language === 'typescript') {
      const sources = files.filter((f) => /\.(ts|mts)$/.test(f) && !f.endsWith('.d.ts'));
      const js = files.filter((f) => /\.(js|mjs)$/.test(f));
      errors.push(...(await checkTypeScript(dir, sources)));
      for (const f of js) {
        try {
          await execFileP(process.execPath, ['--check', join(dir, f)], { timeout: 30_000 });
        } catch (e) {
          errors.push(`${f}: ${firstLine((e as { stderr?: string }).stderr ?? (e as Error).message)}`);
        }
      }
    } else {
      const sources = files.filter((f) => f.endsWith('.py'));
      errors.push(...(await checkPython(this.deps.pythonBin ?? 'python3', dir, sources)));
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  async executions(sessionId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.journal.list(sessionId)) as unknown as Array<Record<string, unknown>>;
  }
}

async function listFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(join(dir, rel), { withFileTypes: true })) {
    if (d.name === '.git' || d.name === 'node_modules' || d.name === '__pycache__') continue;
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...(await listFiles(dir, r)));
    else if (d.isFile()) out.push(r);
  }
  return out;
}

function firstLine(s: string): string {
  return (
    s
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /Error|error/.test(l)) ??
    s.split('\n')[0] ??
    s
  ).slice(0, 500);
}

/**
 * Strip-only TypeScript check (what the runtime actually executes): Node's `module.stripTypeScriptTypes`
 * parses each file and rejects syntax errors and non-erasable syntax (enums, namespaces, parameter properties).
 * Runs in a child process to keep the experimental API out of the server. Not a type-check.
 */
async function checkTypeScript(dir: string, files: string[]): Promise<string[]> {
  if (!files.length) return [];
  const script = `
const { stripTypeScriptTypes } = require('node:module');
const fs = require('node:fs');
const errs = [];
for (const f of process.argv.slice(1)) {
  try { stripTypeScriptTypes(fs.readFileSync(f, 'utf8'), { mode: 'strip' }); }
  catch (e) { errs.push({ file: f, code: e.code || null, message: String(e.message).split('\\n')[0] }); }
}
process.stdout.write(JSON.stringify(errs));`;
  try {
    const { stdout } = await execFileP(process.execPath, ['--no-warnings', '-e', script, ...files.map((f) => join(dir, f))], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const errs = JSON.parse(stdout || '[]') as Array<{ file: string; code: string | null; message: string }>;
    return errs.map((e) => `${relative(dir, e.file)}: ${e.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' ? 'non-erasable TypeScript syntax: ' : ''}${e.message}`);
  } catch (e) {
    return [`typescript check failed to run: ${(e as Error).message}`];
  }
}

/** Python syntax check via `ast.parse` (writes no `__pycache__` into the materialized tree). */
async function checkPython(pythonBin: string, dir: string, files: string[]): Promise<string[]> {
  if (!files.length) return [];
  const script = `
import ast, json, sys
errs = []
for f in sys.argv[1:]:
    try:
        with open(f, 'r', encoding='utf-8') as fh:
            ast.parse(fh.read(), filename=f)
    except SyntaxError as e:
        errs.append({'file': f, 'message': f"line {e.lineno}: {e.msg}"})
    except Exception as e:
        errs.append({'file': f, 'message': str(e)})
sys.stdout.write(json.dumps(errs))`;
  try {
    const { stdout } = await execFileP(pythonBin, ['-c', script, ...files.map((f) => join(dir, f))], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const errs = JSON.parse(stdout || '[]') as Array<{ file: string; message: string }>;
    return errs.map((e) => `${relative(dir, e.file)}: ${e.message}`);
  } catch (e) {
    return [`python check failed to run (${pythonBin}): ${(e as Error).message}`];
  }
}

export function createToolbox(deps: ToolboxDeps): ToolboxImpl {
  return new ToolboxImpl(deps);
}
