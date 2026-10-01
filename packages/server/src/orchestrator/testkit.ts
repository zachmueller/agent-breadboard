/**
 * Test kit for orchestrator/dispatcher tests: a PGlite foundation, the real session store and content
 * service, and hand-written fakes for config, subagents, toolbox, tasks, and the event bus.
 */
import { SCHEMA_TAGS, mintUid, zBreadboardConfig, zCircuit, type ArtifactRef, type BreadboardConfig, type Circuit } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import type { ChatMessage, ConfigService, ConversationResult, EventBus, LoadedCircuit, ResolvedSubagent, RunConversationInput, SubagentRuntime, TaskService, ToolInvocation, Toolbox } from '../core/services.js';
import type { Principal } from '../core/principal.js';
import { createContentService, type ContentServiceImpl } from '../content/service.js';
import { createSessionStore, type PgSessionStore } from './session-store.js';
import { createOrchestrator, type OrchestratorImpl, FINISH_TOOL } from './orchestrator.js';
import { createDispatcher, type DispatcherImpl } from './dispatcher.js';

export type LlmBehavior = (call: { input: RunConversationInput; n: number; prompt: string; kit: Kit }) => Promise<{ exit: string; output: unknown } | null> | { exit: string; output: unknown } | null;
export type ToolBehavior = (input: any, inv: ToolInvocation) => Promise<unknown> | unknown;

export interface Kit {
  f: Foundation;
  sessions: PgSessionStore;
  content: ContentServiceImpl;
  orch: OrchestratorImpl;
  dispatcher: DispatcherImpl;
  settings: BreadboardConfig;
  config: { main: string; circuits: Map<string, Circuit>; bump(): string; add(c: Record<string, unknown>): Circuit };
  llm: Map<string, LlmBehavior>;
  /** Per-call cost for fake model turns. */
  turnCost: { usd: number; tokens_in: number; tokens_out: number };
  llmCalls: Array<{ subagent: string; session_id: string; step_id: string; attempt: number; prompt: string; principal: Principal; messages: ChatMessage[] }>;
  tools: Map<string, ToolBehavior>;
  toolCalls: Array<{ tool_uid: string; input: any; principal: Principal; ambient: any }>;
  taskStatuses: Array<{ uid: string; status: string }>;
  published: Array<{ topic: string; payload: any }>;
  /** Create a session-scoped artifact as the calling subagent. */
  artifact(input: RunConversationInput, title: string, body?: unknown): Promise<ArtifactRef>;
  task(title?: string): Promise<string>;
  close(): Promise<void>;
}

const commitOf = (n: number) => n.toString(16).padStart(40, '0');

export async function createKit(overrides: Record<string, unknown> = {}): Promise<Kit> {
  const f = await createFoundation();
  const settings = zBreadboardConfig.parse({ schema: SCHEMA_TAGS.breadboard, ...overrides });
  const sessions = createSessionStore({ db: f.db, team_id: f.team_id });
  const published: Kit['published'] = [];
  const events = {
    publish: async (topic: string, payload: any) => {
      published.push({ topic, payload });
      return { id: String(published.length), topic, payload, visibility: { scope: 'team' }, at: new Date().toISOString() };
    },
    subscribe: () => () => undefined,
  } as unknown as EventBus;
  const content = createContentService({
    db: f.db,
    team_id: f.team_id,
    nodes: f.nodes,
    edges: f.edges,
    graph: f.graph,
    linkIndexer: f.linkIndexer,
    identity: f.identity,
    events,
    settings: async () => settings,
    knowledge: () => null,
    sessions: () => sessions,
    log: f.log,
  });

  let n = 1;
  const circuits = new Map<string, Circuit>();
  const cfg: Kit['config'] = {
    main: commitOf(n),
    circuits,
    bump() {
      cfg.main = commitOf(++n);
      return cfg.main;
    },
    add(c) {
      const parsed = zCircuit.parse({ schema: SCHEMA_TAGS.circuit, uid: mintUid(), title: 'Test circuit', ...c });
      circuits.set(parsed.uid, parsed);
      return parsed;
    },
  };
  const config = {
    mainCommit: async () => cfg.main,
    settings: async () => settings,
    circuit: async (uid: string, ref?: string): Promise<LoadedCircuit> => {
      const c = circuits.get(uid);
      if (!c) throw new Error(`no circuit ${uid}`);
      return { uid, commit: ref ?? cfg.main, circuit: c, prompts: {}, rubric: null, fixtures: null };
    },
  } as unknown as ConfigService;

  const llm = new Map<string, LlmBehavior>();
  const llmCalls: Kit['llmCalls'] = [];
  const counts = new Map<string, number>();
  const turnCost = { usd: 0.01, tokens_in: 100, tokens_out: 50 };
  const subagents = {
    async resolve(uid: string, commit: string): Promise<ResolvedSubagent> {
      return { uid, slug: `sa-${uid.slice(0, 4).toLowerCase()}`, commit, definition: {} as any, system_prompt: 'You are a test subagent.', injected_notes: [], grants: {} as any, model_preset: 'small' };
    },
    principalFor(resolved: ResolvedSubagent, sessionId: string, stepId: string | null, visible: string[]): Principal {
      return {
        ...f.servicePrincipal,
        actor: { kind: 'subagent', id: resolved.uid, session_id: sessionId, step_id: stepId } as any,
        user: null,
        roles: [],
        is_admin: false,
        scopes: null,
        grants: { subagent_uid: resolved.uid, tools: new Map(), mcp: new Map(), circuits: { read: new Set(), execute: new Set() }, knowledge: { read: new Set(), write: new Set() }, primitives: new Set(), tools_override: false } as any,
        session_id: sessionId,
        visible_sessions: visible,
        token_kind: 'actor' as any,
      } as Principal;
    },
    async toolSurface() {
      return [];
    },
    async runConversation(input: RunConversationInput): Promise<ConversationResult> {
      const behavior = llm.get(input.subagent.uid);
      if (!behavior) throw new Error(`no fake behavior for subagent ${input.subagent.uid}`);
      const key = `${input.session_id}:${input.step_id}:${input.subagent.uid}`;
      const callN = (counts.get(key) ?? 0) + 1;
      counts.set(key, callN);
      const last = input.messages[input.messages.length - 1]!;
      const prompt = last.content.map((c: any) => (c.type === 'text' ? c.text : c.type === 'tool_result' ? c.content : '')).join('\n');
      llmCalls.push({ subagent: input.subagent.uid, session_id: input.session_id, step_id: input.step_id, attempt: input.attempt, prompt, principal: input.principal, messages: input.messages });
      await input.hooks?.checkBudget?.();
      const r = await behavior({ input, n: callN, prompt, kit });
      const id = `tu_${llmCalls.length}`;
      const content = r ? [{ type: 'tool_use' as const, id, name: FINISH_TOOL, input: r }] : [{ type: 'text' as const, text: 'I am done.' }];
      await input.hooks?.onTurn?.({ role: 'assistant', content, model_id: 'fake-model', usage: { input_tokens: turnCost.tokens_in, output_tokens: turnCost.tokens_out }, cost_usd: turnCost.usd, latency_ms: 1 });
      return {
        messages: [...input.messages, { role: 'assistant', content }],
        terminal_call: r ? { name: FINISH_TOOL, input: r, id } : null,
        final_text: r ? '' : 'I am done.',
        usage: { input_tokens: turnCost.tokens_in, output_tokens: turnCost.tokens_out },
        cost_usd: turnCost.usd,
        turns: 1,
        model_ids: ['fake-model'],
      };
    },
  } as unknown as SubagentRuntime;

  const tools = new Map<string, ToolBehavior>();
  const toolCalls: Kit['toolCalls'] = [];
  const toolbox = {
    async invoke(inv: ToolInvocation) {
      toolCalls.push({ tool_uid: inv.tool_uid, input: inv.input, principal: inv.principal, ambient: inv.ambient });
      const b = tools.get(inv.tool_uid);
      if (!b) throw new Error(`no fake tool ${inv.tool_uid}`);
      const output = await b(inv.input, inv);
      return { output, logs: [], execution_key: `ek_${toolCalls.length}`, replayed: false, cost_units: 0, duration_ms: 1 };
    },
    async executions() {
      return [];
    },
  } as unknown as Toolbox;

  const taskStatuses: Kit['taskStatuses'] = [];
  const tasks = {
    async setStatus(uid: string, status: string) {
      taskStatuses.push({ uid, status });
    },
    async dispatchQueued() {
      return [];
    },
  } as unknown as TaskService;

  const orch = createOrchestrator({ sessions, config, subagents, toolbox, content, tasks, events, nodes: f.nodes, edges: f.edges, log: f.log, team_id: f.team_id, settings: async () => settings, fastRetries: true });
  const dispatcher = createDispatcher({ sessions, orchestrator: orch, settings: async () => settings, tasks, log: f.log });

  const kit: Kit = {
    f,
    sessions,
    content,
    orch,
    dispatcher,
    settings,
    config: cfg,
    llm,
    turnCost,
    llmCalls,
    tools,
    toolCalls,
    taskStatuses,
    published,
    async artifact(input, title, body = `# ${title}`) {
      const a = await content.createArtifact({ title, body, scope: 'session', by: input.principal, session_id: input.session_id, step_id: `${input.step_id}#${input.attempt}` } as any);
      return { uid: a.uid, revision_id: a.revision_id };
    },
    async task(title = 'A task') {
      const t = await content.createNode({ type: 'task', title, body: 'do it', by: f.servicePrincipal });
      return t.uid;
    },
    async close() {
      await dispatcher.stop();
      await f.close();
    },
  };
  return kit;
}

export const ARTIFACT_REF = { $ref: '#/defs/artifact-ref' } as const;
