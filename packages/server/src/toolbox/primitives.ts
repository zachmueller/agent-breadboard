/**
 * The Breadboard primitives ([06] §3, §7; [11] §4): the closed set of built-in operations available to
 * tool code via `ctx` (over `POST /api/v1/primitives/:name`), to Subagent tool loops (in-process), and to
 * MCP consumers (the Breadboard MCP server). One implementation behind every surface.
 *
 * Every primitive runs under the caller's Principal: services enforce scope + grants on the resources
 * themselves; this layer adds the primitive-level gates (which names a principal may call, `run_circuit`
 * execute grants, circuit read grants on `read_config`, session visibility on `get_session_summary`).
 */
import { BreadboardError, validateAgainst, type JsonSchema } from '@breadboard/shared';
import { proposalToolChecks } from './proposal-checks.js';
import { hasScope, requireScope, type Principal } from '../core/principal.js';
import type { ChatMessage, Primitives, SessionStore, ToolSpec } from '../core/services.js';
import { obj, sessionVisible, STRING_ARRAY, UID, type PrimitiveCallCtx, type PrimitiveDef, type PrimitivesDeps } from './primitive-defs.js';
import { inspectionCatalog } from './inspection.js';

export type { PrimitiveCallCtx, PrimitiveDef, PrimitivesDeps } from './primitive-defs.js';

/** Composition nesting cap for `run_tool` / `run_circuit` ([06] §2.2). */
export const MAX_COMPOSITION_DEPTH = 8;

/** Primitives never offered to users/services directly (tool-code only). */
const TOOL_CODE_ONLY = new Set(['broker_fetch', 'run_tool', 'model_converse']);
/** Primitives never offered to the model directly, whatever its grants. */
const NEVER_MODEL_DIRECT = new Set(['broker_fetch', 'model_converse']);
/** Reserved capability name: a tool declaring it may call `model_converse` (granted by the gateway, not the broker). */
export const MODEL_CAPABILITY = 'model';
/** Always available to subagent principals. */
const ALWAYS_FOR_SUBAGENTS = new Set(['read_node']);

const EDGE_TYPES = ['derived-from', 'attached-to', 'blocks', 'depends-on', 'references'] as const;
const OWNED_EDGE_TYPES = new Set(['produces', 'updates']);

// ---------------------------------------------------------------------------
// Schema fragments
// ---------------------------------------------------------------------------
const ARTIFACT_REF = {
  type: 'object',
  description: 'Revision-pinned reference to a content node.',
  properties: { uid: { type: 'string', description: 'Node UID.' }, revision_id: { type: 'integer', minimum: 1, description: 'Revision of the node the reference is pinned to.' } },
  required: ['uid', 'revision_id'],
  additionalProperties: false,
};
const FILE_CHANGES = {
  type: 'array',
  minItems: 1,
  description: 'File changes relative to the config repo root (no `config/` prefix). `content: null` deletes the file. Paths are UID-derived (e.g. `circuits/<UID>/circuit.yaml`).',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, description: 'Repo-relative file path.' },
      content: { type: ['string', 'null'], description: 'Full new file content, or null to delete the file.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
export class PrimitivesImpl implements Primitives {
  private readonly defs = new Map<string, PrimitiveDef>();
  readonly names: readonly string[];

  constructor(private readonly deps: PrimitivesDeps) {
    for (const d of this.buildCatalog()) this.defs.set(d.name, d);
    this.names = Object.freeze([...this.defs.keys()]);
  }

  /** The full catalog definitions (tests, docs). */
  definitions(): PrimitiveDef[] {
    return [...this.defs.values()];
  }

  spec(name: string): ToolSpec {
    const d = this.defs.get(name);
    if (!d) throw new BreadboardError('not-found', `unknown primitive '${name}'`);
    return { name: d.name, description: d.description, input_schema: d.input_schema };
  }

  /** What `principal` may call: allowed for its kind and grants, and within its token's scopes (a read-only token lists no writes). */
  specsFor(principal: Principal): ToolSpec[] {
    return this.names
      .filter((n) => {
        const scope = this.defs.get(n)?.scope;
        return this.allowed(n, principal) && (!scope || hasScope(principal, scope));
      })
      .map((n) => this.spec(n));
  }

  async call(name: string, args: unknown, principal: Principal, ctx: PrimitiveCallCtx = {}): Promise<unknown> {
    const def = this.defs.get(name);
    if (!def) throw new BreadboardError('not-found', `unknown primitive '${name}'`);
    // Who may call comes before what they sent: an unauthorized caller learns nothing about the schema.
    if (!this.allowed(name, principal)) throw new BreadboardError('grant-denied', `primitive '${name}' is not available to ${principal.actor.kind}:${principal.actor.id}`);
    if (def.scope) requireScope(principal, def.scope);
    const v = validateAgainst(def.input_schema, args ?? {});
    if (!v.ok) throw new BreadboardError('validation-failed', `invalid arguments for '${name}': ${v.errors.join('; ')}`, { errors: v.errors });
    this.deps.log.debug({ primitive: name, actor: principal.actor, session_id: ctx.session_id ?? null, step_id: ctx.step_id ?? null, depth: ctx.depth ?? 0 }, 'primitive call');
    return def.handler(v.value, principal, ctx);
  }

  /** Primitive-level gate by principal kind (resource-level grants are enforced by handlers/services). */
  private allowed(name: string, p: Principal): boolean {
    if (!this.defs.has(name)) return false;
    if (isToolCode(p)) return true;
    if (p.actor.kind === 'subagent') {
      if (NEVER_MODEL_DIRECT.has(name)) return false;
      if (ALWAYS_FOR_SUBAGENTS.has(name)) return true;
      const g = p.grants;
      if (!g || !g.primitives.has(name)) return false;
      if (g.tools_override && !g.tools_override.has(name)) return false;
      return true;
    }
    // users, services
    return !TOOL_CODE_ONLY.has(name);
  }

  // -------------------------------------------------------------------------
  private buildCatalog(): PrimitiveDef[] {
    const d = this.deps;
    const defs: PrimitiveDef[] = [
      // ---------------- Content ----------------
      {
        name: 'create_artifact',
        scope: 'nodes:write',
        description:
          'Create a new Artifact (a content node) — a deliverable for user review or an intermediate working document. Returns its UID and the first revision id. Lineage `produces` edges are recorded automatically by the orchestrator; use `derived_from` to record which inputs this artifact was built from.',
        input_schema: obj(
          {
            title: { type: 'string', minLength: 1, description: 'Human-readable title.' },
            body: { type: ['string', 'object'], description: 'Markdown string (preferred) or a structured JSON object.' },
            tags: STRING_ARRAY('Optional tags, e.g. `deliverable`.'),
            scope: { type: 'string', enum: ['team', 'session'], description: 'Visibility: `team` (all members) or `session` (only this session family). Defaults to the narrowest scope of `derived_from` parents.' },
            properties: { type: 'object', description: 'Optional typed properties stored on the node.' },
            derived_from: { type: 'array', items: ARTIFACT_REF, description: 'Revision-pinned nodes this artifact was derived from (emits `derived-from` edges).' },
          },
          ['title', 'body'],
        ),
        handler: async (a, p, ctx) => {
          const r = await d.content.createArtifact({ title: a.title, body: a.body, tags: a.tags, scope: a.scope, properties: a.properties, derived_from: a.derived_from, by: p, session_id: ctx.session_id ?? p.session_id, step_id: ctx.step_id ?? p.actor.step_id ?? null });
          return { uid: r.uid, revision_id: r.revision_id };
        },
      },
      {
        name: 'update_artifact',
        scope: 'nodes:write',
        description: 'Update an existing Artifact: replace its body and/or title, merge properties, add/remove tags. Cuts a new revision and returns it.',
        input_schema: obj(
          {
            uid: UID,
            body: { type: ['string', 'object'], description: 'New full body (Markdown string or JSON object). Omit to keep the current body.' },
            title: { type: 'string', minLength: 1, description: 'New title.' },
            properties: { type: 'object', description: 'Properties to merge into the node.' },
            tags_add: STRING_ARRAY('Tags to add.'),
            tags_remove: STRING_ARRAY('Tags to remove.'),
          },
          ['uid'],
        ),
        handler: async (a, p, ctx) => {
          const r = await d.content.updateArtifact({ uid: a.uid, body: a.body, title: a.title, properties: a.properties, tags_add: a.tags_add, tags_remove: a.tags_remove, by: p, session_id: ctx.session_id ?? p.session_id, step_id: ctx.step_id ?? p.actor.step_id ?? null });
          return { uid: r.uid, revision_id: r.revision_id };
        },
      },
      {
        name: 'read_node',
        scope: 'nodes:read',
        description: 'Read any content node you can see (Task, Artifact, Comment, Knowledge Note) by UID — the current head, or a specific immutable revision. Returns title, type, tags, properties, body and its Markdown text.',
        input_schema: obj({ uid: UID, revision_id: { type: 'integer', minimum: 1, description: 'Read this immutable revision instead of the current head.' } }, ['uid']),
        handler: async (a, p) => {
          const node = await d.content.getNode(a.uid, p);
          if (a.revision_id !== undefined && a.revision_id !== null) {
            const rev = await d.content.revision(a.uid, a.revision_id, p);
            return {
              uid: node.uid,
              type: node.type,
              title: node.title,
              scope: node.scope,
              tags: node.tags,
              properties: rev.properties,
              body: rev.body,
              body_text: rev.body_text,
              markdown: rev.body_text,
              revision_id: rev.revision_id,
              head_revision: node.head_revision,
              created_at: rev.created_at,
              created_by: rev.created_by,
            };
          }
          let markdown = node.body_text;
          if (node.crdt) {
            try {
              markdown = await d.knowledge.markdownOf(node.uid);
            } catch {
              /* fall back to the body_text mirror */
            }
          } else if (markdown === null && typeof node.body === 'string') markdown = node.body;
          return {
            uid: node.uid,
            type: node.type,
            title: node.title,
            scope: node.scope,
            tags: node.tags,
            properties: node.properties,
            body: node.body,
            body_text: node.body_text,
            markdown,
            revision_id: node.head_revision,
            head_revision: node.head_revision,
            created_at: node.created_at,
            created_by: node.created_by,
            updated_at: node.updated_at,
          };
        },
      },
      {
        name: 'add_comment',
        scope: 'nodes:write',
        description:
          'Attach a comment to a node, optionally anchored to a quoted passage. The quote must appear exactly once in the target (pass `context` — surrounding text — to disambiguate). Fails with `anchor-not-found`, `anchor-ambiguous` or `anchor-unmappable` when the quote cannot be anchored; re-read the node and retry with an exact quote.',
        input_schema: obj(
          {
            target: { type: 'string', description: 'UID of the node being commented on.' },
            body: { type: 'string', minLength: 1, description: 'Comment text (Markdown).' },
            anchor: obj(
              {
                revision: { type: 'integer', minimum: 1, description: 'Revision the quote was taken from (defaults to head).' },
                quote: { type: 'string', minLength: 1, description: 'Exact text being commented on.' },
                context: { type: 'string', description: 'Surrounding text to disambiguate a repeated quote.' },
              },
              ['quote'],
            ),
          },
          ['target', 'body'],
        ),
        handler: async (a, p, ctx) => {
          const r = await d.content.addComment({ target: a.target, body: a.body, anchor: a.anchor ?? null, by: p, session_id: ctx.session_id ?? p.session_id, step_id: ctx.step_id ?? p.actor.step_id ?? null });
          return { uid: r.uid, anchor_status: r.anchor_status };
        },
      },
      {
        name: 'emit_edge',
        scope: 'nodes:write',
        description:
          'Record an explicit typed edge between two content nodes: `derived-from` (src was built from dst), `attached-to`, `blocks` / `depends-on` (task dependencies), or `references`. `produces` / `updates` lineage is recorded automatically by the orchestrator and cannot be emitted.',
        input_schema: obj(
          {
            type: { type: 'string', enum: [...EDGE_TYPES], description: 'Edge type.' },
            src: { type: 'string', description: 'Source node UID.' },
            dst: { type: 'string', description: 'Destination node UID.' },
            dst_revision: { type: 'integer', minimum: 1, description: 'Pin the edge to a specific revision of the destination.' },
          },
          ['type', 'src', 'dst'],
        ),
        handler: async (a, p) => {
          if (OWNED_EDGE_TYPES.has(a.type)) throw new BreadboardError('validation-failed', `'${a.type}' edges are emitted by the orchestrator only`);
          const e = await d.content.emitEdge({ type: a.type, src: a.src, dst: a.dst, dst_revision: a.dst_revision ?? null, by: p });
          return { edge_id: e.edge_id };
        },
      },
      {
        name: 'tag_need_input',
        scope: 'nodes:write',
        description:
          'Flag an Artifact as needing human direction or review (non-blocking — work continues). Optionally target a review `role` or a specific `username`, and say what you need in `prompt`. Returns a request id that can later be resolved.',
        input_schema: obj(
          {
            uid: UID,
            role: { type: 'string', description: 'Review role slug to target (e.g. `scientist`).' },
            username: { type: 'string', description: 'Specific user handle to target.' },
            prompt: { type: 'string', description: 'What input is needed.' },
          },
          ['uid'],
        ),
        handler: async (a, p) => {
          const r = await d.content.tagNeedInput({ uid: a.uid, role: a.role ?? null, username: a.username ?? null, prompt: a.prompt ?? null, by: p });
          return { request_id: r.request_id };
        },
      },
      {
        name: 'resolve_need_input',
        scope: 'nodes:write',
        description: 'Resolve an open need-input request on a node (by its request id), optionally leaving a comment.',
        input_schema: obj({ uid: UID, request_id: { type: 'string', minLength: 1, description: 'The `nir_…` request id.' }, comment: { type: 'string', description: 'Optional resolution comment.' } }, ['uid', 'request_id']),
        handler: async (a, p) => {
          await d.content.resolveNeedInput({ uid: a.uid, request_id: a.request_id, comment: a.comment ?? null, by: p });
          return { resolved: true };
        },
      },

      // ---------------- Knowledge ----------------
      {
        name: 'query_knowledge',
        scope: 'knowledge:read',
        description: 'Search the Knowledge Notes you can read. `text` = keyword search, `semantic` = embedding similarity (RAG), `hybrid` (default) = both. Returns ranked hits with snippets; use `read_note` for full content.',
        input_schema: obj(
          {
            q: { type: 'string', minLength: 1, description: 'Query text.' },
            mode: { type: 'string', enum: ['text', 'semantic', 'hybrid'], description: 'Search mode (default hybrid).' },
            domains: STRING_ARRAY('Restrict to these Knowledge Domain slugs (intersected with your read grants).'),
            limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max hits (default 10).' },
          },
          ['q'],
        ),
        handler: async (a, p) => {
          const hits = await d.knowledge.search({ q: a.q, mode: a.mode, domains: a.domains, limit: a.limit ?? 10, by: p });
          return hits.map((h) => ({ uid: h.uid, title: h.title, snippet: h.snippet, score: h.score, domains: h.domains, tags: h.tags, source: h.source }));
        },
      },
      {
        name: 'read_note',
        scope: 'knowledge:read',
        description: 'Read a Knowledge Note as Markdown, plus the `base_revision` you must pass to `propose_note_edit`. Always re-read before editing.',
        input_schema: obj({ uid: UID }, ['uid']),
        handler: async (a, p) => {
          const n = await d.knowledge.readNote(a.uid, p);
          return { uid: n.uid, title: n.title, markdown: n.markdown, base_revision: n.base_revision, domains: n.domains, read_only: n.read_only, tags: n.tags };
        },
      },
      {
        name: 'propose_note_edit',
        scope: 'knowledge:write',
        description:
          'Edit a Knowledge Note: send the FULL revised Markdown and the `base_revision` from `read_note`. The server three-way merges your change with any concurrent human edits and returns the actual merged document — treat `merged_markdown` as the new truth. Failures: `base-revision-too-old` (re-read), `parse-failed`, `grant-denied` (no write grant for the note\'s domains), `read-only-source` (connector-owned), `note-not-found`.',
        input_schema: obj(
          {
            uid: UID,
            base_revision: { type: 'integer', minimum: 1, description: 'The `base_revision` returned by `read_note`.' },
            markdown: { type: 'string', description: 'Full revised Markdown of the note.' },
          },
          ['uid', 'base_revision', 'markdown'],
        ),
        handler: async (a, p) => {
          const r = await d.knowledge.proposeEdit({ uid: a.uid, base_revision: a.base_revision, markdown: a.markdown, by: p });
          return { applied: r.applied, had_concurrent_edits: r.had_concurrent_edits, merged_markdown: r.merged_markdown, new_head_revision: r.new_head_revision, pre_ai_edit_revision: r.pre_ai_edit_revision };
        },
      },

      // ---------------- Intake ----------------
      {
        name: 'create_task',
        scope: 'tasks:write',
        description: 'Create a Task in the Intake queue (the single write path for task creation). Queued tasks auto-dispatch to triage, or straight to `target_circuit` when given. Use `find_similar_tasks` first to avoid duplicates.',
        input_schema: obj(
          {
            title: { type: 'string', minLength: 1, description: 'Concise task title.' },
            body: { type: 'string', description: 'Task description (Markdown): goal, context, acceptance criteria.' },
            priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'], description: 'Priority tier (default p2).' },
            target_circuit: { type: 'string', description: 'Circuit UID to route to directly, bypassing triage.' },
            draft: { type: 'boolean', description: 'Create as a draft (not dispatched until accepted).' },
            tags: STRING_ARRAY('Optional tags.'),
          },
          ['title', 'body'],
        ),
        handler: async (a, p, ctx) => {
          const session_id = ctx.session_id ?? p.session_id;
          // In idea shaping the Task stays a draft until the human accepts it into the queue ([08] §7).
          const shaping = !!session_id && (await d.sessions.get(session_id))?.kind === 'intake';
          const t = await d.tasks.create({ title: a.title, body: a.body, priority: a.priority, target_circuit: a.target_circuit ?? null, draft: a.draft ?? shaping, tags: a.tags, by: p, session_id });
          return { uid: t.uid, status: (t.properties as any)?.status ?? null };
        },
      },
      {
        name: 'find_similar_tasks',
        scope: 'tasks:read',
        description: 'Find existing Tasks similar to a description (duplicate detection before `create_task`).',
        input_schema: obj({ q: { type: 'string', minLength: 1, description: 'Task title/description to compare.' }, limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 5).' } }, ['q']),
        handler: async (a, p) => d.tasks.similar(a.q, p, a.limit ?? 5),
      },

      // ---------------- Sessions ----------------
      {
        name: 'run_circuit',
        scope: 'sessions:write',
        description:
          'Run a circuit as a child session of the current one. Requires an execute grant on the circuit. With `wait: true` (default) blocks until the child finishes and returns its exit and output; with `wait: false` returns the queued session id immediately (poll with `get_session_summary`).',
        input_schema: obj(
          {
            circuit: { type: 'string', minLength: 1, description: 'Circuit UID.' },
            input: { description: "Circuit input, matching the circuit's input schema." },
            wait: { type: 'boolean', default: true, description: 'Wait for completion (default true).' },
            budget: obj({ max_cost_usd: { type: 'number', minimum: 0, description: 'Cost ceiling (USD).' }, max_tokens: { type: 'integer', minimum: 0, description: 'Token ceiling.' } }),
          },
          ['circuit'],
        ),
        handler: async (a, p, ctx) => {
          checkDepth(ctx);
          if (p.actor.kind === 'subagent' && !p.grants?.circuits.execute.has(a.circuit)) {
            throw new BreadboardError('grant-denied', `no execute grant for circuit ${a.circuit}`);
          }
          const s = await d.orchestrator.enqueue({
            circuit_uid: a.circuit,
            input: a.input ?? {},
            parent_session: ctx.session_id ?? p.session_id ?? null,
            parent_step_id: ctx.step_id ?? p.actor.step_id ?? null,
            budget: a.budget ?? null,
            created_by: p.actor,
          });
          if (a.wait === false) return { session_id: s.session_id, state: s.state };
          const done = await d.orchestrator.waitFor(s.session_id);
          const completed = await lastEvent(d.sessions, s.session_id, 'session-completed');
          const out: Record<string, unknown> = { session_id: done.session_id, state: done.state };
          if (completed) {
            out.exit = completed.payload.exit ?? null;
            out.output = completed.payload.output ?? null;
          }
          if (done.state !== 'completed') out.state_detail = done.state_detail;
          return out;
        },
      },
      {
        name: 'get_session_summary',
        scope: 'sessions:read',
        description:
          'Summarize a session you can see: state, cost (including child sessions), steps with exits, and child sessions. For intake and designer conversations also `proposals` (ids opened in the chat), `busy`, `last_error` and `draft_task`. Read the turns with `read_session_transcript`.',
        input_schema: obj({ session_id: { type: 'string', minLength: 1, description: 'Session id.' } }, ['session_id']),
        handler: async (a, p) => {
          if (!(await sessionVisible(d.sessions, p, a.session_id))) throw new BreadboardError('grant-denied', `session ${a.session_id} is not visible to this principal`);
          const summary = await d.sessions.summary(a.session_id);
          if (summary.kind !== 'intake' && summary.kind !== 'conversation') return summary;
          const chats = d.conversations();
          const [proposals, draft_task, busy] = await Promise.all([chats.proposals(a.session_id), chats.draftTask(a.session_id), chats.busy(a.session_id)]);
          return { ...summary, proposals, draft_task, busy, last_error: (summary.state_detail as { last_error?: unknown }).last_error ?? null };
        },
      },

      // ---------------- Composition ----------------
      {
        name: 'run_tool',
        scope: 'tools:execute',
        description: 'Invoke another tool extension (nested sandboxed execution sharing the parent budget). Tool code only.',
        input_schema: obj({ tool: { type: 'string', minLength: 1, description: 'Tool UID.' }, input: { description: "Tool input matching the tool's input schema." }, settings: { type: 'object', description: 'Per-call settings overrides.' } }, ['tool']),
        handler: async (a, p, ctx) => {
          checkDepth(ctx);
          const r = await d.toolbox().invoke({
            tool_uid: a.tool,
            input: a.input ?? {},
            settings: a.settings,
            principal: p,
            ambient: { invocation: 'tool-call', session_id: ctx.session_id ?? p.session_id ?? null, step_id: ctx.step_id ?? null },
            session_id: ctx.session_id ?? p.session_id ?? null,
            step_id: ctx.step_id ?? null,
            attempt: ctx.attempt ?? null,
            call_index: ctx.call_index ?? null,
            depth: (ctx.depth ?? 0) + 1,
          });
          return r.output;
        },
      },

      // ---------------- Broker ----------------
      {
        name: 'broker_fetch',
        scope: 'tools:execute',
        description: 'Outbound HTTP through the credential broker under a declared capability. Tool code only.',
        input_schema: obj(
          {
            capability: { type: 'string', minLength: 1, description: 'Capability name declared in the tool manifest.' },
            request: obj(
              {
                url: { type: 'string', minLength: 1 },
                method: { type: 'string' },
                headers: { type: 'object', additionalProperties: { type: 'string' } },
                body: { type: ['string', 'null'] },
              },
              ['url'],
            ),
          },
          ['capability', 'request'],
        ),
        handler: async (a, p) => {
          const { uid, commit } = await this.callingTool(p);
          const loaded = await d.config.tool(uid, commit ?? undefined);
          return d.broker.fetch({ capability: a.capability, request: a.request, tool: loaded.tool, principal: p, execution_key: p.execution_key });
        },
      },
      {
        name: 'model_converse',
        scope: 'tools:execute',
        description:
          "One model turn through the Breadboard model gateway (presets, fallback, the session's budget and cost tracking). Tool code only; the tool must declare the `model` capability. Messages and the reply use Breadboard's chat format (text, tool_use, tool_result blocks).",
        input_schema: obj(
          {
            system: { type: 'string' },
            messages: { type: 'array', minItems: 1, items: { type: 'object' } },
            tools: { type: 'array', items: obj({ name: { type: 'string', minLength: 1 }, description: { type: 'string' }, input_schema: { type: 'object' } }, ['name']) },
            preset: { type: 'string', minLength: 1, description: 'Model preset tier (default `medium`).' },
            model_id: { type: 'string', minLength: 1, description: 'Explicit model id (overrides the preset).' },
            max_tokens: { type: 'integer', minimum: 1 },
            temperature: { type: 'number' },
          },
          ['messages'],
        ),
        handler: async (a, p, ctx) => {
          const { uid, commit } = await this.callingTool(p);
          const loaded = await d.config.tool(uid, commit ?? undefined);
          if (!(loaded.tool.capabilities ?? []).some((c) => c.name === MODEL_CAPABILITY)) {
            throw new BreadboardError('grant-denied', `tool ${loaded.tool.slug} does not declare the '${MODEL_CAPABILITY}' capability`);
          }
          const session_id = ctx.session_id ?? p.session_id;
          if (!session_id) throw new BreadboardError('invalid-state', 'model_converse needs a session (its spend is accounted there)');
          const session = await d.sessions.mustGet(session_id);
          const [spent, used] = await Promise.all([d.sessions.costIncludingChildren(session_id), d.sessions.cost(session_id)]);
          if (spent >= session.budget.max_cost_usd || used.tokens_in + used.tokens_out >= session.budget.max_tokens) {
            throw new BreadboardError('budget-exceeded', `session ${session_id} has no model budget left`, { spent_usd: spent, max_cost_usd: session.budget.max_cost_usd });
          }
          const [step_id, attempt] = (ctx.step_id ?? 'tool').split('#');
          const res = await d.gateway.complete({
            preset: a.preset ?? 'medium',
            model_id: a.model_id,
            system: a.system ?? '',
            messages: a.messages as ChatMessage[],
            tools: (a.tools ?? []).map((t: { name: string; description?: string; input_schema?: JsonSchema }) => ({ name: t.name, description: t.description ?? t.name, input_schema: t.input_schema ?? { type: 'object' } })),
            max_tokens: a.max_tokens,
            temperature: a.temperature,
            model_overrides: session.model_overrides ?? null,
            session_id,
            step_id: step_id!,
          });
          await d.sessions.recordTurn({
            session_id,
            step_id: step_id!,
            attempt: attempt ? Number(attempt) : undefined,
            role: 'assistant',
            username: null,
            content: res.message.content,
            model_id: res.model_id,
            tokens_in: res.usage.input_tokens,
            tokens_out: res.usage.output_tokens,
            cost_usd: res.cost_usd,
            latency_ms: res.latency_ms ?? null,
            fallback_from: res.fallback_from ?? null,
          });
          return { message: res.message, stop_reason: res.stop_reason, usage: res.usage, model_id: res.model_id, cost_usd: res.cost_usd };
        },
      },

      // ---------------- Evals ----------------
      {
        name: 'record_score',
        scope: 'evals:write',
        description: "Record one rubric dimension's score for a fixture in an eval run. `value` must match the dimension's declared type (see `get_rubric`); include a short rationale.",
        input_schema: obj(
          {
            eval_run_id: { type: 'string', minLength: 1, description: 'Eval run id.' },
            fixture_id: { type: 'string', minLength: 1, description: 'Fixture id.' },
            dimension: { type: 'string', minLength: 1, description: 'Rubric dimension name.' },
            value: { description: 'Score value, typed per the rubric dimension (number, boolean, enum string…).' },
            rationale: { type: 'string', description: 'Why this score.' },
          },
          ['eval_run_id', 'fixture_id', 'dimension', 'value'],
        ),
        handler: async (a, p) => {
          await d.evals.recordScore({ eval_run_id: a.eval_run_id, fixture_id: a.fixture_id, dimension: a.dimension, value: a.value, rationale: a.rationale ?? null, by: p });
          return { recorded: true };
        },
      },
      {
        name: 'get_rubric',
        scope: 'evals:read',
        description: "Read a circuit's eval rubric: the scoring dimensions, their types and guidance.",
        input_schema: obj({ circuit_uid: { type: 'string', minLength: 1, description: 'Circuit UID.' } }, ['circuit_uid']),
        handler: async (a) => {
          const r = await d.config.rubric(a.circuit_uid);
          if (!r) throw new BreadboardError('not-found', `circuit ${a.circuit_uid} has no rubric`);
          return r;
        },
      },
      {
        name: 'get_fixture_output',
        scope: 'evals:read',
        description: 'Read the output the circuit produced for a fixture in an eval run (the thing you are grading).',
        input_schema: obj({ eval_run_id: { type: 'string', minLength: 1, description: 'Eval run id.' }, fixture_id: { type: 'string', minLength: 1, description: 'Fixture id.' } }, ['eval_run_id', 'fixture_id']),
        handler: async (a) => d.evals.getFixtureOutput(a.eval_run_id, a.fixture_id),
      },

      // ---------------- Config ----------------
      {
        name: 'read_config',
        scope: 'config:read',
        description:
          'Read a configuration-plane definition (circuit, subagent, tool incl. source files, MCP onboarding, presets, tenets) at main, or at `commit`. Returns the raw file text and the parsed definition. A miss lists the closest definitions; find UIDs with `search_config`. Circuits require a read or execute grant.',
        input_schema: obj(
          {
            ref: {
              type: 'string',
              minLength: 1,
              description:
                'A definition UID; a slug (`check-citations`, or `tool:check-citations` when kinds share a slug); `presets`, `tenets` or `breadboard`; or a repo-relative path (`presets/models.yaml`, `tools/<UID>/src/index.ts`).',
            },
            commit: { type: 'string', minLength: 1, description: 'Read at this commit hash or branch instead of main (e.g. a session\'s `config_commit`, to see exactly what a run used).' },
          },
          ['ref'],
        ),
        handler: async (a, p) => {
          const def = await d.config.definition(a.ref, a.commit, { lenient: true });
          if (def.kind === 'circuit' && p.grants && p.actor.kind === 'subagent') {
            const uid = def.uid ?? '';
            if (!p.grants.circuits.read.has(uid) && !p.grants.circuits.execute.has(uid)) throw new BreadboardError('grant-denied', `no read grant for circuit ${uid}`);
          }
          return def;
        },
      },
      {
        name: 'search_config',
        scope: 'config:read',
        description:
          'Find configuration-plane definitions at main (or at `commit`) by slug, title, UID, path or description, best match first: the whole query first, then definitions matching the most of its words. An empty `q` lists them all. Returns metadata only (uid, kind, slug, title, path): use it to get the UID that references need, then `read_config` for the content. Page with `offset`.',
        input_schema: obj({
          q: { type: 'string', description: 'Search text: a slug, a title, or a few words (default: everything).' },
          kind: { type: 'string', enum: ['circuit', 'subagent', 'tool', 'mcp', 'presets', 'tenets', 'breadboard'], description: 'Only definitions of this kind.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max entries (default 25).' },
          offset: { type: 'integer', minimum: 0, description: 'Skip this many entries (default 0); continue from `next_offset`.' },
          commit: { type: 'string', minLength: 1, description: 'Search at this commit hash or branch instead of main.' },
        }),
        handler: async (a) => {
          const all = await d.config.search(a.q ?? '', a.commit);
          const hits = a.kind ? all.filter((e) => e.kind === a.kind) : all;
          const offset = a.offset ?? 0;
          const page = hits.slice(offset, offset + (a.limit ?? 25));
          return {
            total: hits.length,
            offset,
            next_offset: offset + page.length < hits.length ? offset + page.length : null,
            entries: page.map(({ uid, kind, slug, title, path }) => ({ uid, kind, slug, title, path })),
          };
        },
      },
      {
        name: 'validate_config',
        scope: 'config:read',
        description: 'Validate a prospective change set against the config repo (schemas, UID/path match, dangling references, circuit graph rules) without committing. Use before `propose_config_change`.',
        input_schema: obj({ changes: FILE_CHANGES, base: { type: 'string', description: 'Base branch or commit (default main).' } }, ['changes']),
        handler: async (a) => d.config.validateChanges(a.changes, a.base),
      },
      {
        name: 'propose_config_change',
        scope: 'config:propose',
        description:
          'Propose a configuration change for human review: writes a branch and opens (or, with `proposal_id`, amends) a proposal. Nothing reaches main until a human merges it. For tool changes the result includes `tool_checks` (manifest, TypeScript/Python syntax) at the proposal head; fix failures with an amendment.',
        input_schema: obj(
          {
            changes: FILE_CHANGES,
            message: { type: 'string', minLength: 1, description: 'Commit/proposal message explaining the change and why.' },
            proposal_id: { type: 'string', description: 'Amend this open proposal instead of opening a new one.' },
            base: { type: 'string', description: 'Base branch or commit for a new proposal (default main).' },
          },
          ['changes', 'message'],
        ),
        handler: async (a, p, ctx) => {
          const dto = a.proposal_id
            ? await d.config.amendProposal(a.proposal_id, a.changes, a.message, p)
            : await d.config.propose({ changes: a.changes, message: a.message, by: p, base: a.base, session_id: ctx.session_id ?? p.session_id ?? null });
          // The patch only repeats the caller's own changes, and every later turn would carry it again.
          const { diff: _diff, ...rest } = dto;
          const checks = await proposalToolChecks(d.toolbox(), dto);
          return {
            ...rest,
            ...(checks.tools.length ? { tool_checks: checks.tools } : {}),
            review: `Not merged. The user reviews it from the proposal card in the chat, or at /proposals/${dto.proposal_id}, then merges or discards it.`,
          };
        },
      },

      // ---------------- Inspection ([11] §4) ----------------
      ...inspectionCatalog(d),
    ];
    return defs;
  }

  /** Resolve the tool whose code is calling (broker_fetch): journal row of the execution key, else a code-step actor id. */
  private async callingTool(p: Principal): Promise<{ uid: string; commit: string | null }> {
    if (p.execution_key) {
      const r = await this.deps.db.query<{ tool_uid: string; tool_commit: string | null }>(`SELECT tool_uid, tool_commit FROM tool_executions WHERE execution_key=$1`, [p.execution_key]);
      const row = r.rows[0];
      if (row) return { uid: row.tool_uid.trim(), commit: row.tool_commit };
    }
    if (p.actor.kind === 'code-step') return { uid: p.actor.id, commit: p.config_commit };
    throw new BreadboardError('grant-denied', 'broker_fetch is only callable from tool code with a journaled execution');
  }
}

/** Sandboxed tool code (actor token with an execution key) or a code-step actor. */
function isToolCode(p: Principal): boolean {
  return p.actor.kind === 'code-step' || p.execution_key !== null;
}

function checkDepth(ctx: PrimitiveCallCtx): void {
  if ((ctx.depth ?? 0) >= MAX_COMPOSITION_DEPTH) throw new BreadboardError('invalid-state', `composition depth cap (${MAX_COMPOSITION_DEPTH}) reached`);
}

async function lastEvent(sessions: SessionStore, id: string, type: string) {
  let after: number | undefined = undefined;
  let found: Awaited<ReturnType<SessionStore['events']>>[number] | null = null;
  for (let guard = 0; guard < 1000; guard++) {
    const page = await sessions.events(id, after, 500);
    if (page.length === 0) break;
    for (const e of page) if (e.event_type === type) found = e;
    after = page[page.length - 1]!.seq;
    if (page.length < 500) break;
  }
  return found;
}

export function createPrimitives(deps: PrimitivesDeps): PrimitivesImpl {
  return new PrimitivesImpl(deps);
}
