import {
  BreadboardError,
  SERVICE_ACTOR,
  SYSTEM_DEFS,
  circuitExitName,
  invalidState,
  isCircuitExitTarget,
  isUid,
  notFound,
  renderTemplate,
  requestTargetsUser,
  resolvePath,
  validateAgainst,
  validationFailed,
  type Actor,
  type ArtifactRef,
  type BreadboardConfig,
  type Circuit,
  type CircuitStep,
  type CodeStep,
  type GateStep,
  type LlmStep,
  type NeedInputRequest,
  type SessionBudget,
  type SessionEvent,
  type SessionRecord,
  type SessionState,
  type Step,
} from '@breadboard/shared';
import type {
  ChatMessage,
  ConfigService,
  ContentService,
  ConversationHooks,
  EnqueueRunInput,
  EventBus,
  LoadedCircuit,
  Orchestrator,
  SessionStore,
  SubagentRuntime,
  TaskService,
  Toolbox,
  ToolSpec,
} from '../core/services.js';
import type { Logger } from '../core/logger.js';
import { servicePrincipal, type Principal } from '../core/principal.js';
import type { NodeStore } from '../content/nodes.js';
import type { EdgeStore } from '../content/edges.js';
import type { SessionRow } from './session-store.js';

export interface OrchestratorDeps {
  sessions: SessionStore;
  config: ConfigService;
  subagents: SubagentRuntime;
  toolbox: Toolbox;
  content: ContentService;
  tasks: TaskService;
  events: EventBus;
  nodes: NodeStore;
  edges: EdgeStore;
  log: Logger;
  team_id: string;
  settings: () => Promise<BreadboardConfig>;
  /** Tests: retry backoff collapses to 0 ms. */
  fastRetries?: boolean;
}

export const FINISH_TOOL = 'breadboard_finish';
const ACTOR = SERVICE_ACTOR('orchestrator');
const LIVE_STATES: readonly SessionState[] = ['queued', 'running'];
/** state_detail keys that survive every state transition (admission parameters). */
const PRESERVED_KEYS = ['config_ref', 'pinned_context'] as const;
const LOG_CAP = 50;

/** A step attempt failed; consumes one retry attempt (or suspends immediately when not retryable). */
class StepFailure extends Error {
  constructor(
    message: string,
    readonly detail: Record<string, unknown> = {},
    readonly retryable = true,
    readonly reason = 'step-failed',
  ) {
    super(message);
  }
}
class BudgetExhausted extends Error {
  constructor(readonly remaining: { remaining_usd: number; remaining_tokens: number }) {
    super('session budget exhausted');
  }
}
/** The session was cancelled underneath the run loop; stop quietly. */
class CancelledSignal extends Error {
  constructor() {
    super('session cancelled');
  }
}

type StepResult = { kind: 'exit'; exit: string; output: unknown } | { kind: 'suspended'; session: SessionRecord };

interface Cursor {
  step_id: string;
  attempt: number;
  visit: number;
  status: 'running' | 'exited' | 'failed';
  exit?: string | null;
  output?: unknown;
  child_session_id?: string | null;
}

interface RunCtx {
  session: SessionRow;
  loaded: LoadedCircuit;
  circuit: Circuit;
  commit: string;
  settings: BreadboardConfig;
  input: unknown;
  steps: Record<string, { output: unknown; exit: string }>;
  visits: Map<string, number>;
  maxAttempt: Map<string, number>;
  artifacts: ArtifactRef[];
  pinned: ArtifactRef[];
  task: ArtifactRef | null;
  budget: { remaining_usd: number; remaining_tokens: number };
  family: string[];
}

type Position = { kind: 'step'; step: Step; newVisit: boolean; visit?: number; attempt?: number; reattach?: string | null } | { kind: 'complete'; exit: string; output: unknown };

const asRow = (s: SessionRecord) => s as SessionRow;
const nowIso = () => new Date().toISOString();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function preserve(detail: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PRESERVED_KEYS) if (detail && detail[k] !== undefined && detail[k] !== null) out[k] = detail[k];
  return out;
}

function isRef(v: unknown): v is ArtifactRef {
  return !!v && typeof v === 'object' && !Array.isArray(v) && isUid((v as any).uid) && Number.isInteger((v as any).revision_id);
}

/** Every `{uid, revision_id}` object anywhere in a value. */
function collectRefs(v: unknown, out: ArtifactRef[] = [], depth = 0): ArtifactRef[] {
  if (depth > 32 || v == null || typeof v !== 'object') return out;
  if (isRef(v)) {
    out.push({ uid: v.uid, revision_id: v.revision_id });
    return out;
  }
  for (const x of Array.isArray(v) ? v : Object.values(v)) collectRefs(x, out, depth + 1);
  return out;
}

function dedupeRefs(refs: ArtifactRef[]): ArtifactRef[] {
  const m = new Map<string, number>();
  for (const r of refs) m.set(r.uid, Math.max(m.get(r.uid) ?? -1, r.revision_id));
  return [...m].map(([uid, revision_id]) => ({ uid, revision_id }));
}

/** Resolve an input_map value: `$`-prefixed strings are paths into the template context; objects/arrays recurse; else literal. */
function mapValue(v: unknown, scope: Record<string, unknown>): unknown {
  if (typeof v === 'string') return v.startsWith('$') ? resolvePath(v, [scope]) : v;
  if (Array.isArray(v)) return v.map((x) => mapValue(x, scope));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapValue(x, scope)]));
  return v;
}

/** Finish-tool input schema: `{exit, output}`; nested `defs` hoisted to the root so `#/defs/...` refs resolve. */
export function finishToolSchema(step: { exits: Array<{ name: string }>; output: Record<string, any> }): Record<string, any> {
  const { defs, $defs, ...output } = step.output ?? {};
  return {
    type: 'object',
    required: ['exit', 'output'],
    additionalProperties: false,
    properties: {
      exit: { type: 'string', enum: step.exits.map((e) => e.name) },
      output: Object.keys(output).length ? output : { type: 'object' },
    },
    defs: { ...SYSTEM_DEFS, ...(defs ?? {}), ...($defs ?? {}) },
  };
}

function lastSegment(expr: string): string {
  const segs = expr.replace(/^\$/, '').split('.').filter(Boolean);
  return segs[segs.length - 1] ?? 'artifacts';
}

/**
 * The orchestrator ([02]): event-sourced circuit execution with step-boundary checkpoints, retries, hard
 * gates, sub-circuit sessions, and budget enforcement. `session_events` is authoritative; resume state
 * (step outputs, visit counts, the current position) is rebuilt from it on every admission.
 */
export class OrchestratorImpl implements Orchestrator {
  private readonly active = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly queuedListeners: Array<(id: string) => void> = [];
  private readonly finishedListeners: Array<(id: string) => void> = [];
  private readonly gateLocks = new Map<string, Promise<unknown>>();
  private readonly svc: Principal;

  constructor(private readonly d: OrchestratorDeps) {
    this.svc = servicePrincipal(d.team_id, 'orchestrator');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async enqueue(input: EnqueueRunInput): Promise<SessionRecord> {
    if (!input.circuit_uid) throw validationFailed('circuit_uid required');
    const settings = await this.d.settings();
    const loaded = await this.d.config.circuit(input.circuit_uid, input.config_ref ?? undefined);
    const circuit = loaded.circuit;
    let max_cost_usd = Number(input.budget?.max_cost_usd ?? circuit.budget?.max_cost_usd ?? settings.defaults.budget.max_cost_usd);
    let max_tokens = Number(input.budget?.max_tokens ?? circuit.budget?.max_tokens ?? settings.defaults.budget.max_tokens);
    let parent: SessionRow | null = null;
    if (input.parent_session) {
      parent = asRow(await this.d.sessions.mustGet(input.parent_session));
      const rem = await this.remaining(parent);
      if (rem.remaining_usd <= 0 || rem.remaining_tokens <= 0) throw new BreadboardError('budget-exceeded', `parent session ${parent.session_id} has no budget left for a sub-circuit`, rem);
      max_cost_usd = Math.min(max_cost_usd, rem.remaining_usd);
      max_tokens = Math.min(max_tokens, Math.floor(rem.remaining_tokens));
    }
    const detail: Record<string, unknown> = {};
    if (input.config_ref) detail.config_ref = input.config_ref;
    if (input.pinned_context?.length) detail.pinned_context = input.pinned_context;
    const s = await this.d.sessions.create({
      kind: input.kind ?? 'circuit-run',
      circuit_uid: circuit.uid,
      circuit_slug: circuit.slug,
      // Only an explicit ref pins the commit at enqueue; otherwise main is resolved at admission ([02] §3).
      config_commit: input.config_ref ? loaded.commit : null,
      task_uid: input.task_uid ?? null,
      parent_session: input.parent_session ?? null,
      parent_step_id: input.parent_step_id ?? null,
      budget: { max_cost_usd, max_tokens, spent_usd: 0, spent_tokens: 0 },
      priority: input.priority ?? parent?.priority ?? 'p2',
      input: input.input ?? {},
      model_overrides: input.model_overrides ?? parent?.model_overrides ?? null,
      created_by: input.created_by,
      state: 'queued',
      state_detail: detail,
    });
    await this.publishState(s);
    this.notifyQueued(s.session_id);
    return s;
  }

  async run(sessionId: string): Promise<SessionRecord> {
    if (this.active.has(sessionId)) return this.d.sessions.mustGet(sessionId);
    this.active.add(sessionId);
    try {
      const s = asRow(await this.d.sessions.mustGet(sessionId));
      if (!LIVE_STATES.includes(s.state)) return s;
      return await this.execute(s);
    } catch (e) {
      if (e instanceof CancelledSignal) return this.d.sessions.mustGet(sessionId);
      this.d.log.error({ err: e, session_id: sessionId }, 'orchestrator: run failed');
      try {
        const cur = await this.d.sessions.mustGet(sessionId);
        if (cur.state === 'cancelled' || cur.state === 'completed') return cur;
        return await this.suspendError(asRow(cur), 'internal-error', { error: errMsg(e) });
      } catch (e2) {
        if (e2 instanceof CancelledSignal) return this.d.sessions.mustGet(sessionId);
        throw e2;
      }
    } finally {
      this.active.delete(sessionId);
      for (const fn of this.finishedListeners) {
        try {
          fn(sessionId);
        } catch {
          /* listener errors never break runs */
        }
      }
    }
  }

  async retry(sessionId: string, by: Principal): Promise<SessionRecord> {
    const s = asRow(await this.d.sessions.mustGet(sessionId));
    if (s.state !== 'suspended-error') throw invalidState(`session ${sessionId} is ${s.state}; only suspended-error sessions can be retried`);
    // Re-resolve config ([02] §5.3): fixes merged since the failure apply to the retry. An explicitly pinned ref stays pinned.
    const ref = typeof s.state_detail.config_ref === 'string' ? (s.state_detail.config_ref as string) : null;
    const commit = ref ? (await this.d.config.circuit(s.circuit_uid!, ref)).commit : await this.d.config.mainCommit();
    await this.d.sessions.update(sessionId, { config_commit: commit });
    await this.event(sessionId, 'config-resolved', { commit, ref: ref ?? 'main', reason: 'retry' });
    // A parent stuck behind a failed child: retry the child; the parent re-attaches to it.
    const childId = typeof s.state_detail.child_session_id === 'string' ? (s.state_detail.child_session_id as string) : null;
    if (childId) {
      const child = await this.d.sessions.get(childId);
      if (child?.state === 'suspended-error') await this.retry(childId, by);
    }
    await this.event(sessionId, 'session-resumed', { reason: 'retry', by: by.actor, previous: s.state_detail.reason ?? null });
    return this.transition(sessionId, { state: 'queued', state_detail: { ...preserve(s.state_detail), resumed_from: 'retry' } });
  }

  async cancel(sessionId: string, by: Principal, reason?: string): Promise<SessionRecord> {
    const s = asRow(await this.d.sessions.mustGet(sessionId));
    if (s.state === 'completed' || s.state === 'cancelled') throw invalidState(`session ${sessionId} is already ${s.state}`);
    await this.event(sessionId, 'session-cancelled', { reason: reason ?? null, by: by.actor, previous_state: s.state });
    const out = await this.transition(sessionId, { state: 'cancelled', ended_at: nowIso(), state_detail: { ...preserve(s.state_detail), reason: 'cancelled', cancel_reason: reason ?? null, cancelled_by: by.actor, previous_state: s.state } }, { force: true });
    for (const child of await this.d.sessions.children(sessionId)) {
      if (child.state !== 'completed' && child.state !== 'cancelled') {
        await this.cancel(child.session_id, by, reason ?? `parent ${sessionId} cancelled`).catch((e) => this.d.log.warn({ err: e, session_id: child.session_id }, 'cascade cancel failed'));
      }
    }
    // The task keeps its status; a tag records the cancellation ([02] §5.3).
    if (s.task_uid && !s.parent_session) {
      await this.d.nodes.patch(s.task_uid, { tags_add: ['run-cancelled'] }).catch((e) => this.d.log.warn({ err: e, task_uid: s.task_uid }, 'tagging cancelled task failed'));
    }
    return out;
  }

  async resume(sessionId: string, by: Principal, opts: { budget?: Partial<SessionBudget> } = {}): Promise<SessionRecord> {
    const s = asRow(await this.d.sessions.mustGet(sessionId));
    if (s.state !== 'suspended-error') throw invalidState(`session ${sessionId} is ${s.state}; only suspended-error sessions can be resumed`);
    const b = { ...s.budget };
    if (opts.budget?.max_cost_usd != null) {
      if (!(Number(opts.budget.max_cost_usd) > 0)) throw validationFailed('budget.max_cost_usd must be positive');
      b.max_cost_usd = Number(opts.budget.max_cost_usd);
    }
    if (opts.budget?.max_tokens != null) {
      if (!(Number(opts.budget.max_tokens) > 0)) throw validationFailed('budget.max_tokens must be positive');
      b.max_tokens = Math.floor(Number(opts.budget.max_tokens));
    }
    const spent = await this.treeCost(sessionId);
    const rem = { remaining_usd: b.max_cost_usd - spent.cost_usd, remaining_tokens: b.max_tokens - spent.tokens };
    if (rem.remaining_usd <= 0 || rem.remaining_tokens <= 0) throw validationFailed('budget is still exhausted; raise max_cost_usd / max_tokens above spend', { ...rem, budget: b });
    await this.d.sessions.update(sessionId, { budget: b });
    await this.event(sessionId, 'session-resumed', { reason: 'resume', by: by.actor, budget: b, previous: s.state_detail.reason ?? null });
    return this.transition(sessionId, { state: 'queued', state_detail: { ...preserve(s.state_detail), resumed_from: 'resume' } });
  }

  async manualRoute(sessionId: string, exitName: string, output: unknown, by: Principal): Promise<SessionRecord> {
    const s = asRow(await this.d.sessions.mustGet(sessionId));
    if (s.state !== 'suspended-error') throw invalidState(`session ${sessionId} is ${s.state}; manual routing applies to suspended-error sessions`);
    const rb = await this.rebuild(sessionId);
    if (!rb.cur) throw invalidState('the session failed before entering a step; fix the cause and retry');
    const loaded = await this.d.config.circuit(s.circuit_uid!, s.config_commit ?? undefined);
    // The stuck step: the failed step itself, or (when the last step exited, e.g. max-visits) the step it routed to.
    let stuckId = rb.cur.step_id;
    let attempt = rb.cur.attempt;
    let visit = rb.cur.visit;
    if (rb.cur.status === 'exited') {
      const prev = loaded.circuit.steps.find((x) => x.id === rb.cur!.step_id);
      const to = prev?.exits.find((e) => e.name === rb.cur!.exit)?.to;
      if (!to || isCircuitExitTarget(to)) throw invalidState('no stuck step to route; use retry');
      stuckId = to;
      attempt = (rb.maxAttempt.get(to) ?? 0) + 1;
      visit = rb.visits.get(to) ?? 1;
    }
    const step = loaded.circuit.steps.find((x) => x.id === stuckId);
    if (!step) throw invalidState(`step ${stuckId} no longer exists in circuit ${loaded.circuit.slug}`);
    const exitDef = step.exits.find((e) => e.name === exitName);
    if (!exitDef) throw validationFailed(`step ${step.id} has no exit '${exitName}' (exits: ${step.exits.map((e) => e.name).join(', ')})`);
    const schema = 'output' in step ? (step.output as Record<string, any> | undefined) : undefined;
    const v = validateAgainst(schema, output ?? {});
    if (!v.ok) throw validationFailed(`output does not match step ${step.id} output schema`, { errors: v.errors });
    let out = v.value;
    if (isCircuitExitTarget(exitDef.to)) {
      const cx = loaded.circuit.exits.find((e) => e.name === circuitExitName(exitDef.to));
      const cv = validateAgainst(cx?.output, out);
      if (!cv.ok) throw validationFailed(`output does not match circuit exit '${cx?.name}' schema`, { errors: cv.errors });
      out = cv.value;
    }
    await this.event(sessionId, 'manual-route', { step_id: step.id, attempt, visit, exit: exitName, output: out, by: by.actor }, step.id);
    await this.event(sessionId, 'checkpoint', { step_id: step.id, attempt, visit, status: 'exited', exit: exitName, output: out, manual: true }, step.id);
    await this.d.sessions.upsertCheckpoint({ session_id: sessionId, step_id: step.id, attempt, status: 'exited', exit_name: exitName, output: out, ambient: {}, visit, kind: step.kind, ended: true });
    await this.event(sessionId, 'session-resumed', { reason: 'manual-route', by: by.actor });
    return this.transition(sessionId, { state: 'queued', state_detail: { ...preserve(s.state_detail), resumed_from: 'manual-route' } });
  }

  async gateVerdict(input: { node_uid: string; request_id: string; verdict: 'approve' | 'request-changes'; comment?: string | null; edits?: unknown; by: Principal }): Promise<{ resolved: boolean; session_id: string }> {
    const { by } = input;
    if (input.verdict !== 'approve' && input.verdict !== 'request-changes') throw validationFailed('verdict must be approve|request-changes');
    const node = await this.d.nodes.get(input.node_uid);
    if (!node) throw notFound('node', input.node_uid);
    const open = (Array.isArray(node.properties?.['need-input']) ? node.properties['need-input'] : []) as NeedInputRequest[];
    const history = (Array.isArray(node.properties?.['need-input-history']) ? node.properties['need-input-history'] : []) as NeedInputRequest[];
    let req = open.find((r) => r.request_id === input.request_id) ?? null;
    if (!req) {
      if (history.some((r) => r.request_id === input.request_id)) throw new BreadboardError('conflict', `request ${input.request_id} already has a verdict`);
      throw notFound('need-input request', input.request_id);
    }
    if (!req.gate) throw invalidState(`request ${input.request_id} was not created by a gate; resolve it via POST /nodes/${input.node_uid}/resolve-need-input`);
    const sessionId = req.gate.session_id;
    return this.withGateLock(sessionId, async () => {
      const s = asRow(await this.d.sessions.mustGet(sessionId));
      const detail = s.state_detail as Record<string, any>;
      if (s.state !== 'suspended-gate' || detail.reason !== 'gate' || detail.step_id !== req!.gate!.step_id) throw invalidState(`session ${sessionId} is not suspended at gate ${req!.gate!.step_id}`);
      const requests = (detail.requests ?? []) as Array<{ request_id: string; uid: string; role: string | null; username: string | null }>;
      if (!requests.some((r) => r.request_id === input.request_id)) throw invalidState(`request ${input.request_id} does not belong to the current gate`);
      const verdicts = (detail.verdicts ?? []) as Array<Record<string, any>>;
      if (verdicts.some((v) => v.request_id === input.request_id)) throw new BreadboardError('conflict', `request ${input.request_id} already has a verdict`);
      // Targeting ([02] §5.4): only targeted reviewers record verdicts; there is no admin bypass on gates.
      if (by.actor.kind !== 'service') {
        if (!by.user || !requestTargetsUser(req!, { handle: by.user.handle, roles: by.roles })) {
          throw new BreadboardError('forbidden', `request ${input.request_id} targets ${[req!.role && `role=${req!.role}`, req!.username && `username=${req!.username}`].filter(Boolean).join(',') || 'nobody'}`);
        }
      }
      const loaded = await this.d.config.circuit(s.circuit_uid!, s.config_commit ?? undefined);
      const step = loaded.circuit.steps.find((x) => x.id === detail.step_id);
      if (!step || step.kind !== 'gate') throw invalidState(`gate step ${detail.step_id} not found in circuit at ${s.config_commit}`);
      if (input.edits !== undefined && input.edits !== null) {
        if (input.verdict !== 'request-changes') throw validationFailed('edits are only accepted with a request-changes verdict');
        if (typeof input.edits !== 'object' || Array.isArray(input.edits)) throw validationFailed('edits must be an object merged into the gate output');
        const candidate = { ...(detail.passthrough ?? {}), feedback: [], ...(input.edits as object) };
        const v = validateAgainst(step.output, candidate);
        if (!v.ok) throw validationFailed(`edits do not satisfy gate ${step.id} output schema`, { errors: v.errors });
      }
      await this.d.content.resolveNeedInput({ uid: input.node_uid, request_id: input.request_id, by, verdict: input.verdict, comment: input.comment ?? null });
      const rec = { request_id: input.request_id, uid: input.node_uid, verdict: input.verdict, comment: input.comment ?? null, edits: input.edits ?? null, by: by.actor, at: nowIso() };
      await this.event(sessionId, 'gate-verdict', rec, step.id);
      const all = [...verdicts, rec];
      const nextDetail = { ...detail, verdicts: all };
      const complete = requests.every((r) => all.some((v) => v.request_id === r.request_id));
      if (!complete) {
        await this.d.sessions.update(sessionId, { state_detail: nextDetail });
        return { resolved: false, session_id: sessionId };
      }
      await this.resolveGate(s, step, nextDetail);
      return { resolved: true, session_id: sessionId };
    });
  }

  async waitFor(sessionId: string, timeoutMs?: number): Promise<SessionRecord> {
    const deadline = timeoutMs != null && timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
    for (;;) {
      const s = await this.d.sessions.mustGet(sessionId);
      if (!LIVE_STATES.includes(s.state)) return s;
      const left = deadline - Date.now();
      if (left <= 0) return s;
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(sessionId) ?? new Set();
        this.waiters.set(sessionId, set);
        const done = () => {
          clearTimeout(t);
          set.delete(done);
          if (!set.size) this.waiters.delete(sessionId);
          resolve();
        };
        const t = setTimeout(done, Math.min(500, left));
        set.add(done);
      });
    }
  }

  async recover(): Promise<number> {
    let n = 0;
    for (const s of await this.d.sessions.running()) {
      if (this.active.has(s.session_id)) continue;
      for (const cp of await this.d.sessions.checkpoints(s.session_id)) {
        if (cp.status !== 'running') continue;
        // A circuit step waiting on a child keeps its checkpoint so the parent re-attaches to the child.
        if (cp.kind === 'circuit' && cp.child_session_id) continue;
        await this.d.sessions.upsertCheckpoint({ session_id: s.session_id, step_id: cp.step_id, attempt: Number(cp.attempt), status: 'failed', ambient: cp.ambient ?? {}, error: 'interrupted', ended: true });
        await this.event(s.session_id, 'step-failed', { step_id: cp.step_id, attempt: Number(cp.attempt), visit: Number(cp.visit ?? 1), error: 'interrupted', retryable: true }, cp.step_id);
      }
      await this.event(s.session_id, 'session-resumed', { reason: 'recovery' });
      await this.transition(s.session_id, { state: 'queued', state_detail: { ...preserve(s.state_detail), recovered: true } });
      n++;
    }
    return n;
  }

  onQueued(fn: (sessionId: string) => void): void {
    this.queuedListeners.push(fn);
  }

  /** Extra: notified whenever a `run()` call returns (the dispatcher uses it to free capacity promptly). */
  onRunFinished(fn: (sessionId: string) => void): void {
    this.finishedListeners.push(fn);
  }

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  private async execute(s0: SessionRow): Promise<SessionRecord> {
    const id = s0.session_id;
    const settings = await this.d.settings();
    const first = !s0.started_at;
    const commit = s0.config_commit ?? (await this.d.config.mainCommit());
    let s = asRow(
      await this.transition(id, {
        state: 'running',
        state_detail: preserve(s0.state_detail),
        ...(first ? { started_at: nowIso() } : {}),
        ...(s0.config_commit ? {} : { config_commit: commit }),
      }),
    );
    if (first) {
      await this.event(id, 'session-started', { kind: s.kind, circuit_uid: s.circuit_uid, task_uid: s.task_uid, parent_session: s.parent_session, parent_step_id: s.parent_step_id, budget: s.budget, created_by: s.created_by });
      await this.event(id, 'config-resolved', { commit, ref: (s.state_detail.config_ref as string | undefined) ?? 'main' });
    }
    let loaded: LoadedCircuit;
    try {
      loaded = await this.d.config.circuit(s.circuit_uid!, commit);
    } catch (e) {
      return this.suspendError(s, 'config-error', { error: errMsg(e), commit });
    }
    const circuit = loaded.circuit;
    const iv = validateAgainst(circuit.input, s.input ?? {});
    if (!iv.ok) return this.suspendError(s, 'input-invalid', { errors: iv.errors });

    const triage = settings.intake.triage_circuit === circuit.uid || circuit.tags.includes('triage');
    if (first && s.task_uid) {
      if (!s.parent_session) await this.taskStatus(s.task_uid, triage ? 'triaging' : 'active', { session_id: id });
      else if (!triage) await this.taskStatus(s.task_uid, 'active', { session_id: id });
    }

    const rb = await this.rebuild(id);
    const pinned = Array.isArray(s.state_detail.pinned_context) ? (s.state_detail.pinned_context as ArtifactRef[]).filter(isRef) : [];
    const ctx: RunCtx = {
      session: s,
      loaded,
      circuit,
      commit,
      settings,
      input: iv.value,
      steps: rb.steps,
      visits: rb.visits,
      maxAttempt: rb.maxAttempt,
      artifacts: [],
      pinned,
      task: await this.taskRef(s),
      budget: await this.remaining(s),
      family: await this.d.sessions.family(id),
    };
    ctx.artifacts = await this.sessionArtifacts(id, pinned);

    let pos: Position;
    const cur = rb.cur;
    if (!cur) {
      pos = { kind: 'step', step: this.stepById(circuit, circuit.entry), newVisit: true };
    } else if (cur.status === 'exited') {
      const step = circuit.steps.find((x) => x.id === cur.step_id);
      if (!step) return this.suspendError(s, 'config-error', { error: `step ${cur.step_id} not found in circuit at ${commit}` });
      pos = this.route(circuit, step, cur.exit!, cur.output);
    } else {
      const step = circuit.steps.find((x) => x.id === cur.step_id);
      if (!step) return this.suspendError(s, 'config-error', { error: `step ${cur.step_id} not found in circuit at ${commit}` });
      let reattach: string | null = null;
      if (step.kind === 'circuit' && cur.child_session_id) {
        const child = await this.d.sessions.get(cur.child_session_id);
        if (child && child.state !== 'cancelled') reattach = child.session_id;
      }
      pos = reattach
        ? { kind: 'step', step, newVisit: false, visit: cur.visit, attempt: cur.attempt, reattach }
        : { kind: 'step', step, newVisit: false, visit: cur.visit, attempt: (ctx.maxAttempt.get(step.id) ?? cur.attempt) + 1 };
    }
    return this.loop(ctx, pos);
  }

  private route(circuit: Circuit, step: Step, exit: string, output: unknown): Position {
    const ex = step.exits.find((e) => e.name === exit);
    if (!ex) throw new StepFailure(`step ${step.id} has no exit '${exit}'`);
    if (isCircuitExitTarget(ex.to)) return { kind: 'complete', exit: circuitExitName(ex.to), output };
    return { kind: 'step', step: this.stepById(circuit, ex.to), newVisit: true };
  }

  private stepById(circuit: Circuit, id: string): Step {
    const st = circuit.steps.find((x) => x.id === id);
    if (!st) throw new BreadboardError('internal', `circuit ${circuit.slug} has no step '${id}'`);
    return st;
  }

  private async loop(ctx: RunCtx, start: Position): Promise<SessionRecord> {
    let pos = start;
    for (;;) {
      if (pos.kind === 'complete') return this.complete(ctx, pos.exit, pos.output);
      const step = pos.step;
      let visit = pos.visit ?? ctx.visits.get(step.id) ?? 1;
      if (pos.newVisit) {
        visit = (ctx.visits.get(step.id) ?? 0) + 1;
        const limit = step.max_visits ?? ctx.settings.defaults.max_visits;
        if (visit > limit) return this.suspendError(ctx.session, 'max-visits-exceeded', { step_id: step.id, visits: visit - 1, max_visits: limit });
        ctx.visits.set(step.id, visit);
      }
      const attempt = pos.attempt ?? (ctx.maxAttempt.get(step.id) ?? 0) + 1;
      const r = await this.runWithRetries(ctx, step, visit, attempt, pos.reattach ?? null);
      if (r.kind === 'suspended') return r.session;
      pos = this.route(ctx.circuit, step, r.exit, r.output);
    }
  }

  private async runWithRetries(ctx: RunCtx, step: Step, visit: number, firstAttempt: number, reattach: string | null): Promise<StepResult> {
    const id = ctx.session.session_id;
    const policy = step.retry ?? ctx.settings.defaults.retry;
    let tries = 0;
    let attempt = firstAttempt;
    for (;;) {
      tries++;
      ctx.maxAttempt.set(step.id, Math.max(ctx.maxAttempt.get(step.id) ?? 0, attempt));
      await this.assertNotCancelled(id);
      try {
        await this.ensureBudget(ctx);
        if (!reattach) {
          await this.event(id, 'step-started', { step_id: step.id, attempt, visit, kind: step.kind }, step.id);
          await this.d.sessions.upsertCheckpoint({ session_id: id, step_id: step.id, attempt, status: 'running', ambient: this.ambient(ctx), visit, kind: step.kind });
        }
        const r = await this.runStep(ctx, step, attempt, visit, reattach);
        reattach = null;
        if (r.kind === 'suspended') return r;
        const exitDef = step.exits.find((e) => e.name === r.exit);
        if (!exitDef) throw new StepFailure(`step ${step.id} returned undeclared exit '${r.exit}'`, { exits: step.exits.map((e) => e.name) });
        let output = r.output;
        if (isCircuitExitTarget(exitDef.to)) {
          const cx = ctx.circuit.exits.find((e) => e.name === circuitExitName(exitDef.to));
          const cv = validateAgainst(cx?.output, output);
          if (!cv.ok) throw new StepFailure(`output does not satisfy circuit exit '${circuitExitName(exitDef.to)}' schema`, { errors: cv.errors });
          output = cv.value;
        }
        await this.checkRefs(ctx, output);
        await this.finishStep(ctx, step, attempt, visit, r.exit, exitDef.to, output);
        return { kind: 'exit', exit: r.exit, output };
      } catch (e) {
        reattach = null;
        if (e instanceof CancelledSignal) throw e;
        if (e instanceof BudgetExhausted || (e instanceof BreadboardError && e.code === 'budget-exceeded')) {
          const rem = e instanceof BudgetExhausted ? e.remaining : await this.remaining(ctx.session);
          await this.d.sessions.upsertCheckpoint({ session_id: id, step_id: step.id, attempt, status: 'failed', ambient: this.ambient(ctx), error: 'budget-exceeded', ended: true });
          await this.event(id, 'budget-exceeded', { step_id: step.id, attempt, ...rem, budget: (await this.d.sessions.mustGet(id)).budget }, step.id);
          return { kind: 'suspended', session: await this.suspendError(ctx.session, 'budget-exceeded', { step_id: step.id, ...rem }) };
        }
        const f = e instanceof StepFailure ? e : new StepFailure(errMsg(e), e instanceof BreadboardError ? { code: e.code, detail: e.detail } : {});
        await this.event(id, 'step-failed', { step_id: step.id, attempt, visit, error: f.message, detail: f.detail, retryable: f.retryable }, step.id);
        await this.d.sessions.upsertCheckpoint({ session_id: id, step_id: step.id, attempt, status: 'failed', ambient: this.ambient(ctx), error: f.message, ended: true });
        if (!f.retryable) return { kind: 'suspended', session: await this.suspendError(ctx.session, f.reason, { step_id: step.id, attempt, error: f.message, ...f.detail }) };
        if (tries >= policy.max_attempts) return { kind: 'suspended', session: await this.suspendError(ctx.session, 'retries-exhausted', { step_id: step.id, attempts: tries, attempt, error: f.message, detail: f.detail }) };
        const delay = this.d.fastRetries ? 0 : Math.min(policy.backoff.cap_s, policy.backoff.base_s * 2 ** (tries - 1)) * 1000;
        await this.event(id, 'retry-scheduled', { step_id: step.id, attempt: attempt + 1, after_attempt: attempt, delay_ms: delay }, step.id);
        if (delay > 0) await sleep(delay);
        attempt = Math.max(ctx.maxAttempt.get(step.id) ?? attempt, attempt) + 1;
      }
    }
  }

  private runStep(ctx: RunCtx, step: Step, attempt: number, visit: number, reattach: string | null): Promise<StepResult> {
    switch (step.kind) {
      case 'llm':
        return this.runLlm(ctx, step, attempt);
      case 'code':
        return this.runCode(ctx, step, attempt);
      case 'circuit':
        return this.runCircuitStep(ctx, step, attempt, visit, reattach);
      case 'gate':
        return this.runGate(ctx, step, attempt, visit);
    }
  }

  // --- llm --------------------------------------------------------------------

  private async runLlm(ctx: RunCtx, step: LlmStep, attempt: number): Promise<StepResult> {
    const id = ctx.session.session_id;
    const src = step.prompt_inline ?? (step.prompt ? ctx.loaded.prompts[step.prompt] : undefined);
    if (src === undefined) throw new StepFailure(`prompt template ${step.prompt ?? '(none)'} not found at ${ctx.commit}`, {}, false, 'config-error');
    const rendered = renderTemplate(src, this.templateCtx(ctx));
    const resolved = await this.d.subagents.resolve(step.subagent, ctx.commit, { session_id: id, extra_read_domains: ctx.circuit.knowledge?.read ?? [] });
    const principal = this.d.subagents.principalFor(resolved, id, `${step.id}#${attempt}`, ctx.family);
    if (resolved.injected_notes?.length) await this.event(id, 'knowledge-injected', { step_id: step.id, attempt, notes: resolved.injected_notes, source: 'system-prompt' }, step.id);
    const finish: ToolSpec = {
      name: FINISH_TOOL,
      description: `Finish this step. Choose one exit (${step.exits.map((e) => (e.description ? `${e.name}: ${e.description}` : e.name)).join('; ')}) and provide the step output matching the output schema.`,
      input_schema: finishToolSchema(step),
    };
    const record = async (role: 'user' | 'system', text: string) => {
      await this.d.sessions.recordTurn({ session_id: id, step_id: step.id, attempt, role, username: null, content: [{ type: 'text', text }], model_id: null, tokens_in: null, tokens_out: null, cost_usd: null });
      await this.publishEvent(id, 'turn', step.id);
    };
    const hooks: ConversationHooks = {
      onTurn: async (t) => {
        await this.d.sessions.recordTurn({
          session_id: id,
          step_id: step.id,
          attempt,
          role: t.role,
          username: t.username ?? null,
          content: t.content,
          model_id: t.model_id ?? null,
          tokens_in: t.usage?.input_tokens ?? null,
          tokens_out: t.usage?.output_tokens ?? null,
          cost_usd: t.cost_usd ?? null,
          latency_ms: t.latency_ms ?? null,
          fallback_from: t.fallback_from ?? null,
        });
        await this.publishEvent(id, 'turn', step.id);
        const c = t.content as any;
        if (t.role === 'system' && c && typeof c === 'object' && c.kind === 'knowledge-injected') await this.event(id, 'knowledge-injected', { step_id: step.id, attempt, ...c }, step.id);
      },
      onToolCall: async (c) => {
        await this.event(id, 'tool-call', { step_id: step.id, attempt, id: c.id, name: c.name }, step.id);
      },
      onToolResult: async (r) => {
        await this.event(id, 'tool-result', { step_id: step.id, attempt, id: r.id, name: r.name, is_error: r.is_error }, step.id);
      },
      checkBudget: async () => {
        await this.assertNotCancelled(id);
        await this.ensureBudget(ctx);
      },
    };
    await this.updateStepStarted(ctx, step, attempt, { prompt: { path: step.prompt ?? null, commit: ctx.commit, rendered }, subagent: { uid: resolved.uid, commit: resolved.commit, model_preset: resolved.model_preset } });
    await record('user', rendered);
    let messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: rendered }] }];
    let reasks = 0;
    for (;;) {
      const res = await this.d.subagents.runConversation({
        subagent: resolved,
        principal,
        messages,
        extra_tools: [finish],
        terminal_tools: [FINISH_TOOL],
        max_turns: step.max_turns,
        model_overrides: ctx.session.model_overrides ?? null,
        session_id: id,
        step_id: step.id,
        attempt,
        hooks,
        tools_override: step.tools_override ?? null,
      });
      let problem: string;
      let errors: string[] = [];
      if (!res.terminal_call) {
        problem = `You must finish by calling \`${FINISH_TOOL}\` with {exit, output}.`;
      } else {
        const inp = (res.terminal_call.input ?? {}) as { exit?: unknown; output?: unknown };
        const exitOk = typeof inp.exit === 'string' && step.exits.some((e) => e.name === inp.exit);
        const v = validateAgainst(step.output, inp.output);
        if (exitOk && v.ok) return { kind: 'exit', exit: inp.exit as string, output: v.value };
        if (!exitOk) errors.push(`exit must be one of: ${step.exits.map((e) => e.name).join(', ')} (got ${JSON.stringify(inp.exit ?? null)})`);
        errors = errors.concat(v.errors.map((x) => `output${x.startsWith('/') ? x : ' ' + x}`));
        problem = `Your \`${FINISH_TOOL}\` call was invalid:\n- ${errors.join('\n- ')}\nCall \`${FINISH_TOOL}\` again with a corrected {exit, output}.`;
      }
      if (reasks >= step.max_reasks) {
        throw new StepFailure(res.terminal_call ? `finish output invalid after ${reasks} re-ask(s)` : `subagent did not call ${FINISH_TOOL}`, { errors, reasks });
      }
      reasks++;
      messages = [...res.messages];
      const last = messages[messages.length - 1];
      const termUse = res.terminal_call && last?.role === 'assistant' && last.content.some((c) => c.type === 'tool_use' && c.id === res.terminal_call!.id);
      if (termUse) messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: res.terminal_call!.id, content: problem, is_error: true }] });
      else messages.push({ role: 'user', content: [{ type: 'text', text: problem }] });
      await record('user', problem);
    }
  }

  // --- code -------------------------------------------------------------------

  private async runCode(ctx: RunCtx, step: CodeStep, attempt: number): Promise<StepResult> {
    const id = ctx.session.session_id;
    const scope = this.templateCtx(ctx);
    const input = step.input_map ? mapValue(step.input_map, scope) : {};
    const stepRef = `${step.id}#${attempt}`;
    const principal: Principal = {
      actor: { kind: 'code-step', id: step.tool, session_id: id, step_id: stepRef },
      team_id: this.d.team_id,
      user: null,
      roles: [],
      is_admin: false,
      scopes: null,
      grants: null,
      session_id: id,
      visible_sessions: ctx.family,
      config_commit: ctx.commit,
      execution_key: null,
      token_kind: 'actor',
    };
    await this.updateStepStarted(ctx, step, attempt, { tool: { uid: step.tool, commit: ctx.commit }, input });
    const res = await this.d.toolbox.invoke({
      tool_uid: step.tool,
      commit: ctx.commit,
      input,
      settings: step.settings ?? {},
      principal,
      ambient: { invocation: 'code-step', session_id: id, step_id: step.id, attempt, task: ctx.task, budget_remaining: { usd: ctx.budget.remaining_usd, tokens: ctx.budget.remaining_tokens }, settings: step.settings ?? {} },
      session_id: id,
      step_id: step.id,
      attempt,
      call_index: 0,
    });
    await this.event(id, 'tool-result', { step_id: step.id, attempt, tool_uid: step.tool, execution_key: res.execution_key, replayed: res.replayed, duration_ms: res.duration_ms, cost_units: res.cost_units, logs: (res.logs ?? []).slice(-LOG_CAP) }, step.id);
    const out = res.output as any;
    let exit: string;
    let output: unknown;
    if (out && typeof out === 'object' && !Array.isArray(out) && typeof out.exit === 'string') {
      exit = out.exit;
      output = out.output ?? {};
    } else if (step.exits.length === 1) {
      exit = step.exits[0]!.name;
      output = out ?? {};
    } else {
      throw new StepFailure(`tool ${step.tool} must return {exit, output} (step ${step.id} has ${step.exits.length} exits)`);
    }
    if (step.output) {
      const v = validateAgainst(step.output, output);
      if (!v.ok) throw new StepFailure(`tool output does not match step ${step.id} output schema`, { errors: v.errors });
      output = v.value;
    }
    return { kind: 'exit', exit, output };
  }

  // --- circuit ----------------------------------------------------------------

  private async runCircuitStep(ctx: RunCtx, step: CircuitStep, attempt: number, visit: number, reattach: string | null): Promise<StepResult> {
    const id = ctx.session.session_id;
    let childId = reattach;
    if (!childId) {
      const input = step.input_map ? mapValue(step.input_map, this.templateCtx(ctx)) : {};
      const child = await this.enqueue({
        circuit_uid: step.circuit,
        input,
        task_uid: ctx.session.task_uid,
        parent_session: id,
        parent_step_id: step.id,
        priority: ctx.session.priority ?? undefined,
        model_overrides: ctx.session.model_overrides ?? null,
        kind: 'circuit-run',
        // Sub-circuits run against the parent's resolved commit for a consistent configuration snapshot.
        config_ref: ctx.commit,
        created_by: ACTOR,
      });
      childId = child.session_id;
      ctx.family = [...ctx.family, childId];
      await this.d.sessions.upsertCheckpoint({ session_id: id, step_id: step.id, attempt, status: 'running', ambient: this.ambient(ctx), visit, kind: 'circuit', child_session_id: childId });
      await this.event(id, 'checkpoint', { step_id: step.id, attempt, visit, status: 'running', child_session_id: childId }, step.id);
      await this.updateStepStarted(ctx, step, attempt, { child_session_id: childId, input });
    }
    const child = await this.waitFor(childId);
    switch (child.state) {
      case 'completed': {
        const ev = await this.lastEvent(childId, 'session-completed');
        const cexit = (ev?.payload.exit ?? child.state_detail.exit) as string | undefined;
        const coutput = ev?.payload.output ?? child.state_detail.output ?? {};
        if (!cexit) throw new StepFailure(`child session ${childId} completed without an exit`);
        const exit = step.exit_map?.[cexit] ?? cexit;
        if (!step.exits.some((e) => e.name === exit)) throw new StepFailure(`child exit '${cexit}' maps to '${exit}', which step ${step.id} does not declare`, { child_session_id: childId }, false, 'exit-unmapped');
        return { kind: 'exit', exit, output: coutput };
      }
      case 'suspended-gate':
      case 'suspended-error': {
        const gated = child.state === 'suspended-gate';
        const reason = gated ? 'child-gated' : 'child-error';
        await this.event(id, 'session-suspended', { reason, step_id: step.id, child_session_id: childId, child_reason: child.state_detail.reason ?? null });
        const s = await this.transition(id, { state: gated ? 'suspended-gate' : 'suspended-error', state_detail: { ...preserve(ctx.session.state_detail), reason, step_id: step.id, attempt, visit, child_session_id: childId, child_reason: child.state_detail.reason ?? null } });
        // Race: the child may have settled between waitFor and our suspension (its settle hook saw us running).
        const again = await this.d.sessions.get(childId);
        if (again && again.state !== child.state && (again.state === 'completed' || again.state === 'suspended-error')) await this.onChildSettled(again);
        return { kind: 'suspended', session: s };
      }
      case 'cancelled':
        throw new StepFailure(`child session ${childId} was cancelled`, { child_session_id: childId }, false, 'child-cancelled');
      default:
        throw new StepFailure(`child session ${childId} is ${child.state}`);
    }
  }

  // --- gate -------------------------------------------------------------------

  private async runGate(ctx: RunCtx, step: GateStep, attempt: number, visit: number): Promise<StepResult> {
    const id = ctx.session.session_id;
    const scope = this.templateCtx(ctx);
    const passthrough: Record<string, unknown> = {};
    const refs: ArtifactRef[] = [];
    for (const expr of step.review.artifacts) {
      const v = resolvePath(expr, [scope]);
      passthrough[lastSegment(expr)] = v ?? null;
      collectRefs(v, refs);
    }
    const artifacts = dedupeRefs(refs);
    if (!artifacts.length) throw new StepFailure(`gate ${step.id} resolved no artifacts to review`, { expressions: step.review.artifacts }, false, 'gate-no-artifacts');
    const r = step.review.reviewers ?? {};
    const targets: Array<{ role?: string; username?: string }> = [...(r.any_of ?? [])];
    if (r.role || r.username) targets.unshift({ role: r.role, username: r.username });
    if (!targets.length) targets.push({});
    const prompt = step.review.prompt ? renderTemplate(step.review.prompt, scope) : null;
    const requests: Array<{ request_id: string; uid: string; revision_id: number; role: string | null; username: string | null }> = [];
    for (const a of artifacts) {
      for (const t of targets) {
        const req = await this.d.content.tagNeedInput({ uid: a.uid, role: t.role ?? null, username: t.username ?? null, prompt, by: this.svc, gate: { session_id: id, step_id: step.id } });
        requests.push({ request_id: req.request_id, uid: a.uid, revision_id: a.revision_id, role: req.role, username: req.username });
      }
    }
    const detail = { reason: 'gate', step_id: step.id, attempt, visit, artifacts, requests, verdicts: [], passthrough, prompt };
    await this.updateStepStarted(ctx, step, attempt, { artifacts, requests: requests.length });
    await this.event(id, 'gate-suspended', { step_id: step.id, attempt, visit, artifacts, requests }, step.id);
    await this.event(id, 'session-suspended', { reason: 'gate', step_id: step.id });
    const s = await this.transition(id, { state: 'suspended-gate', state_detail: { ...preserve(ctx.session.state_detail), ...detail } });
    if (ctx.session.task_uid) await this.taskStatus(ctx.session.task_uid, 'gated', { session_id: id, step_id: step.id });
    return { kind: 'suspended', session: s };
  }

  private async resolveGate(s: SessionRow, step: GateStep, detail: Record<string, any>): Promise<void> {
    const id = s.session_id;
    const verdicts = detail.verdicts as Array<Record<string, any>>;
    const changes = verdicts.some((v) => v.verdict === 'request-changes');
    const want = changes ? 'changes' : 'approve';
    const exit = step.exits.some((e) => e.name === want) ? want : (step.exits[0]?.name ?? want);
    // Gate-resolution revisions capture exactly what was approved / what feedback applies to ([01] §5).
    const revs = new Map<string, number>();
    for (const a of (detail.artifacts ?? []) as ArtifactRef[]) {
      try {
        const rev = await this.d.content.cutRevision(a.uid, ['gate-resolution'], ACTOR);
        revs.set(a.uid, rev.revision_id);
      } catch (e) {
        this.d.log.warn({ err: e, uid: a.uid, session_id: id }, 'gate-resolution revision failed');
      }
    }
    const bump = (v: unknown): unknown => {
      if (isRef(v)) return revs.has(v.uid) ? { ...v, revision_id: revs.get(v.uid)! } : v;
      if (Array.isArray(v)) return v.map(bump);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bump(x)]));
      return v;
    };
    let output: Record<string, unknown> = bump(detail.passthrough ?? {}) as Record<string, unknown>;
    if (changes) {
      const feedback = verdicts.filter((v) => v.verdict === 'request-changes' || v.comment).map((v) => v.comment).filter((c): c is string => typeof c === 'string' && c.length > 0);
      output = { ...output, feedback };
      for (const v of verdicts) if (v.edits && typeof v.edits === 'object') output = { ...output, ...v.edits };
    }
    const val = validateAgainst(step.output, output);
    if (!val.ok) this.d.log.warn({ session_id: id, step_id: step.id, errors: val.errors }, 'gate output does not satisfy the gate output schema; passing through unvalidated');
    const out = val.ok ? val.value : output;
    const attempt = Number(detail.attempt ?? 1);
    const visit = Number(detail.visit ?? 1);
    await this.event(id, 'gate-resolved', { step_id: step.id, exit, output: out, verdicts, revisions: Object.fromEntries(revs) }, step.id);
    await this.event(id, 'step-exited', { step_id: step.id, attempt, visit, exit, to: step.exits.find((e) => e.name === exit)?.to ?? null }, step.id);
    await this.event(id, 'checkpoint', { step_id: step.id, attempt, visit, status: 'exited', exit, output: out }, step.id);
    await this.d.sessions.upsertCheckpoint({ session_id: id, step_id: step.id, attempt, status: 'exited', exit_name: exit, output: out, ambient: {}, visit, kind: 'gate', ended: true });
    await this.event(id, 'session-resumed', { reason: 'gate-resolved', step_id: step.id, exit });
    await this.transition(id, { state: 'queued', state_detail: { ...preserve(s.state_detail), resumed_from: 'gate' } });
    if (s.task_uid) await this.taskStatus(s.task_uid, 'active', { session_id: id });
  }

  // --- step bookkeeping -----------------------------------------------------------

  /** A running `checkpoint` event carrying step-kind detail (rendered prompt + commits, tool input, child session, gate requests). */
  private async updateStepStarted(ctx: RunCtx, step: Step, attempt: number, detail: Record<string, unknown>): Promise<void> {
    await this.event(ctx.session.session_id, 'checkpoint', { step_id: step.id, attempt, visit: ctx.visits.get(step.id) ?? 1, status: 'running', kind: step.kind, ...detail }, step.id);
  }

  private async finishStep(ctx: RunCtx, step: Step, attempt: number, visit: number, exit: string, to: string, output: unknown): Promise<void> {
    const id = ctx.session.session_id;
    let cost = { cost_usd: 0, tokens_in: 0, tokens_out: 0 };
    for (const t of await this.d.sessions.turns(id, step.id, attempt)) {
      cost.cost_usd += Number(t.cost_usd ?? 0);
      cost.tokens_in += Number(t.tokens_in ?? 0);
      cost.tokens_out += Number(t.tokens_out ?? 0);
    }
    if (step.kind === 'circuit') {
      const cp = (await this.d.sessions.checkpoints(id)).find((c) => c.step_id === step.id && Number(c.attempt) === attempt);
      if (cp?.child_session_id) {
        const tc = await this.treeCost(cp.child_session_id);
        cost = { cost_usd: tc.cost_usd, tokens_in: 0, tokens_out: tc.tokens };
      }
    }
    ctx.steps[step.id] = { output, exit };
    ctx.artifacts = await this.sessionArtifacts(id, ctx.pinned);
    ctx.budget = await this.remaining(ctx.session);
    await this.event(id, 'step-exited', { step_id: step.id, attempt, visit, exit, to, cost_usd: cost.cost_usd }, step.id);
    await this.event(id, 'checkpoint', { step_id: step.id, attempt, visit, status: 'exited', exit, output }, step.id);
    await this.d.sessions.upsertCheckpoint({ session_id: id, step_id: step.id, attempt, status: 'exited', exit_name: exit, output, ambient: this.ambient(ctx), cost_usd: cost.cost_usd, tokens_in: cost.tokens_in, tokens_out: cost.tokens_out, visit, kind: step.kind, ended: true });
  }

  /** Output refs must name real nodes; artifacts referenced without a step-completion revision get one ([01] §5). */
  private async checkRefs(ctx: RunCtx, output: unknown): Promise<void> {
    for (const ref of dedupeRefs(collectRefs(output))) {
      const node = await this.d.nodes.get(ref.uid);
      if (!node) throw new StepFailure(`output references unknown node ${ref.uid}`, { ref });
      if (node.type !== 'artifact') continue;
      const latest = await this.d.nodes.latestRevision(ref.uid);
      if (!latest || !(latest.labels ?? []).includes('step-completion')) {
        await this.d.content.cutRevision(ref.uid, ['step-completion'], { ...ACTOR, session_id: ctx.session.session_id });
      }
    }
  }

  private async complete(ctx: RunCtx, exit: string, output: unknown): Promise<SessionRecord> {
    const id = ctx.session.session_id;
    const cx = ctx.circuit.exits.find((e) => e.name === exit);
    if (!cx) return this.suspendError(ctx.session, 'config-error', { error: `circuit has no exit '${exit}'` });
    const v = validateAgainst(cx.output, output);
    if (!v.ok) return this.suspendError(ctx.session, 'exit-output-invalid', { exit, errors: v.errors });
    await this.event(id, 'session-completed', { exit, output: v.value });
    const s = await this.transition(id, { state: 'completed', ended_at: nowIso(), state_detail: { ...preserve(ctx.session.state_detail), exit, output: v.value } });
    if (ctx.session.task_uid && !ctx.session.parent_session) {
      const others = await this.d.sessions.list({ task: ctx.session.task_uid, state: ['queued', 'running', 'suspended-gate', 'suspended-error'], limit: 5 });
      if (!others.items.some((o) => o.session_id !== id && !o.parent_session)) await this.taskStatus(ctx.session.task_uid, 'done', { session_id: id, exit });
    }
    return s;
  }

  private async suspendError(s: SessionRecord, reason: string, extra: Record<string, unknown> = {}): Promise<SessionRecord> {
    await this.event(s.session_id, 'session-suspended', { reason, ...extra });
    return this.transition(s.session_id, { state: 'suspended-error', state_detail: { ...preserve(s.state_detail), reason, ...extra } });
  }

  // -------------------------------------------------------------------------
  // State, events, budget
  // -------------------------------------------------------------------------

  private async transition(id: string, patch: Parameters<SessionStore['update']>[1], opts: { force?: boolean } = {}): Promise<SessionRecord> {
    if (!opts.force) {
      const cur = await this.d.sessions.mustGet(id);
      if (cur.state === 'cancelled') throw new CancelledSignal();
    }
    const s = await this.d.sessions.update(id, patch);
    await this.publishState(s);
    if (!LIVE_STATES.includes(s.state)) {
      for (const w of [...(this.waiters.get(id) ?? [])]) w();
    }
    if (s.state === 'queued') this.notifyQueued(id);
    if (s.parent_session && (s.state === 'completed' || s.state === 'suspended-error')) {
      await this.onChildSettled(s).catch((e) => this.d.log.warn({ err: e, session_id: id }, 'parent wake-up failed'));
    }
    return s;
  }

  /** A sub-circuit settled: a parent suspended behind it re-queues and re-attaches ([02] §5.5). */
  private async onChildSettled(child: SessionRecord): Promise<void> {
    if (!child.parent_session) return;
    const parent = await this.d.sessions.get(child.parent_session);
    if (!parent || (parent.state !== 'suspended-gate' && parent.state !== 'suspended-error')) return;
    if (parent.state_detail.child_session_id !== child.session_id) return;
    await this.event(parent.session_id, 'session-resumed', { reason: 'child-settled', child_session_id: child.session_id, child_state: child.state });
    await this.transition(parent.session_id, { state: 'queued', state_detail: { ...preserve(parent.state_detail), resumed_from: 'child' } });
  }

  private async assertNotCancelled(id: string): Promise<void> {
    const s = await this.d.sessions.mustGet(id);
    if (s.state === 'cancelled') throw new CancelledSignal();
  }

  private async event(id: string, type: SessionEvent['event_type'], payload: Record<string, unknown>, stepId: string | null = null): Promise<SessionEvent> {
    const e = await this.d.sessions.appendEvent(id, type, payload, stepId);
    await this.publishEvent(id, type, stepId, e.seq);
    return e;
  }

  private async publishEvent(id: string, type: string, stepId: string | null, seq?: number): Promise<void> {
    try {
      await this.d.events.publish('session.event', { session_id: id, event_type: type, step_id: stepId, ...(seq != null ? { seq } : {}) }, { scope: 'session', session_id: id });
    } catch (e) {
      this.d.log.debug({ err: e }, 'session.event publish failed');
    }
  }

  private async publishState(s: SessionRecord): Promise<void> {
    try {
      await this.d.events.publish('session.state', { session_id: s.session_id, state: s.state, kind: s.kind, circuit_uid: s.circuit_uid, task_uid: s.task_uid, parent_session: s.parent_session, reason: (s.state_detail?.reason as string | undefined) ?? null }, { scope: 'session', session_id: s.session_id });
    } catch (e) {
      this.d.log.debug({ err: e }, 'session.state publish failed');
    }
  }

  private notifyQueued(id: string): void {
    for (const fn of this.queuedListeners) {
      try {
        fn(id);
      } catch {
        /* ignore */
      }
    }
  }

  private async taskStatus(uid: string, status: string, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.d.tasks.setStatus(uid, status, ACTOR, detail);
    } catch (e) {
      this.d.log.warn({ err: e, task_uid: uid, status }, 'task status update failed');
    }
  }

  private async treeCost(id: string): Promise<{ cost_usd: number; tokens: number }> {
    const store = this.d.sessions as SessionStore & { treeCost?: (id: string) => Promise<{ cost_usd: number; tokens: number }> };
    if (typeof store.treeCost === 'function') return store.treeCost(id);
    const own = await this.d.sessions.cost(id);
    let acc = { cost_usd: own.cost_usd, tokens: own.tokens_in + own.tokens_out };
    for (const c of await this.d.sessions.children(id)) {
      const sub = await this.treeCost(c.session_id);
      acc = { cost_usd: acc.cost_usd + sub.cost_usd, tokens: acc.tokens + sub.tokens };
    }
    return acc;
  }

  /** Remaining = ceiling − spend over the session and all its descendants. */
  private async remaining(s: SessionRecord): Promise<{ remaining_usd: number; remaining_tokens: number }> {
    const cur = await this.d.sessions.mustGet(s.session_id);
    const spent = await this.treeCost(s.session_id);
    return { remaining_usd: Math.round((cur.budget.max_cost_usd - spent.cost_usd) * 1e6) / 1e6, remaining_tokens: cur.budget.max_tokens - spent.tokens };
  }

  private async ensureBudget(ctx: RunCtx): Promise<void> {
    ctx.budget = await this.remaining(ctx.session);
    if (ctx.budget.remaining_usd <= 0 || ctx.budget.remaining_tokens <= 0) throw new BudgetExhausted(ctx.budget);
  }

  private ambient(ctx: RunCtx) {
    return { task: ctx.task, session_id: ctx.session.session_id, budget: ctx.budget, artifacts: ctx.artifacts };
  }

  private templateCtx(ctx: RunCtx): Record<string, unknown> {
    return { input: ctx.input, steps: ctx.steps, ambient: this.ambient(ctx) };
  }

  private async taskRef(s: SessionRow): Promise<ArtifactRef | null> {
    if (!s.task_uid) return null;
    const fromInput = (s.input as any)?.task;
    if (isRef(fromInput) && fromInput.uid === s.task_uid) return { uid: fromInput.uid, revision_id: fromInput.revision_id };
    const head = await this.d.nodes.headRevisionId(s.task_uid).catch(() => null);
    return { uid: s.task_uid, revision_id: head ?? 0 };
  }

  /** Accumulated artifact refs: pinned context + everything this session produced/updated (latest revision per node). */
  private async sessionArtifacts(id: string, pinned: ArtifactRef[]): Promise<ArtifactRef[]> {
    const refs: ArtifactRef[] = [...pinned];
    for (const e of await this.d.edges.listForSession(id)) {
      if ((e.type === 'produces' || e.type === 'updates') && !e.retracted_at && e.dst_revision != null) refs.push({ uid: e.dst_uid, revision_id: Number(e.dst_revision) });
    }
    return dedupeRefs(refs);
  }

  private async lastEvent(id: string, type: SessionEvent['event_type']): Promise<SessionEvent | null> {
    let found: SessionEvent | null = null;
    for (const e of await this.allEvents(id)) if (e.event_type === type) found = e;
    return found;
  }

  private async allEvents(id: string): Promise<SessionEvent[]> {
    const out: SessionEvent[] = [];
    let after = 0;
    for (;;) {
      const page = await this.d.sessions.events(id, after, 5000);
      out.push(...page);
      if (page.length < 5000) return out;
      after = page[page.length - 1]!.seq;
    }
  }

  /** Rebuild resume state from the authoritative event log. */
  private async rebuild(id: string): Promise<{ steps: RunCtx['steps']; visits: Map<string, number>; maxAttempt: Map<string, number>; cur: Cursor | null }> {
    const steps: RunCtx['steps'] = {};
    const visits = new Map<string, number>();
    const maxAttempt = new Map<string, number>();
    let cur = null as Cursor | null;
    for (const e of await this.allEvents(id)) {
      const p = e.payload as Record<string, any>;
      if (typeof p.step_id !== 'string') continue;
      const attempt = Number(p.attempt ?? 1);
      const visit = Number(p.visit ?? 1);
      switch (e.event_type) {
        case 'step-started':
          visits.set(p.step_id, Math.max(visits.get(p.step_id) ?? 0, visit));
          maxAttempt.set(p.step_id, Math.max(maxAttempt.get(p.step_id) ?? 0, attempt));
          cur = { step_id: p.step_id, attempt, visit, status: 'running' };
          break;
        case 'step-failed':
          if (cur && cur.step_id === p.step_id && cur.attempt === attempt) cur = { ...(cur as Cursor), status: 'failed' };
          break;
        case 'checkpoint':
          if (p.status === 'exited') {
            steps[p.step_id] = { output: p.output ?? null, exit: p.exit };
            cur = { step_id: p.step_id, attempt, visit, status: 'exited', exit: p.exit, output: p.output ?? null };
          } else if (p.child_session_id && cur && cur.step_id === p.step_id && cur.attempt === attempt) {
            cur = { ...(cur as Cursor), child_session_id: p.child_session_id };
          }
          break;
      }
    }
    return { steps, visits, maxAttempt, cur };
  }

  private async withGateLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.gateLocks.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.gateLocks.set(sessionId, next);
    try {
      return await next;
    } finally {
      if (this.gateLocks.get(sessionId) === next) this.gateLocks.delete(sessionId);
    }
  }
}

export function createOrchestrator(deps: OrchestratorDeps): OrchestratorImpl {
  if (!deps.team_id) throw validationFailed('team_id required');
  return new OrchestratorImpl(deps);
}

export type { Actor };
