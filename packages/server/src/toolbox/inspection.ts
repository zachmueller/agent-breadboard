/**
 * Inspection primitives ([11] §4): read-only views over sessions, content, configuration, knowledge, evals and the
 * instance itself, for a team member's local harness (Claude Code over MCP) and for subagents granted them. Each is
 * a thin wrapper over the service method its REST route calls, so scope, session visibility and knowledge grants
 * are enforced identically. Long values are clipped (`max_chars`) and marked `truncated` ([primitive-defs]).
 */
import { BreadboardError, NODE_TYPES, PROPOSAL_STATUSES, SESSION_KINDS, SESSION_STATES, resultText, toBlocks, type NodeDto, type SessionRecord, type Turn } from '@breadboard/shared';
import { canSeeSession, type Principal } from '../core/principal.js';
import { tokenAccess } from '../identity/identity.js';
import { buildDashboard } from '../core/dashboard.js';
import { ANALYSIS_VIEWS } from '../evals/analysis.js';
import { proposalToolChecks } from './proposal-checks.js';
import { clipJson, clipText, LIMIT, MAX_CHARS, obj, sessionVisible, STRING_ARRAY, UID, type PrimitiveDef, type PrimitivesDeps } from './primitive-defs.js';

type TurnRow = Turn & { attempt?: number; latency_ms?: number | null; fallback_from?: string | null };

const SESSION_ID = { type: 'string', minLength: 1, description: 'Session id (`ses_…`).' };
const ISO = (what: string) => ({ type: 'string', description: `${what} (ISO 8601 timestamp).` });

function isoArg(v: string | undefined, name: string): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (Number.isNaN(Date.parse(v))) throw new BreadboardError('validation-failed', `${name} must be an ISO 8601 timestamp, got '${v}'`);
  return new Date(v).toISOString();
}
const ENUM_ARRAY = (values: readonly string[], description: string) => ({ type: 'array', items: { type: 'string', enum: [...values] }, description });

/** The session columns worth carrying in every listing; `state_detail` clipped (gate info, errors, chat context). */
function sessionHeader(s: SessionRecord) {
  return {
    session_id: s.session_id,
    kind: s.kind,
    state: s.state,
    circuit_uid: s.circuit_uid,
    circuit_slug: s.circuit_slug ?? null,
    task_uid: s.task_uid,
    parent_session: s.parent_session,
    parent_step_id: s.parent_step_id,
    config_commit: s.config_commit,
    priority: s.priority ?? null,
    created_by: s.created_by ?? null,
    created_at: s.created_at,
    started_at: s.started_at,
    ended_at: s.ended_at,
    budget: s.budget,
    state_detail: clipJson(s.state_detail, 2000),
  };
}

/** A node without its body (use `read_node` for that); `body_preview` is the first 200 characters. */
function compactNode(n: NodeDto) {
  const text = n.body_text ?? (typeof n.body === 'string' ? n.body : null);
  return {
    uid: n.uid,
    type: n.type,
    title: n.title,
    tags: n.tags,
    scope: n.scope,
    properties: n.properties,
    head_revision: n.head_revision,
    session_id: n.session_id ?? null,
    created_at: n.created_at,
    created_by: n.created_by,
    updated_at: n.updated_at,
    body_preview: text === null ? null : clipText(text, 200),
  };
}

function renderTurn(t: TurnRow, index: number, max: number) {
  const blocks = toBlocks(t.content).map((b) => {
    if (b.kind === 'text') {
      const c = clipText(b.text, max);
      return typeof c === 'string' ? { type: 'text', text: c } : { type: 'text', ...c };
    }
    if (b.kind === 'reasoning') {
      const c = clipText(b.text, max);
      return { type: 'reasoning', ...(typeof c === 'string' ? { text: c } : c), ...(b.redacted ? { redacted: true } : {}) };
    }
    if (b.kind === 'tool_use') return { type: 'tool_use', id: b.id ?? null, name: b.name, input: clipJson(b.input, max) };
    if (b.kind === 'tool_result') {
      const text = resultText(b.content);
      return { type: 'tool_result', tool_use_id: b.id ?? null, is_error: !!b.is_error, content: text !== null ? clipText(text, max) : clipJson(b.content, max) };
    }
    return { type: 'other', value: clipJson(b.value, max) };
  });
  return {
    index,
    turn_id: t.turn_id,
    step_id: t.step_id,
    attempt: t.attempt ?? 1,
    role: t.role,
    username: t.username,
    model_id: t.model_id,
    tokens_in: t.tokens_in,
    tokens_out: t.tokens_out,
    ...(t.tokens_cache_read ? { tokens_cache_read: t.tokens_cache_read } : {}),
    ...(t.tokens_cache_write ? { tokens_cache_write: t.tokens_cache_write } : {}),
    cost_usd: t.cost_usd,
    latency_ms: t.latency_ms ?? null,
    fallback_from: t.fallback_from ?? null,
    created_at: t.created_at,
    blocks,
  };
}

/** `name` or `name#attempt` → the `turns()` arguments. */
function parseStep(step: string | undefined): { step_id?: string; attempt?: number } {
  if (!step) return {};
  const [step_id, attempt] = step.split('#');
  const n = attempt ? Number(attempt) : undefined;
  if (attempt !== undefined && !Number.isInteger(n)) throw new BreadboardError('validation-failed', `step attempt must be an integer, got '${attempt}'`);
  return { step_id: step_id || undefined, attempt: n };
}

async function visibleSession(d: PrimitivesDeps, p: Principal, id: string): Promise<SessionRecord> {
  if (!(await sessionVisible(d.sessions, p, id))) throw new BreadboardError('grant-denied', `session ${id} is not visible to this principal`);
  return d.sessions.mustGet(id);
}

/** The repo path whose history tells a definition's story: its directory for circuits and tools, else its file. */
function historyPath(defPath: string): string {
  const m = /^((?:circuits|tools)\/[^/]+)\//.exec(defPath);
  return m ? m[1]! : defPath;
}

export function inspectionCatalog(d: PrimitivesDeps): PrimitiveDef[] {
  return [
    // ---------------- Instance ----------------
    {
      name: 'whoami',
      scope: null,
      description:
        "Who this connection acts as: user, review roles, admin flag, token kind, scopes, a personal token's `access` tier (`read-only`, `editor`, or `full`, which only an admin holds and which alone may merge proposals and record gate verdicts; `read_only` when the token cannot write), and the Breadboard session this connection is logged on.",
      input_schema: obj({}),
      handler: async (_a, p) => ({
        actor: p.actor,
        user: p.user ? { user_id: p.user.user_id, handle: p.user.handle, display_name: p.user.display_name, is_admin: p.user.is_admin } : null,
        roles: p.roles,
        is_admin: p.is_admin,
        token_kind: p.token_kind,
        scopes: p.scopes,
        ...(p.token_kind === 'personal' ? { access: tokenAccess(p.scopes) } : {}),
        read_only: p.scopes !== null && p.scopes.every((s) => s.endsWith(':read') || s === 'mcp:call'),
        session_id: p.session_id,
        team_id: p.team_id,
      }),
    },
    {
      name: 'get_breadboard_overview',
      scope: 'sessions:read',
      description: 'One-call health picture of this Breadboard: instance (name, version, database, sandbox, model providers, public URL), config main commit and definition counts by kind, dispatcher capacity and hourly spend, session counts by state, the active admins, open and draft proposals, your review-queue size, knowledge domains, need-input rate over 30 days, eval dashboard, recent model fallbacks, connector status and the repository mirrors you can search (`search_repo`).',
      input_schema: obj({}),
      handler: async (_a, p) => {
        const quiet = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
          try {
            return await fn();
          } catch (err) {
            d.log.warn({ err, panel: name }, 'overview panel failed');
            return null;
          }
        };
        const [dash, main_commit, tree, open, drafts, domains, providers, repos, users] = await Promise.all([
          buildDashboard({ content: d.content, dispatcher: d.dispatcher(), sessions: d.sessions, evals: d.evals, gateway: d.gateway, connectors: d.connectors() }, p, d.log),
          quiet('config.main', () => d.config.mainCommit()),
          quiet('config.tree', () => d.config.tree()),
          quiet('proposals', () => d.config.pageProposals({ status: 'open', limit: 1 })),
          quiet('drafts', () => d.config.pageProposals({ status: 'draft', limit: 1 })),
          quiet('knowledge', () => d.knowledge.domains()),
          quiet('providers', async () => d.gateway.providers()),
          quiet('repos', () => d.mirrors().status(p)),
          quiet('users', () => d.identity.listUsers(d.team_id)),
        ]);
        const definitions: Record<string, number> = {};
        for (const e of tree ?? []) definitions[e.kind] = (definitions[e.kind] ?? 0) + 1;
        const series = dash.need_input?.series ?? [];
        const requests = series.reduce((a, x) => a + x.requests, 0);
        const deliverables = series.reduce((a, x) => a + x.deliverables, 0);
        return {
          instance: { ...d.instance, providers: providers ?? [] },
          config: { main_commit, definitions },
          capacity: dash.capacity,
          sessions: dash.sessions,
          admins: users ? users.filter((u) => u.is_admin && !u.deactivated_at).map((u) => u.handle) : null,
          open_proposals: open ? open.total : null,
          draft_proposals: drafts ? drafts.total : null,
          review_count: dash.review_count,
          knowledge: domains ? { domains: domains.length, by_domain: domains.map((x) => ({ slug: x.slug, note_count: x.note_count })) } : null,
          need_input_30d: dash.need_input ? { requests, deliverables, rate: deliverables ? requests / deliverables : null, by_circuit: dash.need_input.by_circuit } : null,
          evals: dash.evals,
          gateway_fallbacks: dash.gateway_fallbacks.slice(-5),
          connectors: dash.connectors,
          repos: repos ? repos.map((r) => ({ name: r.name, description: r.description, branch: r.branch, phase: r.phase, commit: r.commit, fetched_at: r.fetched_at, stale: r.stale, last_error: r.last_error })) : null,
        };
      },
    },
    {
      name: 'list_users',
      scope: null,
      description: 'The team roster: user ids, handles, display names, admin flags and review roles (the names `tag_need_input` and gate routing use). Deactivated users are excluded unless asked for.',
      input_schema: obj({
        include_deactivated: { type: 'boolean', description: 'Include deactivated users (default false).' },
        include_roles: { type: 'boolean', description: 'Include each user\'s review roles (default true).' },
      }),
      handler: async (a) => {
        const all = await d.identity.listUsers(d.team_id);
        const kept = a.include_deactivated ? all : all.filter((u) => !u.deactivated_at);
        const users = await Promise.all(
          kept.map(async (u) => ({
            user_id: u.user_id,
            handle: u.handle,
            display_name: u.display_name,
            is_admin: u.is_admin,
            created_at: u.created_at,
            deactivated_at: u.deactivated_at,
            ...(a.include_roles === false ? {} : { roles: await d.identity.rolesOfUser(u.user_id) }),
          })),
        );
        return { total: users.length, users };
      },
    },

    // ---------------- Sessions ----------------
    {
      name: 'list_sessions',
      scope: 'sessions:read',
      description: 'List sessions newest first (`order: asc` for oldest first): circuit runs, intake chats, designer and MCP conversations, eval runs. Filter by state, kind, circuit (UID or slug), task, parent, creator (`me` or an actor id), the definition a designer chat was opened on, runs on a proposal branch (`proposal_id`), or a time window (`created_after` / `created_before`). Each row carries its cost including child sessions. Page with `cursor`, or with `offset`, which also returns `total`.',
      input_schema: obj({
        state: ENUM_ARRAY(SESSION_STATES, 'Only these states.'),
        kind: ENUM_ARRAY(SESSION_KINDS, 'Only these kinds.'),
        circuit: { type: 'string', description: 'Circuit UID or slug.' },
        task: UID,
        parent: { type: 'string', description: 'Only children of this session.' },
        created_by: { type: 'string', description: '`me`, or an actor id (user id, subagent UID).' },
        definition: { type: 'string', description: 'Designer chats opened on this configuration definition (UID).' },
        created_after: ISO('Only sessions created at or after'),
        created_before: ISO('Only sessions created at or before'),
        proposal_id: { type: 'string', description: 'Only runs on this proposal branch (`run_circuit {proposal_id}`).' },
        order: { type: 'string', enum: ['desc', 'asc'], description: 'Newest first (default) or oldest first.' },
        limit: LIMIT(200, 20, 'sessions'),
        cursor: { type: 'string', description: '`next_cursor` from the previous page.' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many sessions instead of using `cursor`; the result then carries `total`.' },
      }),
      handler: async (a, p) => {
        const page = await d.sessions.list({
          state: a.state,
          kind: a.kind,
          circuit: a.circuit,
          task: a.task,
          parent: a.parent,
          created_by: a.created_by === 'me' ? p.actor.id : a.created_by,
          definition: a.definition,
          proposal: a.proposal_id,
          created_after: isoArg(a.created_after, 'created_after'),
          created_before: isoArg(a.created_before, 'created_before'),
          order: a.order,
          cursor: a.cursor ?? null,
          offset: a.offset,
          limit: a.limit ?? 20,
        });
        const visible = page.items.filter((s) => canSeeSession(p, s.session_id));
        const costs = await d.sessions.costsIncludingChildren(visible.map((s) => s.session_id));
        const sessions = visible.map((s) => ({ ...sessionHeader(s), cost_usd: costs.get(s.session_id) ?? 0 }));
        return { sessions, next_cursor: page.next_cursor ?? null, ...(page.total !== undefined ? { total: page.total } : {}) };
      },
    },
    {
      name: 'read_session_transcript',
      scope: 'sessions:read',
      description:
        'The conversation of a session you can see, turn by turn: system, user and assistant turns with their text, tool calls (name and input) and tool results, plus per-turn model, tokens, cost and latency. Works for circuit runs (all steps, or one `step`) and for chats. Long values are clipped; read one turn in full with `turn_id` (unclipped unless `max_chars` is given). Page with `offset`.',
      input_schema: obj(
        {
          session_id: SESSION_ID,
          step: { type: 'string', description: 'Only this step: `name` (every attempt) or `name#2` (one attempt).' },
          turn_id: { type: 'string', description: 'Only this turn (`trn_…`), in full.' },
          offset: { type: 'integer', minimum: 0, description: 'Skip this many turns (default 0).' },
          limit: LIMIT(200, 40, 'turns'),
          max_chars: MAX_CHARS(4000),
        },
        ['session_id'],
      ),
      handler: async (a, p) => {
        const session = await visibleSession(d, p, a.session_id);
        const { step_id, attempt } = parseStep(a.step);
        let turns: TurnRow[] = await d.sessions.turns(a.session_id, step_id, attempt);
        if (a.turn_id) {
          turns = turns.filter((t) => t.turn_id === a.turn_id);
          if (!turns.length) throw new BreadboardError('not-found', `turn ${a.turn_id} not found in session ${a.session_id}`);
        }
        const offset = a.offset ?? 0;
        const limit = a.limit ?? 40;
        const max = a.max_chars ?? (a.turn_id ? 0 : 4000);
        const page = turns.slice(offset, offset + limit);
        return {
          session: sessionHeader(session),
          total_turns: turns.length,
          offset,
          next_offset: offset + page.length < turns.length ? offset + page.length : null,
          turns: page.map((t, i) => renderTurn(t, offset + i, max)),
        };
      },
    },
    {
      name: 'read_session_events',
      scope: 'sessions:read',
      description:
        "A session's orchestrator event log in order: session-started, config-resolved, step-started/exited/failed, retry-scheduled, gate-suspended/verdict/resolved, budget-exceeded, tool-call/tool-result, session-completed/cancelled. `turn` events are left out unless `include_turns` (use `read_session_transcript` for them). Filter by `types` or `step`; continue from `next_seq`.",
      input_schema: obj(
        {
          session_id: SESSION_ID,
          after_seq: { type: 'integer', minimum: 0, description: 'Only events with a larger `seq` (default 0 = from the start).' },
          limit: LIMIT(1000, 200, 'events'),
          types: STRING_ARRAY('Only these event types.'),
          step: { type: 'string', description: 'Only events of this step id.' },
          include_turns: { type: 'boolean', description: 'Include `turn` events (default false).' },
          max_chars: MAX_CHARS(2000),
        },
        ['session_id'],
      ),
      handler: async (a, p) => {
        await visibleSession(d, p, a.session_id);
        const limit = a.limit ?? 200;
        const max = a.max_chars ?? 2000;
        const types = a.types?.length ? new Set<string>(a.types) : null;
        const matches = (e: { event_type: string; step_id: string | null }) =>
          (types ? types.has(e.event_type) : a.include_turns || e.event_type !== 'turn') && (!a.step || e.step_id === a.step);
        const events: Array<Record<string, unknown>> = [];
        let after = a.after_seq ?? 0;
        let has_more = false;
        outer: for (;;) {
          const batch = await d.sessions.events(a.session_id, after, 1000);
          if (!batch.length) break;
          for (const e of batch) {
            if (matches(e)) {
              if (events.length >= limit) {
                has_more = true;
                break outer;
              }
              events.push({ seq: e.seq, event_type: e.event_type, step_id: e.step_id, created_at: e.created_at, payload: clipJson(e.payload, max) });
            }
            after = e.seq;
          }
          if (batch.length < 1000) break;
        }
        return { events, next_seq: after, has_more };
      },
    },
    {
      name: 'list_session_executions',
      scope: 'sessions:read',
      description: "The sandboxed tool executions of a session (the tool journal): tool UID and commit, step and attempt, status, input hash, output, error, logs and timing. Explains what a code step or a subagent's tool call actually did.",
      input_schema: obj({ session_id: SESSION_ID, step: { type: 'string', description: 'Only this step: `name` or `name#attempt`.' }, max_chars: MAX_CHARS(2000) }, ['session_id']),
      handler: async (a, p) => {
        await visibleSession(d, p, a.session_id);
        const { step_id, attempt } = parseStep(a.step);
        const max = a.max_chars ?? 2000;
        const rows = (await d.toolbox().executions(a.session_id)) as Array<Record<string, any>>;
        const kept = rows.filter((r) => (!step_id || r.step_id === step_id) && (attempt === undefined || Number(r.attempt) === attempt));
        return {
          total: kept.length,
          executions: kept.map((r) => ({
            execution_key: r.execution_key,
            step_id: r.step_id,
            attempt: r.attempt,
            call_index: r.call_index,
            tool_uid: typeof r.tool_uid === 'string' ? r.tool_uid.trim() : r.tool_uid,
            tool_commit: r.tool_commit,
            status: r.status,
            input_hash: r.input_hash,
            started_at: r.started_at,
            ended_at: r.ended_at,
            cost_units: r.cost_units,
            error: typeof r.error === 'string' ? clipText(r.error, max) : (r.error ?? null),
            output: clipJson(r.output, max),
            output_ref: r.output_ref ?? null,
            logs: clipJson(r.logs ?? null, max),
            log_ref: r.log_ref ?? null,
          })),
        };
      },
    },

    // ---------------- Content ----------------
    {
      name: 'search_nodes',
      scope: 'nodes:read',
      description:
        'Find content nodes (tasks, artifacts, comments, knowledge notes) by type, full-text query, tags, task status or priority, origin, circuit, open need-input requests, knowledge domain or time window. Returns nodes without bodies plus a short `body_preview`; read a body with `read_node`. Session-scoped scratch is included only when you name its `session_id`. Page with `cursor`.',
      input_schema: obj({
        type: { type: 'string', enum: [...NODE_TYPES], description: 'Node type.' },
        q: { type: 'string', description: 'Full-text search over title, aliases and body.' },
        tag: STRING_ARRAY('Only nodes carrying one of these tags (e.g. `deliverable`, `intermediate`).'),
        scope: { type: 'string', enum: ['team', 'session'], description: 'Node scope.' },
        status: STRING_ARRAY('Task status (draft, queued, running, blocked, needs-review, done, rejected…).'),
        priority: STRING_ARRAY('Task priority (p0–p3).'),
        origin_kind: STRING_ARRAY('Task origin kind (conversation, api, mcp…).'),
        circuit: { type: 'string', description: 'Only nodes produced under this circuit (UID).' },
        need_input_open: { type: 'boolean', description: 'Only nodes with an open need-input request.' },
        need_input_role: { type: 'string', description: 'Only nodes with an open need-input request targeting this review role.' },
        need_input_username: { type: 'string', description: 'Only nodes with an open need-input request targeting this user handle.' },
        domain: STRING_ARRAY('Knowledge domain slugs (knowledge notes).'),
        session_id: { type: 'string', description: "Include this session family's session-scoped nodes." },
        created_after: ISO('Only nodes created at or after'),
        created_before: ISO('Only nodes created at or before'),
        limit: LIMIT(200, 25, 'nodes'),
        cursor: { type: 'string', description: '`next_cursor` from the previous page.' },
      }),
      handler: async (a, p) => {
        const page = await d.content.listNodes({ ...a, limit: a.limit ?? 25 }, p);
        return { nodes: page.items.map(compactNode), next_cursor: page.next_cursor ?? null };
      },
    },
    {
      name: 'inspect_node',
      scope: 'nodes:read',
      description:
        'Everything about one content node except its body: the node, its revisions (newest first, with labels and authors), every edge in or out (produces, updates, derived-from, attached-to, blocks, depends-on, references), its comments with anchor status, and its lineage up (what it was built from, and the sessions that built it) and down (what was built from it). Read the body with `read_node`.',
      input_schema: obj(
        {
          uid: UID,
          lineage_depth: { type: 'integer', minimum: 0, maximum: 10, description: 'Lineage depth in each direction (default 2; 0 skips lineage).' },
          revisions_limit: LIMIT(200, 20, 'revisions'),
        },
        ['uid'],
      ),
      handler: async (a, p) => {
        const node = await d.content.getNode(a.uid, p);
        const depth = a.lineage_depth ?? 2;
        const [revisions, edges, comments, up, down] = await Promise.all([
          d.content.revisions(a.uid, p, { limit: a.revisions_limit ?? 20 }),
          d.content.edges(a.uid, p, { direction: 'both' }),
          d.content.comments(a.uid, p),
          depth > 0 ? d.content.lineage(a.uid, 'up', depth, p) : null,
          depth > 0 ? d.content.lineage(a.uid, 'down', depth, p) : null,
        ]);
        return {
          node: compactNode(node),
          revisions: revisions.map((r) => ({ revision_id: r.revision_id, labels: r.labels, created_at: r.created_at, created_by: r.created_by })),
          edges,
          comments: comments.map((c) => ({ uid: c.uid, body: c.body_text ?? c.body, properties: c.properties, created_at: c.created_at, created_by: c.created_by, stale: c.stale, anchor_status: c.anchor_status })),
          lineage: { up, down },
        };
      },
    },
    {
      name: 'get_review_queue',
      scope: 'nodes:read',
      description: 'What is waiting on you: artifacts with open need-input requests targeting you or your review roles, and artifacts gating a suspended run you can unblock.',
      input_schema: obj({ limit: LIMIT(200, 50, 'items') }),
      handler: async (a, p) => {
        const items = await d.content.reviewQueue(p, { limit: a.limit ?? 50 });
        return { total: items.length, items: items.map((i) => ({ node: compactNode(i.node), requests: i.requests, gating_session: i.gating_session })) };
      },
    },

    // ---------------- Configuration ----------------
    {
      name: 'get_config_history',
      scope: 'config:read',
      description: 'Commits that touched a definition (by UID, slug or `kind:slug`), a repo path, or the whole config repo, newest first: hash, author, date, message and changed files. Read any version with `read_config {ref, commit}` or compare two with `diff_config`.',
      input_schema: obj({
        ref: { type: 'string', description: 'A definition (UID, slug, `kind:slug`) or a repo-relative path; omit for the whole repo.' },
        at: { type: 'string', description: 'Walk back from this commit or branch (default main).' },
        limit: LIMIT(100, 20, 'commits'),
      }),
      handler: async (a) => {
        let path: string | undefined;
        if (a.ref) {
          if (/[/.]/.test(a.ref)) path = String(a.ref).replace(/^config\//, '');
          else path = historyPath((await d.config.definition(a.ref, a.at, { lenient: true })).path);
        }
        return { path: path ?? null, commits: await d.config.history({ path, ref: a.at, limit: a.limit ?? 20 }) };
      },
    },
    {
      name: 'list_proposals',
      scope: 'config:read',
      description: 'Configuration proposals (propose-review-commit): status, message, author, base and head commits, changed files, validation and attached eval runs, without the patch. `draft` proposals are staged branches not yet submitted for review; `open` ones are in the review queue. Filter by status, the conversation that opened one, or the definition it changes; page with `offset`. Read one with `read_proposal`.',
      input_schema: obj({
        status: { type: 'string', enum: [...PROPOSAL_STATUSES], description: 'Only this status.' },
        session_id: { type: 'string', description: 'Only proposals opened by this conversation.' },
        definition: { type: 'string', description: 'Only proposals changing this definition (UID).' },
        limit: LIMIT(200, 50, 'proposals'),
        offset: { type: 'integer', minimum: 0, description: 'Skip this many proposals (default 0); continue from `next_offset`.' },
      }),
      handler: async (a) => {
        const offset = a.offset ?? 0;
        const { total, proposals } = await d.config.pageProposals({ status: a.status, session_id: a.session_id, definition: a.definition, limit: a.limit ?? 50, offset });
        return {
          total,
          offset,
          next_offset: offset + proposals.length < total ? offset + proposals.length : null,
          proposals: proposals.map(({ diff: _diff, ...rest }) => rest),
        };
      },
    },
    {
      name: 'read_proposal',
      scope: 'config:read',
      description: 'One proposal in full: metadata, changed files, validation, eval runs, the tool checks (manifest and syntax) at its head, `affected_circuits` (circuits its changes reach, directly or through a tool, subagent, preset or tenets, with fixture counts: what to evaluate with `start_eval_run {proposal_id}`), and the unified patch (clipped; raise `max_chars` or set 0 for all of it).',
      input_schema: obj({ proposal_id: { type: 'string', minLength: 1, description: 'Proposal id (`prp_…`).' }, include_diff: { type: 'boolean', description: 'Include the patch (default true).' }, max_chars: MAX_CHARS(20000) }, ['proposal_id']),
      handler: async (a) => {
        const dto = await d.config.getProposal(a.proposal_id);
        const [checks, affected_circuits] = await Promise.all([proposalToolChecks(d.toolbox(), dto), d.config.affectedCircuits(dto.proposal_id).catch(() => [])]);
        const { diff, ...rest } = dto;
        return { ...rest, ...(a.include_diff === false ? {} : { diff: clipText(diff, a.max_chars ?? 20000) }), tool_checks: checks.tools, affected_circuits };
      },
    },
    {
      name: 'diff_config',
      scope: 'config:read',
      description: 'The unified patch between two commits or branches of the config repo (e.g. the `config_commit` of two runs, or a proposal\'s base and head), with the list of changed files.',
      input_schema: obj({ base: { type: 'string', minLength: 1, description: 'Base commit hash or branch.' }, head: { type: 'string', minLength: 1, description: 'Head commit hash or branch.' }, max_chars: MAX_CHARS(20000) }, ['base', 'head']),
      handler: async (a) => {
        const r = await d.config.diff(a.base, a.head);
        return { base: a.base, head: a.head, files: r.files, patch: clipText(r.patch, a.max_chars ?? 20000) };
      },
    },

    // ---------------- Knowledge ----------------
    {
      name: 'list_knowledge_domains',
      scope: 'knowledge:read',
      description: 'The Knowledge Domains you can read, with descriptions and note counts (the slugs `query_knowledge` filters on).',
      input_schema: obj({}),
      handler: async (_a, p) => {
        const all = await d.knowledge.domains();
        return { domains: p.grants ? all.filter((x) => p.grants!.knowledge.read.has(x.slug)) : all };
      },
    },

    // ---------------- Evals ----------------
    {
      name: 'list_eval_runs',
      scope: 'evals:read',
      description: 'Eval runs newest first, optionally for one circuit, status or proposal (`proposal_id`, or `none` for runs not on a proposal branch: the main-line baseline): run id, circuit, config ref, proposal, model overrides, status, aggregate scores and cost. Page with `offset`; the result carries `total`.',
      input_schema: obj({
        circuit: { type: 'string', description: 'Circuit UID.' },
        status: { type: 'string', description: 'Run status (running, completed, failed…).' },
        proposal_id: { type: 'string', description: 'Only runs on this proposal branch, or `none` for runs that were not.' },
        limit: LIMIT(200, 20, 'runs'),
        offset: { type: 'integer', minimum: 0, description: 'Skip this many runs (default 0).' },
      }),
      handler: async (a) => {
        const offset = a.offset ?? 0;
        const { items, total } = await d.evals.pageRuns({ circuit: a.circuit, status: a.status, proposal: a.proposal_id, limit: a.limit ?? 20, offset });
        return { total, offset, next_offset: offset + items.length < total ? offset + items.length : null, runs: items };
      },
    },
    {
      name: 'read_eval_run',
      scope: 'evals:read',
      description: 'One eval run with every fixture\'s outcome: the sessions it ran, per-dimension scores with rationales, aggregates and cost. `get_fixture_output` reads what the circuit produced for a fixture.',
      input_schema: obj({ eval_run_id: { type: 'string', minLength: 1, description: 'Eval run id.' } }, ['eval_run_id']),
      handler: async (a) => d.evals.getRun(a.eval_run_id),
    },
    {
      name: 'get_eval_analysis',
      scope: 'evals:read',
      description: 'Eval analysis for a circuit: `trend` (scores and cost over runs), `model-regression` (same circuit commit across model variants), `cheapest-model` (cost per passing variant), `circuit-regression` (base vs head commit), or `dashboard`.',
      input_schema: obj(
        {
          circuit_uid: { type: 'string', minLength: 1, description: 'Circuit UID.' },
          view: { type: 'string', enum: [...ANALYSIS_VIEWS], description: 'Analysis view.' },
          base: { type: 'string', description: 'circuit-regression: base circuit commit (or `evr_` run id).' },
          head: { type: 'string', description: 'circuit-regression: head circuit commit (or `evr_` run id).' },
          circuit_commit: { type: 'string', description: 'cheapest-model / model-regression: restrict to one circuit commit.' },
          variant: { type: 'string', description: 'circuit-regression / trend: restrict to one model_overrides variant.' },
        },
        ['circuit_uid', 'view'],
      ),
      handler: async (a) => d.evals.analysis(a.circuit_uid, a.view, { base: a.base, head: a.head, circuit_commit: a.circuit_commit, variant: a.variant }),
    },

    // ---------------- Events ----------------
    {
      name: 'list_recent_events',
      scope: 'events:read',
      description: 'Recent Breadboard events you can see, oldest first: session.state, session.event, task.status, need-input.tagged / resolved, config.committed, eval.run-completed, node.updated. Payloads carry ids and a minimal summary; follow up with the matching read tool. Continue with `after` = the last event id.',
      input_schema: obj({
        topics: STRING_ARRAY('Only these topics.'),
        after: { type: 'string', description: 'Only events after this event id.' },
        limit: LIMIT(500, 50, 'events'),
      }),
      handler: async (a, p) => {
        const topics = a.topics?.length ? new Set<string>(a.topics) : null;
        const all = await d.events.replay(a.after ?? null, a.limit ?? 50);
        const events = [];
        for (const e of all) if ((!topics || topics.has(e.topic)) && (await d.events.visibleTo(e, p))) events.push(e);
        return { events, next_after: all.length ? all[all.length - 1]!.id : (a.after ?? null) };
      },
    },
  ];
}
