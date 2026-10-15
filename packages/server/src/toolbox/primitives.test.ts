import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BreadboardError, type SessionEvent, type SessionRecord } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import type { Grants, Principal } from '../core/principal.js';
import { createPrimitives, type PrimitivesDeps, type PrimitivesImpl } from './primitives.js';

type Call = { svc: string; method: string; args: any[] };

/** A recording fake: provided methods run; anything else throws `not-implemented`. */
function fake<T>(svc: string, calls: Call[], impl: Record<string, (...a: any[]) => any>): T {
  return new Proxy({} as any, {
    get(_t, method: string) {
      if (method === 'then') return undefined;
      return async (...args: any[]) => {
        calls.push({ svc, method, args });
        const fn = impl[method];
        if (!fn) throw new BreadboardError('not-implemented', `${svc}.${method}`);
        return fn(...args);
      };
    },
  }) as T;
}

const CIRCUIT = '01J8FQ2ZK7XW9MBT4PVN';
const OTHER_CIRCUIT = '01J8FQ2ZK7XW9MBT4PVM';
const TOOL = '01J8FQ2ZK7XW9MBT4PVT';
const MODEL_TOOL = '01J8FQ2ZK7XW9MBT4PVH';
let spentUsd = 0;
const SUBAGENT = '01J8FQ2ZK7XW9MBT4PVS';

function grants(over: Partial<{ primitives: string[]; execute: string[]; read: string[]; override: string[] | null }> = {}): Grants {
  return {
    subagent_uid: SUBAGENT,
    tools: new Map(),
    mcp: new Map(),
    circuits: { read: new Set(over.read ?? []), execute: new Set(over.execute ?? []) },
    knowledge: { read: new Set(['eng']), write: new Set() },
    primitives: new Set(over.primitives ?? []),
    tools_override: over.override ? new Set(over.override) : null,
  };
}

function subagentPrincipal(f: Foundation, g: Grants, extra: Partial<Principal> = {}): Principal {
  return {
    actor: { kind: 'subagent', id: SUBAGENT, session_id: 'sess_parent', step_id: 'gather' },
    team_id: f.team_id,
    user: null,
    roles: [],
    is_admin: false,
    scopes: null,
    grants: g,
    session_id: 'sess_parent',
    visible_sessions: ['sess_parent'],
    config_commit: 'c0ffee',
    execution_key: null,
    token_kind: 'internal',
    ...extra,
  };
}

let f: Foundation;
let calls: Call[];
let events: SessionEvent[];
let prims: PrimitivesImpl;

function session(id: string, state: SessionRecord['state'], extra: Partial<SessionRecord> = {}): SessionRecord {
  return { session_id: id, team_id: f.team_id, kind: 'circuit-run', circuit_uid: CIRCUIT, config_commit: null, task_uid: null, parent_session: null, parent_step_id: null, state, state_detail: {}, budget: { max_cost_usd: 1, max_tokens: 1000, spent_usd: 0, spent_tokens: 0 }, created_at: '', started_at: null, ended_at: null, ...extra };
}

function build(): PrimitivesImpl {
  const deps: PrimitivesDeps = {
    content: fake('content', calls, {
      createArtifact: (i: any) => ({ uid: 'ART00000000000000001', revision_id: 1, node: {} }),
      getNode: (uid: string) => ({ uid, type: 'artifact', title: 'T', properties: {}, body: '# hi', body_text: '# hi', crdt: false, tags: [], scope: 'team', head_revision: 2, created_at: '', created_by: { kind: 'service', id: 'x' }, updated_at: '' }),
      revision: (uid: string, rev: number) => ({ uid, revision_id: rev, labels: [], properties: { a: 1 }, body: 'old', body_text: 'old', created_at: '', created_by: { kind: 'service', id: 'x' } }),
      emitEdge: () => ({ edge_id: 42 }),
      addComment: (i: any) => {
        if (i.anchor?.quote === 'missing') throw new BreadboardError('anchor-not-found', 'quote not found');
        return { uid: 'CMT00000000000000001', anchor_status: i.anchor ? 'resolved' : 'none' };
      },
      tagNeedInput: () => ({ request_id: 'nir_1' }),
      resolveNeedInput: () => ({ resolved: {}, remaining_open: 0 }),
    }),
    knowledge: fake('knowledge', calls, {
      search: () => [{ uid: 'N1', title: 'n', snippet: 's', score: 1, domains: ['eng'], tags: [], source: 'text' }],
      readNote: (uid: string) => ({ uid, title: 'n', markdown: '# n', base_revision: 3, domains: ['eng'], read_only: false, tags: [], properties: {} }),
      proposeEdit: () => ({ applied: true, had_concurrent_edits: false, merged_markdown: '# m', new_head_revision: 5, pre_ai_edit_revision: 4, blocks_changed: 1 }),
    }),
    tasks: fake('tasks', calls, {
      create: (i: any) => ({ uid: 'TSK00000000000000001', properties: { status: i.draft ? 'draft' : 'queued' } }),
      similar: () => [{ uid: 'TSK00000000000000002', title: 'dup', status: 'queued', score: 0.9 }],
    }),
    orchestrator: fake('orchestrator', calls, {
      enqueue: () => session('sess_child', 'queued'),
      waitFor: (id: string) => session(id, 'completed'),
    }),
    sessions: fake('sessions', calls, {
      events: (_id: string, after?: number) => events.filter((e) => after === undefined || e.seq > after),
      summary: (id: string) => ({ session_id: id, steps: [] }),
      get: (id: string) =>
        id === 'sess_child' ? session(id, 'running', { parent_session: 'sess_parent' }) : id === 'sess_other' ? session(id, 'running') : id === 'sess_intake' ? session(id, 'running', { kind: 'intake' }) : null,
      mustGet: (id: string) => session(id, 'running'),
      cost: () => ({ cost_usd: spentUsd, tokens_in: 0, tokens_out: 0 }),
      costIncludingChildren: () => spentUsd,
      recordTurn: (t: any) => ({ ...t, turn_id: 'trn_1', created_at: '' }),
    }),
    evals: fake('evals', calls, { recordScore: () => undefined, getFixtureOutput: () => ({ out: 1 }) }),
    config: fake('config', calls, {
      definition: (ref: string, _at?: string, opts?: { lenient?: boolean }) => {
        const uid = opts?.lenient && ref === 'lit-review' ? CIRCUIT : ref;
        return { uid, kind: uid.startsWith('01J8FQ2ZK7XW9MBT4PV') && uid !== TOOL ? 'circuit' : 'tool', path: `x/${uid}`, commit: 'c', slug: 's', title: 't', definition: {}, raw: 'raw', validation: { ok: true, errors: [], warnings: [] }, referenced_by: [] };
      },
      search: () => [
        { uid: CIRCUIT, kind: 'circuit', slug: 'lit-review', title: 'Literature review', path: `circuits/${CIRCUIT}/circuit.yaml` },
        { uid: TOOL, kind: 'tool', slug: 'check-citations', title: 'Citation checker', path: `tools/${TOOL}/tool.yaml` },
        { uid: null, kind: 'presets', slug: null, title: null, path: 'presets/models.yaml' },
      ],
      rubric: () => ({ dimensions: [] }),
      tool: (uid: string) =>
        uid === MODEL_TOOL
          ? { uid, commit: 'c', tool: { uid, slug: 'harness', capabilities: [{ name: 'model', scope: 'invoke' }] }, dir: '/tmp' }
          : { uid, commit: 'c', tool: { uid, slug: 'gh', capabilities: [{ name: 'github', scope: 'read' }] }, dir: '/tmp' },
      validateChanges: () => ({ ok: true, errors: [], warnings: [] }),
      propose: (o: any) => ({ proposal_id: 'prop_1', head_commit: 'h1', diff: 'patch', changes: o.changes.map((c: any) => ({ path: c.path, status: 'modified' })) }),
      amendProposal: (id: string) => ({ proposal_id: id }),
    }),
    toolbox: () =>
      fake('toolbox', calls, {
        invoke: (inv: any) => ({ output: { echoed: inv.input }, logs: [], execution_key: 'k', replayed: false, cost_units: 0, duration_ms: 1 }),
        ci: () => ({ ok: false, errors: ['src/index.ts: Unexpected token'], warnings: [] }),
      }),
    broker: fake('broker', calls, { fetch: () => ({ status: 200, headers: {}, body: 'ok' }) }),
    gateway: fake('gateway', calls, {
      complete: () => ({ model_id: 'm-1', provider: 'mock', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 }, cost_usd: 0.01, latency_ms: 5, fallback_from: null }),
    }),
    db: f.db,
    log: f.log,
  };
  return createPrimitives(deps);
}

beforeAll(async () => {
  f = await createFoundation();
});
afterAll(async () => f.close());
beforeEach(() => {
  calls = [];
  events = [];
  prims = build();
});

const callsTo = (svc: string, method: string) => calls.filter((c) => c.svc === svc && c.method === method);
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as BreadboardError).code ?? 'unknown';
  }
}

describe('primitives catalog', () => {
  it('covers every ctx primitive in sandbox-runtime/context.ts, by exact name', () => {
    const src = readFileSync(fileURLToPath(new URL('../../../sandbox-runtime/src/context.ts', import.meta.url)), 'utf8');
    const ctxNames = [...src.matchAll(/call\('([a-z_]+)'/g)].map((m) => m[1]!);
    expect(ctxNames.length).toBeGreaterThanOrEqual(18);
    for (const n of ctxNames) expect(prims.names).toContain(n);
  });

  it('covers the [11] §4 MCP core catalog', () => {
    const mcpCatalog = ['create_task', 'find_similar_tasks', 'create_artifact', 'update_artifact', 'add_comment', 'emit_edge', 'tag_need_input', 'resolve_need_input', 'query_knowledge', 'read_note', 'propose_note_edit', 'run_circuit', 'get_session_summary', 'record_score', 'get_rubric', 'propose_config_change', 'read_config', 'search_config', 'validate_config', 'get_fixture_output'];
    for (const n of mcpCatalog) expect(prims.names).toContain(n);
  });

  it('every spec has a description and an object input schema', () => {
    for (const n of prims.names) {
      const s = prims.spec(n);
      expect(s.description.length).toBeGreaterThan(20);
      expect(s.input_schema.type).toBe('object');
    }
  });
});

describe('call: dispatch, validation, gating', () => {
  it('unknown primitive → not-found', async () => {
    expect(await codeOf(prims.call('nope', {}, f.memberPrincipal))).toBe('not-found');
  });

  it('invalid args → validation-failed', async () => {
    expect(await codeOf(prims.call('create_artifact', { title: 'x' }, f.memberPrincipal))).toBe('validation-failed');
    expect(await codeOf(prims.call('read_node', { uid: 'X', bogus: 1 }, f.memberPrincipal))).toBe('validation-failed');
    expect(await codeOf(prims.call('emit_edge', { type: 'produces', src: 'a', dst: 'b' }, f.memberPrincipal))).toBe('validation-failed');
    expect(callsTo('content', 'emitEdge')).toHaveLength(0);
  });

  it('create_artifact passes session/step context and returns the ref', async () => {
    const out = await prims.call('create_artifact', { title: 'Report', body: '# r', tags: ['deliverable'] }, f.memberPrincipal, { session_id: 'S1', step_id: 'write' });
    expect(out).toEqual({ uid: 'ART00000000000000001', revision_id: 1 });
    const c = callsTo('content', 'createArtifact')[0]!.args[0];
    expect(c).toMatchObject({ title: 'Report', session_id: 'S1', step_id: 'write', by: f.memberPrincipal });
  });

  it('read_node returns head or a pinned revision', async () => {
    expect(await prims.call('read_node', { uid: 'N' }, f.memberPrincipal)).toMatchObject({ uid: 'N', markdown: '# hi', revision_id: 2 });
    expect(await prims.call('read_node', { uid: 'N', revision_id: 1 }, f.memberPrincipal)).toMatchObject({ uid: 'N', body: 'old', revision_id: 1, head_revision: 2, properties: { a: 1 } });
  });

  it('add_comment surfaces typed anchor failures', async () => {
    expect(await codeOf(prims.call('add_comment', { target: 'N', body: 'hm', anchor: { quote: 'missing' } }, f.memberPrincipal))).toBe('anchor-not-found');
    expect(await prims.call('add_comment', { target: 'N', body: 'hm', anchor: { quote: 'here' } }, f.memberPrincipal)).toEqual({ uid: 'CMT00000000000000001', anchor_status: 'resolved' });
  });

  it('subagents may only call granted primitives (read_node always)', async () => {
    const p = subagentPrincipal(f, grants({ primitives: ['create_artifact'] }));
    expect(await codeOf(prims.call('create_task', { title: 't', body: 'b' }, p))).toBe('grant-denied');
    expect(callsTo('tasks', 'create')).toHaveLength(0);
    expect(await codeOf(prims.call('read_node', { uid: 'N' }, p))).toBe('ok');
    expect(await codeOf(prims.call('create_artifact', { title: 't', body: 'b' }, p))).toBe('ok');

    const granted = subagentPrincipal(f, grants({ primitives: ['create_task'] }));
    expect(await prims.call('create_task', { title: 't', body: 'b', draft: true }, granted)).toEqual({ uid: 'TSK00000000000000001', status: 'draft' });
  });

  it('create_task from an idea-shaping (intake) session makes a draft unless told otherwise', async () => {
    const shaper = subagentPrincipal(f, grants({ primitives: ['create_task'] }), { session_id: 'sess_intake' });
    expect(await prims.call('create_task', { title: 't', body: 'b' }, shaper, { session_id: 'sess_intake' })).toMatchObject({ status: 'draft' });
    expect(await prims.call('create_task', { title: 't', body: 'b', draft: false }, shaper, { session_id: 'sess_intake' })).toMatchObject({ status: 'queued' });
    expect(await prims.call('create_task', { title: 't', body: 'b' }, shaper, { session_id: 'sess_other' })).toMatchObject({ status: 'queued' });
  });

  it('step tools_override narrows the subagent surface', async () => {
    const p = subagentPrincipal(f, grants({ primitives: ['create_artifact', 'create_task'], override: ['create_task'] }));
    expect(await codeOf(prims.call('create_artifact', { title: 't', body: 'b' }, p))).toBe('grant-denied');
    expect(await codeOf(prims.call('create_task', { title: 't', body: 'b' }, p))).toBe('ok');
  });

  it('service-token scopes are enforced', async () => {
    const svc: Principal = { ...f.servicePrincipal, scopes: ['tasks:write'], token_kind: 'service' };
    expect(await codeOf(prims.call('create_task', { title: 't', body: 'b' }, svc))).toBe('ok');
    expect(await codeOf(prims.call('create_artifact', { title: 't', body: 'b' }, svc))).toBe('forbidden');
  });
});

describe('run_circuit', () => {
  it('requires an execute grant for subagent principals', async () => {
    const p = subagentPrincipal(f, grants({ primitives: ['run_circuit'], execute: [OTHER_CIRCUIT] }));
    expect(await codeOf(prims.call('run_circuit', { circuit: CIRCUIT, input: {} }, p))).toBe('grant-denied');
    expect(callsTo('orchestrator', 'enqueue')).toHaveLength(0);
  });

  it('wait path enqueues a child session and returns exit/output from session-completed', async () => {
    events = [
      { session_id: 'sess_child', seq: 1, event_type: 'session-started', step_id: null, payload: {}, created_at: '' },
      { session_id: 'sess_child', seq: 2, event_type: 'session-completed', step_id: null, payload: { exit: 'done', output: { answer: 42 } }, created_at: '' },
    ];
    const p = subagentPrincipal(f, grants({ primitives: ['run_circuit'], execute: [CIRCUIT] }));
    const out = await prims.call('run_circuit', { circuit: CIRCUIT, input: { q: 1 } }, p, { session_id: 'sess_parent', step_id: 'gather' });
    expect(out).toEqual({ session_id: 'sess_child', state: 'completed', exit: 'done', output: { answer: 42 } });
    const enq = callsTo('orchestrator', 'enqueue')[0]!.args[0];
    expect(enq).toMatchObject({ circuit_uid: CIRCUIT, input: { q: 1 }, parent_session: 'sess_parent', parent_step_id: 'gather', created_by: p.actor });
    expect(callsTo('orchestrator', 'waitFor')).toHaveLength(1);
  });

  it('wait: false returns immediately', async () => {
    const out = await prims.call('run_circuit', { circuit: CIRCUIT, input: {}, wait: false }, f.memberPrincipal);
    expect(out).toEqual({ session_id: 'sess_child', state: 'queued' });
    expect(callsTo('orchestrator', 'waitFor')).toHaveLength(0);
  });

  it('enforces the composition depth cap', async () => {
    expect(await codeOf(prims.call('run_circuit', { circuit: CIRCUIT, input: {} }, f.memberPrincipal, { depth: 8 }))).toBe('invalid-state');
  });
});

describe('get_session_summary visibility', () => {
  it('subagents see their visible sessions and children spawned from them only', async () => {
    const p = subagentPrincipal(f, grants({ primitives: ['get_session_summary'] }));
    expect(await codeOf(prims.call('get_session_summary', { session_id: 'sess_parent' }, p))).toBe('ok');
    expect(await codeOf(prims.call('get_session_summary', { session_id: 'sess_child' }, p))).toBe('ok');
    expect(await codeOf(prims.call('get_session_summary', { session_id: 'sess_other' }, p))).toBe('grant-denied');
    expect(await codeOf(prims.call('get_session_summary', { session_id: 'sess_other' }, f.memberPrincipal))).toBe('ok');
  });
});

describe('specsFor by principal kind', () => {
  it('users/services get everything except the tool-code-only primitives', () => {
    const names = prims.specsFor(f.memberPrincipal).map((s) => s.name);
    for (const n of ['broker_fetch', 'run_tool', 'model_converse']) expect(names).not.toContain(n);
    expect(names.length).toBe(prims.names.length - 3);
    expect(prims.specsFor(f.servicePrincipal).map((s) => s.name)).toEqual(names);
  });

  it('subagents get granted primitives ∩ catalog, plus read_node, never broker_fetch', () => {
    const p = subagentPrincipal(f, grants({ primitives: ['create_artifact', 'broker_fetch', 'not_a_primitive'] }));
    expect(prims.specsFor(p).map((s) => s.name).sort()).toEqual(['create_artifact', 'read_node']);
  });

  it('tool code (code-step or execution key) gets everything', () => {
    const codeStep: Principal = { ...f.servicePrincipal, actor: { kind: 'code-step', id: TOOL, session_id: 'S' }, is_admin: false, token_kind: 'actor' };
    expect(prims.specsFor(codeStep)).toHaveLength(prims.names.length);
    const toolUnderSubagent = subagentPrincipal(f, grants(), { execution_key: 'S:step:1:0', token_kind: 'actor' });
    expect(prims.specsFor(toolUnderSubagent)).toHaveLength(prims.names.length);
  });
});

describe('broker_fetch, run_tool, config', () => {
  it('broker_fetch is not callable by the model; tool code resolves its tool from the journal', async () => {
    const model = subagentPrincipal(f, grants({ primitives: ['broker_fetch'] }));
    expect(await codeOf(prims.call('broker_fetch', { capability: 'github', request: { url: 'https://api.github.com' } }, model))).toBe('grant-denied');
    expect(await codeOf(prims.call('broker_fetch', { capability: 'github', request: { url: 'https://api.github.com' } }, f.memberPrincipal))).toBe('grant-denied');

    await f.db.query(`INSERT INTO tool_executions (execution_key, tool_uid, tool_commit, input_hash, status) VALUES ($1,$2,$3,'h','running')`, ['exec-1', TOOL, 'abc123']);
    const toolCode = subagentPrincipal(f, grants(), { execution_key: 'exec-1', token_kind: 'actor' });
    const out = await prims.call('broker_fetch', { capability: 'github', request: { url: 'https://api.github.com/repos' } }, toolCode);
    expect(out).toEqual({ status: 200, headers: {}, body: 'ok' });
    expect(callsTo('config', 'tool')[0]!.args).toEqual([TOOL, 'abc123']);
    expect(callsTo('broker', 'fetch')[0]!.args[0]).toMatchObject({ capability: 'github', execution_key: 'exec-1', tool: { uid: TOOL } });
  });

  it('model_converse: tool code declaring `model` calls the gateway and records the turn on its session', async () => {
    spentUsd = 0;
    await f.db.query(`INSERT INTO tool_executions (execution_key, tool_uid, tool_commit, input_hash, status) VALUES ($1,$2,$3,'h','running')`, ['exec-model', MODEL_TOOL, 'abc123']);
    const toolCode = subagentPrincipal(f, grants(), { execution_key: 'exec-model', token_kind: 'actor' });
    const req = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [{ name: 'run_command', input_schema: { type: 'object' } }] };
    const out = await prims.call('model_converse', req, toolCode, { session_id: 'sess_parent', step_id: 'implement#2' });
    expect(out).toMatchObject({ stop_reason: 'end_turn', model_id: 'm-1', cost_usd: 0.01, message: { content: [{ type: 'text', text: 'hello' }] } });
    expect(callsTo('gateway', 'complete')[0]!.args[0]).toMatchObject({ preset: 'medium', session_id: 'sess_parent', step_id: 'implement', tools: [{ name: 'run_command', description: 'run_command' }] });
    expect(callsTo('sessions', 'recordTurn')[0]!.args[0]).toMatchObject({ session_id: 'sess_parent', step_id: 'implement', attempt: 2, role: 'assistant', model_id: 'm-1', cost_usd: 0.01, tokens_in: 10, tokens_out: 2 });
    // Never for the model or users; never for tools that did not declare the capability; never past the budget.
    expect(await codeOf(prims.call('model_converse', req, subagentPrincipal(f, grants({ primitives: ['model_converse'] }))))).toBe('grant-denied');
    expect(await codeOf(prims.call('model_converse', req, f.memberPrincipal))).toBe('grant-denied');
    await f.db.query(`INSERT INTO tool_executions (execution_key, tool_uid, tool_commit, input_hash, status) VALUES ($1,$2,$3,'h','running') ON CONFLICT DO NOTHING`, ['exec-1', TOOL, 'abc123']);
    const plainTool = subagentPrincipal(f, grants(), { execution_key: 'exec-1', token_kind: 'actor' });
    expect(await codeOf(prims.call('model_converse', req, plainTool, { session_id: 'sess_parent' }))).toBe('grant-denied');
    spentUsd = 1;
    expect(await codeOf(prims.call('model_converse', req, toolCode, { session_id: 'sess_parent' }))).toBe('budget-exceeded');
    spentUsd = 0;
  });

  it('run_tool increments depth and returns the tool output', async () => {
    const toolCode = subagentPrincipal(f, grants(), { execution_key: 'exec-1', token_kind: 'actor' });
    expect(await prims.call('run_tool', { tool: TOOL, input: { a: 1 } }, toolCode, { session_id: 'S', depth: 2 })).toEqual({ echoed: { a: 1 } });
    expect(callsTo('toolbox', 'invoke')[0]!.args[0]).toMatchObject({ tool_uid: TOOL, depth: 3, ambient: { invocation: 'tool-call' } });
    expect(await codeOf(prims.call('run_tool', { tool: TOOL, input: {} }, f.memberPrincipal))).toBe('grant-denied');
  });

  it('read_config: circuits need a read/execute grant for subagents; tools are readable', async () => {
    const p = subagentPrincipal(f, grants({ primitives: ['read_config'], read: [OTHER_CIRCUIT] }));
    expect(await codeOf(prims.call('read_config', { ref: CIRCUIT }, p))).toBe('grant-denied');
    expect(await codeOf(prims.call('read_config', { ref: OTHER_CIRCUIT }, p))).toBe('ok');
    expect(await codeOf(prims.call('read_config', { ref: TOOL }, p))).toBe('ok');
    // Looked up leniently (slugs too); a circuit reached by slug still needs the grant.
    expect(await codeOf(prims.call('read_config', { ref: 'lit-review' }, p))).toBe('grant-denied');
    expect(callsTo('config', 'definition').at(-1)!.args).toEqual(['lit-review', undefined, { lenient: true }]);
    const granted = subagentPrincipal(f, grants({ primitives: ['read_config'], read: [CIRCUIT] }));
    expect(await prims.call('read_config', { ref: 'lit-review' }, granted)).toMatchObject({ uid: CIRCUIT, kind: 'circuit' });
  });

  it('search_config: metadata of every kind, filtered and capped, with no circuit grant needed', async () => {
    const p = subagentPrincipal(f, grants({ primitives: ['search_config'] }));
    const all = (await prims.call('search_config', {}, p)) as any;
    expect(all.total).toBe(3);
    expect(all.entries.map((e: any) => e.uid)).toEqual([CIRCUIT, TOOL, null]);
    expect(callsTo('config', 'search').at(-1)!.args[0]).toBe('');
    expect(await prims.call('search_config', { q: 'cit', kind: 'tool', limit: 1 }, p)).toEqual({
      total: 1,
      entries: [{ uid: TOOL, kind: 'tool', slug: 'check-citations', title: 'Citation checker', path: `tools/${TOOL}/tool.yaml` }],
    });
    expect(callsTo('config', 'search').at(-1)!.args[0]).toBe('cit');
    expect(((await prims.call('search_config', { limit: 2 }, p)) as any).entries).toHaveLength(2);
    expect(await codeOf(prims.call('search_config', { kind: 'rubric' }, p))).toBe('validation-failed');
    expect(await codeOf(prims.call('search_config', { limit: 0 }, p))).toBe('validation-failed');
    expect(await codeOf(prims.call('search_config', {}, subagentPrincipal(f, grants({ primitives: ['read_config'] }))))).toBe('grant-denied');
  });

  it('propose_config_change opens or amends a proposal with the session id', async () => {
    const p = subagentPrincipal(f, grants({ primitives: ['propose_config_change'] }));
    const changes = [{ path: 'config/tenets.md', content: 'be kind' }];
    const opened = (await prims.call('propose_config_change', { changes, message: 'tenet' }, p, { session_id: 'sess_parent' })) as any;
    expect(opened).toMatchObject({ proposal_id: 'prop_1', review: expect.stringContaining('/proposals/prop_1') });
    expect(opened.diff).toBeUndefined(); // the caller wrote the changes; later turns should not carry the patch
    expect(opened.tool_checks).toBeUndefined();
    expect(callsTo('config', 'propose')[0]!.args[0]).toMatchObject({ changes, message: 'tenet', session_id: 'sess_parent', by: p });
    expect(await prims.call('propose_config_change', { changes, message: 'again', proposal_id: 'prop_9' }, p)).toMatchObject({ proposal_id: 'prop_9' });
    expect(await codeOf(prims.call('propose_config_change', { changes, message: 'x' }, subagentPrincipal(f, grants())))).toBe('grant-denied');
  });

  it('propose_config_change reports tool CI for the tools it changes', async () => {
    const p = subagentPrincipal(f, grants({ primitives: ['propose_config_change'] }));
    const changes = [{ path: `tools/${TOOL}/src/index.ts`, content: 'export const handler = (' }];
    const r = (await prims.call('propose_config_change', { changes, message: 'fix' }, p, { session_id: 'sess_parent' })) as any;
    expect(r.tool_checks).toEqual([{ uid: TOOL, ok: false, errors: ['src/index.ts: Unexpected token'], warnings: [] }]);
    expect(callsTo('toolbox', 'ci').at(-1)!.args).toEqual([TOOL, 'h1']);
  });
});
