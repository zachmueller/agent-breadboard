import type { BreadboardConfig, SessionRecord } from '@breadboard/shared';
import type { Dispatcher, Orchestrator, SessionStore, TaskService } from '../core/services.js';
import type { Logger } from '../core/logger.js';
import { isOrchestrated } from './orchestrator.js';

export interface DispatcherDeps {
  sessions: SessionStore;
  orchestrator: Orchestrator;
  settings: () => Promise<BreadboardConfig>;
  tasks: TaskService;
  log: Logger;
}

const HOUR_MS = 60 * 60 * 1000;
const STOP_GRACE_MS = 30_000;
const SCAN_LIMIT = 100;

/**
 * Admission control ([02] §4): queued sessions are admitted subject to
 *  1. `capacity.max_concurrent_runs` (top-level runs; sub-circuit children borrow their parent's slot,
 *     since the parent is blocked waiting on them and would otherwise deadlock the pool),
 *  2. the per-run budget (`max_cost_usd > spent_usd`), and
 *  3. the Breadboard-level spend window (`max_spend_usd_per_hour` over the last hour pauses admission).
 */
export class DispatcherImpl implements Dispatcher {
  /** In-flight run promises, keyed by session id, with the parent id for slot accounting. */
  private readonly inflight = new Map<string, { parent: string | null; promise: Promise<unknown> }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopped = false;
  private ticking: Promise<string[]> | null = null;
  private again = false;
  private subscribed = false;

  constructor(private readonly d: DispatcherDeps) {}

  start(): void {
    if (this.started && !this.stopped) return;
    this.started = true;
    this.stopped = false;
    if (!this.subscribed) {
      this.subscribed = true;
      this.d.orchestrator.onQueued(() => this.schedule());
    }
    void this.d
      .settings()
      .then((s) => {
        if (this.stopped) return;
        this.timer = setInterval(() => this.schedule(), Math.max(50, s.capacity.dispatch_interval_ms));
        this.timer.unref?.();
        this.schedule();
      })
      .catch((e) => this.d.log.error({ err: e }, 'dispatcher: reading settings failed; not started'));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const runs = [...this.inflight.values()].map((r) => r.promise);
    if (this.ticking) runs.push(this.ticking);
    if (!runs.length) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled(runs), new Promise<void>((r) => (t = setTimeout(r, STOP_GRACE_MS)))]);
    if (t) clearTimeout(t);
  }

  private schedule(): void {
    if (!this.started || this.stopped) return;
    void this.tick().catch((e) => this.d.log.error({ err: e }, 'dispatcher: tick failed'));
  }

  /** One admission pass. Concurrent calls coalesce: a tick requested mid-pass re-runs once it finishes. */
  async tick(): Promise<string[]> {
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      const admitted: string[] = [];
      try {
        do {
          this.again = false;
          admitted.push(...(await this.pass()));
        } while (this.again && !this.stopped);
      } finally {
        this.ticking = null;
      }
      return admitted;
    })();
    return this.ticking;
  }

  private async pass(): Promise<string[]> {
    try {
      await this.d.tasks.dispatchQueued();
    } catch (e) {
      this.d.log.warn({ err: e }, 'dispatcher: task dispatch failed');
    }
    const settings = await this.d.settings();
    const spend = await this.d.sessions.spendSince(new Date(Date.now() - HOUR_MS).toISOString());
    if (spend >= settings.capacity.max_spend_usd_per_hour) {
      this.d.log.debug({ spend, limit: settings.capacity.max_spend_usd_per_hour }, 'dispatcher: hourly spend ceiling reached; admission paused');
      return [];
    }
    const running = await this.liveSet();
    let roots = this.countRoots(running);
    const max = settings.capacity.max_concurrent_runs;
    const admitted: string[] = [];
    for (const s of await this.d.sessions.nextQueued(SCAN_LIMIT)) {
      if (this.stopped) break;
      if (this.d.orchestrator.isActive(s.session_id) || this.inflight.has(s.session_id)) continue;
      const borrows = !!s.parent_session && (running.has(s.parent_session) || this.d.orchestrator.isActive(s.parent_session));
      if (!borrows && roots >= max) continue;
      if (!(s.budget.max_cost_usd > s.budget.spent_usd)) {
        this.d.log.debug({ session_id: s.session_id }, 'dispatcher: per-run budget exhausted; not admitting');
        continue;
      }
      this.launch(s);
      running.set(s.session_id, s.parent_session ?? null);
      if (!borrows) roots++;
      admitted.push(s.session_id);
    }
    return admitted;
  }

  private launch(s: SessionRecord): void {
    const id = s.session_id;
    const promise = this.d.orchestrator
      .run(id)
      .catch((e) => this.d.log.error({ err: e, session_id: id }, 'dispatcher: run threw'))
      .finally(() => {
        this.inflight.delete(id);
        this.schedule();
      });
    this.inflight.set(id, { parent: s.parent_session ?? null, promise });
  }

  /** Running sessions (DB) plus in-flight launches, mapped to their parent ids. */
  private async liveSet(): Promise<Map<string, string | null>> {
    const m = new Map<string, string | null>();
    for (const s of (await this.d.sessions.running()).filter(isOrchestrated)) m.set(s.session_id, s.parent_session ?? null);
    for (const [id, r] of this.inflight) m.set(id, r.parent);
    return m;
  }

  /** Top-level slots in use: live sessions whose parent is not itself live. */
  private countRoots(live: Map<string, string | null>): number {
    let n = 0;
    for (const parent of live.values()) if (!parent || !live.has(parent)) n++;
    return n;
  }

  async capacity(): Promise<{ running: number; max_concurrent_runs: number; spend_last_hour_usd: number; max_spend_usd_per_hour: number; queued: number }> {
    const settings = await this.d.settings();
    const [live, spend, queued] = await Promise.all([this.liveSet(), this.d.sessions.spendSince(new Date(Date.now() - HOUR_MS).toISOString()), this.d.sessions.countByState('queued')]);
    return {
      running: this.countRoots(live),
      max_concurrent_runs: settings.capacity.max_concurrent_runs,
      spend_last_hour_usd: Math.round(spend * 1e6) / 1e6,
      max_spend_usd_per_hour: settings.capacity.max_spend_usd_per_hour,
      queued,
    };
  }
}

export function createDispatcher(deps: DispatcherDeps): DispatcherImpl {
  return new DispatcherImpl(deps);
}
