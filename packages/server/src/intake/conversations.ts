/**
 * Conversation service ([08] §4, §7.1; [10] §4): user↔AI chats as Sessions.
 *  - `intake`: idea shaping with the shaper subagent; maintains the draft task panel state.
 *  - `conversation`: designer chat panels; the designer sees the open definition + the editor's working tree.
 * Every turn is recorded (user turns carry the username); budgets apply per session.
 */
import {
  BreadboardError,
  invalidState,
  isUid,
  notFound,
  validationFailed,
  type BreadboardConfig,
  type SessionEvent,
  type SessionRecord,
  type Turn,
} from '@breadboard/shared';
import type { Db } from '../db/index.js';
import type { Logger } from '../core/logger.js';
import { canSeeSession, requireUser, servicePrincipal, type Principal } from '../core/principal.js';
import type { ChatContent, ChatMessage, ConfigService, ContentService, ConversationService, EventBus, ResolvedSubagent, SessionStore, SubagentRuntime, TaskService } from '../core/services.js';

export const CONVERSATION_STEP_ID = 'conversation';
const CONVERSATION_KINDS = ['intake', 'conversation'] as const;
type ConversationKind = (typeof CONVERSATION_KINDS)[number];
const MAX_TURNS = 40;
const RAW_CAP = 30_000;
const FILE_CAP = 10_000;
const PREAMBLE_CAP = 80_000;
const DIFF_CAP = 8_000;
const TOOL_OUTPUT_CAP = 16_000;
const CREATE_TASK_RE = /(^|[_.:/])create_task$/;

export interface ConversationServiceDeps {
  db: Db;
  team_id: string;
  sessions: SessionStore;
  config: ConfigService;
  subagents: SubagentRuntime;
  content: ContentService;
  tasks: TaskService;
  events: EventBus;
  log: Logger;
  settings: () => Promise<BreadboardConfig>;
}

/** Draft task panel state ([08] §7.1), kept on `state_detail.draft_task` of intake sessions. */
export interface DraftTask {
  title: string | null;
  body: string | null;
  priority: string | null;
  target_circuit: string | null;
  references: string[];
  task_uid?: string | null;
  /** Every task the shaper created in this session (latest last). */
  created_tasks?: string[];
}

const emptyDraft = (): DraftTask => ({ title: null, body: null, priority: null, target_circuit: null, references: [] });

export class ConversationServiceImpl implements ConversationService {
  private readonly svc: Principal;
  /** Serialize posts per session so turns never interleave. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly d: ConversationServiceDeps) {
    this.svc = servicePrincipal(d.team_id, 'conversations');
  }

  async start(input: Parameters<ConversationService['start']>[0]): Promise<SessionRecord> {
    const { kind, by } = input;
    if (!CONVERSATION_KINDS.includes(kind)) throw validationFailed(`kind must be one of ${CONVERSATION_KINDS.join(', ')}`);
    requireUser(by); // user↔AI sessions only ([02] §2)
    const settings = await this.d.settings();
    let subagent_uid = input.subagent_uid ?? null;
    if (kind === 'intake') {
      subagent_uid ??= settings.intake?.shaper_subagent ?? null;
      if (!subagent_uid) throw validationFailed('breadboard.yaml intake.shaper_subagent is not configured');
    } else if (!subagent_uid) {
      throw validationFailed('subagent_uid is required for conversation sessions (designer chats pass settings.designers.<editor>)');
    }
    if (!isUid(subagent_uid)) throw validationFailed(`subagent_uid is not a UID: ${subagent_uid}`);

    const commit = await this.d.config.mainCommit();
    const resolved = await this.d.subagents.resolve(subagent_uid, commit); // validates the definition before the session exists
    const context = persistable(input.context ?? {});
    const budget = settings.defaults?.budget ?? { max_cost_usd: 5, max_tokens: 1_000_000 };
    const title = input.title ?? null;
    const created = await this.d.sessions.create({
      kind,
      state: 'running',
      budget: { max_cost_usd: budget.max_cost_usd, max_tokens: budget.max_tokens, spent_usd: 0, spent_tokens: 0 },
      config_commit: commit,
      created_by: by.actor,
      state_detail: { subagent_uid, context, title, started_by: by.actor, resolved_commit: commit, ...(kind === 'intake' ? { draft_task: emptyDraft() } : {}) },
    });
    const sid = created.session_id;
    if (!created.started_at) await this.d.sessions.update(sid, { started_at: new Date().toISOString() }).catch(() => undefined);
    await this.d.sessions.appendEvent(sid, 'session-started', { kind, subagent_uid, user: by.user?.handle ?? null, context, title });
    await this.d.sessions.appendEvent(sid, 'config-resolved', configResolvedPayload(commit, resolved));
    await this.d.events.publish('session.state', { session_id: sid, kind, state: 'running' }).catch(() => undefined);
    return (await this.d.sessions.get(sid)) ?? created;
  }

  async post(input: Parameters<ConversationService['post']>[0]): Promise<{ turns: Turn[]; draft_task?: Record<string, unknown> | null; proposals?: string[] }> {
    const prev = this.locks.get(input.session_id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.postLocked(input));
    this.locks.set(input.session_id, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(input.session_id) === run) this.locks.delete(input.session_id);
    }
  }

  private async postLocked(input: Parameters<ConversationService['post']>[0]): Promise<{ turns: Turn[]; draft_task?: Record<string, unknown> | null; proposals?: string[] }> {
    const { session_id, by } = input;
    const user = requireUser(by);
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text) throw validationFailed('message text is required');
    const session = await this.mustAccess(session_id, by);
    if (session.state !== 'running') throw invalidState(`conversation is ${session.state}`);
    const detail = { ...(session.state_detail ?? {}) } as Record<string, any>;
    const budget = { ...session.budget };
    if (exhausted(budget)) {
      await this.suspendForBudget(session, detail, budget);
      throw new BreadboardError('budget-exceeded', 'conversation budget exhausted');
    }
    const context = { ...(detail.context ?? {}), ...(input.context ?? {}) } as Record<string, any>;

    const prior = await this.d.sessions.turns(session_id, CONVERSATION_STEP_ID);
    const turnIndex = prior.filter((t) => t.role === 'user').length + 1;
    const userContent: ChatContent[] = [{ type: 'text', text }];
    const userTurn = await this.d.sessions.recordTurn({
      session_id,
      step_id: CONVERSATION_STEP_ID,
      attempt: turnIndex,
      role: 'user',
      username: user.handle,
      content: userContent,
      model_id: null,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
    });
    const newTurns: Turn[] = [userTurn];

    // Re-resolve each post so config edits apply to the next turn.
    const commit = await this.d.config.mainCommit();
    const resolved = await this.d.subagents.resolve(detail.subagent_uid, commit, { session_id });
    if (commit !== (detail.resolved_commit ?? session.config_commit)) {
      await this.d.sessions.appendEvent(session_id, 'config-resolved', configResolvedPayload(commit, resolved), CONVERSATION_STEP_ID);
    }
    detail.resolved_commit = commit;

    const messages = historyMessages([...prior, userTurn]);
    const preamble = await this.preamble(session, context);
    if (preamble) {
      const first = messages.find((m) => m.role === 'user');
      if (first) first.content = [{ type: 'text', text: preamble }, ...first.content];
      else messages.unshift({ role: 'user', content: [{ type: 'text', text: preamble }] });
      await this.d.sessions.appendEvent(session_id, 'turn', { kind: 'context-preamble', attempt: turnIndex, text: cap(preamble, PREAMBLE_CAP) }, CONVERSATION_STEP_ID);
    }
    const inputSigs = new Set(messages.map((m) => JSON.stringify(m.content)));

    const proposalsBefore = new Set(await this.proposalIds(session_id));
    let spentUsd = budget.spent_usd;
    let spentTokens = budget.spent_tokens;
    let recordedAssistant = 0;
    let result;
    try {
      result = await this.d.subagents.runConversation({
        subagent: resolved,
        principal: await this.withOpenDefinition(this.d.subagents.principalFor(resolved, session_id, CONVERSATION_STEP_ID, [session_id]), session, context),
        messages,
        session_id,
        step_id: CONVERSATION_STEP_ID,
        attempt: turnIndex,
        max_turns: MAX_TURNS,
        hooks: {
          onTurn: async (t) => {
            if (t.role === 'system') return;
            const content = normalizeContent(t.content);
            const isToolResult = content.some((c) => c.type === 'tool_result');
            if (t.role === 'user' && !isToolResult && inputSigs.has(JSON.stringify(content))) return; // echo of an input message
            const role: Turn['role'] = t.role === 'user' && isToolResult ? 'tool' : t.role;
            const tokens = (t.usage?.input_tokens ?? 0) + (t.usage?.output_tokens ?? 0);
            spentUsd += t.cost_usd ?? 0;
            spentTokens += tokens;
            if (role === 'assistant') recordedAssistant++;
            newTurns.push(
              await this.d.sessions.recordTurn({
                session_id,
                step_id: CONVERSATION_STEP_ID,
                attempt: turnIndex,
                role,
                username: null,
                content,
                model_id: t.model_id ?? null,
                tokens_in: t.usage?.input_tokens ?? null,
                tokens_out: t.usage?.output_tokens ?? null,
                cost_usd: t.cost_usd ?? null,
                latency_ms: t.latency_ms ?? null,
                fallback_from: t.fallback_from ?? null,
              }),
            );
          },
          onToolCall: async (call) => {
            await this.d.sessions.appendEvent(session_id, 'tool-call', { id: call.id, name: call.name, input: call.input, attempt: turnIndex }, CONVERSATION_STEP_ID);
          },
          onToolResult: async (r) => {
            await this.d.sessions.appendEvent(session_id, 'tool-result', { id: r.id, name: r.name, output: capValue(r.output), is_error: r.is_error, attempt: turnIndex }, CONVERSATION_STEP_ID);
          },
          checkBudget: async () => {
            if (spentUsd >= budget.max_cost_usd || spentTokens >= budget.max_tokens) throw new BreadboardError('budget-exceeded', 'conversation budget exhausted');
          },
        },
      });
    } catch (e) {
      budget.spent_usd = spentUsd;
      budget.spent_tokens = spentTokens;
      if (e instanceof BreadboardError && e.code === 'budget-exceeded') {
        detail.draft_task = await this.detectDraft(session_id, detail.draft_task);
        await this.suspendForBudget(session, { ...detail, context: persistable(context) }, budget);
        throw e;
      }
      await this.d.sessions.update(session_id, { budget, state_detail: { ...detail, context: persistable(context), last_error: errMsg(e) } }).catch(() => undefined);
      throw e;
    }

    // Prefer the loop's totals (authoritative) when hooks under-reported.
    const resultTokens = (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0);
    budget.spent_usd = round(Math.max(spentUsd, session.budget.spent_usd + (result.cost_usd ?? 0)));
    budget.spent_tokens = Math.max(spentTokens, session.budget.spent_tokens + resultTokens);

    // The final text is the reply; record it unless the hooks already did.
    const finalText = (result.final_text ?? '').trim();
    const lastAssistant = [...newTurns].reverse().find((t) => t.role === 'assistant');
    const alreadyRecorded = lastAssistant && normalizeContent(lastAssistant.content).some((c) => c.type === 'text' && c.text.trim() === finalText);
    if (finalText && !alreadyRecorded) {
      const unreported = recordedAssistant === 0;
      newTurns.push(
        await this.d.sessions.recordTurn({
          session_id,
          step_id: CONVERSATION_STEP_ID,
          attempt: turnIndex,
          role: 'assistant',
          username: null,
          content: [{ type: 'text', text: finalText }],
          model_id: result.model_ids?.[result.model_ids.length - 1] ?? null,
          // When no per-turn hook fired, carry the exchange's cost on the reply so turn-sum cost stays right.
          tokens_in: unreported ? (result.usage?.input_tokens ?? null) : null,
          tokens_out: unreported ? (result.usage?.output_tokens ?? null) : null,
          cost_usd: unreported ? (result.cost_usd ?? null) : null,
        }),
      );
    }

    if (session.kind === 'intake') detail.draft_task = await this.detectDraft(session_id, detail.draft_task);
    const nextDetail = { ...detail, context: persistable(context), last_error: null };
    if (exhausted(budget)) await this.suspendForBudget(session, nextDetail, budget);
    else await this.d.sessions.update(session_id, { budget, state_detail: nextDetail });

    const proposals = (await this.proposalIds(session_id)).filter((id) => !proposalsBefore.has(id));
    return { turns: newTurns, draft_task: session.kind === 'intake' ? await this.draftTask(session_id) : null, proposals };
  }

  async turns(sessionId: string, by: Principal): Promise<Turn[]> {
    await this.mustAccess(sessionId, by);
    return this.d.sessions.turns(sessionId);
  }

  async list(input: Parameters<ConversationService['list']>[0]): Promise<SessionRecord[]> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const page = await this.d.sessions.list({ kind: input.kind ? [input.kind] : [...CONVERSATION_KINDS], limit: 200 });
    const me = input.by.actor;
    const own = (s: SessionRecord) => {
      const a = ((s.state_detail as any)?.started_by ?? (s as any).created_by) as { kind?: string; id?: string } | undefined;
      return a?.kind === me.kind && a?.id === me.id;
    };
    const visible = page.items.filter((s) => s.team_id === undefined || s.team_id === this.d.team_id).filter((s) => !input.by.grants || canSeeSession(input.by, s.session_id));
    // The user's own sessions first; all team sessions visible. Stable within each group (store order).
    return [...visible.filter(own), ...visible.filter((s) => !own(s))].slice(0, limit);
  }

  async draftTask(sessionId: string): Promise<Record<string, unknown> | null> {
    const s = await this.d.sessions.get(sessionId);
    if (!s) throw notFound('session', sessionId);
    if (s.kind !== 'intake') return null;
    const draft = ((s.state_detail as any)?.draft_task ?? null) as DraftTask | null;
    if (!draft) return null;
    if (draft.task_uid) {
      try {
        const node = await this.d.content.getNode(draft.task_uid, this.svc);
        const props = (node.properties ?? {}) as Record<string, any>;
        let references = draft.references ?? [];
        try {
          const edges = await this.d.content.edges(node.uid, this.svc, { direction: 'out', type: ['references'] });
          references = [...new Set([...references, ...edges.map((e: any) => e.dst ?? e.dst_uid).filter(Boolean)])];
        } catch {
          /* edges optional */
        }
        return {
          source: 'task',
          task_uid: node.uid,
          title: node.title,
          body: node.body_text ?? (typeof node.body === 'string' ? node.body : null),
          priority: props.priority ?? draft.priority ?? null,
          target_circuit: props.target_circuit ?? draft.target_circuit ?? null,
          status: props.status ?? null,
          references,
          created_tasks: draft.created_tasks ?? [node.uid],
          node,
        };
      } catch (e) {
        if (!(e instanceof BreadboardError && e.code === 'not-found')) throw e;
        return { source: 'draft', ...draft, missing: true };
      }
    }
    return { source: 'draft', ...draft };
  }

  // -------------------------------------------------------------------------
  private async mustAccess(sessionId: string, by: Principal): Promise<SessionRecord> {
    const s = await this.d.sessions.get(sessionId);
    if (!s || (s.team_id && s.team_id !== by.team_id)) throw notFound('session', sessionId);
    if (!(CONVERSATION_KINDS as readonly string[]).includes(s.kind)) throw invalidState(`session ${sessionId} is a ${s.kind} session, not a conversation`);
    // Any team user may access team conversations; AI principals only within their visible sessions.
    if (by.grants && !canSeeSession(by, sessionId)) throw notFound('session', sessionId);
    return s;
  }

  private async suspendForBudget(session: SessionRecord, detail: Record<string, any>, budget: SessionRecord['budget']): Promise<void> {
    const sid = session.session_id;
    await this.d.sessions.update(sid, { state: 'suspended-error', budget, state_detail: { ...detail, reason: 'budget-exceeded' } });
    await this.d.sessions.appendEvent(sid, 'budget-exceeded', { spent_usd: budget.spent_usd, spent_tokens: budget.spent_tokens, max_cost_usd: budget.max_cost_usd, max_tokens: budget.max_tokens }, CONVERSATION_STEP_ID);
    await this.d.sessions.appendEvent(sid, 'session-suspended', { reason: 'budget-exceeded' }, CONVERSATION_STEP_ID);
    await this.d.events.publish('session.state', { session_id: sid, kind: session.kind, state: 'suspended-error', reason: 'budget-exceeded' }).catch(() => undefined);
  }

  private async proposalIds(sessionId: string): Promise<string[]> {
    const r = await this.d.db.query(`SELECT proposal_id FROM config_proposals WHERE session_id=$1 ORDER BY created_at`, [sessionId]);
    return r.rows.map((x) => String(x.proposal_id).trim());
  }

  /** Detect `create_task` calls from the session's tool-call/tool-result events and fold them into the draft. */
  private async detectDraft(sessionId: string, current: DraftTask | undefined): Promise<DraftTask> {
    const draft: DraftTask = { ...emptyDraft(), ...(current ?? {}) };
    const events = await allEvents(this.d.sessions, sessionId);
    const calls = new Map<string, Record<string, any>>();
    const created = new Set(draft.created_tasks ?? []);
    for (const e of events) {
      const name = String(e.payload?.name ?? '');
      if (!CREATE_TASK_RE.test(name)) continue;
      const id = String(e.payload.id ?? e.payload.tool_use_id ?? e.payload.call_id ?? '');
      if (e.event_type === 'tool-call') {
        const inp = (e.payload.input ?? {}) as Record<string, any>;
        calls.set(id, inp);
        if (typeof inp.title === 'string') draft.title = inp.title;
        if (typeof inp.body === 'string') draft.body = inp.body;
        if (typeof inp.priority === 'string') draft.priority = inp.priority;
        if (typeof inp.target_circuit === 'string') draft.target_circuit = inp.target_circuit;
        if (Array.isArray(inp.references)) draft.references = [...new Set([...draft.references, ...inp.references.filter(isUid)])];
      } else if (e.event_type === 'tool-result' && !e.payload.is_error) {
        const uid = taskUidOf(e.payload.output);
        if (uid) {
          draft.task_uid = uid;
          created.add(uid);
        }
      }
    }
    if (created.size) draft.created_tasks = [...created];
    return draft;
  }

  /** Context preamble ([10] §4.5): the open definition as on screen (working tree), open proposal, or the draft task. */
  /**
   * A designer chat reads the definition it is open on and what it references, but circuits are readable only with a
   * grant. Grant read on the open circuit and its sub-circuits for this conversation (subagents, tools, and MCP
   * onboarding need no grant).
   */
  private async withOpenDefinition(p: Principal, session: SessionRecord, context: Record<string, any>): Promise<Principal> {
    const uid = typeof context.definition_uid === 'string' ? context.definition_uid : null;
    if (session.kind !== 'conversation' || !uid || !p.grants?.circuits) return p;
    let def: { kind: string; definition: unknown };
    try {
      def = await this.d.config.definition(uid, context.ref ?? undefined);
    } catch {
      return p;
    }
    if (def.kind !== 'circuit') return p;
    const steps = ((def.definition as { steps?: Array<{ kind?: string; circuit?: string }> })?.steps ?? []).filter((s) => s.kind === 'circuit' && s.circuit);
    const read = new Set([...p.grants.circuits.read, uid, ...steps.map((s) => s.circuit!)]);
    return { ...p, grants: { ...p.grants, circuits: { ...p.grants.circuits, read } } };
  }

  private async preamble(session: SessionRecord, context: Record<string, any>): Promise<string | null> {
    const parts: string[] = [];
    if (session.kind === 'conversation' && typeof context.definition_uid === 'string' && context.definition_uid) {
      parts.push(await this.definitionPreamble(context.definition_uid, context.ref ?? undefined, context.working_tree));
    }
    if (typeof context.proposal_id === 'string' && context.proposal_id) {
      try {
        const p = await this.d.config.getProposal(context.proposal_id);
        const changes = (p.changes ?? []).map((c) => `- ${c.status} ${c.path}`).join('\n');
        parts.push(`[Open proposal] ${p.proposal_id} (${p.status}) on branch ${p.branch}: ${p.message}\n${changes}\n\`\`\`diff\n${cap(p.diff ?? '', DIFF_CAP)}\n\`\`\``);
      } catch (e) {
        parts.push(`[Open proposal] ${context.proposal_id} (unavailable: ${errMsg(e)})`);
      }
    }
    if (session.kind === 'intake') {
      const draft = await this.draftTask(session.session_id);
      if (draft) {
        const { node: _node, ...shown } = draft as Record<string, unknown>;
        const empty = !shown.task_uid && !shown.title && !shown.body;
        parts.push(empty ? '[Draft task] none yet' : `[Draft task]\n\`\`\`json\n${JSON.stringify(shown, null, 2)}\n\`\`\``);
      }
    }
    return parts.length ? cap(parts.join('\n\n'), PREAMBLE_CAP) : null;
  }

  private async definitionPreamble(uidOrPath: string, ref: string | undefined, workingTree: unknown): Promise<string> {
    let dto;
    try {
      dto = await this.d.config.definition(uidOrPath, ref);
    } catch (e) {
      return `[Open definition] ${uidOrPath} (could not be read: ${errMsg(e)})`;
    }
    const wt = workingTree && typeof workingTree === 'object' && !Array.isArray(workingTree) ? (workingTree as Record<string, string | null>) : {};
    const dir = dto.path.includes('/') ? dto.path.slice(0, dto.path.lastIndexOf('/') + 1) : '';
    const base = dto.path.slice(dir.length);
    let raw: string | null = dto.raw;
    let rawEdited = false;
    const files: Record<string, { content: string | null; edited: boolean }> = {};
    for (const [rel, content] of Object.entries(dto.files ?? {})) files[rel] = { content, edited: false };
    for (const [p, content] of Object.entries(wt)) {
      if (p === dto.path || p === base) {
        raw = content;
        rawEdited = true;
        continue;
      }
      const rel = dir && p.startsWith(dir) ? p.slice(dir.length) : p;
      files[rel] = { content: content ?? null, edited: true };
    }
    const edited = [rawEdited ? dto.path : null, ...Object.entries(files).filter(([, f]) => f.edited).map(([k]) => k)].filter(Boolean);
    const lines: string[] = [];
    lines.push(`[Open definition] ${dto.kind} ${dto.title ?? dto.slug ?? ''} (uid ${dto.uid ?? '-'}, path ${dto.path}, commit ${dto.commit.slice(0, 12)})`);
    if (edited.length) lines.push(`The editor has unsaved working-tree changes (shown below instead of the committed version): ${edited.join(', ')}`);
    lines.push(`--- ${dto.path}${rawEdited ? ' (working tree)' : ''} ---\n${raw === null ? '(deleted in working tree)' : cap(raw, RAW_CAP)}`);
    for (const [rel, f] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`--- ${dir}${rel}${f.edited ? ' (working tree)' : ''} ---\n${f.content === null ? '(deleted in working tree)' : cap(f.content, FILE_CAP)}`);
    }
    if (dto.validation && !dto.validation.ok) lines.push(`Validation errors at ${dto.commit.slice(0, 12)}: ${dto.validation.errors.join('; ')}`);
    if (dto.referenced_by?.length) lines.push(`Referenced by: ${dto.referenced_by.map((r) => `${r.kind} ${r.slug ?? r.uid}`).join(', ')}`);
    return lines.join('\n');
  }
}

export function createConversationService(deps: ConversationServiceDeps): ConversationServiceImpl {
  return new ConversationServiceImpl(deps);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function configResolvedPayload(commit: string, r: ResolvedSubagent) {
  return { commit, subagent_uid: r.uid, subagent_commit: r.commit, model_preset: r.model_preset, injected_notes: r.injected_notes };
}

function persistable(ctx: Record<string, any>): Record<string, any> {
  const { working_tree: _wt, ...rest } = ctx ?? {};
  return rest;
}

function exhausted(b: SessionRecord['budget']): boolean {
  return b.spent_usd >= b.max_cost_usd || b.spent_tokens >= b.max_tokens;
}

export function normalizeContent(c: unknown): ChatContent[] {
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  if (Array.isArray(c)) return c as ChatContent[];
  if (c && typeof c === 'object' && Array.isArray((c as any).content)) return (c as any).content as ChatContent[];
  if (c && typeof c === 'object' && typeof (c as any).text === 'string') return [{ type: 'text', text: (c as any).text }];
  return [];
}

/** Rebuild the model-facing history from recorded turns; user turns carry the username ([02] §2). */
export function historyMessages(turns: Turn[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const t of turns) {
    if (t.role === 'system') continue;
    let content = normalizeContent(t.content);
    if (content.length === 0) continue;
    if (t.role === 'user' && t.username) {
      let done = false;
      content = content.map((c) => {
        if (!done && c.type === 'text') {
          done = true;
          return { type: 'text', text: `[@${t.username}] ${c.text}` };
        }
        return c;
      });
    }
    out.push({ role: t.role, content });
  }
  return out;
}

function taskUidOf(output: unknown): string | null {
  const o = output as any;
  for (const v of [o?.uid, o?.task_uid, o?.node?.uid, o?.task?.uid]) if (isUid(v)) return v;
  if (typeof output === 'string') {
    try {
      return taskUidOf(JSON.parse(output));
    } catch {
      return null;
    }
  }
  return null;
}

async function allEvents(store: SessionStore, sessionId: string): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  let after = 0;
  for (let i = 0; i < 100; i++) {
    const batch = await store.events(sessionId, after, 1000);
    out.push(...batch);
    if (batch.length < 1000) break;
    after = batch[batch.length - 1]!.seq;
  }
  return out;
}

function capValue(v: unknown): unknown {
  let s: string;
  try {
    s = JSON.stringify(v ?? null);
  } catch {
    return String(v);
  }
  return s.length <= TOOL_OUTPUT_CAP ? v : { truncated: true, preview: s.slice(0, TOOL_OUTPUT_CAP) };
}

function cap(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]`;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
