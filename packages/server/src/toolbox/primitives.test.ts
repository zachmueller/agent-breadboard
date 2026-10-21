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

function grants(over: Partial<{ primitives: string[]; execute: string[]; read: string[]; repos: string[]; override: string[] | null }> = {}): Grants {
  return {
    subagent_uid: SUBAGENT,
    tools: new Map(),
    mcp: new Map(),
    circuits: { read: new Set(over.read ?? []), execute: new Set(over.execute ?? []) },
    knowledge: { read: new Set(['eng']), write: new Set() },
    primitives: new Set(over.primitives ?? []),
    repos: new Set(over.repos ?? []),
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
      tagNeedInput: (i: any) => {
        if (i.role === 'nope') throw new BreadboardError('validation-failed', "unknown review role 'nope'");
        return { request_id: 'nir_1' };
      },
      resolveNeedInput: () => ({ resolved: {}, remaining_open: 0 }),
    }),
    knowledge: fake('knowledge', calls, {
      search: () => [{ uid: 'N1', title: 'n', snippet: 's', score: 1, domains: ['eng'], tags: [], source: 'text' }],
      readNote: (uid: string) => ({ uid, title: 'n', markdown: '# n', base_revision: 3, domains: ['eng'], read_only: false, tags: [], properties: {} }),
      proposeEdit: () => ({ applied: true, had_concurrent_edits: false, merged_markdown: '# m', new_head_revision: 5, pre_ai_edit_revision: 4, blocks_changed: 1 }),
      createNote: (i: any) => ({ uid: 'NTE00000000000000001', title: i.title, revision_id: 1, possible_duplicates: [{ uid: 'NTE00000000000000002', title: 'Old', score: 0.9 }] }),
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
      cost: () => ({ cost_usd: spentUsd, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0 }),
      costIncludingChildren: () => spentUsd,
      recordTurn: (t: any) => ({ ...t, turn_id: 'trn_1', created_at: '' }),
    }),
    evals: fake('evals', calls, { recordScore: () => undefined, getFixtureOutput: () => ({ out: 1 }) }),
    config: fake('config', calls, {
      definition: (ref: string, _at?: string, opts?: { lenient?: boolean }) => {
        // A path to any file under a definition resolves to the definition, as the real lookup does.
        const uid = opts?.lenient && ref === 'lit-review' ? CIRCUIT : (/^(?:tools|circuits)\/([^/]+)\//.exec(ref)?.[1] ?? ref);
        const kind = uid.startsWith('01J8FQ2ZK7XW9MBT4PV') && uid !== TOOL ? 'circuit' : 'tool';
        const path = kind === 'circuit' ? `circuits/${uid}/circuit.yaml` : `tools/${uid}/tool.yaml`;
        const files = kind === 'circuit' ? { 'prompts/draft.md': 'Draft {{input.q}}' } : { 'src/index.ts': 'export const handler = () => 1;' };
        return { uid, kind, path, commit: 'c0ffee1234567890', slug: 's', title: 't', definition: {}, raw: 'raw', files, validation: { ok: true, errors: [], warnings: [] }, referenced_by: [] };
      },
      search: () => [
        { uid: CIRCUIT, kind: 'circuit', slug: 'lit-review', title: 'Literature review', path: `circuits/${CIRCUIT}/circuit.yaml` },
        { uid: TOOL, kind: 'tool', slug: 'check-citations', title: 'Citation checker', path: `tools/${TOOL}/tool.yaml` },
        { uid: null, kind: 'presets', slug: null, title: null, path: 'presets/models.yaml' },
      ],
      tree: () => [
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
    gateway: (() => {
      // `providers` / `fallbackEvents` are synchronous in the real gateway, so they sit beside the recording fake.
      const gw = fake<Pick<PrimitivesDeps['gateway'], 'complete'>>('gateway', calls, {
        complete: () => ({ model_id: 'm-1', provider: 'mock', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 500 }, cost_usd: 0.01, latency_ms: 5, fallback_from: null }),
      });
      return { complete: (req) => gw.complete(req), providers: () => ['mock'], fallbackEvents: () => [] } as PrimitivesDeps['gateway'];
    })(),
    db: f.db,
    log: f.log,
    team_id: f.team_id,
    identity: fake('identity', calls, {
      listUsers: () => [
        { user_id: 'U1', team_id: f.team_id, handle: 'zach', display_name: 'Zach', oidc_subject: null, is_admin: true, created_at: '', deactivated_at: null },
        { user_id: 'U2', team_id: f.team_id, handle: 'gone', display_name: 'Gone', oidc_subject: null, is_admin: false, created_at: '', deactivated_at: '2026-01-01T00:00:00Z' },
      ],
      rolesOfUser: (id: string) => (id === 'U1' ? ['scientist'] : []),
    }),
    events: fake('events', calls, {
      replay: () => [
        { id: 'e1', topic: 'session.state', at: '', payload: { session_id: 'sess_1' }, visibility: { scope: 'team' } },
        { id: 'e2', topic: 'task.status', at: '', payload: {}, visibility: { scope: 'session', session_id: 'sess_hidden' } },
      ],
      visibleTo: (e: any) => e.visibility.scope === 'team',
    }),
    conversations: () => fake('conversations', calls, { proposals: () => ['prp_1'], busy: () => false, draftTask: () => null }),
    dispatcher: () => fake('dispatcher', calls, { capacity: () => ({ running: 1, max_concurrent_runs: 4, spend_last_hour_usd: 0.5, max_spend_usd_per_hour: 25, queued: 2 }) }),
    connectors: () => fake('connectors', calls, { status: () => [] }),
    mirrors: () => fake('mirrors', calls, { status: async () => [], search: async (a: unknown) => ({ searched: a }), read: async (a: unknown) => ({ read: a }) }),
    instance: { name: 'agent-breadboard', version: 'test', db: 'pglite', sandbox: 'process', public_url: 'http://localhost:4000' },
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
    const mcpCatalog = ['create_task', 'find_similar_tasks', 'create_artifact', 'update_artifact', 'add_comment', 'emit_edge', 'tag_need_input', 'resolve_need_input', 'query_knowledge', 'read_note', 'propose_note_edit', 'create_note', 'run_circuit', 'get_session_summary', 'record_score', 'get_rubric', 'propose_config_change', 'read_config', 'search_config', 'validate_config', 'get_fixture_output'];
    for (const n of mcpCatalog) expect(prims.names).toContain(n);
  });

  it('covers the [11] §4 inspection catalog', () => {
    const inspection = ['whoami', 'get_breadboard_overview', 'list_users', 'list_sessions', 'read_session_transcript', 'read_session_events', 'list_session_executions', 'search_nodes', 'inspect_node', 'get_review_queue', 'get_config_history', 'list_proposals', 'read_proposal', 'diff_config', 'list_knowledge_domains', 'list_eval_runs', 'read_eval_run', 'get_eval_analysis', 'list_recent_events'];
    for (const n of inspection) expect(prims.names).toContain(n);
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

  it('create_note passes session/step context, queues the note for review and returns its base revision', async () => {
    const p = subagentPrincipal(f, grants({ primitives: ['create_note'] }));
    const out = await prims.call('create_note', { title: 'Runbook', markdown: '# r', domains: ['eng'], review: { role: 'scientist' } }, p, { session_id: 'S1', step_id: 'write' });
    expect(out).toEqual({ uid: 'NTE00000000000000001', base_revision: 1, domains: ['eng'], review_request_id: 'nir_1', possible_duplicates: [{ uid: 'NTE00000000000000002', title: 'Old', score: 0.9 }] });
    expect(callsTo('knowledge', 'createNote')[0]!.args[0]).toMatchObject({ title: 'Runbook', domains: ['eng'], session_id: 'S1', step_id: 'write', by: p });
    expect(callsTo('content', 'tagNeedInput')[0]!.args[0]).toMatchObject({ uid: 'NTE00000000000000001', role: 'scientist', username: null, by: p });
  });

  it('create_note falls back to an untargeted review request when the target is invalid', async () => {
    const out = (await prims.call('create_note', { title: 'R', markdown: '# r', domains: ['eng'], review: { role: 'nope' } }, f.memberPrincipal)) as any;
    expect(out.review_request_id).toBe('nir_1');
    expect(out.review_warning).toMatch(/unknown review role 'nope'.*untargeted/);
    expect(callsTo('content', 'tagNeedInput').map((c) => c.args[0].role)).toEqual(['nope', null]);
    expect(callsTo('knowledge', 'createNote')).toHaveLength(1);
  });

  it('create_note needs at least one domain and the primitive grant', async () => {
    expect(await codeOf(prims.call('create_note', { title: 'R', markdown: '# r', domains: [] }, f.memberPrincipal))).toBe('validation-failed');
    expect(await codeOf(prims.call('create_note', { title: 'R', markdown: '# r', domains: ['eng'] }, subagentPrincipal(f, grants({ primitives: ['propose_note_edit'] }))))).toBe('grant-denied');
    expect(callsTo('knowledge', 'createNote')).toHaveLength(0);
  });

  it('propose_note_edit passes session/step context for lineage', async () => {
    const p = subagentPrincipal(f, grants({ primitives: ['propose_note_edit'] }));
    await prims.call('propose_note_edit', { uid: 'N', base_revision: 3, markdown: '# m' }, p, { session_id: 'S1', step_id: 'edit' });
    expect(callsTo('knowledge', 'proposeEdit')[0]!.args[0]).toMatchObject({ uid: 'N', session_id: 'S1', step_id: 'edit' });
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

describe('repository primitives', () => {
  it('are offered to subagents with the primitive grant and pass the caller through to the mirrors', async () => {
    const without = subagentPrincipal(f, grants({ primitives: ['create_artifact'] }));
    expect(await codeOf(prims.call('search_repo', { pattern: 'x' }, without))).toBe('grant-denied');
    expect(prims.specsFor(without).map((s) => s.name)).not.toContain('search_repo');
    const granted = subagentPrincipal(f, grants({ primitives: ['search_repo', 'read_repo_file'], repos: ['demo'] }));
    expect(prims.specsFor(granted).map((s) => s.name)).toEqual(expect.arrayContaining(['search_repo', 'read_repo_file']));
    expect(await prims.call('search_repo', { repo: 'demo', pattern: 'x', paths: ['src'] }, granted)).toEqual({ searched: { repo: 'demo', pattern: 'x', paths: ['src'] } });
    expect(await prims.call('read_repo_file', { repo: 'demo', path: 'a.md' }, granted)).toEqual({ read: { repo: 'demo', path: 'a.md' } });
    const call = callsTo('mirrors', 'search')[0]!;
    expect(call.args[1]).toBe(granted);
    expect(await codeOf(prims.call('search_repo', { pattern: 'x', bogus: 1 }, granted))).toBe('validation-failed');
  });

  it('need knowledge:read on scoped tokens; members can call them', async () => {
    const svc: Principal = { ...f.servicePrincipal, scopes: ['tasks:write'], token_kind: 'service' };
    expect(await codeOf(prims.call('search_repo', { pattern: 'x' }, svc))).toBe('forbidden');
    const reader: Principal = { ...f.servicePrincipal, scopes: ['knowledge:read'], token_kind: 'service' };
    expect(await codeOf(prims.call('search_repo', { pattern: 'x' }, reader))).toBe('ok');
    expect(await codeOf(prims.call('read_repo_file', {}, f.memberPrincipal))).toBe('ok');
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
    const req = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [{ name: 'run_command', input_schema: { type: 'object' } }], effort: 'high', force_tool: 'run_command' };
    const out = await prims.call('model_converse', req, toolCode, { session_id: 'sess_parent', step_id: 'implement#2' });
    expect(out).toMatchObject({ stop_reason: 'end_turn', model_id: 'm-1', cost_usd: 0.01, message: { content: [{ type: 'text', text: 'hello' }] } });
    expect(callsTo('gateway', 'complete')[0]!.args[0]).toMatchObject({ preset: 'medium', session_id: 'sess_parent', step_id: 'implement', tools: [{ name: 'run_command', description: 'run_command' }], effort: 'high', force_tool: 'run_command' });
    expect(callsTo('sessions', 'recordTurn')[0]!.args[0]).toMatchObject({ session_id: 'sess_parent', step_id: 'implement', attempt: 2, role: 'assistant', model_id: 'm-1', cost_usd: 0.01, tokens_in: 10, tokens_out: 2, tokens_cache_read: 500 });
    expect(out).toMatchObject({ usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 500 } });
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

  it('read_config: a path to one file of a tool or circuit returns just that file', async () => {
    const p = subagentPrincipal(f, grants({ primitives: ['read_config'], read: [OTHER_CIRCUIT] }));
    expect(await prims.call('read_config', { ref: `tools/${TOOL}/src/index.ts` }, p)).toEqual({
      path: `tools/${TOOL}/src/index.ts`,
      commit: 'c0ffee1234567890',
      owner: { uid: TOOL, kind: 'tool', slug: 's', title: 't', path: `tools/${TOOL}/tool.yaml` },
      text: 'export const handler = () => 1;',
    });
    // The definition file itself (and a bare UID) still returns the whole definition.
    expect(await prims.call('read_config', { ref: `tools/${TOOL}/tool.yaml` }, p)).toMatchObject({ uid: TOOL, raw: 'raw', files: { 'src/index.ts': expect.any(String) } });
    expect(await prims.call('read_config', { ref: `circuits/${OTHER_CIRCUIT}/prompts/draft.md` }, p)).toMatchObject({ path: `circuits/${OTHER_CIRCUIT}/prompts/draft.md`, text: 'Draft {{input.q}}' });
    const miss = (await prims.call('read_config', { ref: `tools/${TOOL}/src/main.ts` }, p).catch((e: Error) => e)) as Error;
    expect(miss).toMatchObject({ code: 'not-found' });
    expect(miss.message).toMatch(/no file 'src\/main\.ts' in tool s at c0ffee123456; its files: src\/index\.ts, tool\.yaml/);
    // A circuit's files need the same grant as the circuit.
    expect(await codeOf(prims.call('read_config', { ref: `circuits/${CIRCUIT}/prompts/draft.md` }, p))).toBe('grant-denied');
  });

  it('search_config: metadata of every kind, filtered and capped, with no circuit grant needed', async () => {
    const p = subagentPrincipal(f, grants({ primitives: ['search_config'] }));
    const all = (await prims.call('search_config', {}, p)) as any;
    expect(all.total).toBe(3);
    expect(all.entries.map((e: any) => e.uid)).toEqual([CIRCUIT, TOOL, null]);
    expect(callsTo('config', 'search').at(-1)!.args[0]).toBe('');
    expect(await prims.call('search_config', { q: 'cit', kind: 'tool', limit: 1 }, p)).toEqual({
      total: 1,
      offset: 0,
      next_offset: null,
      entries: [{ uid: TOOL, kind: 'tool', slug: 'check-citations', title: 'Citation checker', path: `tools/${TOOL}/tool.yaml` }],
    });
    expect(callsTo('config', 'search').at(-1)!.args[0]).toBe('cit');
    // Pages with `offset` / `next_offset`, like the other list tools.
    expect(await prims.call('search_config', { limit: 2 }, p)).toMatchObject({ total: 3, offset: 0, next_offset: 2, entries: [{ uid: CIRCUIT }, { uid: TOOL }] });
    expect(await prims.call('search_config', { limit: 2, offset: 2 }, p)).toMatchObject({ total: 3, offset: 2, next_offset: null, entries: [{ uid: null }] });
    expect(await prims.call('search_config', { offset: 5 }, p)).toMatchObject({ total: 3, next_offset: null, entries: [] });
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

describe('inspection primitives', () => {
  const readOnly = (): Principal => ({ ...f.memberPrincipal, scopes: ['tasks:read', 'nodes:read', 'sessions:read', 'config:read', 'knowledge:read', 'evals:read', 'events:read', 'mcp:call'], token_kind: 'personal' });

  it('whoami describes the principal, including read-only tokens', async () => {
    expect(await prims.call('whoami', {}, f.memberPrincipal)).toMatchObject({ user: { handle: 'member' }, roles: ['scientist'], is_admin: false, token_kind: 'user', scopes: null, read_only: false });
    expect(await prims.call('whoami', {}, readOnly())).toMatchObject({ token_kind: 'personal', read_only: true });
    expect(await prims.call('whoami', {}, { ...f.servicePrincipal, scopes: ['tasks:write'] })).toMatchObject({ user: null, read_only: false });
  });

  it('a scoped token lists only the primitives its scopes allow', async () => {
    const listed = (p: Principal) => prims.specsFor(p).map((s) => s.name);
    const ro = listed(readOnly());
    expect(ro).toEqual(expect.arrayContaining(['whoami', 'search_config', 'read_config', 'read_node', 'list_sessions']));
    for (const write of ['create_task', 'add_comment', 'create_artifact', 'propose_config_change', 'run_circuit']) expect(ro).not.toContain(write);
    // An unscoped principal sees the writes; a write scope implies its read.
    expect(listed(f.memberPrincipal)).toEqual(expect.arrayContaining(['create_task', 'add_comment']));
    const writer = listed({ ...f.servicePrincipal, scopes: ['tasks:write'] });
    expect(writer).toEqual(expect.arrayContaining(['create_task']));
    expect(writer).not.toContain('add_comment');
  });

  it('list_users hides deactivated users unless asked, and carries roles', async () => {
    const r = (await prims.call('list_users', {}, f.memberPrincipal)) as any;
    expect(r.users).toEqual([{ user_id: 'U1', handle: 'zach', display_name: 'Zach', is_admin: true, created_at: '', deactivated_at: null, roles: ['scientist'] }]);
    expect(((await prims.call('list_users', { include_deactivated: true, include_roles: false }, f.memberPrincipal)) as any).users.map((u: any) => [u.handle, u.roles])).toEqual([['zach', undefined], ['gone', undefined]]);
  });

  it('get_breadboard_overview assembles the dashboard, config counts and capacity', async () => {
    const r = (await prims.call('get_breadboard_overview', {}, f.memberPrincipal)) as any;
    expect(r.instance).toMatchObject({ name: 'agent-breadboard', providers: ['mock'], public_url: 'http://localhost:4000' });
    expect(r.capacity).toMatchObject({ running: 1, queued: 2, max_concurrent_runs: 4 });
    expect(r.config.definitions).toEqual({ circuit: 1, tool: 1, presets: 1 });
    // Panels that fail (the fakes lack these methods) degrade to null instead of failing the call.
    expect(r.open_proposals).toBeNull();
    expect(r.sessions).toEqual({ gated: 0, suspended_error: 0, running: 0, queued: 0 });
    expect(r.repos).toEqual([]);
    expect(callsTo('mirrors', 'status')[0]!.args[0]).toBe(f.memberPrincipal);
  });

  it('list_sessions maps `me`, filters by visibility and adds cost including children', async () => {
    let listed: any = null;
    const sessionsFake = fake<PrimitivesDeps['sessions']>('sessions', calls, {
      list: (filter: any) => {
        listed = filter;
        return { items: [session('sess_parent', 'running'), session('sess_other', 'completed')], next_cursor: 'c2' };
      },
      costIncludingChildren: () => 0.25,
    });
    const p2 = createPrimitives({ ...(prims as any).deps, sessions: sessionsFake });
    const r = (await p2.call('list_sessions', { kind: ['circuit-run'], created_by: 'me', limit: 5 }, f.memberPrincipal)) as any;
    expect(listed).toMatchObject({ kind: ['circuit-run'], created_by: f.member.user_id, limit: 5, cursor: null });
    expect(r.sessions.map((s: any) => [s.session_id, s.cost_usd])).toEqual([
      ['sess_parent', 0.25],
      ['sess_other', 0.25],
    ]);
    expect(r.next_cursor).toBe('c2');
    // A subagent sees only its family.
    const sub = subagentPrincipal(f, grants({ primitives: ['list_sessions'] }));
    expect(((await p2.call('list_sessions', {}, sub)) as any).sessions.map((s: any) => s.session_id)).toEqual(['sess_parent']);
    expect(await codeOf(prims.call('list_sessions', { state: ['bogus'] }, f.memberPrincipal))).toBe('validation-failed');
  });

  it('read_session_transcript renders blocks, clips long text, and reads one turn in full', async () => {
    const long = 'x'.repeat(5000);
    const turns = [
      { turn_id: 'trn_1', session_id: 'sess_parent', step_id: 'gather', attempt: 1, role: 'user', username: 'zach', content: 'Find papers', model_id: null, tokens_in: null, tokens_out: null, cost_usd: null, created_at: '', latency_ms: null, fallback_from: null },
      { turn_id: 'trn_2', session_id: 'sess_parent', step_id: 'gather', attempt: 1, role: 'assistant', username: null, content: [{ type: 'text', text: long }, { type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'crdt' } }], model_id: 'm-1', tokens_in: 10, tokens_out: 5, cost_usd: 0.01, created_at: '', latency_ms: 12, fallback_from: null },
      { turn_id: 'trn_3', session_id: 'sess_parent', step_id: 'gather', attempt: 1, role: 'tool', username: null, content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false }], model_id: null, tokens_in: null, tokens_out: null, cost_usd: null, created_at: '', latency_ms: null, fallback_from: null },
    ];
    let asked: any[] = [];
    const sessionsFake = fake<PrimitivesDeps['sessions']>('sessions', calls, {
      get: (id: string) => (id === 'sess_parent' ? session(id, 'running') : null),
      mustGet: (id: string) => session(id, 'running', { config_commit: 'abc' }),
      turns: (...a: any[]) => {
        asked = a;
        return turns;
      },
    });
    const p2 = createPrimitives({ ...(prims as any).deps, sessions: sessionsFake });
    const r = (await p2.call('read_session_transcript', { session_id: 'sess_parent', step: 'gather#1' }, f.memberPrincipal)) as any;
    expect(asked).toEqual(['sess_parent', 'gather', 1]);
    expect(r.session).toMatchObject({ session_id: 'sess_parent', config_commit: 'abc' });
    expect(r.total_turns).toBe(3);
    expect(r.next_offset).toBeNull();
    expect(r.turns[0]).toMatchObject({ index: 0, role: 'user', username: 'zach', blocks: [{ type: 'text', text: 'Find papers' }] });
    expect(r.turns[1].blocks[0]).toEqual({ type: 'text', truncated: true, total_chars: 5000, text: 'x'.repeat(4000) });
    expect(r.turns[1].blocks[1]).toEqual({ type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'crdt' } });
    expect(r.turns[1]).toMatchObject({ model_id: 'm-1', tokens_in: 10, cost_usd: 0.01, latency_ms: 12 });
    expect(r.turns[2].blocks[0]).toEqual({ type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: 'ok' });
    // Paging and a single turn in full.
    const page = (await p2.call('read_session_transcript', { session_id: 'sess_parent', offset: 1, limit: 1 }, f.memberPrincipal)) as any;
    expect(page.turns.map((t: any) => t.turn_id)).toEqual(['trn_2']);
    expect(page.next_offset).toBe(2);
    const one = (await p2.call('read_session_transcript', { session_id: 'sess_parent', turn_id: 'trn_2' }, f.memberPrincipal)) as any;
    expect(one.turns[0].blocks[0]).toEqual({ type: 'text', text: long });
    expect(await codeOf(p2.call('read_session_transcript', { session_id: 'sess_parent', turn_id: 'trn_9' }, f.memberPrincipal))).toBe('not-found');
    expect(await codeOf(p2.call('read_session_transcript', { session_id: 'sess_parent', step: 'gather#two' }, f.memberPrincipal))).toBe('validation-failed');
    // Visibility: a subagent outside the family is refused.
    const outsider = subagentPrincipal(f, grants({ primitives: ['read_session_transcript'] }), { session_id: 'sess_x', visible_sessions: ['sess_x'] });
    expect(await codeOf(p2.call('read_session_transcript', { session_id: 'sess_parent' }, outsider))).toBe('grant-denied');
  });

  it('read_session_events skips turn events by default, filters and pages by seq', async () => {
    events = [
      { session_id: 'sess_parent', seq: 1, event_type: 'session-started', step_id: null, payload: {}, created_at: '' },
      { session_id: 'sess_parent', seq: 2, event_type: 'turn', step_id: 'gather', payload: { role: 'user' }, created_at: '' },
      { session_id: 'sess_parent', seq: 3, event_type: 'step-exited', step_id: 'gather', payload: { exit: 'done', big: 'y'.repeat(100) }, created_at: '' },
      { session_id: 'sess_parent', seq: 4, event_type: 'session-completed', step_id: null, payload: {}, created_at: '' },
    ];
    const r = (await prims.call('read_session_events', { session_id: 'sess_parent', max_chars: 40 }, f.memberPrincipal)) as any;
    expect(r.events.map((e: any) => e.event_type)).toEqual(['session-started', 'step-exited', 'session-completed']);
    expect(r.events[1].payload).toMatchObject({ truncated: true, total_chars: 124 });
    expect(r).toMatchObject({ next_seq: 4, has_more: false });
    expect(((await prims.call('read_session_events', { session_id: 'sess_parent', include_turns: true }, f.memberPrincipal)) as any).events).toHaveLength(4);
    expect(((await prims.call('read_session_events', { session_id: 'sess_parent', types: ['turn'] }, f.memberPrincipal)) as any).events.map((e: any) => e.seq)).toEqual([2]);
    expect(((await prims.call('read_session_events', { session_id: 'sess_parent', step: 'gather' }, f.memberPrincipal)) as any).events.map((e: any) => e.seq)).toEqual([3]);
    const first = (await prims.call('read_session_events', { session_id: 'sess_parent', limit: 1 }, f.memberPrincipal)) as any;
    expect(first.events.map((e: any) => e.seq)).toEqual([1]);
    expect(first.has_more).toBe(true);
    const rest = (await prims.call('read_session_events', { session_id: 'sess_parent', after_seq: first.next_seq }, f.memberPrincipal)) as any;
    expect(rest.events.map((e: any) => e.seq)).toEqual([3, 4]);
  });

  it('list_session_executions filters by step and clips output and logs', async () => {
    const rows = [
      { execution_key: 'k1', step_id: 'gather', attempt: 1, call_index: 0, tool_uid: `${TOOL}    `, tool_commit: 'c', status: 'completed', input_hash: 'h', output: { hits: 'z'.repeat(50) }, error: null, logs: [{ level: 'info', message: 'm' }], started_at: '', ended_at: '' },
      { execution_key: 'k2', step_id: 'check', attempt: 2, call_index: 0, tool_uid: TOOL, tool_commit: 'c', status: 'failed', input_hash: 'h', output: null, error: 'boom', logs: null, started_at: '', ended_at: '' },
    ];
    const p2 = createPrimitives({ ...(prims as any).deps, toolbox: () => fake('toolbox', calls, { executions: () => rows }) });
    const all = (await p2.call('list_session_executions', { session_id: 'sess_parent', max_chars: 40 }, f.memberPrincipal)) as any;
    expect(all.total).toBe(2);
    expect(all.executions[0]).toMatchObject({ tool_uid: TOOL, output: { truncated: true, total_chars: 61 }, logs: [{ level: 'info', message: 'm' }] });
    expect(all.executions[1]).toMatchObject({ status: 'failed', error: 'boom', output: null, logs: null });
    expect(((await p2.call('list_session_executions', { session_id: 'sess_parent', step: 'check#2' }, f.memberPrincipal)) as any).executions.map((e: any) => e.execution_key)).toEqual(['k2']);
    expect(((await p2.call('list_session_executions', { session_id: 'sess_parent', step: 'check#1' }, f.memberPrincipal)) as any).executions).toEqual([]);
  });

  it('search_nodes forwards filters and returns previews, not bodies', async () => {
    let filter: any = null;
    const content = fake<PrimitivesDeps['content']>('content', calls, {
      listNodes: (fl: any) => {
        filter = fl;
        return { items: [{ uid: 'N1', type: 'task', title: 'T', properties: { status: 'queued' }, body: 'b'.repeat(300), body_text: 'b'.repeat(300), crdt: false, tags: [], scope: 'team', head_revision: 1, created_at: '', created_by: { kind: 'user', id: 'u' }, updated_at: '' }], next_cursor: null };
      },
    });
    const p2 = createPrimitives({ ...(prims as any).deps, content });
    const r = (await p2.call('search_nodes', { type: 'task', status: ['queued'], q: 'crdt' }, f.memberPrincipal)) as any;
    expect(filter).toMatchObject({ type: 'task', status: ['queued'], q: 'crdt', limit: 25 });
    expect(r.nodes[0]).toMatchObject({ uid: 'N1', properties: { status: 'queued' }, body_preview: { truncated: true, total_chars: 300 } });
    expect(r.nodes[0].body).toBeUndefined();
    expect(await codeOf(p2.call('search_nodes', { type: 'rubric' }, f.memberPrincipal))).toBe('validation-failed');
  });

  it('inspect_node gathers revisions, edges, comments and lineage in one call', async () => {
    const content = fake<PrimitivesDeps['content']>('content', calls, {
      getNode: (uid: string) => ({ uid, type: 'artifact', title: 'A', properties: {}, body: '# a', body_text: '# a', crdt: false, tags: ['deliverable'], scope: 'team', head_revision: 2, created_at: '', created_by: { kind: 'subagent', id: 's' }, updated_at: '' }),
      revisions: () => [{ uid: 'A', revision_id: 2, labels: ['step-completion'], properties: {}, body: null, body_text: null, created_at: '', created_by: { kind: 'subagent', id: 's' } }],
      edges: () => [{ edge_id: 1, type: 'produces', src: 'sess_parent', dst: 'A' }],
      comments: () => [{ uid: 'C1', type: 'comment', title: '', properties: {}, body: 'nice', body_text: 'nice', crdt: false, tags: [], scope: 'team', head_revision: 1, created_at: '', created_by: { kind: 'user', id: 'u' }, updated_at: '', stale: false, anchor_status: 'resolved' }],
      lineage: (_uid: string, direction: string) => ({ root: 'A', direction, edges: [], nodes: [], sessions: [], truncated: false }),
    });
    const p2 = createPrimitives({ ...(prims as any).deps, content });
    const r = (await p2.call('inspect_node', { uid: 'A', lineage_depth: 3, revisions_limit: 5 }, f.memberPrincipal)) as any;
    expect(r.node).toMatchObject({ uid: 'A', body_preview: '# a' });
    expect(r.revisions).toEqual([{ revision_id: 2, labels: ['step-completion'], created_at: '', created_by: { kind: 'subagent', id: 's' } }]);
    expect(r.edges).toHaveLength(1);
    expect(r.comments[0]).toMatchObject({ uid: 'C1', body: 'nice', anchor_status: 'resolved' });
    expect(r.lineage.up.direction).toBe('up');
    expect(callsTo('content', 'revisions').at(-1)!.args[2]).toEqual({ limit: 5 });
    expect(callsTo('content', 'lineage').map((c) => c.args[2])).toEqual([3, 3]);
    const flat = (await p2.call('inspect_node', { uid: 'A', lineage_depth: 0 }, f.memberPrincipal)) as any;
    expect(flat.lineage).toEqual({ up: null, down: null });
  });

  it('config inspection: history resolves definitions, proposals drop the diff, diff_config clips the patch', async () => {
    const config = fake<PrimitivesDeps['config']>('config', calls, {
      definition: (ref: string) => ({ uid: ref === 'lit-review' ? CIRCUIT : TOOL, kind: ref === 'lit-review' ? 'circuit' : 'subagent', path: ref === 'lit-review' ? `circuits/${CIRCUIT}/circuit.yaml` : `subagents/${TOOL}.yaml`, commit: 'c', slug: ref, title: 't', definition: {}, raw: '', validation: { ok: true, errors: [], warnings: [] }, referenced_by: [] }),
      history: (o: any) => [{ commit: 'c1', author: 'a', date: '', message: `m ${o.path ?? 'all'}` }],
      pageProposals: () => ({ total: 3, proposals: [{ proposal_id: 'prp_1', status: 'open', diff: 'PATCH', changes: [], validation: { ok: true, errors: [], warnings: [] }, eval_runs: [] }] }),
      getProposal: (id: string) => ({ proposal_id: id, head_commit: 'h', status: 'open', diff: 'p'.repeat(100), changes: [{ path: `tools/${TOOL}/tool.yaml`, status: 'modified' }], validation: { ok: true, errors: [], warnings: [] }, eval_runs: [] }),
      diff: (base: string, head: string) => ({ patch: `${base}..${head} ${'d'.repeat(100)}`, files: [{ path: 'tenets.md', status: 'modified' }] }),
    });
    const p2 = createPrimitives({ ...(prims as any).deps, config });
    expect((await p2.call('get_config_history', { ref: 'lit-review', limit: 5 }, f.memberPrincipal)) as any).toMatchObject({ path: `circuits/${CIRCUIT}`, commits: [{ message: `m circuits/${CIRCUIT}` }] });
    expect(((await p2.call('get_config_history', { ref: 'planner' }, f.memberPrincipal)) as any).path).toBe(`subagents/${TOOL}.yaml`);
    expect(((await p2.call('get_config_history', { ref: 'config/presets/models.yaml' }, f.memberPrincipal)) as any).path).toBe('presets/models.yaml');
    expect(((await p2.call('get_config_history', {}, f.memberPrincipal)) as any).commits[0].message).toBe('m all');
    expect(callsTo('config', 'history').at(-1)!.args[0]).toEqual({ path: undefined, ref: undefined, limit: 20 });

    const proposals = (await p2.call('list_proposals', { status: 'open' }, f.memberPrincipal)) as any;
    expect(proposals.proposals[0]).toMatchObject({ proposal_id: 'prp_1' });
    expect(proposals.proposals[0].diff).toBeUndefined();
    expect(proposals).toMatchObject({ total: 3, offset: 0, next_offset: 1 });
    expect(await p2.call('list_proposals', { offset: 2 }, f.memberPrincipal)).toMatchObject({ total: 3, offset: 2, next_offset: null });
    expect(callsTo('config', 'pageProposals').at(-1)!.args[0]).toMatchObject({ limit: 50, offset: 2 });
    const one = (await p2.call('read_proposal', { proposal_id: 'prp_1', max_chars: 10 }, f.memberPrincipal)) as any;
    expect(one.diff).toEqual({ truncated: true, total_chars: 100, text: 'pppppppppp' });
    expect(one.tool_checks).toEqual([{ uid: TOOL, ok: false, errors: ['src/index.ts: Unexpected token'], warnings: [] }]);
    expect(((await p2.call('read_proposal', { proposal_id: 'prp_1', include_diff: false }, f.memberPrincipal)) as any).diff).toBeUndefined();
    const diff = (await p2.call('diff_config', { base: 'a', head: 'b', max_chars: 4 }, f.memberPrincipal)) as any;
    expect(diff).toEqual({ base: 'a', head: 'b', files: [{ path: 'tenets.md', status: 'modified' }], patch: { truncated: true, total_chars: 105, text: 'a..b' } });
  });

  it('read_config and search_config accept a commit', async () => {
    await prims.call('read_config', { ref: TOOL, commit: 'abc123' }, f.memberPrincipal);
    expect(callsTo('config', 'definition').at(-1)!.args).toEqual([TOOL, 'abc123', { lenient: true }]);
    await prims.call('search_config', { q: 'x', commit: 'abc123' }, f.memberPrincipal);
    expect(callsTo('config', 'search').at(-1)!.args).toEqual(['x', 'abc123']);
  });

  it('get_session_summary adds conversation fields for chats only', async () => {
    const sessionsFake = fake<PrimitivesDeps['sessions']>('sessions', calls, {
      get: (id: string) => session(id, 'running'),
      summary: (id: string) => ({ ...session(id, 'completed', { kind: id === 'sess_chat' ? 'conversation' : 'circuit-run', state_detail: { last_error: 'oops' } }), steps: [], cost_usd: 0 }),
    });
    const p2 = createPrimitives({ ...(prims as any).deps, sessions: sessionsFake });
    expect((await p2.call('get_session_summary', { session_id: 'sess_chat' }, f.memberPrincipal)) as any).toMatchObject({ proposals: ['prp_1'], busy: false, draft_task: null, last_error: 'oops' });
    const run = (await p2.call('get_session_summary', { session_id: 'sess_run' }, f.memberPrincipal)) as any;
    expect(run.proposals).toBeUndefined();
  });

  it('knowledge domains, evals and events pass through with their gates', async () => {
    const knowledge = fake<PrimitivesDeps['knowledge']>('knowledge', calls, { domains: () => [{ slug: 'eng', description: '', note_count: 2 }, { slug: 'ops', description: '', note_count: 1 }] });
    const evals = fake<PrimitivesDeps['evals']>('evals', calls, { listRuns: (o: any) => [o], getRun: (id: string) => ({ eval_run_id: id }), analysis: (c: string, v: string, o: any) => ({ c, v, o }) });
    const p2 = createPrimitives({ ...(prims as any).deps, knowledge, evals });
    expect(((await p2.call('list_knowledge_domains', {}, f.memberPrincipal)) as any).domains).toHaveLength(2);
    const sub = subagentPrincipal(f, grants({ primitives: ['list_knowledge_domains'] }));
    expect(((await p2.call('list_knowledge_domains', {}, sub)) as any).domains.map((x: any) => x.slug)).toEqual(['eng']);
    expect(((await p2.call('list_eval_runs', { circuit: CIRCUIT }, f.memberPrincipal)) as any).runs).toEqual([{ circuit: CIRCUIT, status: undefined, limit: 20 }]);
    expect(await p2.call('read_eval_run', { eval_run_id: 'evr_1' }, f.memberPrincipal)).toEqual({ eval_run_id: 'evr_1' });
    expect(await p2.call('get_eval_analysis', { circuit_uid: CIRCUIT, view: 'trend', variant: 'v' }, f.memberPrincipal)).toEqual({ c: CIRCUIT, v: 'trend', o: { base: undefined, head: undefined, circuit_commit: undefined, variant: 'v' } });
    expect(await codeOf(p2.call('get_eval_analysis', { circuit_uid: CIRCUIT, view: 'nope' }, f.memberPrincipal))).toBe('validation-failed');
    const ev = (await prims.call('list_recent_events', { topics: ['session.state', 'task.status'] }, f.memberPrincipal)) as any;
    expect(ev.events.map((e: any) => e.id)).toEqual(['e1']); // e2 is session-scoped and not visible
    expect(ev.next_after).toBe('e2');
  });

  it('read-only tokens can inspect but not write; subagents need the grant', async () => {
    const ro = readOnly();
    expect(await codeOf(prims.call('get_review_queue', {}, ro))).not.toBe('forbidden');
    expect(await codeOf(prims.call('list_recent_events', {}, ro))).toBe('ok');
    expect(await codeOf(prims.call('create_task', { title: 't', body: 'b' }, ro))).toBe('forbidden');
    expect(await codeOf(prims.call('propose_config_change', { changes: [{ path: 'tenets.md', content: 'x' }], message: 'm' }, ro))).toBe('forbidden');
    expect(await codeOf(prims.call('whoami', {}, subagentPrincipal(f, grants())))).toBe('grant-denied');
    expect(await codeOf(prims.call('whoami', {}, subagentPrincipal(f, grants({ primitives: ['whoami'] }))))).toBe('ok');
  });
});
