/**
 * Knowledge service ([07]): Notes, the AI edit path (read pinned → pre-ai-edit → three-way reconcile →
 * merge onto the live head → respond with reality), revert/restore, search (FTS + pgvector), injection
 * rules, domains, embeddings, compaction. Grants are enforced here, not only at the routes.
 */
import * as Y from 'yjs';
import { BreadboardError, SERVICE_ACTOR, TAG, grantDenied, validationFailed, type Actor, type NodeRecord, type RevisionLabel, type Scope } from '@breadboard/shared';
import type { Db } from '../db/index.js';
import type { Logger } from '../core/logger.js';
import type { CreatedNote, EventBus, KnowledgeSearchHit, KnowledgeService, ModelGateway, NoteEditResult, NoteRead, SyncServer } from '../core/services.js';
import type { NodeStore } from '../content/nodes.js';
import type { EdgeStore } from '../content/edges.js';
import type { LinkIndexer } from '../content/link-indexer.js';
import { canReadDomains, canSeeSession, canWriteAllDomains, canWriteDomains, requireScope, type Principal } from '../core/principal.js';
import { MarkdownParseError, attributionOf, cloneDoc, countDeletedChars, docCharCount, docFromRevisionState, docToMarkdown, encodeVector, plainActor, sameVector, splitMarkdownIntoBlocks } from './ydoc.js';
import { reconcile, type ReconcileResult } from './reconcile.js';
import { cutSnapshot } from './snapshot.js';
import { WIPEOUT_MIN_CHARS, nodeVisibility, type SettingsSource } from './sync.js';

/** Sync server surface the service needs; `compact`/`flush` are optional extras of the Hocuspocus impl. */
export type KnowledgeSync = SyncServer & { compact?(uid?: string): Promise<number>; flush?(uid?: string): Promise<void> };

export interface KnowledgeServiceDeps {
  db: Db;
  team_id: string;
  nodes: NodeStore;
  /** Lineage (`produces` / `updates` from a session step) and possible-duplicate `references`. */
  edges: EdgeStore;
  linkIndexer: LinkIndexer;
  sync: KnowledgeSync;
  gateway: Pick<ModelGateway, 'embed'>;
  settings: SettingsSource;
  events: Pick<EventBus, 'publish'>;
  log: Logger;
  /** Debounce for embedding refresh after live edits (0 disables auto-reindex). */
  embedDebounceMs?: number;
  embedMaxDebounceMs?: number;
}

export const CHUNK_CHARS = 800;
export const SNIPPET_CHARS = 240;
const RRF_K = 60;
/** Cosine similarity at which an AI-created note is flagged as a possible duplicate of an existing one. */
export const NOTE_DUP_THRESHOLD = 0.85;

type KNode = NodeRecord & { session_id: string | null };

export function noteDomains(node: Pick<NodeRecord, 'properties'>): string[] {
  const d = node.properties?.domains;
  return Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Read-visibility check shared by the service and the routes: existence, session scope, domain grants.
 * Hidden nodes surface as `note-not-found` (no existence leak); visible-but-ungranted as `grant-denied`.
 */
export function assertCanRead(node: KNode | null, by: Principal, opts: { knowledgeOnly?: boolean } = {}): asserts node is KNode {
  if (!node || node.deleted_at) throw new BreadboardError('note-not-found', 'note not found');
  if ((opts.knowledgeOnly ?? true) && node.type !== 'knowledge') throw new BreadboardError('note-not-found', `node ${node.uid} is not a knowledge note`);
  if (node.scope === 'session' && !canSeeSession(by, node.session_id)) throw new BreadboardError('note-not-found', 'note not found');
  if (node.type === 'knowledge' && !canReadDomains(by, noteDomains(node))) {
    throw grantDenied(`no read grant for knowledge domains [${noteDomains(node).join(', ')}]`, { uid: node.uid, domains: noteDomains(node) });
  }
}

function isCompaction(a: Actor | null | undefined): boolean {
  return a?.kind === 'service' && a.id === 'compaction';
}

function isAi(p: Principal): boolean {
  return p.actor.kind === 'subagent' || p.actor.kind === 'code-step';
}

function changes(r: ReconcileResult): number {
  return r.stats.replaced + r.stats.inserted + r.stats.deleted;
}

/** Split Markdown into ~CHUNK_CHARS chunks on block boundaries (oversized blocks are hard-split). */
export function chunkMarkdown(md: string, size = CHUNK_CHARS): string[] {
  let blocks: string[];
  try {
    blocks = splitMarkdownIntoBlocks(md);
  } catch {
    blocks = md.split(/\n{2,}/);
  }
  const out: string[] = [];
  let cur = '';
  for (const b of blocks) {
    if (b.length > size) {
      if (cur) out.push(cur);
      cur = '';
      for (let i = 0; i < b.length; i += size) out.push(b.slice(i, i + size));
      continue;
    }
    if (cur && cur.length + 2 + b.length > size) {
      out.push(cur);
      cur = b;
    } else cur = cur ? `${cur}\n\n${b}` : b;
  }
  if (cur) out.push(cur);
  return out.filter((c) => c.trim());
}

/** The block (paragraph) of `text` that best matches the query terms, truncated. */
export function snippetFor(text: string, q: string, max = SNIPPET_CHARS): string {
  const terms = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1);
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim());
  let best = blocks[0] ?? '';
  let bestScore = -1;
  for (const b of blocks) {
    const lb = b.toLowerCase();
    let s = 0;
    for (const t of terms) if (lb.includes(t)) s++;
    if (s > bestScore) {
      best = b;
      bestScore = s;
    }
  }
  const flat = best.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const vectorLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;

export class KnowledgeServiceImpl implements KnowledgeService {
  private locks = new Map<string, Promise<unknown>>();
  private embedTimers = new Map<string, { timer: NodeJS.Timeout; first: number }>();
  private unsubscribe: (() => void) | null = null;

  constructor(private deps: KnowledgeServiceDeps) {
    const wait = deps.embedDebounceMs ?? 3000;
    if (wait > 0) this.unsubscribe = deps.sync.onChange((uid) => this.scheduleReindex(uid));
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const { timer } of this.embedTimers.values()) clearTimeout(timer);
    this.embedTimers.clear();
  }

  private async withLock<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(uid) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(uid, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(uid) === tail) this.locks.delete(uid);
    }
  }

  private async liveDoc(uid: string): Promise<Y.Doc> {
    const doc = await this.deps.sync.openDoc(uid);
    await this.deps.sync.flush?.(uid);
    return doc;
  }

  private snapshot(uid: string, doc: Y.Doc, labels: RevisionLabel[], by: Actor) {
    return cutSnapshot({ db: this.deps.db, nodes: this.deps.nodes, linkIndexer: this.deps.linkIndexer }, uid, doc, labels, plainActor(by));
  }

  /** The latest revision if it captures the live head exactly, else a freshly cut snapshot. */
  private async ensureBaseRevision(uid: string, doc: Y.Doc, by: Actor): Promise<{ revision_id: number; markdown: string }> {
    const latest = await this.deps.nodes.latestRevision(uid);
    const vector = encodeVector(doc);
    if (latest?.ydoc_vector_buf && sameVector(latest.ydoc_vector_buf, vector)) return { revision_id: latest.revision_id, markdown: docToMarkdown(doc) };
    const snap = await this.snapshot(uid, doc, ['compaction'], by);
    return { revision_id: snap.revision.revision_id, markdown: snap.markdown };
  }

  private parseOrThrow(markdown: unknown): void {
    if (typeof markdown !== 'string') throw new BreadboardError('parse-failed', 'markdown must be a string');
    try {
      splitMarkdownIntoBlocks(markdown);
    } catch (e) {
      throw new BreadboardError('parse-failed', `could not parse markdown: ${(e as Error).message}`);
    }
  }

  private async assertWritable(node: KNode, by: Principal): Promise<void> {
    if (node.tags.includes(TAG.readOnly)) throw new BreadboardError('read-only-source', `note ${node.uid} is read-only (connector-owned); edit the upstream source instead`);
    requireScope(by, 'knowledge:write');
    if (!canWriteDomains(by, noteDomains(node))) throw grantDenied(`no write grant for knowledge domains [${noteDomains(node).join(', ')}]`, { uid: node.uid, domains: noteDomains(node) });
  }

  // --- Notes --------------------------------------------------------------------------------------

  async createNote(input: {
    title: string;
    markdown: string;
    domains?: string[];
    tags?: string[];
    properties?: Record<string, unknown>;
    by: Principal;
    scope?: Scope;
    session_id?: string | null;
    step_id?: string | null;
  }): Promise<CreatedNote> {
    const { by } = input;
    requireScope(by, 'knowledge:write');
    if (typeof input.title !== 'string' || !input.title.trim()) throw validationFailed('title is required');
    this.parseOrThrow(input.markdown);
    const settings = await this.deps.settings();
    const declared = new Set(settings.knowledge.domains.map((d) => d.slug));
    const domains = [...new Set(input.domains ?? (Array.isArray(input.properties?.domains) ? (input.properties!.domains as string[]) : []))];
    const unknown = domains.filter((d) => !declared.has(d));
    if (unknown.length) throw validationFailed(`unknown knowledge domain(s): ${unknown.join(', ')}`, { unknown, declared: [...declared] });
    const ai = isAi(by);
    if (ai) {
      if (!domains.length) throw grantDenied('AI-created notes must be placed in a knowledge domain you can write');
      // Creating places the note in every listed domain, so each must be writable (editing needs only one).
      if (!canWriteAllDomains(by, domains)) throw grantDenied(`no write grant for knowledge domains [${domains.join(', ')}]`, { domains });
    }
    const tags = (input.tags ?? []).filter((t) => t !== TAG.readOnly && !t.startsWith('connector:'));
    if (ai && !tags.includes(TAG.origin(by.actor.kind))) tags.push(TAG.origin(by.actor.kind));
    const md = input.markdown.replace(/\r\n?/g, '\n');
    const session_id = input.session_id ?? by.session_id ?? null;
    const step_id = input.step_id ?? by.actor.step_id ?? null;
    const orchestrated = !!(session_id && step_id);
    const node = await this.deps.nodes.create({
      type: 'knowledge',
      title: input.title.trim(),
      properties: { ...(input.properties ?? {}), domains },
      body_text: splitMarkdownIntoBlocks(md).join('\n\n'),
      crdt: true,
      tags,
      scope: input.scope ?? 'team',
      created_by: plainActor(by.actor),
      session_id: by.session_id ?? null,
    });
    const doc = await this.liveDoc(node.uid);
    const snap = await this.snapshot(node.uid, doc, [orchestrated ? 'step-completion' : 'publish'], by.actor);
    const revision_id = snap.revision.revision_id;
    if (orchestrated) {
      await this.deps.edges.emit({ type: 'produces', src_session_id: session_id!, src_step_id: step_id!, dst_uid: node.uid, dst_revision: revision_id, created_by: plainActor(by.actor) });
    }
    const possible_duplicates = ai ? await this.flagDuplicates(node.uid, `${node.title}\n${md}`, domains, by) : [];
    // Seeding the live doc is an internal change, so no sync listener fires for a new note.
    this.autoReindex(node.uid);
    await this.deps.events.publish('node.updated', { uid: node.uid, type: 'knowledge', title: node.title, created: true }, nodeVisibility({ ...node, session_id: by.session_id ?? null })).catch(() => undefined);
    return { ...(await this.deps.nodes.mustGet(node.uid)), revision_id, possible_duplicates };
  }

  /** Dedup for AI-created notes, like task dedup ([08] §4): flag and link near-duplicates, never block. */
  private async flagDuplicates(uid: string, text: string, domains: string[], by: Principal): Promise<CreatedNote['possible_duplicates']> {
    try {
      const hits = (await this.search({ q: text, mode: 'semantic', domains, limit: 5, by })).filter((h) => h.uid !== uid && h.score >= NOTE_DUP_THRESHOLD);
      if (!hits.length) return [];
      await this.deps.nodes.patch(uid, { tags_add: hits.map((h) => TAG.possibleDupOf(h.uid)) });
      for (const h of hits) {
        if (!(await this.deps.edges.exists('references', uid, h.uid))) {
          await this.deps.edges.emit({ type: 'references', src_uid: uid, dst_uid: h.uid, properties: { reason: 'possible-duplicate', score: h.score }, created_by: SERVICE_ACTOR('knowledge-dedup') });
        }
      }
      return hits.map((h) => ({ uid: h.uid, title: h.title, score: h.score }));
    } catch (err) {
      this.deps.log.warn({ err, uid }, 'note dedup failed (non-blocking)');
      return [];
    }
  }

  async readNote(uid: string, by: Principal): Promise<NoteRead> {
    requireScope(by, 'knowledge:read');
    const node = await this.deps.nodes.get(uid);
    assertCanRead(node, by);
    return this.withLock(uid, async () => {
      const doc = await this.liveDoc(uid);
      const base = await this.ensureBaseRevision(uid, doc, by.actor);
      const fresh = (await this.deps.nodes.get(uid)) ?? node;
      return {
        uid,
        title: fresh.title,
        markdown: base.markdown,
        base_revision: base.revision_id,
        domains: noteDomains(fresh),
        read_only: fresh.tags.includes(TAG.readOnly),
        tags: fresh.tags,
        properties: fresh.properties,
      };
    });
  }

  async proposeEdit(input: { uid: string; base_revision: number; markdown: string; by: Principal; session_id?: string | null; step_id?: string | null }): Promise<NoteEditResult> {
    const { uid, by } = input;
    const node = await this.deps.nodes.get(uid);
    assertCanRead(node, by);
    await this.assertWritable(node, by);
    return this.withLock(uid, async () => {
      const base = Number.isInteger(input.base_revision) ? await this.deps.nodes.getRevision(uid, input.base_revision) : null;
      if (!base || !base.ydoc_state_buf) {
        throw new BreadboardError('base-revision-too-old', `base_revision ${input.base_revision} is no longer available as a merge base; call read_note again and re-apply your edit`, { uid, base_revision: input.base_revision });
      }
      this.parseOrThrow(input.markdown);
      const actor: Actor = plainActor({ ...by.actor, ...(by.session_id && !by.actor.session_id ? { session_id: by.session_id } : {}) });
      const baseDoc = docFromRevisionState(base.ydoc_state_buf);
      let r: ReconcileResult;
      try {
        r = reconcile(baseDoc, input.markdown, { actor });
      } catch (e) {
        if (e instanceof MarkdownParseError) throw new BreadboardError('parse-failed', e.message);
        throw e;
      }
      const live = await this.liveDoc(uid);
      const had = !sameVector(base.ydoc_vector_buf, encodeVector(live));
      if (changes(r) === 0) {
        const head = await this.ensureBaseRevision(uid, live, by.actor);
        return { applied: true, had_concurrent_edits: had, merged_markdown: head.markdown, new_head_revision: head.revision_id, pre_ai_edit_revision: head.revision_id, blocks_changed: 0 };
      }
      const settings = await this.deps.settings();
      const total = docCharCount(live);
      const deleted = countDeletedChars(live, r.update);
      if (total >= WIPEOUT_MIN_CHARS && deleted / total > settings.knowledge.wipeout_fraction) {
        await this.deps.events
          .publish('node.updated', { uid, wipeout_detected: true, deleted_chars: deleted, total_chars: total, actor, session_id: actor.session_id ?? null }, nodeVisibility(node))
          .catch(() => undefined);
        throw new BreadboardError('wipeout-detected', `edit would delete ${deleted} of ${total} characters (> ${Math.round(settings.knowledge.wipeout_fraction * 100)}%); suspended for human review`, {
          uid,
          deleted_chars: deleted,
          total_chars: total,
          base_revision: input.base_revision,
        });
      }
      const pre = await this.snapshot(uid, live, ['pre-ai-edit'], actor);
      await this.deps.sync.transact(uid, actor, (doc) => Y.applyUpdate(doc, r.update));
      const post = await this.snapshot(uid, live, ['compaction'], actor);
      const session_id = input.session_id ?? actor.session_id ?? null;
      const step_id = input.step_id ?? actor.step_id ?? null;
      if (session_id && step_id) {
        await this.deps.edges.emit({ type: 'updates', src_session_id: session_id, src_step_id: step_id, dst_uid: uid, dst_revision: post.revision.revision_id, created_by: actor });
      }
      await this.deps.events
        .publish('node.updated', { uid, type: 'knowledge', actor, session_id: actor.session_id ?? null, step_id: actor.step_id ?? null, revision_id: post.revision.revision_id, pre_ai_edit_revision: pre.revision.revision_id }, nodeVisibility(node))
        .catch(() => undefined);
      return {
        applied: true,
        had_concurrent_edits: had,
        merged_markdown: post.markdown,
        new_head_revision: post.revision.revision_id,
        pre_ai_edit_revision: pre.revision.revision_id,
        blocks_changed: changes(r),
      };
    });
  }

  async revertAiEdit(input: { uid: string; pre_ai_edit_revision: number; by: Principal }): Promise<{ new_head_revision: number }> {
    const { uid, by } = input;
    const node = await this.deps.nodes.get(uid);
    assertCanRead(node, by);
    await this.assertWritable(node, by);
    return this.withLock(uid, async () => {
      const pre = await this.deps.nodes.getRevision(uid, input.pre_ai_edit_revision);
      if (!pre) throw new BreadboardError('not-found', `revision ${input.pre_ai_edit_revision} not found`);
      if (!pre.labels.includes('pre-ai-edit')) throw validationFailed(`revision ${input.pre_ai_edit_revision} is not a pre-ai-edit revision`);
      const live = await this.liveDoc(uid);
      // Three-way: diff the AI's result back to the pre-edit text, so only the AI's blocks are reverted and later
      // human edits survive. proposeEdit cuts the result right after pre-ai-edit under the note lock, whoever edits
      // (a subagent, a code step, or an external agent on a user or service token); only the sync server's
      // compaction, which does not take the lock, can cut a revision in between.
      let after = await this.deps.nodes.getRevision(uid, pre.revision_id + 1);
      for (let id = pre.revision_id + 2; after && isCompaction(after.created_by) && id <= pre.revision_id + 4; id++) after = await this.deps.nodes.getRevision(uid, id);
      const baseDoc = after?.ydoc_state_buf && !isCompaction(after.created_by) ? docFromRevisionState(after.ydoc_state_buf) : cloneDoc(live);
      const r = reconcile(baseDoc, pre.body_text ?? '', { actor: plainActor(by.actor) });
      if (changes(r) > 0) await this.deps.sync.transact(uid, plainActor(by.actor), (doc) => Y.applyUpdate(doc, r.update));
      const snap = await this.snapshot(uid, live, ['publish'], by.actor);
      return { new_head_revision: snap.revision.revision_id };
    });
  }

  async restoreRevision(input: { uid: string; revision_id: number; by: Principal }): Promise<{ new_head_revision: number }> {
    const { uid, by } = input;
    const node = await this.deps.nodes.get(uid);
    assertCanRead(node, by, { knowledgeOnly: false });
    if (!node.crdt) throw new BreadboardError('invalid-state', `node ${uid} is not CRDT-backed`);
    await this.assertWritable(node, by);
    const rev = await this.deps.nodes.getRevision(uid, input.revision_id);
    if (!rev) throw new BreadboardError('not-found', `revision ${input.revision_id} not found`);
    const { revision } = await this.replaceBodyLocked(uid, rev.body_text ?? '', plainActor(by.actor), 'publish');
    return { new_head_revision: revision };
  }

  async replaceBody(input: { uid: string; markdown: string; by: Actor; label: RevisionLabel }): Promise<{ revision: number }> {
    this.parseOrThrow(input.markdown);
    return this.replaceBodyLocked(input.uid, input.markdown, plainActor(input.by), input.label);
  }

  private replaceBodyLocked(uid: string, markdown: string, by: Actor, label: RevisionLabel): Promise<{ revision: number }> {
    return this.withLock(uid, async () => {
      const live = await this.liveDoc(uid);
      const r = reconcile(cloneDoc(live), markdown, { actor: by });
      if (changes(r) > 0) await this.deps.sync.transact(uid, by, (doc) => Y.applyUpdate(doc, r.update));
      // Also when nothing changed: a connector creates the node with its body, then replaces it with the same text.
      else this.autoReindex(uid);
      const snap = await this.snapshot(uid, live, [label], by);
      return { revision: snap.revision.revision_id };
    });
  }

  async markdownOf(uid: string): Promise<string> {
    const node = await this.deps.nodes.get(uid);
    if (!node) throw new BreadboardError('note-not-found', `node ${uid} not found`);
    if (!node.crdt) return node.body_text ?? '';
    return docToMarkdown(await this.liveDoc(uid));
  }

  async attribution(uid: string): Promise<Record<string, { actor: Actor; at: string }>> {
    const node = await this.deps.nodes.get(uid);
    if (!node || !node.crdt) throw new BreadboardError('note-not-found', `node ${uid} not found`);
    return attributionOf(await this.liveDoc(uid));
  }

  // --- Search ([07] §9) ---------------------------------------------------------------------------

  async search(input: { q: string; mode?: 'text' | 'semantic' | 'hybrid'; domains?: string[]; limit?: number; by: Principal; types?: string[] }): Promise<KnowledgeSearchHit[]> {
    const { by } = input;
    requireScope(by, 'knowledge:read');
    const q = (input.q ?? '').trim();
    if (!q) return [];
    const limit = Math.max(1, Math.min(100, input.limit ?? 10));
    const types = input.types?.length ? input.types : ['knowledge'];
    let domains = input.domains?.length ? [...new Set(input.domains)] : undefined;
    if (by.grants) {
      const readable = [...by.grants.knowledge.read];
      domains = domains ? domains.filter((d) => by.grants!.knowledge.read.has(d)) : readable;
      if (!domains.length && types.every((t) => t === 'knowledge')) return [];
    }
    const mode = input.mode ?? 'hybrid';
    const visible = (n: KNode) => {
      if (n.deleted_at) return false;
      if (!types.includes(n.type)) return false;
      if (n.scope === 'session' && !canSeeSession(by, n.session_id)) return false;
      if (n.type === 'knowledge' && !canReadDomains(by, noteDomains(n))) return false;
      if (domains && n.type === 'knowledge' && !noteDomains(n).some((d) => domains!.includes(d))) return false;
      return true;
    };
    const hitOf = (n: KNode, score: number, snippet: string, source: KnowledgeSearchHit['source']): KnowledgeSearchHit => ({ uid: n.uid, title: n.title, snippet, score, domains: noteDomains(n), tags: n.tags, source });

    const text = mode === 'semantic' ? [] : await this.textSearch(q, types, domains, by, limit * 3);
    let semantic: Array<{ uid: string; score: number; chunk: string }> = [];
    let semanticFailed = false;
    if (mode !== 'text') {
      try {
        semantic = await this.semanticSearch(q, types, limit * 6);
      } catch (e) {
        semanticFailed = true;
        this.deps.log.warn({ err: e }, 'semantic search unavailable');
        if (mode === 'semantic') throw new BreadboardError('invalid-state', `semantic search unavailable: ${(e as Error).message}`);
      }
    }
    const textHits = text.filter(visible).map((n) => hitOf(n, Number(n.rank ?? 0), snippetFor(n.body_text ?? n.title, q), 'text'));
    if (mode === 'text' || (mode === 'hybrid' && semanticFailed)) return textHits.slice(0, limit);

    const best = new Map<string, { score: number; chunk: string }>();
    for (const s of semantic) {
      const cur = best.get(s.uid);
      if (!cur || s.score > cur.score) best.set(s.uid, { score: s.score, chunk: s.chunk });
    }
    const nodes = await this.deps.nodes.getMany([...best.keys()]);
    const semHits: KnowledgeSearchHit[] = [];
    for (const [uid, b] of [...best.entries()].sort((a, c) => c[1].score - a[1].score)) {
      const n = nodes.get(uid);
      if (!n || !visible(n)) continue;
      semHits.push(hitOf(n, b.score, snippetFor(b.chunk, q), 'semantic'));
    }
    if (mode === 'semantic') return semHits.slice(0, limit);

    // Hybrid: reciprocal-rank fusion.
    const fused = new Map<string, { hit: KnowledgeSearchHit; score: number; sources: Set<string> }>();
    const add = (list: KnowledgeSearchHit[], src: string) =>
      list.forEach((h, i) => {
        const e = fused.get(h.uid) ?? { hit: h, score: 0, sources: new Set<string>() };
        e.score += 1 / (RRF_K + i + 1);
        e.sources.add(src);
        if (src === 'text') e.hit = { ...e.hit, snippet: h.snippet };
        fused.set(h.uid, e);
      });
    add(semHits, 'semantic');
    add(textHits, 'text');
    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((e) => ({ ...e.hit, score: e.score, source: e.sources.size > 1 ? 'hybrid' : (([...e.sources][0] ?? 'text') as KnowledgeSearchHit['source']) }));
  }

  private async textSearch(q: string, types: string[], domains: string[] | undefined, by: Principal, limit: number) {
    const page = await this.deps.nodes.list({
      type: types,
      q,
      domains: domains && types.every((t) => t === 'knowledge') ? domains : undefined,
      visible_sessions: by.visible_sessions,
      limit: Math.min(200, limit),
    });
    return page.items as Array<KNode & { rank?: number }>;
  }

  private async semanticSearch(q: string, types: string[], limit: number): Promise<Array<{ uid: string; score: number; chunk: string }>> {
    const { model_id, vectors } = await this.deps.gateway.embed([q]);
    const qv = vectors[0];
    if (!qv?.length) return [];
    if (this.deps.db.features.pgvector) {
      const r = await this.deps.db.query(
        `SELECT c.uid, c.chunk_text, 1 - (c.embedding <=> $1::vector) AS score
           FROM knowledge_chunks c JOIN nodes n ON n.uid = c.uid
          WHERE n.team_id = $2 AND n.deleted_at IS NULL AND n.type = ANY($3::text[]) AND c.model_id = $4 AND vector_dims(c.embedding) = $5
          ORDER BY c.embedding <=> $1::vector LIMIT $6`,
        [vectorLiteral(qv), this.deps.team_id, types, model_id, qv.length, limit],
      );
      return r.rows.map((row: any) => ({ uid: String(row.uid).trim(), score: Number(row.score), chunk: row.chunk_text }));
    }
    const r = await this.deps.db.query(
      `SELECT c.uid, c.chunk_text, c.embedding FROM knowledge_chunks c JOIN nodes n ON n.uid = c.uid
        WHERE n.team_id = $1 AND n.deleted_at IS NULL AND n.type = ANY($2::text[]) AND c.model_id = $3`,
      [this.deps.team_id, types, model_id],
    );
    return r.rows
      .map((row: any) => {
        const emb: number[] = Array.isArray(row.embedding) ? row.embedding.map(Number) : [];
        return { uid: String(row.uid).trim(), score: emb.length === qv.length ? cosine(qv, emb) : -1, chunk: row.chunk_text as string };
      })
      .filter((x) => x.score > -1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // --- Embeddings -------------------------------------------------------------------------------

  /** Debounced embedding refresh, when auto-reindex is on (live edits reach it through the sync listener). */
  private autoReindex(uid: string): void {
    if ((this.deps.embedDebounceMs ?? 3000) > 0) this.scheduleReindex(uid);
  }

  private scheduleReindex(uid: string): void {
    const wait = this.deps.embedDebounceMs ?? 3000;
    const maxWait = this.deps.embedMaxDebounceMs ?? 10_000;
    const cur = this.embedTimers.get(uid);
    const first = cur?.first ?? Date.now();
    if (cur) clearTimeout(cur.timer);
    const delay = Math.max(0, Math.min(wait, first + maxWait - Date.now()));
    const timer = setTimeout(() => {
      this.embedTimers.delete(uid);
      this.reindexEmbeddings(uid).catch((e) => this.deps.log.warn({ err: e, uid }, 'embedding reindex failed'));
    }, delay);
    timer.unref?.();
    this.embedTimers.set(uid, { timer, first });
  }

  async reindexEmbeddings(uid: string): Promise<void> {
    const node = await this.deps.nodes.get(uid);
    if (!node || node.deleted_at || node.type !== 'knowledge') {
      await this.deps.db.query(`DELETE FROM knowledge_chunks WHERE uid=$1`, [uid]);
      return;
    }
    const md = node.crdt ? await this.markdownOf(uid) : (node.body_text ?? '');
    const chunks = chunkMarkdown(md);
    if (!chunks.length) {
      await this.deps.db.query(`DELETE FROM knowledge_chunks WHERE uid=$1`, [uid]);
      return;
    }
    let emb: { model_id: string; vectors: number[][] };
    try {
      emb = await this.deps.gateway.embed(chunks.map((c) => `${node.title}\n\n${c}`));
    } catch (e) {
      this.deps.log.warn({ err: e, uid }, 'embedding failed; keeping previous chunks');
      return;
    }
    const pg = this.deps.db.features.pgvector;
    await this.deps.db.transaction(async (tx) => {
      await tx.query(`DELETE FROM knowledge_chunks WHERE uid=$1`, [uid]);
      for (let i = 0; i < chunks.length; i++) {
        const v = emb.vectors[i];
        if (!v?.length) continue;
        await tx.query(`INSERT INTO knowledge_chunks (uid, chunk_idx, chunk_text, embedding, model_id) VALUES ($1,$2,$3,$4${pg ? '::vector' : '::real[]'},$5)`, [uid, i, chunks[i], pg ? vectorLiteral(v) : v, emb.model_id]);
      }
    });
  }

  // --- Injection ([07] §4), domains, compaction ----------------------------------------------------

  async injectionsFor(text: string, readableDomains: string[] | null): Promise<Array<{ uid: string; title: string; revision_id: number; markdown: string; rule: string }>> {
    if (!text) return [];
    const settings = await this.deps.settings();
    const out: Array<{ uid: string; title: string; revision_id: number; markdown: string; rule: string }> = [];
    const seen = new Set<string>();
    for (const rule of settings.knowledge_injection) {
      if (readableDomains !== null && !readableDomains.includes(rule.domain)) continue;
      let re: RegExp;
      try {
        re = new RegExp(rule.trigger.pattern, 'g');
      } catch {
        this.deps.log.warn({ pattern: rule.trigger.pattern }, 'invalid knowledge_injection pattern');
        continue;
      }
      const tags = new Set<string>();
      for (const m of text.matchAll(re)) tags.add(rule.inject.notes_tagged.replace(/\$(\d+)/g, (_s, n: string) => m[Number(n)] ?? ''));
      if (!tags.size) continue;
      const page = await this.deps.nodes.list({ type: ['knowledge'], tag: [...tags], domains: [rule.domain], visible_sessions: [], limit: Math.min(200, rule.max_notes * 4) });
      let count = 0;
      for (const n of page.items.sort((a, b) => a.title.localeCompare(b.title))) {
        if (count >= rule.max_notes) break;
        if (seen.has(n.uid)) continue;
        seen.add(n.uid);
        count++;
        const base = await this.withLock(n.uid, async () => this.ensureBaseRevision(n.uid, await this.liveDoc(n.uid), { kind: 'service', id: 'knowledge-injection' }));
        out.push({ uid: n.uid, title: n.title, revision_id: base.revision_id, markdown: base.markdown, rule: `${rule.domain}:${rule.trigger.pattern}` });
      }
    }
    return out;
  }

  async domains(): Promise<Array<{ slug: string; description: string; note_count: number }>> {
    const settings = await this.deps.settings();
    const r = await this.deps.db.query(
      `SELECT d AS slug, count(*)::int AS n
         FROM nodes n, jsonb_array_elements_text(CASE WHEN jsonb_typeof(n.properties->'domains')='array' THEN n.properties->'domains' ELSE '[]'::jsonb END) d
        WHERE n.team_id=$1 AND n.type='knowledge' AND n.deleted_at IS NULL GROUP BY d`,
      [this.deps.team_id],
    );
    const counts = new Map<string, number>(r.rows.map((row: any) => [row.slug, Number(row.n)]));
    return settings.knowledge.domains.map((d) => ({ slug: d.slug, description: d.description ?? '', note_count: counts.get(d.slug) ?? 0 }));
  }

  async compact(uid?: string): Promise<number> {
    return this.deps.sync.compact ? this.deps.sync.compact(uid) : 0;
  }
}

export function createKnowledgeService(deps: KnowledgeServiceDeps): KnowledgeServiceImpl {
  return new KnowledgeServiceImpl(deps);
}
