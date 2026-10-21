/**
 * Inspection primitives against a real session store (PGlite): the transcript, event log and listing read back
 * what the orchestrator-side writers (`recordTurn`, `appendEvent`) actually store.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BreadboardError } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import { createSessionStore, type PgSessionStore } from '../orchestrator/session-store.js';
import { createPrimitives, type PrimitivesImpl } from './primitives.js';

const CIRCUIT = '01J8FQ2ZK7XW9MBT4PVN';

let f: Foundation;
let sessions: PgSessionStore;
let prims: PrimitivesImpl;
let runId: string;
let chatId: string;

beforeAll(async () => {
  f = await createFoundation();
  sessions = createSessionStore({ db: f.db, team_id: f.team_id });
  const unimpl = () => {
    throw new BreadboardError('not-implemented');
  };
  const proxy: any = new Proxy({}, { get: () => unimpl });
  prims = createPrimitives({
    content: proxy,
    knowledge: proxy,
    tasks: proxy,
    orchestrator: proxy,
    sessions,
    evals: proxy,
    config: proxy,
    toolbox: () => proxy,
    broker: proxy,
    gateway: proxy,
    db: f.db,
    log: f.log,
    team_id: f.team_id,
    identity: f.identity,
    events: proxy,
    conversations: () => ({ proposals: async () => ['prp_1'], busy: () => false, draftTask: async () => null }),
    dispatcher: () => proxy,
    connectors: () => proxy,
    mirrors: () => proxy,
    instance: { name: 'agent-breadboard', version: 'test', db: 'pglite', sandbox: 'process', public_url: 'http://localhost:4000' },
  });

  const budget = { max_cost_usd: 5, max_tokens: 100000, spent_usd: 0, spent_tokens: 0 };
  const run = await sessions.create({ kind: 'circuit-run', circuit_uid: CIRCUIT, circuit_slug: 'lit-review', config_commit: 'abc123', budget, created_by: f.memberPrincipal.actor, state: 'running' });
  runId = run.session_id;
  await sessions.appendEvent(runId, 'session-started', { circuit_uid: CIRCUIT });
  await sessions.appendEvent(runId, 'step-started', { attempt: 1 }, 'gather');
  const base = { session_id: runId, step_id: 'gather', username: null, model_id: null, tokens_in: null, tokens_out: null, cost_usd: null };
  await sessions.recordTurn({ ...base, role: 'user', username: 'member', content: 'Find papers on CRDTs' });
  await sessions.recordTurn({ ...base, role: 'assistant', content: [{ type: 'reasoning', text: 'Search first.', signature: 'opaque-sig', model_id: 'us.anthropic.claude-sonnet-5' }, { type: 'text', text: 'Searching. ' + 'x'.repeat(5000) }, { type: 'tool_use', id: 'tu1', name: 'search-scholarly', input: { q: 'crdt text editors' } }], model_id: 'us.anthropic.claude-sonnet-5', tokens_in: 120, tokens_out: 40, tokens_cache_read: 900, cost_usd: 0.0012, latency_ms: 850 });
  await sessions.recordTurn({ ...base, role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: JSON.stringify({ hits: 3 }), is_error: false }] });
  await sessions.appendEvent(runId, 'step-exited', { exit: 'found', attempt: 1 }, 'gather');
  await sessions.update(runId, { state: 'completed', ended_at: new Date().toISOString() });

  const chat = await sessions.create({ kind: 'conversation', budget, created_by: f.adminPrincipal.actor, state: 'running', state_detail: { context: { definition_uid: CIRCUIT }, started_by: f.adminPrincipal.actor, last_error: null } });
  chatId = chat.session_id;
});

afterAll(async () => {
  await f?.close();
});

describe('inspection over a real session store', () => {
  it('read_session_transcript returns the recorded turns in order with clipped text', async () => {
    const r = (await prims.call('read_session_transcript', { session_id: runId }, f.memberPrincipal)) as any;
    expect(r.session).toMatchObject({ session_id: runId, kind: 'circuit-run', state: 'completed', circuit_slug: 'lit-review', config_commit: 'abc123' });
    expect(r.total_turns).toBe(3);
    expect(r.turns.map((t: any) => t.role)).toEqual(['user', 'assistant', 'tool']);
    expect(r.turns[0]).toMatchObject({ step_id: 'gather', attempt: 1, username: 'member', blocks: [{ type: 'text', text: 'Find papers on CRDTs' }] });
    expect(r.turns[1]).toMatchObject({ model_id: 'us.anthropic.claude-sonnet-5', tokens_in: 120, tokens_out: 40, tokens_cache_read: 900, cost_usd: 0.0012, latency_ms: 850 });
    expect(r.turns[1].blocks[0]).toEqual({ type: 'reasoning', text: 'Search first.' }); // the signature stays out
    expect(r.turns[1].blocks[1]).toMatchObject({ type: 'text', truncated: true, total_chars: 5011 });
    expect(r.turns[1].blocks[2]).toEqual({ type: 'tool_use', id: 'tu1', name: 'search-scholarly', input: { q: 'crdt text editors' } });
    expect(r.turns[2].blocks[0]).toEqual({ type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: '{"hits":3}' });
    const full = (await prims.call('read_session_transcript', { session_id: runId, turn_id: r.turns[1].turn_id }, f.memberPrincipal)) as any;
    expect(full.turns).toHaveLength(1);
    expect(full.turns[0].blocks[1].text).toHaveLength(5011);
    expect(((await prims.call('read_session_transcript', { session_id: runId, step: 'gather#2' }, f.memberPrincipal)) as any).total_turns).toBe(0);
  });

  it('read_session_events leaves turn events to the transcript and pages by seq', async () => {
    const r = (await prims.call('read_session_events', { session_id: runId }, f.memberPrincipal)) as any;
    expect(r.events.map((e: any) => e.event_type)).toEqual(['session-started', 'step-started', 'step-exited']);
    expect(r.events[2]).toMatchObject({ step_id: 'gather', payload: { exit: 'found' } });
    const all = (await prims.call('read_session_events', { session_id: runId, include_turns: true }, f.memberPrincipal)) as any;
    expect(all.events.filter((e: any) => e.event_type === 'turn')).toHaveLength(3);
    const tail = (await prims.call('read_session_events', { session_id: runId, after_seq: r.events[1].seq }, f.memberPrincipal)) as any;
    expect(tail.events.map((e: any) => e.event_type)).toEqual(['step-exited']);
  });

  it('list_sessions filters in SQL by kind, creator and definition, with cost', async () => {
    const runs = (await prims.call('list_sessions', { kind: ['circuit-run'] }, f.memberPrincipal)) as any;
    expect(runs.sessions.map((s: any) => s.session_id)).toEqual([runId]);
    expect(runs.sessions[0].cost_usd).toBeCloseTo(0.0012, 6);
    const mine = (await prims.call('list_sessions', { created_by: 'me' }, f.memberPrincipal)) as any;
    expect(mine.sessions.map((s: any) => s.session_id)).toEqual([runId]);
    const theirs = (await prims.call('list_sessions', { created_by: f.admin.user_id }, f.memberPrincipal)) as any;
    expect(theirs.sessions.map((s: any) => s.session_id)).toEqual([chatId]);
    const onDef = (await prims.call('list_sessions', { definition: CIRCUIT }, f.memberPrincipal)) as any;
    expect(onDef.sessions.map((s: any) => s.session_id)).toEqual([chatId]);
    expect(((await prims.call('list_sessions', { circuit: 'lit-review', state: ['completed'] }, f.memberPrincipal)) as any).sessions).toHaveLength(1);
  });

  it('get_session_summary carries the chat fields for a conversation', async () => {
    const chat = (await prims.call('get_session_summary', { session_id: chatId }, f.memberPrincipal)) as any;
    expect(chat).toMatchObject({ kind: 'conversation', proposals: ['prp_1'], busy: false, draft_task: null, last_error: null });
    const run = (await prims.call('get_session_summary', { session_id: runId }, f.memberPrincipal)) as any;
    expect(run.proposals).toBeUndefined();
    expect(run.steps.map((s: any) => s.step_id)).toEqual([]);
  });
});
