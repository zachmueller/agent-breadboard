/**
 * Subagent runtime ([05] §2-§3): resolves a Subagent definition at a config commit into an executable form
 * (tenets + `{{knowledge:…}}`-resolved system prompt, grants), builds the namespaced tool surface (primitives,
 * tool extensions, MCP tools), and runs the in-process tool-use loop through the model gateway.
 */
import { createHash } from 'node:crypto';
import { BreadboardError, grantDenied, knowledgeTokens, KNOWLEDGE_TOKEN_RE, type Subagent } from '@breadboard/shared';
import type {
  ChatContent,
  ChatMessage,
  ConfigService,
  ConversationResult,
  KnowledgeService,
  McpClientManager,
  ModelGateway,
  Primitives,
  ResolvedSubagent,
  RunConversationInput,
  SessionStore,
  SubagentRuntime,
  TokenUsage,
  Toolbox,
  ToolSpec,
} from '../core/services.js';
import type { Grants, Principal } from '../core/principal.js';
import { canReadDomains } from '../core/principal.js';
import type { Logger } from '../core/logger.js';

/** Primitives a subagent gets when its definition omits `primitives` ([05] §2). */
export const DEFAULT_PRIMITIVES: readonly string[] = Object.freeze([
  'create_artifact',
  'update_artifact',
  'read_node',
  'add_comment',
  'emit_edge',
  'tag_need_input',
  'query_knowledge',
  'read_note',
  'find_similar_tasks',
  'get_session_summary',
]);
export const DEFAULT_MAX_TURNS = 60;
const MAX_TOOL_RESULT_CHARS = 100_000;
const MAX_TOOL_NAME = 64;

export interface SubagentRuntimeDeps {
  config: ConfigService;
  knowledge: KnowledgeService;
  toolbox: Toolbox;
  mcp: McpClientManager;
  primitives: Primitives;
  gateway: ModelGateway;
  /** Accepted for wiring symmetry; turns are recorded by the caller through `hooks`. */
  sessions?: SessionStore;
  team_id: string;
  log: Logger;
}

type Route =
  | { kind: 'primitive'; name: string }
  | { kind: 'tool'; tool_uid: string; settings: Record<string, unknown> }
  | { kind: 'mcp'; server_uid: string; tool: string };

interface Surface {
  specs: ToolSpec[];
  routes: Map<string, Route>;
}

type ToolUse = Extract<ChatContent, { type: 'tool_use' }>;

/** Tool names must match `[a-zA-Z0-9_-]{1,64}` for every provider. */
export function sanitizeToolName(name: string): string {
  let s = name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool';
  if (s.length > MAX_TOOL_NAME) s = `${s.slice(0, MAX_TOOL_NAME - 9)}_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
  return s;
}

/** Resolve grants from a definition ([05] §2): the subagent's real permission set. */
export function grantsFor(def: Subagent, extraReadDomains: string[] = []): Grants {
  const tools = new Map<string, Record<string, unknown>>();
  const mcp = new Map<string, string[] | null>();
  for (const entry of def.tools) {
    if ('tool' in entry) tools.set(entry.tool, { ...(entry.settings ?? {}) });
    else mcp.set(entry.mcp, entry.allow ? [...entry.allow] : null);
  }
  const read = new Set<string>();
  const execute = new Set<string>();
  for (const c of def.circuits) {
    read.add(c.circuit); // execute implies read
    if (c.access === 'execute') execute.add(c.circuit);
  }
  const knowledgeWrite = new Set(def.knowledge.write);
  // Writable domains are readable (proposing an edit requires reading the note).
  const knowledgeRead = new Set([...def.knowledge.read, ...extraReadDomains, ...knowledgeWrite]);
  let primitives: Set<string>;
  if (def.primitives) {
    primitives = new Set(def.primitives); // explicit list honoured literally
  } else {
    primitives = new Set(DEFAULT_PRIMITIVES);
    if (knowledgeWrite.size) primitives.add('propose_note_edit');
    if (execute.size) primitives.add('run_circuit');
  }
  return {
    subagent_uid: def.uid,
    tools,
    mcp,
    circuits: { read, execute },
    knowledge: { read: knowledgeRead, write: knowledgeWrite },
    primitives,
    tools_override: null,
  };
}

/** Deep-clone a tool's input schema and drop any properties that name hidden settings. */
function publicInputSchema(input: unknown, hidden: Set<string>): Record<string, unknown> {
  const schema = (input && typeof input === 'object' ? structuredClone(input) : { type: 'object' }) as Record<string, any>;
  if (hidden.size && schema.properties && typeof schema.properties === 'object') {
    for (const k of hidden) delete schema.properties[k];
    if (Array.isArray(schema.required)) schema.required = schema.required.filter((r: unknown) => typeof r !== 'string' || !hidden.has(r));
  }
  return schema;
}

function textOf(content: ChatContent[]): string {
  return content
    .filter((c): c is Extract<ChatContent, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

function stringifyOutput(output: unknown): string {
  let s: string;
  if (typeof output === 'string') s = output;
  else if (output === undefined) s = '';
  else {
    try {
      s = JSON.stringify(output);
    } catch {
      s = String(output);
    }
  }
  if (s.length > MAX_TOOL_RESULT_CHARS) s = `${s.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${s.length - MAX_TOOL_RESULT_CHARS} chars]`;
  return s;
}

function errorInfo(e: unknown): { code: string; message: string } {
  if (e instanceof BreadboardError) return { code: e.code, message: e.message };
  if (e instanceof Error) return { code: 'internal', message: e.message };
  return { code: 'internal', message: String(e) };
}

export class SubagentRuntimeImpl implements SubagentRuntime {
  constructor(private readonly deps: SubagentRuntimeDeps) {}

  async resolve(uid: string, commit: string, opts: { session_id?: string | null; extra_read_domains?: string[] } = {}): Promise<ResolvedSubagent> {
    const def = await this.deps.config.subagent(uid, commit);
    const tenets = (await this.deps.config.tenets(commit)).trim();
    const grants = grantsFor(def, opts.extra_read_domains ?? []);
    const reader = this.principal(uid, commit, grants, opts.session_id ?? null, null, null);

    const injected: Array<{ uid: string; revision_id: number }> = [];
    const bodies = new Map<string, string>();
    for (const noteUid of new Set(knowledgeTokens(def.system_prompt))) {
      let note;
      try {
        note = await this.deps.knowledge.readNote(noteUid, reader);
      } catch (e) {
        if (e instanceof BreadboardError && (e.code === 'grant-denied' || e.code === 'forbidden')) {
          throw grantDenied(`subagent '${def.slug}' injects knowledge note ${noteUid} ({{knowledge:${noteUid}}}) outside its readable knowledge domains [${[...grants.knowledge.read].join(', ')}]`, { subagent_uid: uid, note_uid: noteUid });
        }
        if (e instanceof BreadboardError) throw new BreadboardError(e.code, `subagent '${def.slug}' system prompt token {{knowledge:${noteUid}}}: ${e.message}`, e.detail);
        throw e;
      }
      // Defence in depth: the knowledge service enforces this, but the check is cheap and the failure is clearer here.
      if (!canReadDomains(reader, note.domains)) {
        throw grantDenied(`subagent '${def.slug}' injects knowledge note ${noteUid} ('${note.title}', domains [${note.domains.join(', ')}]) outside its readable knowledge domains [${[...grants.knowledge.read].join(', ')}]`, { subagent_uid: uid, note_uid: noteUid });
      }
      bodies.set(noteUid, note.markdown.trim());
      injected.push({ uid: noteUid, revision_id: note.base_revision });
    }
    const prompt = def.system_prompt.replace(new RegExp(KNOWLEDGE_TOKEN_RE.source, 'g'), (_m, id: string) => bodies.get(id) ?? '');
    const system_prompt = tenets ? `# Tenets\n${tenets}\n\n${prompt}` : prompt;

    return { uid: def.uid, slug: def.slug, commit, definition: def, system_prompt, injected_notes: injected, grants, model_preset: def.model_preset };
  }

  principalFor(resolved: ResolvedSubagent, sessionId: string, stepId: string | null, visibleSessions: string[]): Principal {
    return this.principal(resolved.uid, resolved.commit, resolved.grants, sessionId, stepId, visibleSessions);
  }

  private principal(uid: string, commit: string, grants: Grants, sessionId: string | null, stepId: string | null, visibleSessions: string[] | null): Principal {
    return {
      actor: { kind: 'subagent', id: uid, ...(sessionId ? { session_id: sessionId } : {}), ...(stepId ? { step_id: stepId } : {}) },
      team_id: this.deps.team_id,
      user: null,
      roles: [],
      is_admin: false,
      scopes: null,
      grants,
      session_id: sessionId,
      visible_sessions: visibleSessions ?? (sessionId ? [sessionId] : []),
      config_commit: commit,
      execution_key: null,
      token_kind: 'actor',
    };
  }

  async toolSurface(resolved: ResolvedSubagent, override?: string[] | null): Promise<ToolSpec[]> {
    const principal = this.principal(resolved.uid, resolved.commit, resolved.grants, null, null, null);
    return (await this.buildSurface(resolved, principal, override)).specs;
  }

  private async buildSurface(resolved: ResolvedSubagent, principal: Principal, overrideIn?: string[] | null): Promise<Surface> {
    const grants = principal.grants ?? resolved.grants;
    const override = overrideIn !== undefined ? (overrideIn ? new Set(overrideIn) : null) : grants.tools_override;
    const specs: ToolSpec[] = [];
    const routes = new Map<string, Route>();
    if (override && override.size === 0) return { specs, routes };

    const add = (spec: ToolSpec, route: Route) => {
      specs.push(spec);
      routes.set(spec.name, route);
    };

    // 1. Primitives (granted names only; specsFor applies the primitive-level gates).
    for (const spec of this.deps.primitives.specsFor(principal)) {
      if (!grants.primitives.has(spec.name)) continue;
      add(spec, { kind: 'primitive', name: spec.name });
    }

    // 2. Tool extensions, named by slug (prefixed `tool__` when the slug collides).
    for (const [toolUid, settings] of grants.tools) {
      let loaded;
      try {
        loaded = await this.deps.config.tool(toolUid, resolved.commit);
      } catch (e) {
        this.deps.log.warn({ subagent: resolved.uid, tool_uid: toolUid, err: errorInfo(e).message }, 'granted tool failed to load; omitted from surface');
        continue;
      }
      const tool = loaded.tool;
      if (override && !override.has(toolUid) && !override.has(tool.slug)) continue;
      let name = sanitizeToolName(tool.slug);
      if (routes.has(name)) name = sanitizeToolName(`tool__${tool.slug}`);
      if (routes.has(name)) name = sanitizeToolName(`tool__${tool.slug}__${toolUid}`);
      const hidden = new Set(Object.entries(tool.settings ?? {}).filter(([, s]) => s.hidden).map(([k]) => k));
      add({ name, description: tool.description || tool.title, input_schema: publicInputSchema(tool.input, hidden) }, { kind: 'tool', tool_uid: toolUid, settings });
    }

    // 3. MCP tools, namespaced `mcp__<server-slug>__<tool>`; dropped under an override unless the server is listed.
    for (const [serverUid, allow] of grants.mcp) {
      if (override && !override.has(serverUid)) continue;
      try {
        const server = await this.deps.config.mcp(serverUid, resolved.commit);
        const slug = server.slug;
        for (const t of await this.deps.mcp.tools(serverUid, allow, resolved.commit)) {
          let name = sanitizeToolName(`mcp__${slug}__${t.name}`);
          if (routes.has(name)) name = sanitizeToolName(`mcp__${serverUid}__${t.name}`);
          add({ ...t, name }, { kind: 'mcp', server_uid: serverUid, tool: t.name });
        }
      } catch (e) {
        this.deps.log.warn({ subagent: resolved.uid, server_uid: serverUid, err: errorInfo(e).message }, 'MCP server tools unavailable; omitted from surface');
      }
    }
    return { specs, routes };
  }

  async runConversation(input: RunConversationInput): Promise<ConversationResult> {
    const { subagent, principal, hooks = {}, session_id, step_id, attempt } = input;
    const grants = principal.grants ?? subagent.grants;
    const surface = await this.buildSurface(subagent, principal, input.tools_override);

    // Extra tools (e.g. the finish tool) win over surface tools on a name collision.
    const extra = input.extra_tools ?? [];
    const extraNames = new Set(extra.map((t) => t.name));
    const tools = [...surface.specs.filter((t) => !extraNames.has(t.name)), ...extra];
    for (const n of extraNames) surface.routes.delete(n);
    const terminal = new Set(input.terminal_tools ?? []);
    const terminalName = input.terminal_tools?.[0] ?? null;
    const maxTurns = input.max_turns ?? DEFAULT_MAX_TURNS;

    const messages: ChatMessage[] = [...input.messages];
    await this.injectKnowledge(messages, subagent, grants, hooks);

    const usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
    let cost = 0;
    const modelIds: string[] = [];
    let turns = 0;
    let callIndex = 0;
    let forceTool: string | undefined = input.force_tool;
    let nudged = false;
    let lastText = '';
    const done = (terminal_call: ConversationResult['terminal_call']): ConversationResult => ({
      messages,
      terminal_call,
      final_text: lastText,
      usage,
      cost_usd: Math.round(cost * 1e6) / 1e6,
      turns,
      model_ids: modelIds,
    });

    while (turns < maxTurns) {
      await hooks.checkBudget?.();
      const res = await this.deps.gateway.complete({
        preset: subagent.model_preset,
        system: subagent.system_prompt,
        messages: [...messages], // snapshot: the loop keeps appending to its own array
        tools: tools.length ? tools : undefined,
        force_tool: forceTool,
        requires: tools.length ? ['tool-use'] : undefined,
        model_overrides: input.model_overrides ?? null,
        session_id,
        step_id,
      });
      turns++;
      // A forced tool applies to one call; keeping it would force the same tool forever.
      forceTool = undefined;
      messages.push(res.message);
      usage.input_tokens += res.usage.input_tokens;
      usage.output_tokens += res.usage.output_tokens;
      cost += res.cost_usd;
      if (!modelIds.includes(res.model_id)) modelIds.push(res.model_id);
      const text = textOf(res.message.content);
      if (text) lastText = text;
      await hooks.onTurn?.({
        role: 'assistant',
        content: res.message.content,
        model_id: res.model_id,
        usage: res.usage,
        cost_usd: res.cost_usd,
        latency_ms: res.latency_ms,
        fallback_from: res.fallback_from,
      });

      const uses = res.message.content.filter((c): c is ToolUse => c.type === 'tool_use');
      const term = uses.find((u) => terminal.has(u.name));
      if (term) return done({ name: term.name, input: term.input, id: term.id });

      if (uses.length) {
        const results: ChatContent[] = [];
        for (const use of uses) {
          await hooks.onToolCall?.({ name: use.name, input: use.input, id: use.id });
          const r = await this.execute(use, surface.routes.get(use.name), { subagent, principal, session_id, step_id, attempt, call_index: callIndex++ });
          await hooks.onToolResult?.({ id: use.id, name: use.name, output: r.output, is_error: r.is_error });
          results.push({ type: 'tool_result', tool_use_id: use.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
        await hooks.onTurn?.({ role: 'tool', content: results });
        continue;
      }

      // No tool calls: the model ended its turn.
      if (!terminalName) return done(null);
      if (nudged) return done(null);
      nudged = true;
      const nudge = `Call \`${terminalName}\` to finish.`;
      messages.push({ role: 'user', content: [{ type: 'text', text: nudge }] });
      forceTool = terminalName;
      await hooks.onTurn?.({ role: 'system', content: { kind: 'finish-nudge', text: nudge, tool: terminalName } });
    }
    this.deps.log.warn({ session_id, step_id, subagent: subagent.uid, max_turns: maxTurns }, 'subagent conversation hit max_turns');
    return done(null);
  }

  /**
   * Context-rule knowledge injection ([07]): notes whose rules match the conversation text are added as user messages
   * just before the latest user message, so the request itself stays last.
   */
  private async injectKnowledge(messages: ChatMessage[], subagent: ResolvedSubagent, grants: Grants, hooks: NonNullable<RunConversationInput['hooks']>): Promise<void> {
    const userText = messages
      .filter((m) => m.role === 'user')
      .map((m) => textOf(m.content))
      .filter(Boolean)
      .join('\n');
    if (!userText || grants.knowledge.read.size === 0) return;
    let matches;
    try {
      matches = await this.deps.knowledge.injectionsFor(userText, [...grants.knowledge.read]);
    } catch (e) {
      this.deps.log.warn({ subagent: subagent.uid, err: errorInfo(e).message }, 'knowledge injection lookup failed; continuing without');
      return;
    }
    const already = new Set(subagent.injected_notes.map((n) => n.uid));
    const injected: ChatMessage[] = [];
    for (const m of matches) {
      if (already.has(m.uid)) continue;
      already.add(m.uid);
      injected.push({ role: 'user', content: [{ type: 'text', text: `[Injected knowledge: ${m.title} ([[${m.uid}|${m.title}]]) rev ${m.revision_id}]\n${m.markdown}` }] });
      await hooks.onTurn?.({ role: 'system', content: { kind: 'knowledge-injected', uid: m.uid, revision_id: m.revision_id } });
    }
    if (!injected.length) return;
    let at = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        at = i;
        break;
      }
    }
    messages.splice(at, 0, ...injected);
  }

  private async execute(
    use: ToolUse,
    route: Route | undefined,
    ctx: { subagent: ResolvedSubagent; principal: Principal; session_id: string; step_id: string; attempt: number; call_index: number },
  ): Promise<{ output: unknown; content: string; is_error: boolean }> {
    const fail = (code: string, message: string) => ({ output: { error: { code, message } }, content: `Error (${code}): ${message}`, is_error: true });
    if (!route) return fail('validation-failed', `tool '${use.name}' is not available in this step`);
    try {
      switch (route.kind) {
        case 'primitive': {
          const out = await this.deps.primitives.call(route.name, use.input, ctx.principal, { session_id: ctx.session_id, step_id: ctx.step_id, attempt: ctx.attempt, call_index: ctx.call_index });
          return { output: out, content: stringifyOutput(out), is_error: false };
        }
        case 'tool': {
          const res = await this.deps.toolbox.invoke({
            tool_uid: route.tool_uid,
            commit: ctx.subagent.commit,
            input: use.input,
            settings: route.settings,
            principal: ctx.principal,
            ambient: { invocation: 'tool-call', session_id: ctx.session_id, step_id: ctx.step_id, attempt: ctx.attempt, tool_uid: route.tool_uid, settings: route.settings },
            session_id: ctx.session_id,
            step_id: ctx.step_id,
            attempt: ctx.attempt,
            call_index: ctx.call_index,
          });
          return { output: res.output, content: stringifyOutput(res.output), is_error: false };
        }
        case 'mcp': {
          const res = await this.deps.mcp.call(route.server_uid, route.tool, use.input, ctx.subagent.commit);
          return { output: res.content, content: stringifyOutput(res.content), is_error: res.is_error };
        }
      }
    } catch (e) {
      // Budget exhaustion aborts the run; everything else goes back to the model as an error result.
      if (e instanceof BreadboardError && e.code === 'budget-exceeded') throw e;
      const { code, message } = errorInfo(e);
      this.deps.log.debug({ session_id: ctx.session_id, step_id: ctx.step_id, tool: use.name, code, message }, 'tool call failed');
      return fail(code, message);
    }
  }
}

export function createSubagentRuntime(deps: SubagentRuntimeDeps): SubagentRuntimeImpl {
  return new SubagentRuntimeImpl(deps);
}
