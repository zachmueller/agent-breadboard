import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SERVICE_ACTOR, mintUid, type Circuit } from '@breadboard/shared';
import { createKit, type Kit } from './testkit.js';

const BY = SERVICE_ACTOR('test');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function until(fn: () => Promise<boolean> | boolean, ms = 10000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('dispatcher: max_concurrent_runs and per-run budget', () => {
  let k: Kit;
  let circuit: Circuit;
  const tool = mintUid();
  const gates = new Map<string, ReturnType<typeof deferred>>();
  beforeAll(async () => {
    k = await createKit({ capacity: { max_concurrent_runs: 1, max_spend_usd_per_hour: 100, dispatch_interval_ms: 60000 } });
    k.tools.set(tool, async (_inp, inv) => {
      const d = gates.get(inv.session_id!) ?? deferred();
      gates.set(inv.session_id!, d);
      await d.promise;
      return { exit: 'ok', output: {} };
    });
    circuit = k.config.add({ slug: 'blocking', exits: [{ name: 'done' }], entry: 'work', steps: [{ id: 'work', kind: 'code', tool, exits: [{ name: 'ok', to: '$exit.done' }] }] });
  });
  afterAll(async () => k.close());

  it('admits at most max_concurrent_runs top-level sessions', async () => {
    const a = await k.orch.enqueue({ circuit_uid: circuit.uid, input: {}, created_by: BY, priority: 'p1' });
    const b = await k.orch.enqueue({ circuit_uid: circuit.uid, input: {}, created_by: BY });
    expect(await k.dispatcher.tick()).toEqual([a.session_id]);
    await until(() => gates.has(a.session_id));
    expect(await k.dispatcher.capacity()).toMatchObject({ running: 1, max_concurrent_runs: 1, queued: 1 });
    expect(await k.dispatcher.tick()).toEqual([]);
    gates.get(a.session_id)!.resolve();
    expect((await k.orch.waitFor(a.session_id, 10000)).state).toBe('completed');
    await until(async () => !k.orch.isActive(a.session_id));
    expect(await k.dispatcher.tick()).toEqual([b.session_id]);
    await until(() => gates.has(b.session_id));
    gates.get(b.session_id)!.resolve();
    expect((await k.orch.waitFor(b.session_id, 10000)).state).toBe('completed');
    await until(async () => (await k.dispatcher.capacity()).running === 0);
  });

  it('skips sessions whose per-run budget is spent', async () => {
    const s = await k.orch.enqueue({ circuit_uid: circuit.uid, input: {}, created_by: BY, budget: { max_cost_usd: 0.01, max_tokens: 1000 } });
    await k.sessions.update(s.session_id, { budget: { ...s.budget, spent_usd: 0.01 } });
    expect(await k.dispatcher.tick()).toEqual([]);
    await k.orch.cancel(s.session_id, k.f.adminPrincipal, 'cleanup');
  });

  it('sub-circuit children borrow their parent slot (no deadlock at max_concurrent_runs = 1)', async () => {
    const child = k.config.add({ slug: 'quick-child', exits: [{ name: 'ok' }], entry: 'w', steps: [{ id: 'w', kind: 'code', tool, exits: [{ name: 'ok', to: '$exit.ok' }] }] });
    const parent = k.config.add({ slug: 'wrapper', exits: [{ name: 'done' }], entry: 'sub', steps: [{ id: 'sub', kind: 'circuit', circuit: child.uid, exits: [{ name: 'ok', to: '$exit.done' }] }] });
    k.dispatcher.start();
    try {
      const p = await k.orch.enqueue({ circuit_uid: parent.uid, input: {}, created_by: BY });
      await until(async () => (await k.sessions.children(p.session_id)).length === 1);
      const [c] = await k.sessions.children(p.session_id);
      await until(() => gates.has(c!.session_id));
      expect((await k.dispatcher.capacity()).running).toBe(1);
      gates.get(c!.session_id)!.resolve();
      expect((await k.orch.waitFor(p.session_id, 10000)).state).toBe('completed');
    } finally {
      await k.dispatcher.stop();
    }
  });

  it('recover() re-queues interrupted running sessions and the dispatcher re-admits them', async () => {
    const s = await k.orch.enqueue({ circuit_uid: circuit.uid, input: {}, created_by: BY });
    // Simulate a crash mid-step: running state, a step-started event, and a running checkpoint.
    await k.sessions.update(s.session_id, { state: 'running', started_at: new Date().toISOString(), config_commit: k.config.main });
    await k.sessions.appendEvent(s.session_id, 'session-started', {});
    await k.sessions.appendEvent(s.session_id, 'config-resolved', { commit: k.config.main });
    await k.sessions.appendEvent(s.session_id, 'step-started', { step_id: 'work', attempt: 1, visit: 1, kind: 'code' }, 'work');
    await k.sessions.upsertCheckpoint({ session_id: s.session_id, step_id: 'work', attempt: 1, status: 'running', ambient: {}, visit: 1, kind: 'code' });

    expect(await k.orch.recover()).toBe(1);
    const q = await k.sessions.mustGet(s.session_id);
    expect(q.state).toBe('queued');
    expect(q.state_detail.recovered).toBe(true);
    expect((await k.sessions.checkpoints(s.session_id))[0]).toMatchObject({ status: 'failed', error: 'interrupted' });

    // A restarted dispatcher (start() after stop()) picks the recovered session up.
    k.dispatcher.start();
    await until(() => gates.has(s.session_id));
    gates.get(s.session_id)!.resolve();
    const done = await k.orch.waitFor(s.session_id, 10000);
    await k.dispatcher.stop();
    expect(done.state).toBe('completed');
    const cps = await k.sessions.checkpoints(s.session_id);
    expect(cps.map((c) => [Number(c.attempt), c.status])).toEqual([
      [1, 'failed'],
      [2, 'exited'],
    ]);
    const started = (await k.sessions.events(s.session_id)).filter((e) => e.event_type === 'session-started');
    expect(started).toHaveLength(1);
  });
});

describe('dispatcher: hourly spend window', () => {
  let k: Kit;
  let circuit: Circuit;
  beforeAll(async () => {
    k = await createKit({ capacity: { max_concurrent_runs: 4, max_spend_usd_per_hour: 0.015, dispatch_interval_ms: 60000 } });
    const sa = mintUid();
    k.llm.set(sa, () => ({ exit: 'done', output: {} }));
    circuit = k.config.add({ slug: 'spender', exits: [{ name: 'done' }], entry: 'think', steps: [{ id: 'think', kind: 'llm', subagent: sa, prompt_inline: 'go', output: { type: 'object' }, exits: [{ name: 'done', to: '$exit.done' }] }] });
  });
  afterAll(async () => k.close());

  it('pauses admission once spend in the last hour reaches max_spend_usd_per_hour', async () => {
    for (let i = 0; i < 2; i++) {
      const s = await k.orch.enqueue({ circuit_uid: circuit.uid, input: {}, created_by: BY });
      expect(await k.dispatcher.tick()).toEqual([s.session_id]);
      expect((await k.orch.waitFor(s.session_id, 10000)).state).toBe('completed');
      await until(() => !k.orch.isActive(s.session_id));
    }
    const third = await k.orch.enqueue({ circuit_uid: circuit.uid, input: {}, created_by: BY });
    expect(await k.dispatcher.tick()).toEqual([]);
    const cap = await k.dispatcher.capacity();
    expect(cap.spend_last_hour_usd).toBeCloseTo(0.02, 6);
    expect(cap).toMatchObject({ queued: 1, running: 0, max_spend_usd_per_hour: 0.015 });
    expect((await k.sessions.mustGet(third.session_id)).state).toBe('queued');
  });
});
