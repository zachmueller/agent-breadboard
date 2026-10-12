import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BreadboardError, mintId, mintUid, notFound, type BreadboardConfig } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import type { ConfigService, ContentService, RunConversationInput, TaskService } from '../core/services.js';
import { FakeEventBus, FakeSubagentRuntime, MemorySessionStore, type ScriptedTurn } from '../evals/test-fakes.js';
import { CONVERSATION_STEP_ID, createConversationService, type ConversationServiceImpl } from './conversations.js';

const SHAPER = mintUid();
const DESIGNER = mintUid();
const CIRC = mintUid();
const SUB_CIRC = mintUid();
const TASK = mintUid();
const NOTE = mintUid();
const MAIN = 'm'.repeat(40);

const textOf = (m: RunConversationInput['messages'][number]) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

describe('ConversationService', () => {
  let f: Foundation;
  let store: MemorySessionStore;
  let events: FakeEventBus;
  let svc: ConversationServiceImpl;
  let script: (input: RunConversationInput) => ScriptedTurn | Promise<ScriptedTurn>;
  let subagents: FakeSubagentRuntime;
  let settings: BreadboardConfig;

  beforeEach(async () => {
    f = await createFoundation();
    store = new MemorySessionStore(f.team_id);
    events = new FakeEventBus();
    script = () => ({ text: 'ok' });
    subagents = new FakeSubagentRuntime((input) => script(input));
    settings = { intake: { shaper_subagent: SHAPER }, designers: { circuit: DESIGNER }, defaults: { budget: { max_cost_usd: 1, max_tokens: 100_000 } } } as unknown as BreadboardConfig;
    const config = {
      mainCommit: async () => MAIN,
      definition: async (uid: string, _ref?: string) => {
        if (uid !== CIRC) throw notFound('definition', uid);
        return {
          uid: CIRC,
          kind: 'circuit',
          path: `circuits/${CIRC}/circuit.yaml`,
          commit: MAIN,
          slug: 'research',
          title: 'Research',
          definition: { steps: [{ id: 'gather', kind: 'llm' }, { id: 'deep', kind: 'circuit', circuit: SUB_CIRC }] },
          raw: 'title: Research\nsteps: [gather]\n',
          files: { 'prompts/gather.md': 'ORIGINAL PROMPT', 'prompts/write.md': 'WRITE PROMPT' },
          validation: { ok: true, errors: [], warnings: [] },
          referenced_by: [],
        };
      },
      getProposal: async (id: string) => ({ proposal_id: id, branch: 'proposals/x', status: 'open', message: 'Tighten gather', changes: [{ path: `circuits/${CIRC}/prompts/gather.md`, status: 'modified' }], diff: '-old\n+new' }),
    } as unknown as ConfigService;
    const content = {
      getNode: async (uid: string) => {
        if (uid !== TASK) throw notFound('node', uid);
        return { uid: TASK, type: 'task', title: 'Write the Q3 report', body_text: 'Gather numbers and write it up.', properties: { status: 'queued', priority: 'high' } };
      },
      edges: async () => [{ src: TASK, dst: NOTE, type: 'references' }],
    } as unknown as ContentService;
    svc = createConversationService({ db: f.db, team_id: f.team_id, sessions: store.asStore(), config, subagents: subagents.asRuntime(), content, tasks: {} as TaskService, events: events.asBus(), log: f.log, settings: async () => settings });
  });
  afterEach(async () => f.close());

  it('runs an intake conversation: turns with usernames, history, and the draft task from create_task', async () => {
    const s = await svc.start({ kind: 'intake', by: f.memberPrincipal, title: 'Q3 report' });
    expect(s.kind).toBe('intake');
    expect(s.state).toBe('running');
    expect(s.state_detail).toMatchObject({ subagent_uid: SHAPER, title: 'Q3 report' });
    expect((await store.events(s.session_id)).map((e) => e.event_type)).toEqual(['session-started', 'config-resolved']);

    script = () => ({ text: 'What should the report cover?', cost_usd: 0.02 });
    const first = await svc.post({ session_id: s.session_id, text: 'I need a Q3 report', by: f.memberPrincipal });
    expect(first.turns.map((t) => [t.role, t.username])).toEqual([
      ['user', 'member'],
      ['assistant', null],
    ]);
    expect(first.draft_task).toMatchObject({ source: 'draft', title: null });
    expect(first.proposals).toEqual([]);

    script = () => ({
      tool_calls: [{ name: 'breadboard_create_task', input: { title: 'Write the Q3 report', body: 'Gather numbers and write it up.', priority: 'high', references: [NOTE] }, output: { uid: TASK, title: 'Write the Q3 report' } }],
      text: 'Created the task.',
      cost_usd: 0.03,
    });
    const second = await svc.post({ session_id: s.session_id, text: 'Revenue and churn, please', by: f.memberPrincipal });
    expect(second.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(second.draft_task).toMatchObject({ source: 'task', task_uid: TASK, title: 'Write the Q3 report', priority: 'high', status: 'queued', references: [NOTE], created_tasks: [TASK] });

    // The model saw the full history, user turns attributed, with the draft-task preamble up front.
    const call = subagents.calls[1]!;
    expect(call.step_id).toBe(CONVERSATION_STEP_ID);
    expect(call.attempt).toBe(2);
    expect(call.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(textOf(call.messages[0]!)).toContain('[Draft task] none yet');
    expect(textOf(call.messages[0]!)).toContain('[@member] I need a Q3 report');
    expect(textOf(call.messages[1]!)).toBe('What should the report cover?');
    expect(textOf(call.messages[2]!)).toBe('[@member] Revenue and churn, please');

    const turns = await svc.turns(s.session_id, f.memberPrincipal);
    expect(turns.filter((t) => t.role === 'user').map((t) => t.username)).toEqual(['member', 'member']);
    expect(turns).toHaveLength(6);

    const log = await store.events(s.session_id);
    expect(log.filter((e) => e.event_type === 'tool-call').map((e) => e.payload.name)).toEqual(['breadboard_create_task']);
    const after = (await store.get(s.session_id))!;
    expect(after.budget.spent_usd).toBeCloseTo(0.05);
    expect(after.state_detail.draft_task).toMatchObject({ task_uid: TASK });
    expect(await svc.draftTask(s.session_id)).toMatchObject({ task_uid: TASK, body: 'Gather numbers and write it up.' });

    // A third turn shows the created task in the preamble.
    script = () => ({ text: 'Anything else?' });
    await svc.post({ session_id: s.session_id, text: 'Thanks', by: f.memberPrincipal });
    expect(textOf(subagents.calls[2]!.messages[0]!)).toContain(`"task_uid": "${TASK}"`);
  });

  it('designer chat sees the open definition with working-tree overrides and surfaces proposal ids', async () => {
    const s = await svc.start({ kind: 'conversation', subagent_uid: DESIGNER, context: { definition_uid: CIRC, editor: 'circuit' }, by: f.adminPrincipal });
    expect(s.state_detail).toMatchObject({ subagent_uid: DESIGNER, context: { definition_uid: CIRC, editor: 'circuit' } });

    const proposalId = mintId('prp');
    script = async (input) => {
      // The designer's propose primitive opens a proposal tied to this session.
      await f.db.query(
        `INSERT INTO config_proposals (proposal_id, team_id, branch, base_commit, head_commit, message, created_by, session_id) VALUES ($1,$2,$3,$4,$4,'Tighten gather',$5,$6)`,
        [proposalId, f.team_id, `proposals/${proposalId}`, MAIN, JSON.stringify({ kind: 'subagent', id: DESIGNER }), input.session_id],
      );
      return { text: 'I proposed a tighter gather prompt.' };
    };
    const out = await svc.post({
      session_id: s.session_id,
      text: 'Make the gather step stricter',
      context: { working_tree: { [`circuits/${CIRC}/prompts/gather.md`]: 'EDITED PROMPT (unsaved)' } },
      by: f.adminPrincipal,
    });
    expect(out.proposals).toEqual([proposalId]);
    expect(out.draft_task).toBeNull();

    // The designer may read the open circuit and its sub-circuits (read_config needs a circuit grant).
    expect([...(subagents.calls[0]!.principal.grants!.circuits.read as Set<string>)].sort()).toEqual([CIRC, SUB_CIRC].sort());
    const pre = textOf(subagents.calls[0]!.messages[0]!);
    expect(pre).toContain(`[Open definition] circuit Research (uid ${CIRC}`);
    expect(pre).toContain('title: Research\nsteps: [gather]');
    expect(pre).toContain('EDITED PROMPT (unsaved)');
    expect(pre).not.toContain('ORIGINAL PROMPT');
    expect(pre).toContain('WRITE PROMPT');
    expect(pre).toMatch(/unsaved working-tree changes.*prompts\/gather\.md/);
    expect(pre).toContain('[@admin] Make the gather step stricter');
    // The working tree is per-message editor state: never persisted on the session.
    expect(((await store.get(s.session_id))!.state_detail as any).context.working_tree).toBeUndefined();

    // The follow-up message references the open proposal; nothing new was proposed this turn.
    script = () => ({ text: 'Looks good.' });
    const next = await svc.post({ session_id: s.session_id, text: 'Show me the diff', context: { proposal_id: proposalId }, by: f.adminPrincipal });
    expect(next.proposals).toEqual([]);
    const pre2 = textOf(subagents.calls[1]!.messages[0]!);
    expect(pre2).toContain(`[Open proposal] ${proposalId} (open)`);
    expect(pre2).toContain('+new');
    expect(pre2).toContain('ORIGINAL PROMPT'); // no working tree sent this time
  });

  it('validates start/post inputs', async () => {
    const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof BreadboardError ? e.code : String(e)));
    expect(await code(svc.start({ kind: 'conversation', by: f.memberPrincipal }))).toBe('validation-failed');
    expect(await code(svc.start({ kind: 'intake', by: f.servicePrincipal }))).toBe('forbidden');
    settings = { ...settings, intake: {} } as unknown as BreadboardConfig;
    expect(await code(svc.start({ kind: 'intake', by: f.memberPrincipal }))).toBe('validation-failed');
    const s = await svc.start({ kind: 'intake', subagent_uid: SHAPER, by: f.memberPrincipal });
    expect(await code(svc.post({ session_id: s.session_id, text: '  ', by: f.memberPrincipal }))).toBe('validation-failed');
    expect(await code(svc.post({ session_id: s.session_id, text: 'hi', by: f.servicePrincipal }))).toBe('forbidden');
    expect(await code(svc.post({ session_id: mintId('ses'), text: 'hi', by: f.memberPrincipal }))).toBe('not-found');
  });

  it('suspends on budget exhaustion and rejects further posts', async () => {
    settings = { ...settings, defaults: { budget: { max_cost_usd: 0.05, max_tokens: 100_000 } } } as unknown as BreadboardConfig;
    const s = await svc.start({ kind: 'intake', by: f.memberPrincipal });
    script = () => ({ text: 'expensive reply', cost_usd: 0.06 });
    await svc.post({ session_id: s.session_id, text: 'go', by: f.memberPrincipal });
    const after = (await store.get(s.session_id))!;
    expect(after.state).toBe('suspended-error');
    expect(after.state_detail.reason).toBe('budget-exceeded');
    expect((await store.events(s.session_id)).map((e) => e.event_type)).toContain('budget-exceeded');
    await expect(svc.post({ session_id: s.session_id, text: 'again', by: f.memberPrincipal })).rejects.toMatchObject({ code: 'invalid-state' });
  });

  it('submit replies in the background: busy until done, live session.events, proposals and failures on the session', async () => {
    const s = await svc.start({ kind: 'conversation', subagent_uid: DESIGNER, context: { definition_uid: CIRC }, by: f.adminPrincipal });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const proposalId = mintId('prp');
    let runs = 0;
    script = async (input) => {
      await gate;
      if (runs++ === 0)
        await f.db.query(
          `INSERT INTO config_proposals (proposal_id, team_id, branch, base_commit, head_commit, message, created_by, session_id) VALUES ($1,$2,$3,$4,$4,'x',$5,$6)`,
          [proposalId, f.team_id, `proposals/${proposalId}`, MAIN, JSON.stringify({ kind: 'subagent', id: DESIGNER }), input.session_id],
        );
      return { tool_calls: [{ name: 'breadboard_validate_config', input: {}, output: { ok: true } }], text: 'Proposed.' };
    };
    expect(await svc.submit({ session_id: s.session_id, text: 'Build it', by: f.adminPrincipal })).toEqual({ accepted: true, session_id: s.session_id });
    expect(svc.busy(s.session_id)).toBe(true);
    // A second message queues behind the first rather than interleaving.
    await svc.submit({ session_id: s.session_id, text: 'And then this', by: f.adminPrincipal });
    release();
    await vi.waitFor(() => expect(svc.busy(s.session_id)).toBe(false));
    expect((await svc.turns(s.session_id, f.adminPrincipal)).map((t) => t.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'assistant']);
    expect(await svc.proposals(s.session_id)).toEqual([proposalId]);
    expect((await store.get(s.session_id))!.state_detail.last_error).toBeNull();
    // Every turn and tool event reached live clients.
    const live = events.published.filter((e) => e.topic === 'session.event' && e.payload.session_id === s.session_id).map((e) => e.payload.event_type);
    expect(live.filter((t) => t === 'turn').length).toBeGreaterThanOrEqual(8);
    expect(live).toEqual(expect.arrayContaining(['tool-call', 'tool-result']));

    // A failed background reply leaves its error on the session instead of vanishing.
    script = () => {
      throw new Error('bedrock throttled');
    };
    await svc.submit({ session_id: s.session_id, text: 'Again', by: f.adminPrincipal });
    await vi.waitFor(() => expect(svc.busy(s.session_id)).toBe(false));
    expect((await store.get(s.session_id))!.state_detail.last_error).toBe('bedrock throttled');
    expect(events.published.at(-1)).toMatchObject({ topic: 'session.event', payload: { session_id: s.session_id, event_type: 'conversation-error' } });

    // Up-front validation still throws to the caller.
    await expect(svc.submit({ session_id: s.session_id, text: ' ', by: f.adminPrincipal })).rejects.toMatchObject({ code: 'validation-failed' });
    await expect(svc.submit({ session_id: mintId('ses'), text: 'hi', by: f.adminPrincipal })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('lists conversations with the caller’s own first', async () => {
    const mine = await svc.start({ kind: 'intake', by: f.memberPrincipal });
    const theirs = await svc.start({ kind: 'intake', by: f.adminPrincipal });
    const designer = await svc.start({ kind: 'conversation', subagent_uid: DESIGNER, by: f.adminPrincipal });
    const list = await svc.list({ by: f.memberPrincipal });
    expect(list.map((x) => x.session_id)).toEqual([mine.session_id, designer.session_id, theirs.session_id]);
    expect((await svc.list({ kind: 'conversation', by: f.memberPrincipal })).map((x) => x.session_id)).toEqual([designer.session_id]);
  });
});
