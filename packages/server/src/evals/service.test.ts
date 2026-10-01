import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BreadboardError, mintUid, notFound, SCHEMA_TAGS, type Rubric } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import type { ConfigService, ContentService, EnqueueRunInput, Orchestrator, Toolbox } from '../core/services.js';
import type { Principal } from '../core/principal.js';
import { createEvalService, fixturesPath, JUDGE_STEP_ID, RECORD_SCORES_TOOL, type EvalServiceImpl } from './service.js';
import { FakeEventBus, FakeSubagentRuntime, MemorySessionStore } from './test-fakes.js';

const CIRCUIT = mintUid();
const JUDGE = mintUid();
const NOTE = mintUid();
const COMMIT = 'c'.repeat(40);
const RUBRIC_COMMIT = 'r'.repeat(40);

const rubric: Rubric = {
  schema: SCHEMA_TAGS.rubric,
  circuit: CIRCUIT,
  judge: { subagent: JUDGE, model_id: 'judge-model-1', provider: 'bedrock' },
  dimensions: [
    { key: 'accuracy', type: 'numeric', scale: { min: 1, max: 5 }, prompt: 'How accurate?' },
    { key: 'clarity', type: 'ordinal', levels: ['poor', 'ok', 'good'], prompt: 'How clear?' },
    { key: 'cites', type: 'boolean', prompt: 'Cites sources?' },
    { key: 'exit', type: 'programmatic', tool: 'assert-exit', settings: { expected: 'done' } },
  ],
  aggregate: { method: 'weighted-mean', weights: { accuracy: 2 }, ordinal_map: { clarity: { poor: 0, ok: 0.6, good: 1 } }, gate: { min: 0.7 } },
  required_for_merge: false,
} as Rubric;

const fixtures = {
  schema: SCHEMA_TAGS.fixtures,
  circuit: CIRCUIT,
  fixtures: [
    { fixture_id: 'fx-a', title: 'A', input: { q: 'a' }, tags: ['core'], retired: false },
    { fixture_id: 'fx-b', title: 'B', input: { q: 'b' }, tags: ['edge'], retired: false },
    { fixture_id: 'fx-old', title: 'Old', input: { q: 'old' }, tags: ['core'], retired: true },
  ],
};

/** Per-fixture behavior of the fake circuit + judge. */
const behavior: Record<string, { exit: string; fail?: boolean; scores: Array<{ dimension: string; value: unknown; rationale?: string }> }> = {
  a: { exit: 'done', scores: [{ dimension: 'accuracy', value: 5, rationale: 'exact' }, { dimension: 'clarity', value: 'good' }, { dimension: 'cites', value: true }] },
  b: { exit: 'needs-input', scores: [{ dimension: 'accuracy', value: 2 }, { dimension: 'clarity', value: 'ok' }, { dimension: 'cites', value: false }] },
};

function fakeConfig(state: { commits: Array<{ changes: Array<{ path: string; content: string | null }>; message: string; by: Principal }>; fixturesRaw: string | null; attached: string[] }): ConfigService {
  const loaded = { uid: CIRCUIT, commit: COMMIT, circuit: { uid: CIRCUIT, title: 'Answerer', exits: [{ name: 'done' }, { name: 'needs-input' }] }, prompts: {}, rubric, fixtures };
  return {
    mainCommit: async () => COMMIT,
    circuit: async () => loaded,
    rubric: async () => rubric,
    fixtures: async () => fixtures,
    history: async () => [{ commit: RUBRIC_COMMIT, author: 'x', date: '2026-09-01', message: 'rubric' }],
    getProposal: async (id: string) => ({ proposal_id: id, head_commit: COMMIT }),
    attachEvalRun: async (_p: string, id: string) => void state.attached.push(id),
    definition: async (path: string) => {
      if (state.fixturesRaw === null) throw notFound('definition', path);
      return { uid: null, kind: 'fixtures', path, commit: COMMIT, slug: null, title: null, definition: null, raw: state.fixturesRaw, validation: { ok: true, errors: [], warnings: [] }, referenced_by: [] };
    },
    commitDirect: async (opts: any) => {
      state.commits.push(opts);
      return { commit: 'n'.repeat(40), validation: { ok: true, errors: [], warnings: [] } };
    },
  } as unknown as ConfigService;
}

function fakeOrchestrator(store: MemorySessionStore, enqueued: EnqueueRunInput[]): Orchestrator {
  return {
    enqueue: async (input: EnqueueRunInput) => {
      enqueued.push(input);
      return store.create({ kind: input.kind ?? 'circuit-run', circuit_uid: input.circuit_uid, input: input.input, model_overrides: input.model_overrides, budget: { max_cost_usd: 1, max_tokens: 1e6, spent_usd: 0, spent_tokens: 0 }, created_by: input.created_by, state: 'queued' });
    },
    waitFor: async (id: string) => {
      const s = (await store.get(id))!;
      const q = ((s as any).input as { q: string }).q;
      const b = behavior[q]!;
      await store.recordTurn({ session_id: id, step_id: 'answer', role: 'assistant', username: null, content: [{ type: 'text', text: 'answer' }], model_id: 'm', tokens_in: 10, tokens_out: 5, cost_usd: 0.05 });
      if (b.fail) {
        await store.appendEvent(id, 'session-failed' as any, { reason: 'tool crashed' });
        return store.update(id, { state: 'suspended-error', state_detail: { reason: 'tool crashed' } });
      }
      await store.appendEvent(id, 'session-completed', { exit: b.exit, output: { answer: q.toUpperCase() } });
      return store.update(id, { state: 'completed' });
    },
  } as unknown as Orchestrator;
}

describe('EvalService', () => {
  let f: Foundation;
  let store: MemorySessionStore;
  let events: FakeEventBus;
  let subagents: FakeSubagentRuntime;
  let svc: EvalServiceImpl;
  let enqueued: EnqueueRunInput[];
  let cfg: { commits: any[]; fixturesRaw: string | null; attached: string[] };

  beforeEach(async () => {
    f = await createFoundation();
    store = new MemorySessionStore(f.team_id);
    events = new FakeEventBus();
    enqueued = [];
    cfg = { commits: [], fixturesRaw: null, attached: [] };
    behavior.b!.fail = false;
    subagents = new FakeSubagentRuntime(async (input) => {
      const s = (await store.get(input.session_id!))!;
      const q = ((s as any).input as { q: string }).q;
      return { terminal: { name: RECORD_SCORES_TOOL, input: { scores: behavior[q]!.scores } }, cost_usd: 0.03 };
    });
    svc = createEvalService({
      db: f.db,
      team_id: f.team_id,
      config: fakeConfig(cfg),
      orchestrator: fakeOrchestrator(store, enqueued),
      sessions: store.asStore(),
      subagents: subagents.asRuntime(),
      toolbox: {} as Toolbox,
      content: { getNode: async (uid: string) => { throw notFound('node', uid); } } as unknown as ContentService,
      events: events.asBus(),
      log: f.log,
    });
  });
  afterEach(async () => f.close());

  it('runs fixtures, writes fixture × dimension rows plus aggregates, and computes the summary', async () => {
    const run = (await svc.startRun({ circuit: CIRCUIT, ref: null, fixture_tags: null, model_overrides: null, by: f.adminPrincipal })) as any;
    expect(run.status).toBe('completed');
    expect(run.rubric_commit).toBe(RUBRIC_COMMIT);
    expect(run.circuit_commit).toBe(COMMIT);
    expect(run.judge_model_id).toBe('judge-model-1');
    expect(enqueued).toHaveLength(2); // retired fixture skipped
    expect(enqueued.every((e) => e.kind === 'eval-run' && e.config_ref === COMMIT)).toBe(true);

    const rows = (await f.db.query(`SELECT fixture_id, dimension, dim_type, value, cost_usd FROM eval_results WHERE eval_run_id=$1 ORDER BY fixture_id, dimension`, [run.eval_run_id])).rows;
    expect(rows).toHaveLength(10); // 2 fixtures × (4 dims + '*')
    const get = (fx: string, dim: string) => rows.find((r) => r.fixture_id === fx && r.dimension === dim)!;
    expect(get('fx-a', 'accuracy').value).toBe(5);
    expect(get('fx-a', 'clarity').value).toBe('good');
    expect(get('fx-b', 'exit').value).toMatchObject({ pass: false, score: 0 });
    expect(Number(get('fx-a', 'accuracy').cost_usd)).toBeCloseTo(0.01);

    // fx-a: all dims 1 → 1. fx-b: (2·0.25 + 0.6 + 0 + 0) / 5 = 0.22.
    const aggA = get('fx-a', '*').value;
    const aggB = get('fx-b', '*').value;
    expect(get('fx-a', '*').dim_type).toBe('aggregate');
    expect(aggA.score).toBeCloseTo(1);
    expect(aggA.pass).toBe(true);
    expect(aggB.score).toBeCloseTo(0.22);
    expect(aggB.pass).toBe(false);
    expect(aggB.per_dimension).toMatchObject({ accuracy: 0.25, clarity: 0.6, cites: 0, exit: 0 });
    expect(aggA.session_cost_usd).toBeCloseTo(0.05); // judge turns excluded (computed before judging)

    expect(run.summary.scored).toBe(2);
    expect(run.summary.mean_aggregate).toBeCloseTo(0.61);
    expect(run.summary.pass_rate).toBeCloseTo(0.5);
    expect(run.summary.gate_min).toBe(0.7);
    expect(run.summary.total_cost_usd).toBeCloseTo(0.16); // (3 × 0.01 judge share + 0.05 session) × 2
    expect(Object.keys(run.summary.sessions)).toEqual(['fx-a', 'fx-b']);
    expect(run.results).toHaveLength(2);

    // Judge pinned to the rubric's model id through the preset override, forced to the scoring tool.
    expect(subagents.calls).toHaveLength(2);
    expect(subagents.calls[0]!.model_overrides).toEqual({ medium: 'judge-model-1' });
    expect(subagents.calls[0]!.force_tool).toBe(RECORD_SCORES_TOOL);
    const judgeTurns = await store.turns(run.summary.sessions['fx-a'], JUDGE_STEP_ID);
    expect(judgeTurns.length).toBeGreaterThan(0);

    expect(events.published.find((e) => e.topic === 'eval.run-completed')?.payload).toMatchObject({ eval_run_id: run.eval_run_id, status: 'completed' });
  });

  it('filters fixtures by tag and attaches proposal runs', async () => {
    const run = (await svc.startRun({ circuit: CIRCUIT, ref: null, fixture_tags: ['edge'], model_overrides: { medium: 'cheap' }, proposal_id: 'prp_' + mintUid(), by: f.adminPrincipal } as any)) as any;
    expect(enqueued.map((e) => (e.input as any).q)).toEqual(['b']);
    expect(enqueued[0]!.model_overrides).toEqual({ medium: 'cheap' });
    expect(run.variant).toBe('medium=cheap');
    expect(cfg.attached).toEqual([run.eval_run_id]);
    await expect(svc.startRun({ circuit: CIRCUIT, ref: null, fixture_tags: ['nope'], model_overrides: null, by: f.adminPrincipal })).rejects.toMatchObject({ code: 'validation-failed' });
  });

  it('scores a failed session as 0 and skips the judge', async () => {
    behavior.b!.fail = true;
    const run = (await svc.startRun({ circuit: CIRCUIT, ref: null, fixture_tags: ['edge'], model_overrides: null, by: f.adminPrincipal })) as any;
    expect(subagents.calls).toHaveLength(0);
    const agg = (run.results[0].aggregate ?? {}) as any;
    expect(agg).toMatchObject({ score: 0, failed: true, pass: false });
    const acc = run.results[0].dimensions.find((d: any) => d.dimension === 'accuracy');
    expect(acc.value).toBeNull();
    expect(acc.rationale).toMatch(/skipped/);
  });

  it('record_score validates values and principals, and refreshes aggregates', async () => {
    const run = (await svc.startRun({ circuit: CIRCUIT, ref: null, fixture_tags: null, model_overrides: null, by: f.adminPrincipal })) as any;
    const base = { eval_run_id: run.eval_run_id, fixture_id: 'fx-b', rationale: 'manual', by: f.adminPrincipal };
    const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof BreadboardError ? e.code : String(e)));
    expect(await code(svc.recordScore({ ...base, dimension: 'nope', value: 1 }))).toBe('validation-failed');
    expect(await code(svc.recordScore({ ...base, dimension: '*', value: 1 }))).toBe('validation-failed');
    expect(await code(svc.recordScore({ ...base, dimension: 'accuracy', value: 9 }))).toBe('validation-failed');
    expect(await code(svc.recordScore({ ...base, dimension: 'clarity', value: 'great' }))).toBe('validation-failed');
    expect(await code(svc.recordScore({ ...base, dimension: 'cites', value: 'maybe' }))).toBe('validation-failed');
    const otherSubagent = { ...f.servicePrincipal, actor: { kind: 'subagent' as const, id: mintUid() } };
    expect(await code(svc.recordScore({ ...base, dimension: 'accuracy', value: 3, by: otherSubagent }))).toBe('grant-denied');
    const judge = { ...f.servicePrincipal, actor: { kind: 'subagent' as const, id: JUDGE } };
    expect(await code(svc.recordScore({ ...base, dimension: 'cites', value: true, by: judge }))).toBe('ok');

    await svc.recordScore({ ...base, dimension: 'accuracy', value: 5 });
    const after = (await svc.getRun(run.eval_run_id)) as any;
    const b = after.results.find((r: any) => r.fixture_id === 'fx-b');
    // (2·1 + 0.6 + 1 + 0) / 5 = 0.72 → passes the 0.7 gate now.
    expect(b.aggregate.score).toBeCloseTo(0.72);
    expect(b.aggregate.pass).toBe(true);
    expect(b.aggregate.session_cost_usd).toBeCloseTo(0.05);
    expect(after.summary.mean_aggregate).toBeCloseTo(0.86);
    expect(after.summary.pass_rate).toBe(1);
    expect(b.dimensions.find((d: any) => d.dimension === 'accuracy').rationale).toBe('manual');
  });

  it('returns a background run immediately when wait=false', async () => {
    const run = (await svc.startRun({ circuit: CIRCUIT, ref: null, fixture_tags: null, model_overrides: null, wait: false, by: f.adminPrincipal } as any)) as any;
    expect(run.status).toBe('running');
    await svc.settle(run.eval_run_id);
    expect(((await svc.getRun(run.eval_run_id)) as any).status).toBe('completed');
    expect((await svc.listRuns({ circuit: CIRCUIT })).length).toBe(1);
    expect((await svc.listRuns({ status: 'failed' })).length).toBe(0);
  });

  describe('promoteFixture', () => {
    async function productionSession() {
      const s = await store.create({ kind: 'circuit-run', circuit_uid: CIRCUIT, input: { q: 'prod' }, budget: { max_cost_usd: 1, max_tokens: 1, spent_usd: 0, spent_tokens: 0 }, created_by: f.adminPrincipal.actor, state: 'completed' });
      await store.appendEvent(s.session_id, 'session-started', { input: { q: 'prod' } });
      await store.appendEvent(s.session_id, 'knowledge-injected' as any, { notes: [{ uid: NOTE, revision_id: 2 }, { uid: NOTE, revision_id: 4 }] });
      return s;
    }

    it('creates fixtures.yaml when absent, pinning knowledge revisions', async () => {
      const s = await productionSession();
      const out = await svc.promoteFixture({ session_id: s.session_id, fixture_title: 'Prod case', tags: ['regression'], notes: 'from prod', by: f.adminPrincipal });
      expect(out.fixture_id).toMatch(/^fx-[0-9a-z]{8}$/);
      expect(out.commit).toBe('n'.repeat(40));
      expect(cfg.commits).toHaveLength(1);
      const change = cfg.commits[0].changes[0];
      expect(change.path).toBe(fixturesPath(CIRCUIT));
      const doc = parse(change.content);
      expect(doc.schema).toBe(SCHEMA_TAGS.fixtures);
      expect(doc.circuit).toBe(CIRCUIT);
      expect(doc.fixtures).toEqual([
        { fixture_id: out.fixture_id, title: 'Prod case', source_session_id: s.session_id, input: { q: 'prod' }, pinned_context: [{ uid: NOTE, revision_id: 4 }], tags: ['regression'], notes: 'from prod' },
      ]);
    });

    it('appends to an existing manifest preserving comments', async () => {
      cfg.fixturesRaw = `# curated fixtures — keep sorted\nschema: ${SCHEMA_TAGS.fixtures}\ncircuit: ${CIRCUIT}\nfixtures:\n  - fixture_id: fx-a # the happy path\n    title: A\n    input: { q: a }\n    tags: [core]\n`;
      const s = await productionSession();
      const out = await svc.promoteFixture({ session_id: s.session_id, fixture_title: 'Second', tags: [], by: f.adminPrincipal });
      const content: string = cfg.commits[0].changes[0].content;
      expect(content).toContain('# curated fixtures — keep sorted');
      expect(content).toContain('# the happy path');
      expect(parse(content).fixtures.map((x: any) => x.fixture_id)).toEqual(['fx-a', out.fixture_id]);
    });

    it('requires a human and a circuit session', async () => {
      const s = await productionSession();
      const sub = { ...f.servicePrincipal, actor: { kind: 'subagent' as const, id: JUDGE }, grants: {} as any };
      await expect(svc.promoteFixture({ session_id: s.session_id, fixture_title: 'x', tags: [], by: sub })).rejects.toMatchObject({ code: 'grant-denied' });
      const chat = await store.create({ kind: 'intake', budget: { max_cost_usd: 1, max_tokens: 1, spent_usd: 0, spent_tokens: 0 }, created_by: f.adminPrincipal.actor });
      await expect(svc.promoteFixture({ session_id: chat.session_id, fixture_title: 'x', tags: [], by: f.adminPrincipal })).rejects.toMatchObject({ code: 'invalid-state' });
    });
  });
});
