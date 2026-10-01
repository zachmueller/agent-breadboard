import { describe, expect, it } from 'vitest';
import { BreadboardError, grantDenied, type Presets, type Subagent } from '@breadboard/shared';
import { silentLogger } from '../core/logger.js';
import type { Principal } from '../core/principal.js';
import type { ChatMessage, ConfigService, KnowledgeService, McpClientManager, Primitives, Toolbox, ToolSpec } from '../core/services.js';
import { createModelGateway } from '../gateway/gateway.js';
import { MockProvider } from '../gateway/mock.js';
import { DEFAULT_PRIMITIVES, createSubagentRuntime, grantsFor } from './runtime.js';

const SA = '01J8SVBAG0RSRCHSCT00';
const NOTE1 = '01J8NTE0000000000001';
const NOTE2 = '01J8NTE0000000000002';
const NOTE3 = '01J8NTE0000000000003';
const TOOL1 = '01J8TQQ0000000000001';
const TOOL2 = '01J8TQQ0000000000002';
const MCP1 = '01J8MCP0000000000001';
const CIRCUIT = '01J8CRC0000000000001';
const COMMIT = 'c0ffee';

const finishTool: ToolSpec = { name: 'breadboard_finish', description: 'finish', input_schema: { type: 'object', properties: { exit: { type: 'string', enum: ['done', 'blocked'] } }, required: ['exit'] } };
const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });

function subagentDef(over: Partial<Subagent> = {}): Subagent {
  return {
    schema: 'breadboard/subagent@1',
    uid: SA,
    slug: 'researcher',
    title: 'Researcher',
    description: '',
    system_prompt: `You research.\n\n{{knowledge:${NOTE1}}}`,
    model_preset: 'medium',
    tools: [{ tool: TOOL1, settings: { api_key: 'secret' } }, { tool: TOOL2 }, { mcp: MCP1, allow: ['fetch'] }],
    circuits: [{ circuit: CIRCUIT, access: 'execute' }],
    knowledge: { read: ['eng'], write: [] },
    ...over,
  } as Subagent;
}

function harness(def: Subagent = subagentDef()) {
  const log: string[] = [];
  const primitiveCalls: Array<{ name: string; args: unknown; ctx: unknown }> = [];
  const toolCalls: any[] = [];
  const notes: Record<string, { title: string; markdown: string; base_revision: number; domains: string[] }> = {
    [NOTE1]: { title: 'House style', markdown: 'Write plainly.', base_revision: 7, domains: ['eng'] },
    [NOTE2]: { title: 'Secret', markdown: 'nope', base_revision: 1, domains: ['hr'] },
  };
  const config = {
    subagent: async () => def,
    tenets: async () => 'Be honest.',
    presets: async () => ({}) as Presets,
    tool: async (uid: string) => {
      if (uid === TOOL1)
        return {
          uid,
          commit: COMMIT,
          dir: '/x',
          tool: { uid, slug: 'search', title: 'Search', description: 'Search the web', input: { type: 'object', properties: { q: { type: 'string' }, api_key: { type: 'string' } }, required: ['q', 'api_key'] }, settings: { api_key: { type: 'string', hidden: true } } },
        };
      return { uid, commit: COMMIT, dir: '/y', tool: { uid, slug: 'read_node', title: 'Reader', description: '', input: { type: 'object' }, settings: {} } };
    },
    mcp: async (uid: string) => ({ uid, slug: 'web' }),
  } as unknown as ConfigService;
  const knowledge = {
    readNote: async (uid: string, by: Principal) => {
      const n = notes[uid];
      if (!n) throw new BreadboardError('note-not-found', `note ${uid} not found`);
      if (!n.domains.some((d) => by.grants?.knowledge.read.has(d))) throw grantDenied(`note ${uid} not readable`);
      return { uid, ...n, read_only: false, tags: [], properties: {} };
    },
    injectionsFor: async (text: string, domains: string[] | null) => {
      log.push(`injectionsFor:${domains?.join(',')}`);
      return /style/i.test(text) ? [{ uid: NOTE3, title: 'Style guide', revision_id: 4, markdown: 'Use active voice.', rule: 'mentions style' }] : [];
    },
  } as unknown as KnowledgeService;
  const primitiveNames = [...DEFAULT_PRIMITIVES, 'run_circuit', 'propose_note_edit', 'create_task'];
  const spec = (name: string): ToolSpec => ({ name, description: `primitive ${name}`, input_schema: { type: 'object' } });
  const primitives: Primitives = {
    names: primitiveNames,
    spec,
    specsFor: (p) => primitiveNames.filter((n) => p.grants?.primitives.has(n)).map(spec),
    call: async (name, args, _p, ctx) => {
      primitiveCalls.push({ name, args, ctx });
      if (name === 'add_comment') throw grantDenied('cannot comment here');
      return { ok: true, name };
    },
  };
  const toolbox = {
    invoke: async (inv: any) => {
      toolCalls.push(inv);
      return { output: { results: ['r1'] }, logs: [], execution_key: 'k', replayed: false, cost_units: 1, duration_ms: 1 };
    },
  } as unknown as Toolbox;
  const mcp = {
    tools: async (_uid: string, allow: string[] | null) => (allow ?? ['fetch', 'post']).map((name) => ({ name, description: name, input_schema: { type: 'object' } })),
    call: async () => ({ content: 'page', is_error: false, raw: null }),
    stop: async () => {},
  } as McpClientManager;
  const mock = new MockProvider();
  const gateway = createModelGateway({ providers: [mock], presets: async () => ({ schema: 'breadboard/presets@1', presets: { medium: [{ provider: 'mock', model_id: 'mock-medium' }] } }) as Presets, log: silentLogger });
  const runtime = createSubagentRuntime({ config, knowledge, toolbox, mcp, primitives, gateway, team_id: 'team1', log: silentLogger });
  const hooks = {
    onTurn: async (t: any) => void log.push(`turn:${t.role}${t.content?.kind ? `:${t.content.kind}` : ''}`),
    onToolCall: async (c: any) => void log.push(`call:${c.name}`),
    onToolResult: async (r: any) => void log.push(`result:${r.name}${r.is_error ? ':error' : ''}`),
    checkBudget: async () => void log.push('budget'),
  };
  return { runtime, mock, log, hooks, primitiveCalls, toolCalls };
}

describe('SubagentRuntime.resolve', () => {
  it('prepends tenets, resolves knowledge tokens, records revisions, builds grants', async () => {
    const { runtime } = harness();
    const r = await runtime.resolve(SA, COMMIT, { extra_read_domains: ['ops'] });
    expect(r.system_prompt).toBe('# Tenets\nBe honest.\n\nYou research.\n\nWrite plainly.');
    expect(r.injected_notes).toEqual([{ uid: NOTE1, revision_id: 7 }]);
    expect(r.model_preset).toBe('medium');
    expect(r.commit).toBe(COMMIT);
    expect([...r.grants.tools.keys()]).toEqual([TOOL1, TOOL2]);
    expect(r.grants.tools.get(TOOL1)).toEqual({ api_key: 'secret' });
    expect(r.grants.mcp.get(MCP1)).toEqual(['fetch']);
    expect([...r.grants.circuits.execute]).toEqual([CIRCUIT]);
    expect(r.grants.circuits.read.has(CIRCUIT)).toBe(true);
    expect([...r.grants.knowledge.read].sort()).toEqual(['eng', 'ops']);
    expect(r.grants.primitives.has('run_circuit')).toBe(true);
    expect(r.grants.primitives.has('propose_note_edit')).toBe(false);
    expect(r.grants.primitives.has('create_task')).toBe(false);
    expect(r.grants.tools_override).toBeNull();
  });

  it('fails clearly when a knowledge token is outside the readable domains', async () => {
    const { runtime } = harness(subagentDef({ system_prompt: `x {{knowledge:${NOTE2}}}` }));
    const err = await runtime.resolve(SA, COMMIT).catch((e) => e);
    expect(err).toBeInstanceOf(BreadboardError);
    expect(err.code).toBe('grant-denied');
    expect(err.message).toContain(NOTE2);
    expect(err.message).toContain("'researcher'");
  });

  it('primitive defaults: write grant adds propose_note_edit; explicit lists are literal', () => {
    expect(grantsFor(subagentDef({ knowledge: { read: [], write: ['eng'] }, circuits: [] })).primitives.has('propose_note_edit')).toBe(true);
    const explicit = grantsFor(subagentDef({ primitives: ['read_node', 'create_task'] }));
    expect([...explicit.primitives]).toEqual(['read_node', 'create_task']);
  });

  it('principalFor builds an actor principal', async () => {
    const { runtime } = harness();
    const r = await runtime.resolve(SA, COMMIT);
    const p = runtime.principalFor(r, 'S1', 'step-a', ['S1', 'S0']);
    expect(p).toMatchObject({ actor: { kind: 'subagent', id: SA, session_id: 'S1', step_id: 'step-a' }, team_id: 'team1', scopes: null, is_admin: false, user: null, roles: [], visible_sessions: ['S1', 'S0'], config_commit: COMMIT, token_kind: 'actor', session_id: 'S1' });
    expect(p.grants).toBe(r.grants);
  });
});

describe('SubagentRuntime.toolSurface', () => {
  it('namespaces extensions and MCP tools, strips hidden settings', async () => {
    const { runtime } = harness();
    const r = await runtime.resolve(SA, COMMIT);
    const surface = await runtime.toolSurface(r);
    const names = surface.map((t) => t.name);
    expect(names).toEqual([...DEFAULT_PRIMITIVES, 'run_circuit', 'search', 'tool__read_node', 'mcp__web__fetch']);
    const search = surface.find((t) => t.name === 'search')!;
    expect(search.description).toBe('Search the web');
    expect(search.input_schema).toEqual({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] });
  });

  it('tools_override narrows: listed extensions + primitives, MCP only when listed; [] empties', async () => {
    const { runtime } = harness();
    const r = await runtime.resolve(SA, COMMIT);
    const narrowed = (await runtime.toolSurface(r, [TOOL1])).map((t) => t.name);
    expect(narrowed).toContain('search');
    expect(narrowed).toContain('read_node');
    expect(narrowed).not.toContain('tool__read_node');
    expect(narrowed).not.toContain('mcp__web__fetch');
    expect((await runtime.toolSurface(r, ['search', MCP1])).map((t) => t.name)).toContain('mcp__web__fetch');
    expect(await runtime.toolSurface(r, [])).toEqual([]);
  });
});

describe('SubagentRuntime.runConversation', () => {
  it('runs primitive → extension → failing primitive → finish, with hooks in order', async () => {
    const h = harness();
    const r = await h.runtime.resolve(SA, COMMIT);
    const principal = h.runtime.principalFor(r, 'S1', 'step-a', ['S1']);
    h.mock.enqueue(
      { tool_calls: [{ name: 'read_node', input: { uid: 'X' } }] },
      { tool_calls: [{ name: 'search', input: { q: 'hello' } }] },
      { tool_calls: [{ name: 'add_comment', input: { body: 'hi' } }] },
    );
    const res = await h.runtime.runConversation({
      subagent: r,
      principal,
      messages: [user('Please check the style of this doc')],
      extra_tools: [finishTool],
      terminal_tools: ['breadboard_finish'],
      session_id: 'S1',
      step_id: 'step-a',
      attempt: 1,
      hooks: h.hooks,
    });
    expect(res.terminal_call).toEqual({ name: 'breadboard_finish', input: { exit: 'done' }, id: 'toolu_mock_3_0' });
    expect(res.turns).toBe(4);
    expect(res.model_ids).toEqual(['mock-medium']);
    expect(res.usage.input_tokens).toBeGreaterThan(0);
    expect(res.cost_usd).toBeGreaterThan(0);
    expect(h.log).toEqual([
      'injectionsFor:eng',
      'turn:system:knowledge-injected',
      'budget', 'turn:assistant', 'call:read_node', 'result:read_node', 'turn:tool',
      'budget', 'turn:assistant', 'call:search', 'result:search', 'turn:tool',
      'budget', 'turn:assistant', 'call:add_comment', 'result:add_comment:error', 'turn:tool',
      'budget', 'turn:assistant',
    ]);
    // Primitive context and journal coordinates.
    expect(h.primitiveCalls[0]).toMatchObject({ name: 'read_node', args: { uid: 'X' }, ctx: { session_id: 'S1', step_id: 'step-a', attempt: 1, call_index: 0 } });
    expect(h.toolCalls[0]).toMatchObject({ tool_uid: TOOL1, commit: COMMIT, input: { q: 'hello' }, settings: { api_key: 'secret' }, ambient: { invocation: 'tool-call', session_id: 'S1', tool_uid: TOOL1 }, call_index: 1, attempt: 1 });
    // Injection placed before the request; finish tool offered; system prompt from resolve.
    const first = h.mock.calls[0]!;
    expect(first.system).toBe(r.system_prompt);
    expect(first.messages[0]).toEqual(user(`[Injected knowledge: Style guide ([[${NOTE3}|Style guide]]) rev 4]\nUse active voice.`));
    expect(first.messages[1]).toEqual(user('Please check the style of this doc'));
    expect(first.tools!.map((t) => t.name)).toContain('breadboard_finish');
    expect(first.requires).toEqual(['tool-use']);
    // The primitive error came back as an is_error tool_result and the loop continued.
    const errResult = res.messages.find((m) => m.content.some((c) => c.type === 'tool_result' && c.is_error));
    expect(errResult!.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_mock_2_0', content: 'Error (grant-denied): cannot comment here', is_error: true });
    expect(res.messages.at(-1)!.role).toBe('assistant');
  });

  it('nudges once on end_turn when a terminal tool is expected', async () => {
    const h = harness(subagentDef({ system_prompt: 'plain' }));
    const r = await h.runtime.resolve(SA, COMMIT);
    const principal = h.runtime.principalFor(r, 'S1', 's', []);
    h.mock.enqueue({ text: 'I think we are done.' });
    const res = await h.runtime.runConversation({ subagent: r, principal, messages: [user('go')], extra_tools: [finishTool], terminal_tools: ['breadboard_finish'], session_id: 'S1', step_id: 's', attempt: 1, hooks: h.hooks });
    expect(res.terminal_call?.name).toBe('breadboard_finish');
    expect(h.mock.calls[0]!.force_tool).toBeUndefined();
    expect(h.mock.calls[1]!.force_tool).toBe('breadboard_finish');
    expect(h.mock.calls[1]!.messages.at(-1)).toEqual(user('Call `breadboard_finish` to finish.'));
    expect(h.log).toContain('turn:system:finish-nudge');
    expect(res.final_text).toBe('I think we are done.');
  });

  it('gives up after one nudge, and returns final_text when no terminal tool is expected', async () => {
    const h = harness(subagentDef({ system_prompt: 'plain' }));
    const r = await h.runtime.resolve(SA, COMMIT);
    const principal = h.runtime.principalFor(r, 'S1', 's', []);
    h.mock.script(() => ({ text: 'no.' }));
    const stuck = await h.runtime.runConversation({ subagent: r, principal, messages: [user('go')], extra_tools: [finishTool], terminal_tools: ['breadboard_finish'], session_id: 'S1', step_id: 's', attempt: 1 });
    expect(stuck.terminal_call).toBeNull();
    expect(stuck.turns).toBe(2);
    h.mock.script(null);
    const chat = await h.runtime.runConversation({ subagent: r, principal, messages: [user('echo me')], tools_override: [], session_id: 'S1', step_id: 's', attempt: 1 });
    expect(chat.final_text).toBe('echo me');
    expect(chat.terminal_call).toBeNull();
    expect(h.mock.calls.at(-1)!.tools).toBeUndefined();
  });

  it('returns unknown tools as errors and aborts when the budget hook throws', async () => {
    const h = harness(subagentDef({ system_prompt: 'plain' }));
    const r = await h.runtime.resolve(SA, COMMIT);
    const principal = h.runtime.principalFor(r, 'S1', 's', []);
    h.mock.enqueue({ tool_calls: [{ name: 'nonexistent', input: {} }] });
    const res = await h.runtime.runConversation({ subagent: r, principal, messages: [user('go')], extra_tools: [finishTool], terminal_tools: ['breadboard_finish'], session_id: 'S1', step_id: 's', attempt: 1 });
    expect(res.messages[2]!.content[0]).toMatchObject({ type: 'tool_result', is_error: true, content: expect.stringContaining('not available') });
    expect(res.terminal_call?.name).toBe('breadboard_finish');
    let n = 0;
    const budget = async () => {
      if (++n > 1) throw new BreadboardError('budget-exceeded', 'over budget');
    };
    h.mock.enqueue({ tool_calls: [{ name: 'read_node', input: {} }] });
    await expect(h.runtime.runConversation({ subagent: r, principal, messages: [user('go')], extra_tools: [finishTool], terminal_tools: ['breadboard_finish'], session_id: 'S1', step_id: 's', attempt: 1, hooks: { checkBudget: budget } })).rejects.toMatchObject({ code: 'budget-exceeded' });
  });
});
