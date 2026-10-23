import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SERVICE_ACTOR, mintUid, type Circuit } from '@breadboard/shared';
import { createKit, ARTIFACT_REF, type Kit } from './testkit.js';
import { EDITOR_SCOPES } from '../identity/identity.js';

const BY = SERVICE_ACTOR('test');
let k: Kit;

beforeAll(async () => {
  k = await createKit();
});
afterAll(async () => k.close());

const docOutput = { type: 'object', required: ['doc'], properties: { doc: ARTIFACT_REF } };

async function eventTypes(id: string) {
  return (await k.sessions.events(id)).map((e) => e.event_type);
}

describe('orchestrator: llm → code circuit', () => {
  it('completes with checkpoints, lineage edges, session-completed, and cost', async () => {
    const writer = mintUid();
    const publisher = mintUid();
    k.llm.set(writer, async ({ input, kit }) => ({ exit: 'done', output: { doc: await kit.artifact(input, 'Draft') } }));
    k.tools.set(publisher, (inp) => ({ exit: 'ok', output: { url: `https://x/${inp.doc.uid}`, topic: inp.topic } }));
    const c = k.config.add({
      slug: 'write-publish',
      input: { type: 'object', required: ['topic'], properties: { topic: { type: 'string' } } },
      exits: [{ name: 'done', output: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } } }],
      entry: 'draft',
      steps: [
        { id: 'draft', kind: 'llm', subagent: writer, prompt_inline: 'Write about {{input.topic}} (session {{ambient.session_id}})', output: docOutput, exits: [{ name: 'done', to: 'publish' }] },
        { id: 'publish', kind: 'code', tool: publisher, input_map: { doc: '$steps.draft.output.doc', topic: '$input.topic', literal: 7 }, exits: [{ name: 'ok', to: '$exit.done' }] },
      ],
    });
    const task = await k.task();
    const s = await k.orch.enqueue({ circuit_uid: c.uid, input: { topic: 'otters' }, task_uid: task, created_by: BY });
    expect(s.state).toBe('queued');
    expect(s.config_commit).toBeNull();
    const done = await k.orch.run(s.session_id);
    expect(done.state).toBe('completed');
    expect(done.config_commit).toBe(k.config.main);
    expect(done.state_detail).toMatchObject({ exit: 'done', output: { url: expect.stringMatching(/^https:\/\/x\//) } });

    const types = await eventTypes(s.session_id);
    expect(types.slice(0, 2)).toEqual(['session-started', 'config-resolved']);
    expect(types).toContain('step-exited');
    expect(types[types.length - 1]).toBe('session-completed');
    const completed = (await k.sessions.events(s.session_id)).find((e) => e.event_type === 'session-completed')!;
    expect(completed.payload).toMatchObject({ exit: 'done', output: { topic: 'otters' } });

    const cps = await k.sessions.checkpoints(s.session_id);
    expect(cps.map((c) => [c.step_id, c.status, c.exit_name])).toEqual([
      ['draft', 'exited', 'done'],
      ['publish', 'exited', 'ok'],
    ]);

    const call = k.llmCalls.find((x) => x.session_id === s.session_id)!;
    expect(call.prompt).toBe(`Write about otters (session ${s.session_id})`);
    expect(call.principal.visible_sessions).toEqual([s.session_id]);
    const tool = k.toolCalls.find((x) => x.input.topic === 'otters')!;
    expect(tool.input.literal).toBe(7);
    expect(tool.principal.actor).toMatchObject({ kind: 'code-step', id: publisher, step_id: 'publish#1' });
    expect(tool.ambient).toMatchObject({ invocation: 'code-step', session_id: s.session_id, task: { uid: task } });

    const edges = await k.f.edges.listForSession(s.session_id);
    expect(edges.some((e: any) => e.type === 'produces' && e.src_step_id === 'draft#1' && e.dst_uid === tool.input.doc.uid)).toBe(true);
    const cpPublish = cps.find((c) => c.step_id === 'publish')!;
    expect((cpPublish.ambient as any).artifacts.map((a: any) => a.uid)).toContain(tool.input.doc.uid);

    const cost = await k.sessions.cost(s.session_id);
    expect(cost.cost_usd).toBeCloseTo(0.01, 6);
    expect(Number(cps[0]!.cost_usd)).toBeCloseTo(0.01, 6);
    const turns = await k.sessions.turns(s.session_id, 'draft');
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);

    expect(k.taskStatuses.filter((t) => t.uid === task).map((t) => t.status)).toEqual(['active', 'done']);
  });

  it('rejects input that fails the circuit input schema', async () => {
    const c = k.config.add({ slug: 'needs-input', input: { type: 'object', required: ['q'] }, exits: [{ name: 'done' }], entry: 'a', steps: [{ id: 'a', kind: 'code', tool: mintUid(), exits: [{ name: 'ok', to: '$exit.done' }] }] });
    const s = await k.orch.enqueue({ circuit_uid: c.uid, input: {}, created_by: BY });
    const r = await k.orch.run(s.session_id);
    expect(r.state).toBe('suspended-error');
    expect(r.state_detail.reason).toBe('input-invalid');
  });
});

describe('orchestrator: re-asks, retries, and manual actions', () => {
  it('re-asks the subagent when the finish output is invalid', async () => {
    const sa = mintUid();
    k.llm.set(sa, ({ n }) => (n === 1 ? { exit: 'done', output: { wrong: true } } : { exit: 'done', output: { answer: 'yes' } }));
    const c = k.config.add({
      slug: 'reask',
      exits: [{ name: 'done' }],
      entry: 'ask',
      steps: [{ id: 'ask', kind: 'llm', subagent: sa, prompt_inline: 'Q?', output: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }, exits: [{ name: 'done', to: '$exit.done' }] }],
    });
    const s = await k.orch.enqueue({ circuit_uid: c.uid, input: {}, created_by: BY });
    const r = await k.orch.run(s.session_id);
    expect(r.state).toBe('completed');
    const calls = k.llmCalls.filter((x) => x.session_id === s.session_id);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.attempt).toBe(1);
    expect(calls[1]!.prompt).toMatch(/invalid/);
    const last = calls[1]!.messages[calls[1]!.messages.length - 1]!;
    expect(last.content[0]).toMatchObject({ type: 'tool_result', is_error: true });
  });

  it('invalid exit → retries → retries-exhausted → retry() at the new main commit succeeds once fixed', async () => {
    const sa = mintUid();
    let broken = true;
    k.llm.set(sa, () => (broken ? { exit: 'bogus', output: {} } : { exit: 'done', output: {} }));
    const c = k.config.add({
      slug: 'flaky',
      exits: [{ name: 'done' }],
      entry: 'think',
      steps: [{ id: 'think', kind: 'llm', subagent: sa, prompt_inline: 'think', output: { type: 'object' }, max_reasks: 0, retry: { max_attempts: 2, backoff: { base_s: 1, cap_s: 1 } }, exits: [{ name: 'done', to: '$exit.done' }] }],
    });
    const s = await k.orch.enqueue({ circuit_uid: c.uid, input: {}, created_by: BY });
    const r = await k.orch.run(s.session_id);
    expect(r.state).toBe('suspended-error');
    expect(r.state_detail).toMatchObject({ reason: 'retries-exhausted', step_id: 'think', attempts: 2 });
    const types = await eventTypes(s.session_id);
    expect(types.filter((t) => t === 'step-failed')).toHaveLength(2);
    expect(types.filter((t) => t === 'retry-scheduled')).toHaveLength(1);
    const before = r.config_commit;

    await expect(k.orch.resume(s.session_id, k.f.adminPrincipal, { budget: { max_cost_usd: 0.001 } })).rejects.toMatchObject({ code: 'validation-failed' });

    broken = false;
    const fixedCommit = k.config.bump();
    const q = await k.orch.retry(s.session_id, k.f.adminPrincipal);
    expect(q.state).toBe('queued');
    expect(q.config_commit).toBe(fixedCommit);
    expect(fixedCommit).not.toBe(before);
    const done = await k.orch.run(s.session_id);
    expect(done.state).toBe('completed');
    const cps = (await k.sessions.checkpoints(s.session_id)).filter((c) => c.step_id === 'think');
    expect(cps.map((c) => [Number(c.attempt), c.status])).toEqual([
      [1, 'failed'],
      [2, 'failed'],
      [3, 'exited'],
    ]);
    await expect(k.orch.retry(s.session_id, k.f.adminPrincipal)).rejects.toMatchObject({ code: 'invalid-state' });
  });

  it('a loop exceeding max_visits suspends with max-visits-exceeded', async () => {
    const tool = mintUid();
    k.tools.set(tool, () => ({ exit: 'again', output: {} }));
    const c = k.config.add({
      slug: 'looper',
      exits: [{ name: 'done' }],
      entry: 'spin',
      steps: [{ id: 'spin', kind: 'code', tool, max_visits: 3, exits: [{ name: 'again', to: 'spin' }, { name: 'done', to: '$exit.done' }] }],
    });
    const s = await k.orch.enqueue({ circuit_uid: c.uid, input: {}, created_by: BY });
    const r = await k.orch.run(s.session_id);
    expect(r.state).toBe('suspended-error');
    expect(r.state_detail).toMatchObject({ reason: 'max-visits-exceeded', step_id: 'spin', max_visits: 3 });
    expect(k.toolCalls.filter((t) => t.tool_uid === tool)).toHaveLength(3);

    // Manual routing skips the stuck step to a chosen exit.
    await expect(k.orch.manualRoute(s.session_id, 'nope', {}, k.f.adminPrincipal)).rejects.toMatchObject({ code: 'validation-failed' });
    await k.orch.manualRoute(s.session_id, 'done', {}, k.f.adminPrincipal);
    const done = await k.orch.run(s.session_id);
    expect(done.state).toBe('completed');
    expect(await eventTypes(s.session_id)).toContain('manual-route');
  });

  it('budget exhaustion suspends; resume() raises the ceiling and the run continues', async () => {
    const sa = mintUid();
    k.llm.set(sa, () => ({ exit: 'next', output: {} }));
    const c = k.config.add({
      slug: 'pricey',
      budget: { max_cost_usd: 0.015, max_tokens: 100000 },
      exits: [{ name: 'done' }],
      entry: 'one',
      steps: [
        { id: 'one', kind: 'llm', subagent: sa, prompt_inline: '1', output: { type: 'object' }, exits: [{ name: 'next', to: 'two' }] },
        { id: 'two', kind: 'llm', subagent: sa, prompt_inline: '2', output: { type: 'object' }, exits: [{ name: 'next', to: 'three' }] },
        { id: 'three', kind: 'llm', subagent: sa, prompt_inline: '3', output: { type: 'object' }, exits: [{ name: 'next', to: '$exit.done' }] },
      ],
    });
    const s = await k.orch.enqueue({ circuit_uid: c.uid, input: {}, created_by: BY });
    const r = await k.orch.run(s.session_id);
    expect(r.state).toBe('suspended-error');
    expect(r.state_detail).toMatchObject({ reason: 'budget-exceeded', step_id: 'three' });
    await k.orch.resume(s.session_id, k.f.adminPrincipal, { budget: { max_cost_usd: 1 } });
    const done = await k.orch.run(s.session_id);
    expect(done.state).toBe('completed');
    expect(done.budget.max_cost_usd).toBe(1);
    expect(k.llmCalls.filter((x) => x.session_id === s.session_id).map((x) => x.step_id)).toEqual(['one', 'two', 'three']);
  });

  it('cancel() records the cancellation, tags the task, and leaves its status alone', async () => {
    const c = k.config.add({ slug: 'cancel-me', exits: [{ name: 'done' }], entry: 'a', steps: [{ id: 'a', kind: 'code', tool: mintUid(), exits: [{ name: 'ok', to: '$exit.done' }] }] });
    const task = await k.task();
    const s = await k.orch.enqueue({ circuit_uid: c.uid, input: {}, task_uid: task, created_by: BY });
    const before = k.taskStatuses.length;
    const r = await k.orch.cancel(s.session_id, k.f.adminPrincipal, 'not needed');
    expect(r.state).toBe('cancelled');
    expect(await eventTypes(s.session_id)).toEqual(['session-cancelled']);
    expect((await k.f.nodes.mustGet(task)).tags).toContain('run-cancelled');
    expect(k.taskStatuses.length).toBe(before);
    expect((await k.orch.run(s.session_id)).state).toBe('cancelled');
    await expect(k.orch.cancel(s.session_id, k.f.adminPrincipal)).rejects.toMatchObject({ code: 'invalid-state' });
  });

  it('cancel() keeps a conversation’s record (subagent, context, who started it)', async () => {
    const detail = { subagent_uid: mintUid(), context: { definition_uid: mintUid() }, started_by: BY, title: 'Designer: x' };
    const s = await k.sessions.create({ kind: 'conversation', state: 'running', budget: { max_cost_usd: 1, max_tokens: 1000, spent_usd: 0, spent_tokens: 0 }, created_by: BY, state_detail: detail });
    const r = await k.orch.cancel(s.session_id, k.f.adminPrincipal);
    expect(r.state_detail).toMatchObject({ ...detail, reason: 'cancelled', previous_state: 'running' });
  });
});

describe('orchestrator: gates', () => {
  let circuit: Circuit;
  const writer = mintUid();
  const reviser = mintUid();
  beforeAll(() => {
    k.llm.set(writer, async ({ input, kit }) => ({ exit: 'done', output: { doc: await kit.artifact(input, 'Gated draft') } }));
    k.llm.set(reviser, () => ({ exit: 'done', output: {} }));
    circuit = k.config.add({
      slug: 'gated',
      exits: [{ name: 'approved' }, { name: 'revised' }],
      entry: 'draft',
      steps: [
        { id: 'draft', kind: 'llm', subagent: writer, prompt_inline: 'draft', output: docOutput, exits: [{ name: 'done', to: 'review' }] },
        {
          id: 'review',
          kind: 'gate',
          review: { artifacts: ['$steps.draft.output.doc'], reviewers: { role: 'scientist' }, prompt: 'Please review' },
          output: { type: 'object', required: ['doc'], properties: { doc: ARTIFACT_REF, feedback: { type: 'array', items: { type: 'string' } }, priority: { type: 'string', enum: ['low', 'high'] } } },
          exits: [
            { name: 'approve', to: '$exit.approved' },
            { name: 'changes', to: 'revise' },
          ],
        },
        { id: 'revise', kind: 'llm', subagent: reviser, prompt_inline: 'Feedback: {{#each steps.review.output.feedback}}[{{this}}]{{/each}} priority={{steps.review.output.priority}}', output: { type: 'object' }, exits: [{ name: 'done', to: '$exit.revised' }] },
      ],
    });
  });

  async function toGate() {
    const task = await k.task();
    const s = await k.orch.enqueue({ circuit_uid: circuit.uid, input: {}, task_uid: task, created_by: BY });
    const r = await k.orch.run(s.session_id);
    expect(r.state).toBe('suspended-gate');
    const req = (r.state_detail.requests as any[])[0];
    return { s: r, task, req };
  }

  it('suspends with need-input requests; a non-targeted reviewer is forbidden; approve resolves via approve', async () => {
    const { s, task, req } = await toGate();
    expect(s.state_detail).toMatchObject({ reason: 'gate', step_id: 'review', verdicts: [] });
    expect(s.state_detail.requests).toHaveLength(1);
    expect(req).toMatchObject({ role: 'scientist' });
    expect(k.taskStatuses.filter((t) => t.uid === task).map((t) => t.status)).toEqual(['active', 'gated']);
    const node = await k.f.nodes.mustGet(req.uid);
    expect((node.properties['need-input'] as any[])[0]).toMatchObject({ request_id: req.request_id, gate: { session_id: s.session_id, step_id: 'review' } });

    await expect(k.orch.gateVerdict({ node_uid: req.uid, request_id: req.request_id, verdict: 'approve', by: k.f.adminPrincipal })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(k.orch.gateVerdict({ node_uid: req.uid, request_id: req.request_id, verdict: 'approve', edits: { priority: 'high' }, by: k.f.memberPrincipal })).rejects.toMatchObject({ code: 'validation-failed' });

    // The targeted reviewer's editor token is not enough: a gate verdict needs an unscoped credential ([12] §3).
    const editor = { ...k.f.memberPrincipal, scopes: [...EDITOR_SCOPES], token_kind: 'personal' as const };
    await expect(k.orch.gateVerdict({ node_uid: req.uid, request_id: req.request_id, verdict: 'approve', by: editor })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await k.sessions.mustGet(s.session_id)).state_detail.verdicts).toEqual([]);

    const v = await k.orch.gateVerdict({ node_uid: req.uid, request_id: req.request_id, verdict: 'approve', comment: 'lgtm', by: k.f.memberPrincipal });
    expect(v).toEqual({ resolved: true, session_id: s.session_id });
    const q = await k.sessions.mustGet(s.session_id);
    expect(q.state).toBe('queued');
    await expect(k.orch.gateVerdict({ node_uid: req.uid, request_id: req.request_id, verdict: 'approve', by: k.f.memberPrincipal })).rejects.toMatchObject({ code: 'conflict' });

    const done = await k.orch.run(s.session_id);
    expect(done.state).toBe('completed');
    expect(done.state_detail.exit).toBe('approved');
    const resolved = (await k.sessions.events(s.session_id)).find((e) => e.event_type === 'gate-resolved')!;
    expect(resolved.payload).toMatchObject({ exit: 'approve' });
    const out = (resolved.payload as any).output;
    expect(out.doc.uid).toBe(req.uid);
    const rev = await k.f.nodes.getRevision(req.uid, out.doc.revision_id);
    expect(rev!.labels).toContain('gate-resolution');
    expect(k.taskStatuses.filter((t) => t.uid === task).map((t) => t.status)).toEqual(['active', 'gated', 'active', 'done']);
  });

  it('request-changes resolves via changes with feedback and edits visible to the next step', async () => {
    const { s, req } = await toGate();
    await expect(k.orch.gateVerdict({ node_uid: req.uid, request_id: req.request_id, verdict: 'request-changes', edits: { priority: 'urgent' }, by: k.f.memberPrincipal })).rejects.toMatchObject({ code: 'validation-failed' });
    expect((await k.sessions.mustGet(s.session_id)).state).toBe('suspended-gate');
    await k.orch.gateVerdict({ node_uid: req.uid, request_id: req.request_id, verdict: 'request-changes', comment: 'tighten the intro', edits: { priority: 'high' }, by: k.f.memberPrincipal });
    const done = await k.orch.run(s.session_id);
    expect(done.state).toBe('completed');
    expect(done.state_detail.exit).toBe('revised');
    const call = k.llmCalls.find((x) => x.session_id === s.session_id && x.step_id === 'revise')!;
    expect(call.prompt).toBe('Feedback: [tighten the intro] priority=high');
    const node = await k.f.nodes.mustGet(req.uid);
    expect(node.properties['need-input'] ?? []).toEqual([]);
  });
});

describe('orchestrator: sub-circuits', () => {
  it('runs a child session with budget draw-down and exit/output mapping', async () => {
    const sa = mintUid();
    const echo = mintUid();
    k.llm.set(sa, ({ input }) => ({ exit: 'ok', output: { n: 42, seen: input.session_id } }));
    k.tools.set(echo, (inp) => ({ exit: 'ok', output: { n: inp.n } }));
    const child = k.config.add({
      slug: 'child',
      exits: [{ name: 'ok', output: { type: 'object', required: ['n'] } }],
      entry: 'compute',
      steps: [{ id: 'compute', kind: 'llm', subagent: sa, prompt_inline: 'x={{input.x}}', output: { type: 'object' }, exits: [{ name: 'ok', to: '$exit.ok' }] }],
    });
    const parent = k.config.add({
      slug: 'parent',
      budget: { max_cost_usd: 0.5, max_tokens: 10000 },
      exits: [{ name: 'done', output: { type: 'object', required: ['n'] } }],
      entry: 'sub',
      steps: [
        { id: 'sub', kind: 'circuit', circuit: child.uid, input_map: { x: '$input.x' }, exit_map: { ok: 'good' }, exits: [{ name: 'good', to: 'after' }] },
        { id: 'after', kind: 'code', tool: echo, input_map: { n: '$steps.sub.output.n' }, exits: [{ name: 'ok', to: '$exit.done' }] },
      ],
    });
    k.dispatcher.start();
    try {
      const task = await k.task();
      const s = await k.orch.enqueue({ circuit_uid: parent.uid, input: { x: 3 }, task_uid: task, created_by: BY });
      const done = await k.orch.waitFor(s.session_id, 20000);
      expect(done.state).toBe('completed');
      expect(done.state_detail.output).toEqual({ n: 42 });
      const [kid] = await k.sessions.children(s.session_id);
      expect(kid).toBeDefined();
      expect(kid!.state).toBe('completed');
      expect(kid!.parent_step_id).toBe('sub');
      expect(kid!.budget.max_cost_usd).toBeLessThanOrEqual(0.5);
      expect(kid!.budget.max_tokens).toBeLessThanOrEqual(10000);
      expect(kid!.config_commit).toBe(done.config_commit);
      const kidCall = k.llmCalls.find((x) => x.session_id === kid!.session_id)!;
      expect(kidCall.prompt).toBe('x=3');
      expect(kidCall.principal.visible_sessions).toEqual(expect.arrayContaining([kid!.session_id, s.session_id]));
      const cp = (await k.sessions.checkpoints(s.session_id)).find((c) => c.step_id === 'sub')!;
      expect(cp).toMatchObject({ status: 'exited', exit_name: 'good', child_session_id: kid!.session_id });
      expect(Number(cp.cost_usd)).toBeCloseTo(0.01, 6);
      expect((await k.sessions.treeCost(s.session_id)).cost_usd).toBeCloseTo(0.01, 6);
      // The task finishes with the top-level session only.
      const statuses = k.taskStatuses.filter((t) => t.uid === task).map((t) => t.status);
      expect(statuses.filter((x, i) => x !== statuses[i - 1])).toEqual(['active', 'done']);
    } finally {
      await k.dispatcher.stop();
    }
  });

  it('a parent parked behind a gated child resumes with it when the reviewer requests changes', async () => {
    const writer = mintUid();
    k.llm.set(writer, async ({ input, kit }) => ({ exit: 'done', output: { doc: await kit.artifact(input, 'Child doc') } }));
    const child = k.config.add({
      slug: 'looping-child',
      exits: [{ name: 'ok' }],
      entry: 'draft',
      steps: [
        { id: 'draft', kind: 'llm', subagent: writer, prompt_inline: 'd', output: docOutput, exits: [{ name: 'done', to: 'review' }] },
        { id: 'review', kind: 'gate', review: { artifacts: ['$steps.draft.output.doc'], reviewers: {} }, output: { type: 'object' }, exits: [{ name: 'approve', to: '$exit.ok' }, { name: 'changes', to: 'draft' }] },
      ],
    });
    const parent = k.config.add({ slug: 'looping-parent', exits: [{ name: 'done' }], entry: 'sub', steps: [{ id: 'sub', kind: 'circuit', circuit: child.uid, exits: [{ name: 'ok', to: '$exit.done' }] }] });
    k.dispatcher.start();
    try {
      const s = await k.orch.enqueue({ circuit_uid: parent.uid, input: {}, created_by: BY });
      const first = await k.orch.waitFor(s.session_id, 20000);
      expect(first.state_detail.reason).toBe('child-gated');
      const kidId = first.state_detail.child_session_id as string;
      const gateRequest = async () => ((await k.sessions.mustGet(kidId)).state_detail.requests as any[] | undefined)?.[0];
      const r1 = await gateRequest();
      await k.orch.gateVerdict({ node_uid: r1.uid, request_id: r1.request_id, verdict: 'request-changes', comment: 'tighten it', by: k.f.memberPrincipal });
      // The parent woke with the child instead of staying "awaiting review", and parks again at the child's next gate.
      const resumed = async () => (await k.sessions.events(s.session_id)).some((e) => e.event_type === 'session-resumed' && (e.payload as any).reason === 'child-resumed');
      for (let i = 0; i < 100 && !(await resumed()); i++) await new Promise((r) => setTimeout(r, 50));
      expect(await resumed()).toBe(true);
      let r2 = await gateRequest();
      for (let i = 0; i < 200 && (!r2 || r2.request_id === r1.request_id || (await k.sessions.mustGet(s.session_id)).state !== 'suspended-gate'); i++) {
        await new Promise((r) => setTimeout(r, 50));
        r2 = await gateRequest();
      }
      expect((await k.sessions.mustGet(s.session_id)).state_detail.reason).toBe('child-gated');
      await k.orch.gateVerdict({ node_uid: r2.uid, request_id: r2.request_id, verdict: 'approve', by: k.f.memberPrincipal });
      for (let i = 0; i < 200 && (await k.sessions.mustGet(s.session_id)).state !== 'completed'; i++) await new Promise((r) => setTimeout(r, 50));
      expect((await k.sessions.mustGet(s.session_id)).state).toBe('completed');
    } finally {
      await k.dispatcher.stop();
    }
  });

  it('a gated child suspends the parent, which resumes when the child completes', async () => {
    const writer = mintUid();
    k.llm.set(writer, async ({ input, kit }) => ({ exit: 'done', output: { doc: await kit.artifact(input, 'Child doc') } }));
    const child = k.config.add({
      slug: 'gated-child',
      exits: [{ name: 'ok' }],
      entry: 'draft',
      steps: [
        { id: 'draft', kind: 'llm', subagent: writer, prompt_inline: 'd', output: docOutput, exits: [{ name: 'done', to: 'review' }] },
        { id: 'review', kind: 'gate', review: { artifacts: ['$steps.draft.output.doc'], reviewers: {} }, output: { type: 'object' }, exits: [{ name: 'approve', to: '$exit.ok' }, { name: 'changes', to: '$exit.ok' }] },
      ],
    });
    const parent = k.config.add({ slug: 'gated-parent', exits: [{ name: 'done' }], entry: 'sub', steps: [{ id: 'sub', kind: 'circuit', circuit: child.uid, exits: [{ name: 'ok', to: '$exit.done' }] }] });
    k.dispatcher.start();
    try {
      const s = await k.orch.enqueue({ circuit_uid: parent.uid, input: {}, created_by: BY });
      const susp = await k.orch.waitFor(s.session_id, 20000);
      expect(susp.state).toBe('suspended-gate');
      expect(susp.state_detail.reason).toBe('child-gated');
      const kid = await k.sessions.mustGet(susp.state_detail.child_session_id as string);
      expect(kid.state).toBe('suspended-gate');
      const req = (kid.state_detail.requests as any[])[0];
      await k.orch.gateVerdict({ node_uid: req.uid, request_id: req.request_id, verdict: 'approve', by: k.f.memberPrincipal });
      await k.orch.waitFor(kid.session_id, 20000);
      for (let i = 0; i < 100 && (await k.sessions.mustGet(s.session_id)).state !== 'completed'; i++) await new Promise((r) => setTimeout(r, 50));
      const done = await k.sessions.mustGet(s.session_id);
      expect(done.state).toBe('completed');
      expect(await eventTypes(s.session_id)).toContain('session-resumed');
    } finally {
      await k.dispatcher.stop();
    }
  });
});
