/**
 * Test-only fakes shared by the evals and conversations tests (not wired into the app).
 * A tiny in-memory SessionStore covering what those services use, plus a scripted SubagentRuntime.
 */
import { mintId, mintSessionId, type SessionEvent, type SessionRecord, type Turn } from '@breadboard/shared';
import type { ConversationHooks, ConversationResult, CreateSessionInput, EventBus, ResolvedSubagent, RunConversationInput, SessionFilter, SessionStore, SubagentRuntime } from '../core/services.js';
import type { Principal } from '../core/principal.js';

type Rec = SessionRecord & { input?: unknown; created_by?: unknown; model_overrides?: unknown; pinned_context?: unknown };

export class MemorySessionStore {
  readonly sessions = new Map<string, Rec>();
  readonly eventLog = new Map<string, SessionEvent[]>();
  readonly turnLog = new Map<string, Array<Turn & { attempt: number }>>();
  private clock = Date.parse('2026-09-01T00:00:00Z');

  constructor(private readonly teamId: string) {}

  private now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  async create(input: CreateSessionInput & { pinned_context?: unknown }): Promise<SessionRecord> {
    const id = mintSessionId();
    const rec: Rec = {
      session_id: id,
      team_id: this.teamId,
      kind: input.kind,
      circuit_uid: input.circuit_uid ?? null,
      circuit_slug: input.circuit_slug ?? null,
      config_commit: input.config_commit ?? null,
      task_uid: input.task_uid ?? null,
      parent_session: input.parent_session ?? null,
      parent_step_id: input.parent_step_id ?? null,
      state: input.state ?? 'queued',
      state_detail: input.state_detail ?? {},
      budget: input.budget,
      priority: input.priority ?? null,
      created_at: this.now(),
      started_at: null,
      ended_at: null,
      input: input.input,
      created_by: input.created_by,
      model_overrides: input.model_overrides ?? null,
      pinned_context: (input as any).pinned_context ?? null,
    };
    this.sessions.set(id, rec);
    this.eventLog.set(id, []);
    this.turnLog.set(id, []);
    return structuredClone(rec);
  }

  async get(id: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(id);
    return s ? structuredClone(s) : null;
  }

  async mustGet(id: string): Promise<SessionRecord> {
    const s = await this.get(id);
    if (!s) throw new Error(`session ${id} not found`);
    return s;
  }

  async list(f: SessionFilter): Promise<{ items: SessionRecord[]; next_cursor: string | null }> {
    let items = [...this.sessions.values()];
    if (f.kind?.length) items = items.filter((s) => f.kind!.includes(s.kind));
    if (f.state?.length) items = items.filter((s) => f.state!.includes(s.state));
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { items: items.slice(0, f.limit ?? 50).map((s) => structuredClone(s)), next_cursor: null };
  }

  async update(id: string, patch: Partial<SessionRecord>): Promise<SessionRecord> {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session ${id} not found`);
    Object.assign(s, structuredClone(patch));
    return structuredClone(s);
  }

  async appendEvent(id: string, type: SessionEvent['event_type'], payload: Record<string, unknown>, stepId: string | null = null): Promise<SessionEvent> {
    const log = this.eventLog.get(id);
    if (!log) throw new Error(`session ${id} not found`);
    const e: SessionEvent = { session_id: id, seq: log.length + 1, event_type: type, step_id: stepId, payload: structuredClone(payload), created_at: this.now() };
    log.push(e);
    return structuredClone(e);
  }

  async events(id: string, afterSeq = 0, limit = 1000): Promise<SessionEvent[]> {
    return (this.eventLog.get(id) ?? []).filter((e) => e.seq > afterSeq).slice(0, limit).map((e) => structuredClone(e));
  }

  async recordTurn(t: Omit<Turn, 'turn_id' | 'created_at'> & { attempt?: number; latency_ms?: number | null; fallback_from?: string | null }): Promise<Turn> {
    const log = this.turnLog.get(t.session_id);
    if (!log) throw new Error(`session ${t.session_id} not found`);
    const turn = { turn_id: mintId('trn'), session_id: t.session_id, step_id: t.step_id, role: t.role, username: t.username, content: structuredClone(t.content), model_id: t.model_id, tokens_in: t.tokens_in, tokens_out: t.tokens_out, cost_usd: t.cost_usd, created_at: this.now(), attempt: t.attempt ?? 1 };
    log.push(turn);
    const { attempt: _a, ...out } = turn;
    return structuredClone(out);
  }

  async turns(id: string, stepId?: string, attempt?: number): Promise<Turn[]> {
    return (this.turnLog.get(id) ?? [])
      .filter((t) => (stepId === undefined || t.step_id === stepId) && (attempt === undefined || t.attempt === attempt))
      .map(({ attempt: _a, ...t }) => structuredClone(t));
  }

  /** Turn-sum cost; `excludeStep` mirrors the analysis join's judge exclusion. */
  async cost(id: string): Promise<{ cost_usd: number; tokens_in: number; tokens_out: number }> {
    const ts = this.turnLog.get(id) ?? [];
    return { cost_usd: ts.reduce((s, t) => s + (t.cost_usd ?? 0), 0), tokens_in: ts.reduce((s, t) => s + (t.tokens_in ?? 0), 0), tokens_out: ts.reduce((s, t) => s + (t.tokens_out ?? 0), 0) };
  }

  async costIncludingChildren(id: string): Promise<number> {
    let total = (await this.cost(id)).cost_usd;
    for (const s of this.sessions.values()) if (s.parent_session === id) total += await this.costIncludingChildren(s.session_id);
    return total;
  }

  async countByState(state: string): Promise<number> {
    return [...this.sessions.values()].filter((s) => s.state === state).length;
  }

  asStore(): SessionStore {
    return this as unknown as SessionStore;
  }
}

export class FakeEventBus {
  readonly published: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  async publish(topic: string, payload: Record<string, unknown>) {
    this.published.push({ topic, payload });
    return { id: String(this.published.length), topic, payload } as any;
  }
  asBus(): EventBus {
    return this as unknown as EventBus;
  }
}

export interface ScriptedTurn {
  /** Tool calls the "model" makes (each gets a scripted result through the hooks). */
  tool_calls?: Array<{ name: string; input: unknown; output?: unknown; is_error?: boolean }>;
  /** Terminal call (e.g. `breadboard_record_scores`). */
  terminal?: { name: string; input: unknown };
  text?: string;
  cost_usd?: number;
}

/**
 * Scripted SubagentRuntime: `script(input)` decides the conversation; the fake drives the hooks the way the
 * real loop does (assistant turn → tool-call/tool-result → tool turn → final assistant turn).
 */
export class FakeSubagentRuntime {
  readonly calls: RunConversationInput[] = [];
  readonly resolved: Array<{ uid: string; commit: string }> = [];
  constructor(private readonly script: (input: RunConversationInput) => ScriptedTurn | Promise<ScriptedTurn>) {}

  async resolve(uid: string, commit: string): Promise<ResolvedSubagent> {
    this.resolved.push({ uid, commit });
    return { uid, slug: `sub-${uid.slice(0, 4).toLowerCase()}`, commit, definition: {} as any, system_prompt: 'You are a test subagent.', injected_notes: [], grants: {} as any, model_preset: 'medium' };
  }

  principalFor(resolved: ResolvedSubagent, sessionId: string, stepId: string | null, visible: string[]): Principal {
    return {
      actor: { kind: 'subagent', id: resolved.uid, session_id: sessionId, step_id: stepId ?? undefined },
      team_id: 'test',
      user: null,
      roles: [],
      is_admin: false,
      scopes: null,
      grants: resolved.grants,
      session_id: sessionId,
      visible_sessions: visible,
      config_commit: resolved.commit,
      execution_key: null,
      token_kind: 'actor',
    };
  }

  async toolSurface() {
    return [];
  }

  async runConversation(input: RunConversationInput): Promise<ConversationResult> {
    this.calls.push(structuredClone({ ...input, hooks: undefined }) as RunConversationInput);
    const s = await this.script(input);
    const h: ConversationHooks = input.hooks ?? {};
    const cost = s.cost_usd ?? 0.01;
    const usage = { input_tokens: 100, output_tokens: 20 };
    await h.checkBudget?.();
    const toolUses = (s.tool_calls ?? []).map((c, i) => ({ type: 'tool_use' as const, id: `tu_${i}`, name: c.name, input: c.input }));
    if (s.terminal) toolUses.push({ type: 'tool_use', id: 'tu_terminal', name: s.terminal.name, input: s.terminal.input });
    if (toolUses.length) {
      await h.onTurn?.({ role: 'assistant', content: toolUses, model_id: 'model-a', usage, cost_usd: cost });
    }
    const results: any[] = [];
    for (const [i, c] of (s.tool_calls ?? []).entries()) {
      await h.onToolCall?.({ id: `tu_${i}`, name: c.name, input: c.input });
      await h.onToolResult?.({ id: `tu_${i}`, name: c.name, output: c.output ?? null, is_error: !!c.is_error });
      results.push({ type: 'tool_result', tool_use_id: `tu_${i}`, content: JSON.stringify(c.output ?? null), is_error: !!c.is_error });
    }
    if (results.length) await h.onTurn?.({ role: 'user', content: results });
    let final_text = '';
    if (!s.terminal && s.text !== undefined) {
      final_text = s.text;
      await h.onTurn?.({ role: 'assistant', content: [{ type: 'text', text: s.text }], model_id: 'model-a', usage, cost_usd: toolUses.length ? 0 : cost });
    }
    return {
      messages: input.messages,
      terminal_call: s.terminal ? { name: s.terminal.name, input: s.terminal.input, id: 'tu_terminal' } : null,
      final_text,
      usage,
      cost_usd: cost,
      turns: 1 + (results.length ? 1 : 0),
      model_ids: ['model-a'],
    };
  }

  asRuntime(): SubagentRuntime {
    return this as unknown as SubagentRuntime;
  }
}
