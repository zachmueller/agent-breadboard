/**
 * Intake task service ([08] §2–§4, §10): task lifecycle, dedup, the queue view, and the dispatch pass
 * that feeds queued tasks into triage (or a pinned target circuit) as capacity allows.
 */
import {
  BreadboardError,
  SERVICE_ACTOR,
  TAG,
  TASK_PRIORITIES,
  TASK_STATUSES,
  invalidState,
  validationFailed,
  type Actor,
  type NodeDto,
  type NodeRecord,
  type Page,
  type SessionBudget,
  type TaskPriority,
  type TaskStatus,
} from '@breadboard/shared';
import type { Db } from '../db/index.js';
import type { Logger } from '../core/logger.js';
import type { ConfigService, ContentService, EventBus, KnowledgeService, Orchestrator, SessionStore, TaskService } from '../core/services.js';
import type { Principal } from '../core/principal.js';
import type { NodeStore } from '../content/nodes.js';
import type { EdgeStore } from '../content/edges.js';
import type { GraphQueries } from '../content/graph-queries.js';

export interface TaskServiceDeps {
  db: Db;
  team_id: string;
  nodes: NodeStore;
  edges: EdgeStore;
  graph: GraphQueries;
  content: ContentService;
  orchestrator: () => Orchestrator;
  sessions: () => SessionStore;
  config: ConfigService;
  knowledge: () => KnowledgeService | null;
  events: EventBus;
  log: Logger;
}

/** Session states that count as "this task already has a run in flight". */
const ACTIVE_SESSION_STATES = ['queued', 'running', 'suspended-gate', 'suspended-error'];
const DEFAULT_LIST_STATUSES: TaskStatus[] = ['queued', 'triaging', 'active', 'gated'];
const DUP_THRESHOLD = 0.5;
const RRF_K = 60;
const DISPATCH_BATCH = 200;

const STOPWORDS = new Set('a an and are as at be by for from has have in into is it its of on or that the this to was were will with we our you your i not no do does should can could'.split(' '));

/** Lowercased content words with naive suffix stripping — enough for an overlap score, not a stemmer. */
function terms(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.add(w.replace(/(ing|ed|es|s)$/, '') || w);
  }
  return out;
}

function overlap(q: Set<string>, d: Set<string>): number {
  if (!q.size) return 0;
  let hit = 0;
  for (const t of q) if (d.has(t)) hit++;
  return hit / q.size;
}

function statusOf(n: NodeRecord): string {
  return typeof n.properties?.status === 'string' ? (n.properties.status as string) : 'queued';
}

function assertTask(n: NodeRecord): void {
  if (n.type !== 'task') throw validationFailed(`node ${n.uid} is a ${n.type}, not a task`);
}

function originKind(by: Principal): 'user' | 'api' | 'subagent' {
  if (by.actor.kind === 'user') return 'user';
  if (by.actor.kind === 'service') return 'api';
  return 'subagent';
}

export class TaskServiceImpl implements TaskService {
  private warnedNoTriage = false;

  constructor(private deps: TaskServiceDeps) {}

  private get nodes() {
    return this.deps.nodes;
  }

  private async publishStatus(n: NodeRecord & { session_id?: string | null }, status: string, extra: Record<string, unknown> = {}): Promise<void> {
    try {
      const vis = n.scope === 'session' ? { scope: 'session' as const, session_id: n.session_id ?? undefined, node_uid: n.uid } : { scope: 'team' as const, node_uid: n.uid };
      await this.deps.events.publish('task.status', { uid: n.uid, status, title: n.title, ...extra }, vis);
    } catch (err) {
      this.deps.log.warn({ err, uid: n.uid }, 'task.status publish failed');
    }
  }

  private async loadTask(uid: string, by: Principal): Promise<NodeDto> {
    const n = await this.deps.content.getNode(uid, by);
    assertTask(n);
    return n;
  }

  /** Internal status write (bypasses the content service's "status is orchestrator-driven" patch guard). */
  private async writeStatus(uid: string, status: TaskStatus, by: Actor, extra: { properties?: Record<string, unknown>; tags_add?: string[]; tags_remove?: string[]; detail?: Record<string, unknown> } = {}): Promise<NodeRecord> {
    const cur = await this.nodes.mustGet(uid);
    const history = Array.isArray(cur.properties?.status_history) ? [...(cur.properties.status_history as unknown[])] : [];
    const from = statusOf(cur);
    if (from !== status) history.push({ from, to: status, at: new Date().toISOString(), by, ...(extra.detail ? { detail: extra.detail } : {}) });
    let tags = [...cur.tags, ...(extra.tags_add ?? [])];
    if (extra.tags_remove) tags = tags.filter((t) => !extra.tags_remove!.includes(t));
    const n = await this.nodes.patch(uid, { properties: { ...(extra.properties ?? {}), status, status_history: history.slice(-50) }, tags });
    if (from !== status) await this.publishStatus(n, status, { from });
    return n;
  }

  // --- create ([08] §2.1, §4) ------------------------------------------------------

  async create(input: Parameters<TaskService['create']>[0]): Promise<NodeDto> {
    const { by } = input;
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) throw validationFailed("field 'title' is required");
    if (typeof input.body !== 'string') throw validationFailed("field 'body' (markdown) is required");
    const priority = (input.priority ?? 'p2') as TaskPriority;
    if (!TASK_PRIORITIES.includes(priority)) throw validationFailed(`priority must be one of ${TASK_PRIORITIES.join(', ')}`);
    if (input.target_circuit) {
      try {
        await this.deps.config.circuit(input.target_circuit);
      } catch (err) {
        if (err instanceof BreadboardError && err.code !== 'not-found') throw err;
        throw validationFailed(`target_circuit ${input.target_circuit} is not a known circuit`);
      }
    }
    const kind = originKind(by);
    const status: TaskStatus = input.draft ? 'draft' : 'queued';
    const tags = [...(input.tags ?? [])];
    if (kind !== 'user') tags.push(TAG.origin(kind));
    const node = await this.deps.content.createNode({
      type: 'task',
      title,
      body: input.body,
      crdt: false,
      tags,
      by,
      properties: {
        priority,
        origin: { kind, id: by.actor.id },
        status,
        ...(input.target_circuit ? { target_circuit: input.target_circuit } : {}),
        ...(input.budget ? { budget: input.budget } : {}),
      },
    });
    let rev: number | null = null;
    if (status === 'queued' || input.session_id) {
      rev = (await this.nodes.cutRevision(node.uid, { labels: ['intake'], created_by: by.actor })).revision_id;
    }
    if (input.session_id && rev !== null) {
      await this.deps.edges.emit({ type: 'produces', src_session_id: input.session_id, src_step_id: 'conversation', dst_uid: node.uid, dst_revision: rev, created_by: by.actor });
    }
    // Dedup ([08] §4): flag, link, never block.
    try {
      const hits = (await this.similar(`${title}\n${input.body}`, by, 5)).filter((h) => h.uid !== node.uid && h.score >= DUP_THRESHOLD);
      if (hits.length) {
        await this.nodes.patch(node.uid, { tags_add: hits.map((h) => TAG.possibleDupOf(h.uid)) });
        for (const h of hits) {
          if (!(await this.deps.edges.exists('references', node.uid, h.uid))) {
            await this.deps.edges.emit({ type: 'references', src_uid: node.uid, dst_uid: h.uid, properties: { reason: 'possible-duplicate', score: h.score }, created_by: SERVICE_ACTOR('intake-dedup') });
          }
        }
      }
    } catch (err) {
      this.deps.log.warn({ err, uid: node.uid }, 'task dedup failed (non-blocking)');
    }
    const fresh = await this.nodes.mustGet(node.uid);
    await this.publishStatus(fresh, status, { created: true });
    return this.deps.content.nodeDto(fresh);
  }

  // --- status actions ([08] §2.2) ----------------------------------------------------

  async accept(uid: string, by: Principal): Promise<NodeDto> {
    const n = await this.loadTask(uid, by);
    if (statusOf(n) !== 'draft') throw invalidState(`task ${uid} is ${statusOf(n)}, not a draft`);
    await this.writeStatus(uid, 'queued', by.actor);
    await this.nodes.cutRevision(uid, { labels: ['intake'], created_by: by.actor });
    return this.deps.content.getNode(uid, by);
  }

  async reject(uid: string, by: Principal, reason?: string): Promise<NodeDto> {
    const n = await this.loadTask(uid, by);
    const s = statusOf(n);
    if (s === 'done' || s === 'rejected') throw invalidState(`task ${uid} is already ${s}`);
    await this.writeStatus(uid, 'rejected', by.actor, { properties: reason ? { rejected_reason: reason } : {}, detail: reason ? { reason } : undefined });
    return this.deps.content.getNode(uid, by);
  }

  async promote(uid: string, by: Principal, priority?: string): Promise<NodeDto> {
    const n = await this.loadTask(uid, by);
    const cur = (n.properties?.priority as TaskPriority) ?? 'p2';
    let next: TaskPriority;
    if (priority !== undefined) {
      if (!TASK_PRIORITIES.includes(priority as TaskPriority)) throw validationFailed(`priority must be one of ${TASK_PRIORITIES.join(', ')}`);
      next = priority as TaskPriority;
    } else {
      next = TASK_PRIORITIES[Math.max(0, TASK_PRIORITIES.indexOf(cur) - 1)] ?? 'p0';
    }
    await this.nodes.patch(uid, { properties: { priority: next }, tags_remove: n.tags.filter((t) => t.startsWith('origin:')), tags_add: ['reviewed'] });
    await this.publishStatus(await this.nodes.mustGet(uid), statusOf(n), { promoted: true, priority: next });
    return this.deps.content.getNode(uid, by);
  }

  async markReviewed(uid: string, by: Principal): Promise<NodeDto> {
    await this.loadTask(uid, by);
    await this.nodes.patch(uid, { tags_add: ['reviewed'] });
    return this.deps.content.getNode(uid, by);
  }

  async discard(uid: string, by: Principal): Promise<void> {
    const n = await this.loadTask(uid, by);
    if (statusOf(n) !== 'draft') throw invalidState(`only drafts can be discarded; task ${uid} is ${statusOf(n)}`);
    await this.nodes.softDelete(uid);
    await this.publishStatus(n, 'discarded');
  }

  async setStatus(uid: string, status: string, by: Actor, detail?: Record<string, unknown>): Promise<void> {
    if (!TASK_STATUSES.includes(status as TaskStatus)) throw validationFailed(`status must be one of ${TASK_STATUSES.join(', ')}`);
    const n = await this.nodes.mustGet(uid);
    assertTask(n);
    await this.writeStatus(uid, status as TaskStatus, by, { detail });
  }

  // --- similar / list --------------------------------------------------------------

  async similar(q: string, by: Principal, limit = 5): Promise<Array<{ uid: string; title: string; status: string; score: number }>> {
    const qTerms = terms(q);
    if (!qTerms.size) return [];
    const lim = Math.min(Math.max(limit, 1), 50);
    // Lexical leg: OR-of-terms FTS (websearch_to_tsquery ANDs every word, too strict for dedup).
    const tsq = [...qTerms].map((t) => `${t}:*`).join(' | ');
    const lex = await this.deps.db.query<{ uid: string; title: string; body_text: string | null; status: string | null; scope: string; session_id: string | null }>(
      `SELECT uid, title, body_text, properties->>'status' AS status, scope, session_id FROM nodes
        WHERE team_id=$1 AND type='task' AND deleted_at IS NULL
          AND to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body_text,'')) @@ to_tsquery('simple', $2)
        ORDER BY ts_rank(to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body_text,'')), to_tsquery('simple', $2)) DESC, created_at DESC
        LIMIT $3`,
      [this.deps.team_id, tsq, lim * 4],
    );
    const visible = (r: { scope: string; session_id: string | null }) => r.scope !== 'session' || by.visible_sessions === null || (r.session_id !== null && by.visible_sessions.includes(r.session_id));
    const cand = new Map<string, { uid: string; title: string; status: string; lexical: number; semantic: number; rrf: number }>();
    lex.rows.filter(visible).forEach((r, i) => {
      const score = overlap(qTerms, terms(`${r.title} ${r.body_text ?? ''}`));
      cand.set(r.uid, { uid: r.uid, title: r.title, status: r.status ?? 'queued', lexical: score, semantic: 0, rrf: 1 / (RRF_K + i + 1) });
    });
    // Semantic leg (when the knowledge search index is available).
    const k = this.deps.knowledge();
    if (k) {
      try {
        const hits = await k.search({ q, mode: 'hybrid', limit: lim * 4, by, types: ['task'] });
        hits.forEach((h, i) => {
          const c = cand.get(h.uid) ?? { uid: h.uid, title: h.title, status: '', lexical: 0, semantic: 0, rrf: 0 };
          c.semantic = Math.max(c.semantic, Number(h.score) || 0);
          c.rrf += 1 / (RRF_K + i + 1);
          cand.set(h.uid, c);
        });
      } catch (err) {
        this.deps.log.debug({ err }, 'semantic task search unavailable');
      }
    }
    const missing = [...cand.values()].filter((c) => !c.status).map((c) => c.uid);
    if (missing.length) {
      const m = await this.nodes.getMany(missing);
      for (const uid of missing) {
        const n = m.get(uid);
        if (!n || n.type !== 'task') cand.delete(uid);
        else cand.get(uid)!.status = statusOf(n);
      }
    }
    return [...cand.values()]
      .sort((a, b) => b.rrf - a.rrf)
      .slice(0, lim)
      .map((c) => ({ uid: c.uid, title: c.title, status: c.status, score: Math.round(Math.max(c.lexical, Math.min(c.semantic, 1)) * 1000) / 1000 }));
  }

  async list(filter: Record<string, unknown>, by: Principal): Promise<Page<NodeDto & { queue_age_s: number | null }>> {
    const one = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Array.isArray(v) ? v[0] : v);
    const drafts = ['1', 'true', 'yes'].includes(String(one(filter.drafts) ?? '').toLowerCase()) || filter.drafts === true;
    const status = drafts ? ['draft'] : (filter.status ?? DEFAULT_LIST_STATUSES);
    const page = await this.deps.content.listNodes(
      {
        type: 'task',
        status,
        priority: filter.priority,
        origin_kind: filter.origin ?? filter.origin_kind,
        tag: filter.tag,
        circuit: filter.circuit,
        created_after: filter.created_after ?? filter.since,
        created_before: filter.created_before ?? filter.until,
        q: filter.q,
        session_id: filter.session_id,
        cursor: filter.cursor,
        offset: filter.offset,
        order: filter.order,
        limit: filter.limit,
      },
      by,
    );
    const now = Date.now();
    return {
      items: page.items.map((n) => {
        if (statusOf(n) !== 'queued') return { ...n, queue_age_s: null };
        const hist = Array.isArray(n.properties?.status_history) ? (n.properties.status_history as Array<{ to?: string; at?: string }>) : [];
        const since = [...hist].reverse().find((h) => h.to === 'queued')?.at ?? n.created_at;
        return { ...n, queue_age_s: Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000)) };
      }),
      next_cursor: page.next_cursor,
      ...(page.total !== undefined ? { total: page.total } : {}),
    };
  }

  // --- dispatch ([08] §3) ----------------------------------------------------------

  /** Tasks this task waits on: `X depends-on Y` and `Y blocks X`. */
  private async blockers(uid: string): Promise<string[]> {
    const r = await this.deps.db.query<{ uid: string }>(
      `SELECT dst_uid AS uid FROM edges WHERE type='depends-on' AND src_uid=$1 AND retracted_at IS NULL
       UNION SELECT src_uid AS uid FROM edges WHERE type='blocks' AND dst_uid=$1 AND src_uid IS NOT NULL AND retracted_at IS NULL`,
      [uid],
    );
    return r.rows.map((x) => x.uid);
  }

  private async dependenciesDone(uid: string): Promise<boolean> {
    const deps = await this.blockers(uid);
    if (!deps.length) return true;
    const m = await this.nodes.getMany(deps);
    for (const d of deps) {
      const n = m.get(d);
      if (!n) continue; // deleted dependency no longer blocks
      if (n.type === 'task' && statusOf(n) !== 'done') return false;
    }
    return true;
  }

  private async hasActiveSession(uid: string): Promise<boolean> {
    const page = await this.deps.sessions().list({ task: uid, state: ACTIVE_SESSION_STATES, limit: 1 });
    return page.items.length > 0;
  }

  async dispatchQueued(): Promise<string[]> {
    const r = await this.deps.db.query<{ uid: string }>(
      `SELECT uid FROM nodes WHERE team_id=$1 AND type='task' AND deleted_at IS NULL AND properties->>'status' = 'queued'
        ORDER BY coalesce(properties->>'priority','p2') ASC, created_at ASC LIMIT ${DISPATCH_BATCH}`,
      [this.deps.team_id],
    );
    if (!r.rows.length) return [];
    let triage: string | undefined;
    try {
      triage = (await this.deps.config.settings()).intake.triage_circuit;
    } catch (err) {
      this.deps.log.warn({ err }, 'dispatch: settings unavailable');
    }
    const out: string[] = [];
    for (const { uid } of r.rows) {
      try {
        const n = await this.nodes.get(uid);
        if (!n || statusOf(n) !== 'queued') continue;
        if (await this.hasActiveSession(uid)) continue;
        if (!(await this.dependenciesDone(uid))) continue;
        const target = typeof n.properties?.target_circuit === 'string' ? (n.properties.target_circuit as string) : null;
        const circuit = target ?? triage ?? null;
        if (!circuit) {
          if (!this.warnedNoTriage) {
            this.deps.log.warn('dispatch: queued tasks have no target_circuit and settings.intake.triage_circuit is unset; leaving them queued');
            this.warnedNoTriage = true;
          }
          continue;
        }
        let head = await this.nodes.headRevisionId(uid);
        if (head === null) head = (await this.nodes.cutRevision(uid, { labels: ['intake'], created_by: SERVICE_ACTOR('dispatcher') })).revision_id;
        const priority = typeof n.properties?.priority === 'string' ? (n.properties.priority as string) : 'p2';
        const budget = (n.properties?.budget as Partial<SessionBudget> | undefined) ?? null;
        const session = await this.deps.orchestrator().enqueue({
          circuit_uid: circuit,
          input: { task: { uid, revision_id: head }, title: n.title, body: n.body_text ?? '', priority },
          task_uid: uid,
          priority,
          budget,
          created_by: SERVICE_ACTOR('dispatcher'),
        });
        out.push(session.session_id);
        if (!target) await this.writeStatus(uid, 'triaging', SERVICE_ACTOR('dispatcher'), { detail: { session_id: session.session_id } });
      } catch (err) {
        this.deps.log.warn({ err, uid }, 'dispatch: enqueue failed; task stays queued');
      }
    }
    return out;
  }

  async archiveStaleDrafts(): Promise<number> {
    let days = 30;
    try {
      days = (await this.deps.config.settings()).intake.draft_retention_days;
    } catch {
      /* default */
    }
    const r = await this.deps.db.query<{ uid: string }>(
      `UPDATE nodes SET deleted_at = now(), updated_at = now()
        WHERE team_id=$1 AND type='task' AND deleted_at IS NULL AND properties->>'status'='draft' AND updated_at < now() - ($2::int * interval '1 day')
        RETURNING uid`,
      [this.deps.team_id, days],
    );
    if (r.rows.length) this.deps.log.info({ count: r.rows.length }, 'archived stale task drafts');
    return r.rows.length;
  }
}

export function createTaskService(deps: TaskServiceDeps): TaskServiceImpl {
  return new TaskServiceImpl(deps);
}
