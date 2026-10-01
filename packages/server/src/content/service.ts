/**
 * ContentService ([09], [01] §3–§5): the one implementation of node/edge/comment/need-input behaviour
 * behind REST, MCP, and in-process primitives. Every read/write takes the caller's Principal and
 * enforces scope + grants here ([11] §1).
 */
import {
  BreadboardError,
  EXPLICIT_EDGE_TYPES,
  SCOPES,
  TAG,
  grantDenied,
  invalidState,
  isNeedInputTag,
  isProvenanceEdge,
  mintRequestId,
  needInputTags,
  notFound,
  requestTargetsUser,
  validationFailed,
  type Actor,
  type ArtifactRef,
  type BreadboardConfig,
  type EdgeRecord,
  type EdgeType,
  type LineageDto,
  type NeedInputRequest,
  type NodeDto,
  type NodeRecord,
  type NodeRevision,
  type Page,
  type ResolvedNeedInputRequest,
  type ReviewQueueItemDto,
  type RevisionLabel,
  type Scope,
  type StreamEvent,
} from '@breadboard/shared';
import type { Db, Queryable } from '../db/index.js';
import type { Logger } from '../core/logger.js';
import type { ObjectStore } from '../core/object-store.js';
import type { ContentService, EventBus, KnowledgeService, SessionStore } from '../core/services.js';
import { canReadDomains, canSeeSession, canWriteDomains, type Principal } from '../core/principal.js';
import type { NodeStore, ListNodesFilter, PatchNodeInput } from './nodes.js';
import type { EdgeStore } from './edges.js';
import type { GraphQueries } from './graph-queries.js';
import type { LinkIndexer } from './link-indexer.js';
import type { IdentityStore } from '../identity/identity.js';
import { assertNoNarrowing, propagatedScope } from './scope.js';

type StoredNode = NodeRecord & { session_id: string | null };

export interface ContentServiceDeps {
  db: Db;
  team_id: string;
  nodes: NodeStore;
  edges: EdgeStore;
  graph: GraphQueries;
  linkIndexer: LinkIndexer;
  identity: IdentityStore;
  events: EventBus;
  settings: () => Promise<BreadboardConfig>;
  knowledge: () => KnowledgeService | null;
  sessions: () => SessionStore | null;
  log: Logger;
  /** Large-body spill target ([09] §2.3). Optional: without it bodies are always stored inline. */
  objects?: ObjectStore | null;
  /** Spill threshold (env.OBJECT_STORE_THRESHOLD_BYTES); default 256 KiB. */
  objectThresholdBytes?: number;
}

const NEED_INPUT = 'need-input';
const NEED_INPUT_HISTORY = 'need-input-history';
const SPILL_PREVIEW_CHARS = 16 * 1024;
const ACTIVE_ANCHOR_STATUSES = ['resolved', 'not_found', 'ambiguous', 'unmappable'] as const;
type AnchorResolution = { status: (typeof ACTIVE_ANCHOR_STATUSES)[number]; block_id?: string; offset?: number };

export interface CommentAnchor {
  revision: number | null;
  quote: string;
  context: string | null;
  block_id?: string;
  offset?: number;
  status: AnchorResolution['status'];
}

function isAi(p: Principal): boolean {
  return p.actor.kind === 'subagent' || p.actor.kind === 'code-step';
}

function domainsOf(n: NodeRecord): string[] {
  const d = n.properties?.domains;
  return Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : [];
}

function openRequests(n: NodeRecord): NeedInputRequest[] {
  const v = n.properties?.[NEED_INPUT];
  return Array.isArray(v) ? (v as NeedInputRequest[]) : [];
}

function historyOf(n: NodeRecord): ResolvedNeedInputRequest[] {
  const v = n.properties?.[NEED_INPUT_HISTORY];
  return Array.isArray(v) ? (v as ResolvedNeedInputRequest[]) : [];
}

/** Recompute tags: drop every need-input tag, then add the grammar tags for the open requests ([09] §3). */
function withNeedInputTags(tags: string[], open: NeedInputRequest[]): string[] {
  return [...new Set([...tags.filter((t) => !isNeedInputTag(t)), ...needInputTags(open)])];
}

function arr(v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const a = Array.isArray(v) ? v : [v];
  const out = a.flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}
function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = Array.isArray(v) ? v[0] : v;
  return s === '' || s === undefined ? undefined : String(s);
}
function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  const s = str(v);
  return s === undefined ? undefined : ['1', 'true', 'yes'].includes(s.toLowerCase());
}

function assertScope(s: unknown): asserts s is Scope {
  if (!(SCOPES as readonly string[]).includes(String(s))) throw validationFailed(`invalid scope '${String(s)}' (allowed: ${SCOPES.join(', ')})`);
}

function stripRevision(r: NodeRevision & Record<string, unknown>): NodeRevision {
  const { ydoc_state_buf: _a, ydoc_vector_buf: _b, ...rest } = r as any;
  return rest as NodeRevision;
}

function visibilityOf(n: StoredNode): StreamEvent['visibility'] {
  return n.scope === 'session' ? { scope: 'session', session_id: n.session_id ?? undefined, node_uid: n.uid } : { scope: 'team', node_uid: n.uid };
}

// ---------------------------------------------------------------------------
// Anchor resolution ([07] §5.4): content-based, tiered exact → fuzzy, never guesses.
// ---------------------------------------------------------------------------

function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

const FUZZY_SKIP = new Set(['*', '_', '`', '~']);

/** Collapse whitespace, lowercase, drop inline-markdown emphasis characters; keep a map back to source offsets. */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      if (norm.length && !norm.endsWith(' ')) {
        norm += ' ';
        map.push(i);
      }
      continue;
    }
    if (FUZZY_SKIP.has(ch)) continue;
    const low = ch.toLowerCase();
    for (const c of low) {
      norm += c;
      map.push(i);
    }
  }
  if (norm.endsWith(' ')) {
    norm = norm.slice(0, -1);
    map.pop();
  }
  return { norm, map };
}

function narrowByContext(hay: string, offsets: number[], qlen: number, ctx: string): number[] {
  return offsets.filter((o) => hay.slice(Math.max(0, o - ctx.length), o + qlen + ctx.length).includes(ctx));
}

function blockIdAt(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const n = (before.match(/\n[ \t]*\n+/g) ?? []).length;
  return `idx:${n}`;
}

/** Pure locator used by `resolveAnchor` (exported for tests/reuse). */
export function locateQuote(text: string, quote: string, context?: string | null): AnchorResolution {
  if (!text || !text.trim() || !quote || !quote.trim()) return { status: 'unmappable' };
  // Tier 1: exact.
  const exact = allIndexes(text, quote);
  if (exact.length === 1) return { status: 'resolved', offset: exact[0]!, block_id: blockIdAt(text, exact[0]!) };
  if (exact.length > 1) {
    if (context && context.trim()) {
      const hits = narrowByContext(text, exact, quote.length, context);
      if (hits.length === 1) return { status: 'resolved', offset: hits[0]!, block_id: blockIdAt(text, hits[0]!) };
      if (hits.length === 0) {
        // context may differ in whitespace/emphasis; try the normalized context against normalized windows
        const nt = normalizeWithMap(text);
        const nc = normalizeWithMap(context).norm;
        const nq = normalizeWithMap(quote).norm;
        const mapped = exact.map((o) => nt.map.findIndex((m) => m >= o)).filter((x) => x >= 0);
        const nh = narrowByContext(nt.norm, mapped, nq.length, nc);
        if (nh.length === 1) {
          const off = nt.map[nh[0]!]!;
          return { status: 'resolved', offset: off, block_id: blockIdAt(text, off) };
        }
      }
    }
    return { status: 'ambiguous' };
  }
  // Tier 2: normalized (whitespace/case/emphasis-insensitive).
  const nt = normalizeWithMap(text);
  const nq = normalizeWithMap(quote).norm;
  if (!nq) return { status: 'unmappable' };
  const fuzzy = allIndexes(nt.norm, nq);
  if (fuzzy.length === 0) return { status: 'not_found' };
  let pick: number | null = fuzzy.length === 1 ? fuzzy[0]! : null;
  if (pick === null && context && context.trim()) {
    const hits = narrowByContext(nt.norm, fuzzy, nq.length, normalizeWithMap(context).norm);
    if (hits.length === 1) pick = hits[0]!;
  }
  if (pick === null) return { status: 'ambiguous' };
  const off = nt.map[pick]!;
  return { status: 'resolved', offset: off, block_id: blockIdAt(text, off) };
}

// ---------------------------------------------------------------------------

export class ContentServiceImpl implements ContentService {
  private db: Db;
  private teamId: string;
  private nodes: NodeStore;
  private edgeStore: EdgeStore;
  private graph: GraphQueries;
  private linkIndexer: LinkIndexer;
  private identity: IdentityStore;
  private events: EventBus;
  private settings: () => Promise<BreadboardConfig>;
  private knowledge: () => KnowledgeService | null;
  private sessions: () => SessionStore | null;
  private log: Logger;
  private objects: ObjectStore | null;
  private threshold: number;

  constructor(deps: ContentServiceDeps) {
    this.db = deps.db;
    this.teamId = deps.team_id;
    this.nodes = deps.nodes;
    this.edgeStore = deps.edges;
    this.graph = deps.graph;
    this.linkIndexer = deps.linkIndexer;
    this.identity = deps.identity;
    this.events = deps.events;
    this.settings = deps.settings;
    this.knowledge = deps.knowledge;
    this.sessions = deps.sessions;
    this.log = deps.log;
    this.objects = deps.objects ?? null;
    this.threshold = deps.objectThresholdBytes ?? 256 * 1024;
  }

  // --- visibility -------------------------------------------------------------

  private isVisible(n: StoredNode, by: Principal): boolean {
    if (n.scope === 'session' && !canSeeSession(by, n.session_id)) return false;
    if (n.type === 'knowledge' && by.grants && !canReadDomains(by, domainsOf(n))) return false;
    return true;
  }

  /** Load a node and enforce visibility. Hidden session-scoped nodes are indistinguishable from missing ones. */
  private async mustSee(uid: string, by: Principal, q?: Queryable): Promise<StoredNode> {
    const n = await this.nodes.get(uid, q);
    if (!n) throw notFound('node', uid);
    if (n.scope === 'session' && !canSeeSession(by, n.session_id)) throw notFound('node', uid);
    if (n.type === 'knowledge' && by.grants && !canReadDomains(by, domainsOf(n))) throw grantDenied(`no read grant for the knowledge domains of ${uid}`, { domains: domainsOf(n) });
    return n;
  }

  private assertWritable(n: StoredNode, by: Principal): void {
    if (n.tags.includes(TAG.readOnly)) throw new BreadboardError('read-only-source', `node ${n.uid} is read-only (connector-synced)`);
    if (n.type === 'knowledge' && by.grants && !canWriteDomains(by, domainsOf(n))) throw grantDenied(`no write grant for the knowledge domains of ${n.uid}`, { domains: domainsOf(n) });
  }

  private async defaultScope(): Promise<Scope> {
    try {
      return (await this.settings()).defaults.scope;
    } catch {
      return 'team';
    }
  }

  private async publish(topic: Parameters<EventBus['publish']>[0], payload: Record<string, unknown>, visibility: StreamEvent['visibility']): Promise<void> {
    try {
      await this.events.publish(topic, payload, visibility);
    } catch (err) {
      this.log.warn({ err, topic }, 'event publish failed');
    }
  }

  private async heads(uids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!uids.length) return out;
    const r = await this.db.query<{ uid: string; m: number }>(`SELECT uid, max(revision_id)::int AS m FROM node_revisions WHERE uid = ANY($1::char(20)[]) GROUP BY uid`, [uids]);
    for (const row of r.rows) out.set(row.uid, row.m);
    return out;
  }

  /** Body → storage fields: markdown string → body_text, object → body JSON; oversized bodies spill ([09] §2.3). */
  private async bodyFields(body: unknown): Promise<{ body: unknown; body_text: string | null; props: Record<string, unknown> }> {
    const clear = { body_ref: null, body_bytes: null, body_format: null, body_truncated: null };
    if (body === null) return { body: null, body_text: null, props: clear };
    if (typeof body === 'string') {
      const bytes = Buffer.byteLength(body, 'utf8');
      if (this.objects && bytes > this.threshold) {
        const ref = await this.objects.put(body, 'text/markdown');
        return { body: null, body_text: body.slice(0, SPILL_PREVIEW_CHARS), props: { body_ref: ref, body_bytes: bytes, body_format: 'markdown', body_truncated: true } };
      }
      return { body: null, body_text: body, props: clear };
    }
    if (typeof body === 'object') {
      const json = JSON.stringify(body);
      const bytes = Buffer.byteLength(json, 'utf8');
      if (this.objects && bytes > this.threshold) {
        const ref = await this.objects.put(json, 'application/json');
        return { body: null, body_text: null, props: { body_ref: ref, body_bytes: bytes, body_format: 'json', body_truncated: true } };
      }
      return { body, body_text: null, props: clear };
    }
    throw validationFailed('body must be a markdown string or a JSON object');
  }

  private static dropNulls(p: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null));
  }

  private assertNoReservedProps(props: Record<string, unknown> | undefined): void {
    if (!props) return;
    if (NEED_INPUT in props || NEED_INPUT_HISTORY in props) throw validationFailed(`'${NEED_INPUT}' properties are managed through POST /nodes/:uid/need-input and its resolve endpoint`);
  }

  // --- DTOs -----------------------------------------------------------------

  async nodeDto(node: NodeRecord): Promise<NodeDto> {
    return { ...node, head_revision: await this.nodes.headRevisionId(node.uid) };
  }

  private async dtos(nodes: NodeRecord[]): Promise<NodeDto[]> {
    const heads = await this.heads(nodes.map((n) => n.uid));
    return nodes.map((n) => {
      const { rank: _r, ...rest } = n as NodeRecord & { rank?: number };
      return { ...rest, head_revision: heads.get(n.uid) ?? null };
    });
  }

  // --- nodes ----------------------------------------------------------------

  async getNode(uid: string, by: Principal): Promise<NodeDto> {
    return this.nodeDto(await this.mustSee(uid, by));
  }

  async listNodes(filter: Record<string, unknown>, by: Principal): Promise<Page<NodeDto>> {
    const session_id = str(filter.session_id);
    const f: ListNodesFilter = {
      type: arr(filter.type),
      tag: arr(filter.tag),
      scope: arr(filter.scope),
      q: str(filter.q),
      created_after: str(filter.created_after),
      created_before: str(filter.created_before),
      need_input_role: str(filter.need_input_role),
      need_input_username: str(filter.need_input_username),
      need_input_open: bool(filter.need_input) ?? bool(filter.need_input_open),
      circuit: str(filter.circuit),
      status: arr(filter.status),
      priority: arr(filter.priority),
      origin_kind: arr(filter.origin_kind) ?? arr(filter.origin),
      domains: arr(filter.domain) ?? arr(filter.domains),
      session_id,
      cursor: str(filter.cursor) ?? null,
      limit: filter.limit === undefined ? undefined : Number(str(filter.limit)),
    };
    // [01] §3.4: session scratch is excluded from cross-session list/search unless the caller names the session.
    if (by.visible_sessions !== null) f.visible_sessions = by.visible_sessions;
    else if (!session_id) f.visible_sessions = [];
    const page = await this.nodes.list(f);
    const items = page.items.filter((n) => this.isVisible(n, by));
    return { items: await this.dtos(items), next_cursor: page.next_cursor };
  }

  async createNode(input: Parameters<ContentService['createNode']>[0]): Promise<NodeDto> {
    const { node } = await this.createInternal(input, { revision: input.session_id && input.step_id ? 'step-completion' : null });
    return this.nodeDto(node);
  }

  private async resolveParents(refs: ArtifactRef[] | undefined, by: Principal): Promise<Array<{ node: StoredNode; revision_id: number }>> {
    const out: Array<{ node: StoredNode; revision_id: number }> = [];
    for (const ref of refs ?? []) {
      if (!ref || typeof ref.uid !== 'string') throw validationFailed('derived_from entries must be {uid, revision_id}');
      const parent = await this.mustSee(ref.uid, by);
      let rev = typeof ref.revision_id === 'number' ? ref.revision_id : null;
      if (rev === null) rev = (await this.nodes.headRevisionId(parent.uid)) ?? (await this.nodes.cutRevision(parent.uid, { labels: ['publish'], created_by: by.actor })).revision_id;
      else if (!(await this.nodes.getRevision(parent.uid, rev))) throw validationFailed(`node ${parent.uid} has no revision ${rev}`);
      out.push({ node: parent, revision_id: rev });
    }
    return out;
  }

  /** Shared creation path: scope propagation, derived-from edges, orchestrator-driven provenance, link index, event. */
  private async createInternal(
    input: Parameters<ContentService['createNode']>[0] & { body_text?: string | null },
    opts: { revision: RevisionLabel | null; crdtMarkdown?: string | null },
  ): Promise<{ node: StoredNode; revision: NodeRevision | null }> {
    const by = input.by;
    if (!input.type || typeof input.type !== 'string') throw validationFailed("field 'type' is required");
    if (input.scope !== undefined) assertScope(input.scope);
    this.assertNoReservedProps(input.properties);
    if (input.tags && (!Array.isArray(input.tags) || input.tags.some((t) => typeof t !== 'string'))) throw validationFailed('tags must be an array of strings');
    if ((input.step_id && !input.session_id) || (input.session_id && input.step_id === '')) throw validationFailed('step_id requires session_id');
    const parents = await this.resolveParents(input.derived_from, by);
    const scope = propagatedScope(
      parents.map((p) => p.node.scope),
      input.scope,
      await this.defaultScope(),
    );
    let fields: { body: unknown; body_text: string | null; props: Record<string, unknown> } = { body: null, body_text: input.body_text ?? null, props: {} };
    const crdt = !!input.crdt;
    if (input.body !== undefined) {
      if (crdt) {
        if (typeof input.body !== 'string') throw validationFailed('CRDT bodies are markdown strings');
        fields = { body: null, body_text: input.body, props: {} };
      } else fields = await this.bodyFields(input.body);
    }
    const sessionId = input.session_id ?? by.session_id ?? null;
    const stepId = input.session_id ? (input.step_id ?? null) : null;
    const tags = (input.tags ?? []).filter((t) => !isNeedInputTag(t));

    const { node, revision } = await this.db.transaction(async (tx) => {
      let node = (await this.nodes.create(
        {
          type: input.type,
          title: input.title,
          properties: { ...(input.properties ?? {}), ...ContentServiceImpl.dropNulls(fields.props) },
          body: fields.body ?? undefined,
          body_text: fields.body_text,
          crdt,
          tags,
          scope,
          created_by: by.actor,
          session_id: sessionId,
        },
        tx,
      )) as StoredNode;
      for (const p of parents) {
        await this.edgeStore.emit({ type: 'derived-from', src_uid: node.uid, dst_uid: p.node.uid, dst_revision: p.revision_id, created_by: by.actor }, tx);
      }
      let revision: NodeRevision | null = null;
      if (opts.revision && !(crdt && this.knowledge())) {
        revision = await this.nodes.cutRevision(node.uid, { labels: [opts.revision], created_by: by.actor }, tx);
      }
      await this.linkIndexer.reindex(node, tx);
      node = (await this.nodes.get(node.uid, tx))!;
      return { node, revision };
    });

    let rev = revision;
    // CRDT bodies are initialized through the knowledge service (Y.Doc block model owner).
    if (crdt && fields.body_text) {
      const k = this.knowledge();
      if (k) {
        const r = await k.replaceBody({ uid: node.uid, markdown: fields.body_text, by: by.actor, label: opts.revision ?? 'publish' });
        if (opts.revision) rev = (await this.nodes.getRevision(node.uid, r.revision)) ?? (await this.nodes.latestRevision(node.uid));
      } else if (opts.revision && !rev) {
        rev = await this.nodes.cutRevision(node.uid, { labels: [opts.revision], created_by: by.actor });
      }
    } else if (crdt && opts.revision && !rev) {
      rev = await this.nodes.cutRevision(node.uid, { labels: [opts.revision], created_by: by.actor });
    }

    if (input.session_id && stepId && rev) {
      await this.edgeStore.emit({ type: 'produces', src_session_id: input.session_id, src_step_id: stepId, dst_uid: node.uid, dst_revision: rev.revision_id, created_by: by.actor });
    }
    await this.publish('node.updated', { uid: node.uid, type: node.type, change: 'created' }, visibilityOf(node));
    return { node, revision: rev ? stripRevision(rev as any) : null };
  }

  async patchNode(uid: string, patch: Record<string, unknown>, by: Principal): Promise<NodeDto> {
    const cur = await this.mustSee(uid, by);
    this.assertWritable(cur, by);
    const allowed = new Set(['title', 'properties', 'tags', 'tags_add', 'tags_remove', 'scope', 'body']);
    for (const k of Object.keys(patch ?? {})) if (!allowed.has(k)) throw validationFailed(`field '${k}' cannot be patched (allowed: ${[...allowed].join(', ')})`);
    const props = patch.properties as Record<string, unknown> | undefined;
    if (props !== undefined && (typeof props !== 'object' || props === null || Array.isArray(props))) throw validationFailed('properties must be an object');
    this.assertNoReservedProps(props);
    if (cur.type === 'task' && props && 'status' in props && by.actor.kind !== 'service') {
      throw validationFailed('task status is orchestrator-driven; use POST /tasks/:uid/accept|reject or DELETE /nodes/:uid');
    }
    const p: PatchNodeInput = {};
    if (patch.title !== undefined) {
      if (typeof patch.title !== 'string') throw validationFailed('title must be a string');
      p.title = patch.title;
    }
    if (props) p.properties = { ...props };
    if (patch.scope !== undefined && patch.scope !== cur.scope) {
      assertScope(patch.scope);
      assertNoNarrowing(cur.scope, patch.scope, await this.graph.widestDescendantScope(uid));
      p.scope = patch.scope;
    }
    if (patch.body !== undefined) {
      if (cur.crdt) {
        throw invalidState(`node ${uid} has a CRDT body; edit it via the sync editor or POST /knowledge/${uid}/edits`, { use: `/knowledge/${uid}/edits` });
      }
      const f = await this.bodyFields(patch.body);
      p.body = f.body;
      p.body_text = f.body_text;
      p.properties = { ...(p.properties ?? {}), ...f.props };
    }
    if (patch.tags !== undefined || patch.tags_add !== undefined || patch.tags_remove !== undefined) {
      for (const k of ['tags', 'tags_add', 'tags_remove'] as const) {
        const v = patch[k];
        if (v !== undefined && (!Array.isArray(v) || v.some((t) => typeof t !== 'string'))) throw validationFailed(`${k} must be an array of strings`);
      }
      let tags = patch.tags ? [...(patch.tags as string[])] : [...cur.tags];
      if (patch.tags_add) tags.push(...(patch.tags_add as string[]));
      if (patch.tags_remove) tags = tags.filter((t) => !(patch.tags_remove as string[]).includes(t));
      p.tags = withNeedInputTags(tags, openRequests(cur));
    }
    const node = await this.db.transaction(async (tx) => {
      const n = await this.nodes.patch(uid, p, tx);
      await this.linkIndexer.reindex(n, tx);
      return n as StoredNode;
    });
    await this.publish('node.updated', { uid, type: node.type, change: 'patched' }, visibilityOf(node));
    return this.nodeDto(node);
  }

  async deleteNode(uid: string, by: Principal): Promise<void> {
    const n = await this.mustSee(uid, by);
    this.assertWritable(n, by);
    if (isAi(by) && n.session_id !== by.session_id) throw new BreadboardError('forbidden', 'AI principals may only delete nodes produced in their own session');
    await this.nodes.softDelete(uid);
    await this.publish('node.updated', { uid, type: n.type, change: 'deleted' }, visibilityOf(n));
  }

  // --- artifacts ([09] §2) -----------------------------------------------------

  async createArtifact(input: Parameters<ContentService['createArtifact']>[0]): Promise<ArtifactRef & { node: NodeDto }> {
    if (typeof input.title !== 'string') throw validationFailed("field 'title' is required");
    if (input.body === undefined || input.body === null) throw validationFailed("field 'body' is required");
    const props = { ...(input.properties ?? {}) };
    const wantCrdt = props.crdt === true && typeof input.body === 'string';
    delete props.crdt;
    // Default tagging ([09] §2.1): session-scoped outputs default to `intermediate`.
    const parents = await this.resolveParents(input.derived_from, input.by);
    const scope = propagatedScope(parents.map((p) => p.node.scope), input.scope, await this.defaultScope());
    const tags = [...(input.tags ?? [])];
    if (scope === 'session' && !tags.includes(TAG.intermediate) && !tags.includes(TAG.deliverable)) tags.push(TAG.intermediate);
    const orchestrated = !!(input.session_id && input.step_id);
    const { node, revision } = await this.createInternal(
      {
        type: 'artifact',
        title: input.title,
        body: input.body,
        tags,
        scope,
        properties: props,
        crdt: wantCrdt,
        derived_from: parents.map((p) => ({ uid: p.node.uid, revision_id: p.revision_id })),
        by: input.by,
        session_id: input.session_id,
        step_id: input.step_id,
      },
      { revision: orchestrated ? 'step-completion' : 'publish' },
    );
    const rev = revision ?? (await this.nodes.cutRevision(node.uid, { labels: [orchestrated ? 'step-completion' : 'publish'], created_by: input.by.actor }));
    return { uid: node.uid, revision_id: rev.revision_id, node: await this.nodeDto((await this.nodes.get(node.uid)) ?? node) };
  }

  async updateArtifact(input: Parameters<ContentService['updateArtifact']>[0]): Promise<ArtifactRef & { node: NodeDto }> {
    const by = input.by;
    const cur = await this.mustSee(input.uid, by);
    if (cur.type !== 'artifact') throw invalidState(`node ${cur.uid} is a ${cur.type}, not an artifact`);
    this.assertWritable(cur, by);
    this.assertNoReservedProps(input.properties);
    if (input.body !== undefined && cur.crdt) {
      throw invalidState(`artifact ${cur.uid} has a CRDT body; edit it via POST /knowledge/${cur.uid}/edits`, { use: `/knowledge/${cur.uid}/edits` });
    }
    const p: PatchNodeInput = {};
    if (input.title !== undefined) p.title = input.title;
    if (input.properties) p.properties = { ...input.properties };
    if (input.body !== undefined) {
      const f = await this.bodyFields(input.body);
      p.body = f.body;
      p.body_text = f.body_text;
      p.properties = { ...(p.properties ?? {}), ...f.props };
    }
    if (input.tags_add || input.tags_remove) {
      let tags = [...cur.tags, ...(input.tags_add ?? [])];
      if (input.tags_remove) tags = tags.filter((t) => !input.tags_remove!.includes(t));
      p.tags = withNeedInputTags(tags, openRequests(cur));
    }
    const orchestrated = !!(input.session_id && input.step_id);
    const label: RevisionLabel = orchestrated ? 'step-completion' : 'publish';
    const { node, rev } = await this.db.transaction(async (tx) => {
      const node = (await this.nodes.patch(cur.uid, p, tx)) as StoredNode;
      const rev = await this.nodes.cutRevision(cur.uid, { labels: [label], created_by: by.actor }, tx);
      await this.linkIndexer.reindex(node, tx);
      if (orchestrated) {
        await this.edgeStore.emit({ type: 'updates', src_session_id: input.session_id!, src_step_id: input.step_id!, dst_uid: cur.uid, dst_revision: rev.revision_id, created_by: by.actor }, tx);
      }
      return { node, rev };
    });
    await this.publish('node.updated', { uid: node.uid, type: node.type, change: 'updated', revision_id: rev.revision_id }, visibilityOf(node));
    return { uid: node.uid, revision_id: rev.revision_id, node: await this.nodeDto(node) };
  }

  // --- revisions ([01] §3.3) ------------------------------------------------------

  async cutRevision(uid: string, labels: NodeRevision['labels'], by: Actor): Promise<NodeRevision> {
    if (!labels?.length) throw validationFailed('at least one revision label is required');
    const node = await this.nodes.get(uid);
    if (!node) throw notFound('node', uid);
    let body_text: string | null | undefined;
    if (node.crdt) {
      const k = this.knowledge();
      if (k) {
        try {
          body_text = await k.markdownOf(uid);
        } catch (err) {
          this.log.warn({ err, uid }, 'markdownOf failed; snapshotting body_text mirror');
        }
      }
    }
    const rev = await this.nodes.cutRevision(uid, { labels, created_by: by, ...(body_text !== undefined ? { body_text } : {}) });
    await this.linkIndexer.reindex({ ...node, body_text: body_text ?? node.body_text });
    return stripRevision(rev as any);
  }

  async revisions(uid: string, by: Principal, opts: { limit?: number; before?: number } = {}): Promise<NodeRevision[]> {
    await this.mustSee(uid, by);
    const list = await this.nodes.listRevisions(uid, undefined, opts);
    return list.map((r) => stripRevision(r as any));
  }

  async revision(uid: string, rev: number, by: Principal): Promise<NodeRevision> {
    await this.mustSee(uid, by);
    if (!Number.isInteger(rev)) throw validationFailed('revision must be an integer');
    const r = await this.nodes.getRevision(uid, rev);
    if (!r) throw notFound(`revision ${rev} of node`, uid);
    return stripRevision(r as any);
  }

  // --- edges ([01] §4) ------------------------------------------------------------

  private async edgeVisible(edges: EdgeRecord[], by: Principal): Promise<EdgeRecord[]> {
    const uids = new Set<string>();
    for (const e of edges) {
      if (e.src_uid) uids.add(e.src_uid);
      uids.add(e.dst_uid);
    }
    const nodes = await this.nodes.getMany([...uids]);
    return edges.filter((e) => {
      for (const u of [e.src_uid, e.dst_uid]) {
        if (!u) continue;
        const n = nodes.get(u);
        if (n && !this.isVisible(n, by)) return false;
      }
      return true;
    });
  }

  async edges(uid: string, by: Principal, opts: { direction?: 'in' | 'out' | 'both'; type?: string[] } = {}): Promise<EdgeRecord[]> {
    await this.mustSee(uid, by);
    if (opts.direction && !['in', 'out', 'both'].includes(opts.direction)) throw validationFailed('direction must be in|out|both');
    const list = await this.edgeStore.listForNode(uid, { direction: opts.direction ?? 'both', type: opts.type as EdgeType[] | undefined });
    return this.edgeVisible(list, by);
  }

  async emitEdge(input: Parameters<ContentService['emitEdge']>[0]): Promise<EdgeRecord> {
    const { by } = input;
    this.edgeStore.assertExplicitType(input.type);
    const type = input.type;
    if (!input.src || !input.dst) throw validationFailed('src and dst are required');
    if (input.src === input.dst) throw validationFailed('an edge cannot point at its own source');
    const src = await this.mustSee(input.src, by);
    const dst = await this.mustSee(input.dst, by);
    if (type === 'attached-to' && src.type !== 'comment') throw validationFailed('attached-to edges must originate from a comment');
    if (type === 'blocks' || type === 'depends-on') {
      if (src.type !== 'task') throw validationFailed(`${type} edges must originate from a task`);
      if (dst.type !== 'task' && dst.type !== 'artifact') throw validationFailed(`${type} edges must target a task or artifact`);
    }
    const existing = await this.edgeStore.exists(type, src.uid, dst.uid);
    if (existing) return existing;
    if (type === 'blocks' || type === 'depends-on') {
      // "waits on" graph: X depends-on Y ≡ Y blocks X. Reject edges that would close a cycle.
      const [waiter, waitee] = type === 'depends-on' ? [src.uid, dst.uid] : [dst.uid, src.uid];
      if (await this.waitsOn(waitee, waiter)) throw validationFailed(`edge would create a dependency cycle between ${src.uid} and ${dst.uid}`);
    }
    let dst_revision: number | null = null;
    if (isProvenanceEdge(type)) {
      if (input.dst_revision !== undefined && input.dst_revision !== null) {
        if (!(await this.nodes.getRevision(dst.uid, input.dst_revision))) throw validationFailed(`node ${dst.uid} has no revision ${input.dst_revision}`);
        dst_revision = input.dst_revision;
      } else {
        dst_revision = (await this.nodes.headRevisionId(dst.uid)) ?? (await this.cutRevision(dst.uid, ['publish'], by.actor)).revision_id;
      }
    }
    const props = { ...(input.properties ?? {}) };
    delete (props as Record<string, unknown>).indexer; // indexer-owned flag is reserved ([01] §4.3)
    return this.edgeStore.emit({ type, src_uid: src.uid, dst_uid: dst.uid, dst_revision, properties: props, created_by: by.actor });
  }

  /** Does `from` (transitively) wait on `to` via depends-on/blocks edges? */
  private async waitsOn(from: string, to: string): Promise<boolean> {
    const r = await this.db.query(
      `WITH RECURSIVE w(uid, depth) AS (
         SELECT $1::char(20), 0
         UNION
         SELECT CASE WHEN e.type='depends-on' THEN e.dst_uid ELSE e.src_uid END, w.depth + 1
           FROM edges e JOIN w ON ((e.type='depends-on' AND e.src_uid = w.uid) OR (e.type='blocks' AND e.dst_uid = w.uid))
          WHERE e.retracted_at IS NULL AND e.src_uid IS NOT NULL AND w.depth < 50
       ) SELECT 1 FROM w WHERE uid = $2::char(20) LIMIT 1`,
      [from, to],
    );
    return r.rows.length > 0;
  }

  async retractEdge(edgeId: number, by: Principal): Promise<EdgeRecord> {
    if (!Number.isInteger(edgeId)) throw validationFailed('edge id must be an integer');
    const e = await this.edgeStore.get(edgeId);
    if (!e || e.retracted_at) throw notFound('edge', String(edgeId));
    if (!EXPLICIT_EDGE_TYPES.includes(e.type) && by.actor.kind !== 'service') throw new BreadboardError('forbidden', `${e.type} edges are orchestrator-owned provenance and cannot be retracted`);
    if (e.properties?.indexer === true) throw invalidState('link-indexer references are derived from body content; remove the [[link]] instead');
    if (e.src_uid) await this.mustSee(e.src_uid, by);
    await this.mustSee(e.dst_uid, by);
    return this.edgeStore.retract(edgeId, by.actor);
  }

  async lineage(uid: string, direction: 'up' | 'down', depth: number, by: Principal): Promise<LineageDto> {
    const root = await this.mustSee(uid, by);
    if (direction !== 'up' && direction !== 'down') throw validationFailed('direction must be up|down');
    const d = Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : 10;
    // Up: into the session/step behind it (produces/updates) and what it was built on (derived-from).
    // Down: where it has been consumed (derived-from referents, references backlinks) — [09] §5.2.
    const res = direction === 'up' ? await this.graph.upstream(uid, { depth: d }) : await this.graph.downstream(uid, { depth: d, types: ['derived-from', 'references'] });
    const uids = new Set<string>([uid]);
    const sessionIds = new Set<string>();
    for (const e of res.edges) {
      if (e.src_uid) uids.add(e.src_uid);
      uids.add(e.dst_uid);
      if (e.src_session_id) sessionIds.add(e.src_session_id);
    }
    const loaded = await this.nodes.getMany([...uids]);
    loaded.set(root.uid, root);
    const hidden = new Set([...loaded.values()].filter((n) => !this.isVisible(n, by)).map((n) => n.uid));
    const edges = res.edges.filter((e) => !(e.src_uid && hidden.has(e.src_uid)) && !hidden.has(e.dst_uid));
    const nodes = [...loaded.values()].filter((n) => !hidden.has(n.uid)).map((n) => ({ uid: n.uid, type: n.type, title: n.title, tags: n.tags, scope: n.scope }));
    const sessions: LineageDto['sessions'] = [];
    const store = this.sessions();
    if (store) {
      for (const sid of sessionIds) {
        if (!edges.some((e) => e.src_session_id === sid)) continue;
        const s = await store.get(sid).catch(() => null);
        if (s) sessions.push({ session_id: s.session_id, kind: s.kind, circuit_uid: s.circuit_uid, state: s.state });
      }
    }
    return { root: uid, direction, edges, nodes, sessions, truncated: res.truncated };
  }

  // --- comments ([09] §4) ---------------------------------------------------------

  private async markdownFor(node: StoredNode): Promise<string> {
    if (node.crdt) {
      const k = this.knowledge();
      if (k) {
        try {
          return await k.markdownOf(node.uid);
        } catch (err) {
          this.log.warn({ err, uid: node.uid }, 'markdownOf failed; falling back to body_text mirror');
        }
      }
    }
    if (node.body_text) return node.body_text;
    if (typeof node.body === 'string') return node.body;
    return '';
  }

  async resolveAnchor(uid: string, quote: string, context?: string | null): Promise<AnchorResolution> {
    const node = await this.nodes.get(uid);
    if (!node) throw notFound('node', uid);
    return locateQuote(await this.markdownFor(node), quote, context);
  }

  async addComment(input: Parameters<ContentService['addComment']>[0]): Promise<NodeDto & { anchor_status: 'resolved' | 'stale' | 'none' }> {
    const { by } = input;
    if (typeof input.body !== 'string' || !input.body.trim()) throw validationFailed("field 'body' (markdown) is required");
    const target = await this.mustSee(input.target, by);
    let anchor: CommentAnchor | null = null;
    if (input.anchor) {
      if (typeof input.anchor.quote !== 'string' || !input.anchor.quote) throw validationFailed('anchor.quote is required');
      const head = await this.nodes.headRevisionId(target.uid);
      const revision = input.anchor.revision ?? head;
      if (revision !== null && revision !== undefined && !(await this.nodes.getRevision(target.uid, revision))) throw validationFailed(`node ${target.uid} has no revision ${revision}`);
      // Anchor against the referenced revision when it isn't the head; else against the live head.
      let res: AnchorResolution;
      if (revision !== null && head !== null && revision < head) {
        const r = await this.nodes.getRevision(target.uid, revision);
        res = locateQuote(r?.body_text ?? (typeof r?.body === 'string' ? r.body : ''), input.anchor.quote, input.anchor.context);
      } else res = await this.resolveAnchor(target.uid, input.anchor.quote, input.anchor.context);
      if (res.status !== 'resolved' && isAi(by)) {
        const code = res.status === 'not_found' ? 'anchor-not-found' : res.status === 'ambiguous' ? 'anchor-ambiguous' : 'anchor-unmappable';
        throw new BreadboardError(code, `anchor quote ${res.status.replace('_', ' ')} in ${target.uid}${res.status === 'ambiguous' ? '; retry with more context' : ''}`, { status: res.status, target: target.uid });
      }
      anchor = { revision: revision ?? null, quote: input.anchor.quote, context: input.anchor.context ?? null, status: res.status, ...(res.block_id ? { block_id: res.block_id } : {}), ...(res.offset !== undefined ? { offset: res.offset } : {}) };
    }
    // Comments follow their target's visibility: session scratch stays in its session.
    const scope: Scope = target.scope === 'session' ? 'session' : 'team';
    const sessionId = target.scope === 'session' ? target.session_id : (input.session_id ?? by.session_id ?? null);
    const orchestrated = !!(input.session_id && input.step_id);
    const node = await this.db.transaction(async (tx) => {
      const n = (await this.nodes.create(
        { type: 'comment', title: '', body_text: input.body, crdt: false, scope, properties: anchor ? { anchor } : {}, created_by: by.actor, session_id: sessionId },
        tx,
      )) as StoredNode;
      await this.edgeStore.emit({ type: 'attached-to', src_uid: n.uid, dst_uid: target.uid, created_by: by.actor }, tx);
      if (orchestrated) {
        const rev = await this.nodes.cutRevision(n.uid, { labels: ['step-completion'], created_by: by.actor }, tx);
        await this.edgeStore.emit({ type: 'produces', src_session_id: input.session_id!, src_step_id: input.step_id!, dst_uid: n.uid, dst_revision: rev.revision_id, created_by: by.actor }, tx);
      }
      await this.linkIndexer.reindex(n, tx);
      return n;
    });
    await this.publish('node.updated', { uid: node.uid, type: 'comment', change: 'created', target: target.uid }, visibilityOf(node));
    const anchor_status = !anchor ? 'none' : anchor.status === 'resolved' ? 'resolved' : 'stale';
    return { ...(await this.nodeDto(node)), anchor_status };
  }

  async comments(uid: string, by: Principal): Promise<Array<NodeDto & { stale: boolean; anchor_status: string }>> {
    await this.mustSee(uid, by);
    const head = await this.nodes.headRevisionId(uid);
    const edges = await this.edgeStore.listForNode(uid, { direction: 'in', type: ['attached-to'] });
    const map = await this.nodes.getMany(edges.map((e) => e.src_uid).filter((x): x is string => !!x));
    const list = [...map.values()].filter((n) => n.type === 'comment' && this.isVisible(n, by)).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const dtos = await this.dtos(list);
    const out: Array<NodeDto & { stale: boolean; anchor_status: string }> = [];
    for (const c of dtos) {
      const anchor = c.properties?.anchor as CommentAnchor | undefined;
      if (!anchor || typeof anchor.quote !== 'string') {
        out.push({ ...c, stale: false, anchor_status: 'none' });
        continue;
      }
      const moved = head !== null && (anchor.revision ?? 0) < head;
      if (!moved) {
        out.push({ ...c, stale: false, anchor_status: anchor.status ?? 'resolved' });
        continue;
      }
      // Head moved past the anchor: try to re-anchor against the head; confident matches display in place.
      const res = await this.resolveAnchor(uid, anchor.quote, anchor.context);
      const reanchored = res.status === 'resolved' ? { ...anchor, status: res.status, block_id: res.block_id, offset: res.offset } : anchor;
      out.push({ ...c, properties: { ...c.properties, anchor: reanchored }, stale: res.status !== 'resolved', anchor_status: res.status });
    }
    return out;
  }

  // --- need-input ([09] §3) -------------------------------------------------------

  async tagNeedInput(input: Parameters<ContentService['tagNeedInput']>[0]): Promise<NeedInputRequest> {
    const { by } = input;
    await this.mustSee(input.uid, by);
    const role = input.role || null;
    const username = input.username || null;
    if (role) {
      const r = await this.db.query(`SELECT 1 FROM roles WHERE team_id=$1 AND slug=$2`, [this.teamId, role]);
      if (!r.rows.length) throw validationFailed(`unknown review role '${role}'`);
    }
    if (username) {
      const u = await this.identity.getUserByHandle(this.teamId, username);
      if (!u || u.deactivated_at) throw validationFailed(`unknown user '${username}'`);
    }
    if (input.gate && by.actor.kind !== 'service') throw new BreadboardError('forbidden', 'gate-created requests are written by the orchestrator');
    if (input.prompt !== undefined && input.prompt !== null && typeof input.prompt !== 'string') throw validationFailed('prompt must be a string');
    const requested_by: Actor = { ...by.actor, ...(by.session_id && !by.actor.session_id ? { session_id: by.session_id } : {}) };
    const req: NeedInputRequest = {
      request_id: mintRequestId(),
      role,
      username,
      prompt: input.prompt ?? null,
      requested_by,
      requested_at: new Date().toISOString(),
      gate: input.gate ? { session_id: input.gate.session_id, step_id: input.gate.step_id } : null,
    };
    const node = await this.db.transaction(async (tx) => {
      await tx.query(`SELECT uid FROM nodes WHERE uid=$1 FOR UPDATE`, [input.uid]);
      const cur = await this.nodes.mustGet(input.uid, tx);
      const open = [...openRequests(cur), req];
      return (await this.nodes.patch(input.uid, { properties: { [NEED_INPUT]: open }, tags: withNeedInputTags(cur.tags, open) }, tx)) as StoredNode;
    });
    await this.publish('need-input.tagged', { uid: node.uid, request_id: req.request_id, role, username, gate: req.gate }, visibilityOf(node));
    return req;
  }

  async resolveNeedInput(input: Parameters<ContentService['resolveNeedInput']>[0]): Promise<{ resolved: NeedInputRequest; remaining_open: number }> {
    const { by } = input;
    const visible = await this.mustSee(input.uid, by);
    const req = openRequests(visible).find((r) => r.request_id === input.request_id);
    if (!req) {
      if (historyOf(visible).some((r) => r.request_id === input.request_id)) throw invalidState(`need-input request ${input.request_id} is already resolved`);
      throw notFound('need-input request', input.request_id);
    }
    if (input.verdict !== undefined && input.verdict !== null && input.verdict !== 'approve' && input.verdict !== 'request-changes') throw validationFailed('verdict must be approve|request-changes');
    if (req.gate && !input.verdict) {
      throw invalidState(`request ${req.request_id} was created by a gate; record a verdict via POST /nodes/${input.uid}/gate-verdict`, { use: `/nodes/${input.uid}/gate-verdict`, gate: req.gate });
    }
    // Targeting ([09] §3, [02] §5.4): only targeted reviewers resolve; services bypass; admins bypass non-gate requests.
    const bypass = by.actor.kind === 'service' || (by.is_admin && !req.gate);
    if (!bypass && !requestTargetsUser(req, { handle: by.user?.handle ?? '', roles: by.user ? by.roles : [] })) {
      throw new BreadboardError('forbidden', `request ${req.request_id} targets ${[req.role && `role=${req.role}`, req.username && `username=${req.username}`].filter(Boolean).join(',')}`);
    }
    const resolved: ResolvedNeedInputRequest = { ...req, resolved_by: by.actor, resolved_at: new Date().toISOString(), verdict: input.verdict ?? null, comment: input.comment ?? null };
    const { node, remaining } = await this.db.transaction(async (tx) => {
      await tx.query(`SELECT uid FROM nodes WHERE uid=$1 FOR UPDATE`, [input.uid]);
      const cur = await this.nodes.mustGet(input.uid, tx);
      const open = openRequests(cur);
      if (!open.some((r) => r.request_id === input.request_id)) throw invalidState(`need-input request ${input.request_id} is already resolved`);
      const remaining = open.filter((r) => r.request_id !== input.request_id);
      const history = [...historyOf(cur), resolved];
      const node = (await this.nodes.patch(input.uid, { properties: { [NEED_INPUT]: remaining, [NEED_INPUT_HISTORY]: history }, tags: withNeedInputTags(cur.tags, remaining) }, tx)) as StoredNode;
      return { node, remaining };
    });
    await this.publish('need-input.resolved', { uid: node.uid, request_id: req.request_id, verdict: resolved.verdict ?? null, remaining_open: remaining.length, gate: req.gate }, visibilityOf(node));
    return { resolved, remaining_open: remaining.length };
  }

  private targets(req: NeedInputRequest, by: Principal): boolean {
    if (by.user) return requestTargetsUser(req, { handle: by.user.handle, roles: by.roles });
    if (by.actor.kind === 'service') return true;
    return !req.role && !req.username;
  }

  private async queueItems(by: Principal): Promise<Array<{ node: StoredNode; requests: NeedInputRequest[] }>> {
    const r = await this.db.query<{ uid: string }>(
      `SELECT uid FROM nodes WHERE team_id=$1 AND deleted_at IS NULL AND jsonb_typeof(properties->'need-input')='array' AND jsonb_array_length(properties->'need-input') > 0 ORDER BY updated_at DESC LIMIT 2000`,
      [this.teamId],
    );
    const map = await this.nodes.getMany(r.rows.map((x) => x.uid));
    const items: Array<{ node: StoredNode; requests: NeedInputRequest[] }> = [];
    for (const row of r.rows) {
      const n = map.get(row.uid);
      if (!n || !this.isVisible(n, by)) continue;
      const requests = openRequests(n).filter((q) => this.targets(q, by));
      if (requests.length) items.push({ node: n, requests });
    }
    // Gating artifacts first (a suspended session waits on them), then oldest request first.
    const oldest = (x: { requests: NeedInputRequest[] }) => x.requests.map((q) => q.requested_at).sort()[0] ?? '';
    items.sort((a, b) => {
      const ga = a.requests.some((q) => q.gate) ? 0 : 1;
      const gb = b.requests.some((q) => q.gate) ? 0 : 1;
      return ga - gb || oldest(a).localeCompare(oldest(b));
    });
    return items;
  }

  async reviewQueue(by: Principal, opts: { limit?: number } = {}): Promise<ReviewQueueItemDto[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const items = (await this.queueItems(by)).slice(0, limit);
    const dtos = await this.dtos(items.map((i) => i.node));
    const store = this.sessions();
    const out: ReviewQueueItemDto[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const gate = it.requests.find((q) => q.gate)?.gate ?? null;
      let gating_session: ReviewQueueItemDto['gating_session'] = null;
      if (gate && store) {
        const s = await store.get(gate.session_id).catch(() => null);
        if (s) gating_session = { session_id: s.session_id, circuit_uid: s.circuit_uid, state: s.state, kind: s.kind };
      }
      out.push({ node: dtos[i]!, requests: it.requests as unknown as Array<Record<string, unknown>>, gating_session });
    }
    return out;
  }

  async reviewCount(by: Principal): Promise<number> {
    return (await this.queueItems(by)).length;
  }

  async healthMetric(opts: { days?: number } = {}): Promise<{ series: Array<{ day: string; requests: number; deliverables: number; rate: number }>; by_circuit: Array<{ circuit_uid: string | null; requests: number; deliverables: number; rate: number }> }> {
    const days = Math.min(Math.max(Math.floor(opts.days ?? 30), 1), 365);
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
    const since = start.toISOString();
    const circuitOf = `coalesce(n.properties->>'circuit_uid', (SELECT s.circuit_uid FROM edges e JOIN sessions s ON s.session_id = e.src_session_id
        WHERE e.dst_uid = n.uid AND e.type = 'produces' AND e.retracted_at IS NULL ORDER BY e.edge_id LIMIT 1))`;
    const reqs = await this.db.query<{ at: string; circuit_uid: string | null }>(
      `SELECT r->>'requested_at' AS at, ${circuitOf} AS circuit_uid
         FROM nodes n CROSS JOIN LATERAL jsonb_array_elements(
           (CASE WHEN jsonb_typeof(n.properties->'need-input')='array' THEN n.properties->'need-input' ELSE '[]'::jsonb END) ||
           (CASE WHEN jsonb_typeof(n.properties->'need-input-history')='array' THEN n.properties->'need-input-history' ELSE '[]'::jsonb END)) r
        WHERE n.team_id = $1 AND n.deleted_at IS NULL AND (r->>'requested_at') IS NOT NULL AND (r->>'requested_at')::timestamptz >= $2::timestamptz`,
      [this.teamId, since],
    );
    const dels = await this.db.query<{ created_at: string | Date; circuit_uid: string | null }>(
      `SELECT n.created_at, ${circuitOf} AS circuit_uid FROM nodes n
        WHERE n.team_id = $1 AND n.deleted_at IS NULL AND n.tags && ARRAY['deliverable']::text[] AND n.created_at >= $2::timestamptz`,
      [this.teamId, since],
    );
    const dayOf = (v: string | Date) => new Date(v).toISOString().slice(0, 10);
    const series = new Map<string, { requests: number; deliverables: number }>();
    for (let i = 0; i < days; i++) series.set(new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10), { requests: 0, deliverables: 0 });
    const circuits = new Map<string | null, { requests: number; deliverables: number }>();
    const bump = (c: string | null) => {
      if (!circuits.has(c)) circuits.set(c, { requests: 0, deliverables: 0 });
      return circuits.get(c)!;
    };
    for (const r of reqs.rows) {
      const s = series.get(dayOf(r.at));
      if (s) s.requests++;
      bump(r.circuit_uid?.trim() || null).requests++;
    }
    for (const d of dels.rows) {
      const s = series.get(dayOf(d.created_at));
      if (s) s.deliverables++;
      bump(d.circuit_uid?.trim() || null).deliverables++;
    }
    const rate = (x: { requests: number; deliverables: number }) => x.requests / Math.max(x.deliverables, 1);
    return {
      series: [...series.entries()].map(([day, v]) => ({ day, ...v, rate: rate(v) })),
      by_circuit: [...circuits.entries()].map(([circuit_uid, v]) => ({ circuit_uid, ...v, rate: rate(v) })).sort((a, b) => b.requests - a.requests),
    };
  }
}

export function createContentService(deps: ContentServiceDeps): ContentServiceImpl {
  return new ContentServiceImpl(deps);
}
