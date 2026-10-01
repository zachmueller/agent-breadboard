/**
 * The CRDT sync authority ([07] §6, [12] §4): an embedded Hocuspocus instance mounted on the Fastify
 * WebSocket endpoint `/api/v1/sync`, plus server-side access to the same live documents for AI writes,
 * connector syncs, and restores — so every write (human or server) flows through one pipeline:
 * broadcast to connected editors, append to `yjs_updates` with a server-asserted origin, stamp
 * per-block attribution, and (debounced) refresh the `body_text` mirror / links / events.
 *
 * Persistence model:
 *  - load   = latest revision carrying `ydoc_state` + every `yjs_updates` row (idempotent re-apply);
 *             a CRDT node with neither is initialized from its `body_text` and that init is persisted.
 *  - write  = every update appended to `yjs_updates` (ordered per document by a promise chain).
 *  - store  = debounced head refresh (Hocuspocus `onStoreDocument`), then a compaction check.
 *  - compact= when the log since the latest snapshot exceeds `compaction_update_threshold`, cut a
 *             `compaction` revision and prune updates it covers that are older than the retention
 *             window; pure-`compaction` revisions older than the window drop their (bulky) Y state.
 */
import * as Y from 'yjs';
import { Hocuspocus, type Document } from '@hocuspocus/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BreadboardError, SERVICE_ACTOR, TAG, isUid, type Actor, type BreadboardConfig, type NodeRecord } from '@breadboard/shared';
import type { Db } from '../db/index.js';
import type { Logger } from '../core/logger.js';
import type { AuthService, EventBus, SyncServer } from '../core/services.js';
import type { NodeStore } from '../content/nodes.js';
import type { LinkIndexer } from '../content/link-indexer.js';
import { canReadDomains, canSeeSession, canWriteDomains, requireScope, type Principal } from '../core/principal.js';
import { attributionMap, blocksOf, countDeletedChars, docCharCount, docToMarkdown, initDocFromMarkdown, plainActor, propertiesMap } from './ydoc.js';
import { cutSnapshot } from './snapshot.js';

/** Mounted under the API prefix (kept literal to avoid an import cycle with app.ts). */
export const SYNC_PATH = '/api/v1/sync';
/** Below this many characters a note is too small for the wipeout guard to be meaningful. */
export const WIPEOUT_MIN_CHARS = 64;
/** WebSocket close code used when the wipeout guard rejects an update. */
export const WIPEOUT_CLOSE = { code: 4409, reason: 'wipeout-blocked' } as const;
/** Node properties that are system-owned and never written back from the CRDT `properties` map. */
const RESERVED_PROPERTIES = new Set(['external_id', 'source_url', 'source_updated_at', 'connector', 'status', 'need-input']);

type DirectConnection = Awaited<ReturnType<Hocuspocus['openDirectConnection']>>;

export type SettingsSource = () => BreadboardConfig | Promise<BreadboardConfig>;

/** The server-asserted origin recorded for an update. */
export interface SyncOrigin {
  actor: Actor;
  session_id?: string;
  /** Hocuspocus socket id for editor connections. */
  connection?: string;
  /** Marks server-internal follow-up transactions (attribution stamps, initialization). */
  internal?: 'attribution' | 'init';
}

export interface SyncServerDeps {
  db: Db;
  team_id: string;
  nodes: NodeStore;
  linkIndexer: LinkIndexer;
  auth: Pick<AuthService, 'authenticate'>;
  events: Pick<EventBus, 'publish'>;
  settings: SettingsSource;
  log: Logger;
  /** Called after a debounced head refresh changed the rendered body (e.g. embedding reindex). */
  onHeadChanged?: (uid: string) => void;
  debounceMs?: number;
  maxDebounceMs?: number;
  /** Periodic all-document compaction sweep interval (0 disables). */
  compactIntervalMs?: number;
  /** How long a server-side direct connection stays open after last use. */
  directIdleMs?: number;
}

interface SyncContext {
  principal?: Principal | null;
  fallbackToken?: string | null;
  confirmWipeout?: boolean;
  wipeoutAllowUntil?: number;
}

interface LocalOrigin {
  source: 'local';
  context: { bbOrigin: SyncOrigin };
  skipStoreHooks?: boolean;
}

function localOrigin(o: SyncOrigin): LocalOrigin {
  return { source: 'local', context: { bbOrigin: o } };
}

export function nodeVisibility(node: Pick<NodeRecord, 'uid' | 'scope'> & { session_id?: string | null }) {
  return node.scope === 'session' && node.session_id ? { scope: 'session' as const, session_id: node.session_id, node_uid: node.uid } : { scope: 'team' as const, node_uid: node.uid };
}

function denied(reason: string): Error {
  return Object.assign(new Error(reason), { reason });
}

function domainsOf(node: NodeRecord): string[] {
  const d = node.properties?.domains;
  return Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : [];
}

/** Block ids whose content a transaction changed (text edits, inserted blocks, re-set text keys). */
export function changedBlockIds(doc: Y.Doc, tr: Y.Transaction): string[] {
  const blocks = blocksOf(doc);
  const ids = new Set<string>();
  const idOf = (m: unknown) => (m instanceof Y.Map && typeof m.get('id') === 'string' ? (m.get('id') as string) : null);
  for (const type of tr.changed.keys()) {
    if (type instanceof Y.Text) {
      const parent = type._item?.parent;
      if (parent instanceof Y.Map && parent._item?.parent === blocks) {
        const id = idOf(parent);
        if (id) ids.add(id);
      }
    } else if (type instanceof Y.Map && type._item?.parent === blocks) {
      const id = idOf(type);
      if (id) ids.add(id);
    }
  }
  if ((tr.changed as Map<unknown, unknown>).has(blocks)) {
    for (const m of blocks.toArray()) {
      const item = (m as Y.Map<unknown>)._item;
      if (!item) continue;
      const before = tr.beforeState.get(item.id.client) ?? 0;
      if (item.id.clock >= before) {
        const id = idOf(m);
        if (id) ids.add(id);
      }
    }
  }
  return [...ids];
}

export class HocuspocusSyncServer implements SyncServer {
  readonly hocuspocus: Hocuspocus<SyncContext>;
  private chains = new Map<string, Promise<void>>();
  private dirtyProps = new Map<string, Set<string>>();
  private listeners = new Set<(uid: string, origin: unknown) => void>();
  private direct = new Map<string, { conn: DirectConnection; timer: NodeJS.Timeout | null }>();
  private opening = new Map<string, Promise<DirectConnection>>();
  private compactTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly directIdleMs: number;

  constructor(private deps: SyncServerDeps) {
    this.directIdleMs = deps.directIdleMs ?? 30_000;
    this.hocuspocus = new Hocuspocus<SyncContext>({
      name: 'breadboard-sync',
      quiet: true,
      debounce: deps.debounceMs ?? 2000,
      maxDebounce: deps.maxDebounceMs ?? 10_000,
      unloadImmediately: false,
      yDocOptions: { gc: false, gcFilter: () => true },
      onAuthenticate: async (p) => this.authenticate(p.documentName, p.token, p.context, p.connectionConfig, p.requestParameters),
      onLoadDocument: async (p) => {
        await this.load(p.documentName, p.document);
      },
      afterLoadDocument: async (p) => {
        this.attach(p.documentName, p.document);
      },
      beforeSync: async (p) => this.guard(p.documentName, p.document, p.connection, p.type, p.payload),
      onStateless: async (p) => {
        let msg: any;
        try {
          msg = JSON.parse(p.payload);
        } catch {
          return;
        }
        if (msg?.type === 'confirm-wipeout') {
          (p.connection.context as SyncContext).wipeoutAllowUntil = Date.now() + 60_000;
        }
      },
      onStoreDocument: async (p) => {
        await this.refreshHead(p.documentName, p.document);
      },
    });
  }

  // --- Fastify mount -----------------------------------------------------------------------------

  async register(app: FastifyInstance): Promise<void> {
    app.get(SYNC_PATH, { websocket: true }, (socket: any, req: FastifyRequest) => this.handleSocket(socket, req));
    const every = this.deps.compactIntervalMs ?? 10 * 60_000;
    if (every > 0 && !this.compactTimer) {
      this.compactTimer = setInterval(() => {
        this.compact().catch((e) => this.deps.log.warn({ err: e }, 'knowledge compaction sweep failed'));
      }, every);
      this.compactTimer.unref?.();
    }
  }

  private handleSocket(socket: any, req: FastifyRequest): void {
    const url = new URL(req.url, 'http://localhost');
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(', '));
    }
    const request = new Request(url.toString(), { headers });
    const fallbackToken = bearerFrom(req);
    const cc = this.hocuspocus.handleConnection(socket, request, { principal: ((req as any).principal as Principal | null) ?? null, fallbackToken });
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      cc.handleMessage(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
    socket.on('close', (code: number, reason: Buffer) => cc.handleClose({ code, reason: reason?.toString() ?? '' } as any));
    socket.on('error', (err: Error) => this.deps.log.debug({ err }, 'sync socket error'));
  }

  // --- Auth (doc-open checks, [12] §4) -----------------------------------------------------------

  private async authenticate(uid: string, token: string, context: SyncContext, cfg: { readOnly: boolean }, params: URLSearchParams): Promise<SyncContext> {
    if (!isUid(uid)) throw denied('invalid document name');
    let principal: Principal | null = null;
    const tok = token && token !== 'null' && token !== 'undefined' ? token : context.fallbackToken;
    if (tok) {
      try {
        principal = await this.deps.auth.authenticate(tok);
      } catch {
        principal = null;
      }
    }
    principal ??= context.principal ?? null;
    if (!principal) throw denied('unauthorized');
    try {
      requireScope(principal, 'knowledge:read');
    } catch {
      throw denied('forbidden');
    }
    const node = await this.deps.nodes.get(uid);
    if (!node || !node.crdt) throw denied('not-found');
    if (node.scope === 'session' && !canSeeSession(principal, node.session_id)) throw denied('not-found');
    const domains = domainsOf(node);
    if (node.type === 'knowledge' && !canReadDomains(principal, domains)) throw denied('grant-denied');
    let readOnly = node.tags.includes(TAG.readOnly);
    if (!readOnly) {
      try {
        requireScope(principal, 'knowledge:write');
      } catch {
        readOnly = true;
      }
    }
    if (!readOnly && node.type === 'knowledge' && !canWriteDomains(principal, domains)) readOnly = true;
    if (readOnly) cfg.readOnly = true;
    const confirm = params.get('confirmWipeout');
    return { principal, confirmWipeout: confirm === '1' || confirm === 'true' };
  }

  // --- Load / attach ---------------------------------------------------------------------------

  private async load(uid: string, doc: Y.Doc): Promise<void> {
    const snap = await this.deps.db.query(`SELECT ydoc_state FROM node_revisions WHERE uid=$1 AND ydoc_state IS NOT NULL ORDER BY revision_id DESC LIMIT 1`, [uid]);
    let applied = false;
    if (snap.rows[0]?.ydoc_state) {
      Y.applyUpdate(doc, new Uint8Array(snap.rows[0].ydoc_state));
      applied = true;
    }
    const ups = await this.deps.db.query(`SELECT update FROM yjs_updates WHERE uid=$1 ORDER BY seq`, [uid]);
    if (ups.rows.length) {
      Y.applyUpdate(doc, Y.mergeUpdates(ups.rows.map((r: any) => new Uint8Array(r.update))));
      applied = true;
    }
    if (applied) return;
    const node = await this.deps.nodes.get(uid);
    if (!node) return;
    const sv = Y.encodeStateVector(doc);
    initDocFromMarkdown(doc, node.body_text ?? '', node.created_by, { properties: { title: node.title, ...node.properties } });
    const init = Y.encodeStateAsUpdate(doc, sv);
    await this.deps.db.query(`INSERT INTO yjs_updates (uid, update, origin) VALUES ($1,$2,$3)`, [uid, Buffer.from(init), JSON.stringify({ actor: plainActor(node.created_by), internal: 'init' } satisfies SyncOrigin)]);
  }

  private attach(uid: string, doc: Document): void {
    doc.on('update', (update: Uint8Array, origin: unknown, _d: Y.Doc, tr: Y.Transaction) => {
      const o = this.resolveOrigin(origin);
      this.persist(uid, update, o);
      if (o.internal) return;
      const changed = tr.changed as Map<unknown, Set<string | null>>;
      if (changed.has(propertiesMap(doc))) {
        const keys = changed.get(propertiesMap(doc));
        const set = this.dirtyProps.get(uid) ?? new Set<string>();
        for (const k of keys ?? []) if (k) set.add(k);
        this.dirtyProps.set(uid, set);
      }
      const fromEditor = (origin as any)?.source === 'connection';
      if (fromEditor || !changed.has(attributionMap(doc))) {
        const ids = changedBlockIds(doc, tr);
        if (ids.length) {
          const at = new Date().toISOString();
          const actor = plainActor(o.actor);
          doc.transact(() => {
            const attr = attributionMap(doc);
            for (const id of ids) attr.set(id, { actor, at });
          }, localOrigin({ ...o, internal: 'attribution' }));
        }
      }
      for (const fn of this.listeners) {
        try {
          fn(uid, o);
        } catch (e) {
          this.deps.log.warn({ err: e }, 'sync onChange listener failed');
        }
      }
    });
  }

  private resolveOrigin(origin: unknown): SyncOrigin {
    const o = origin as any;
    if (o?.source === 'connection') {
      const p = o.connection?.context?.principal as Principal | undefined;
      const actor: Actor = p?.actor ?? SERVICE_ACTOR('sync-unknown');
      return { actor, ...(p?.session_id ? { session_id: p.session_id } : {}), connection: o.connection?.socketId };
    }
    if (o?.source === 'local' && o.context?.bbOrigin) return o.context.bbOrigin as SyncOrigin;
    return { actor: SERVICE_ACTOR('sync') };
  }

  private persist(uid: string, update: Uint8Array, origin: SyncOrigin): void {
    const prev = this.chains.get(uid) ?? Promise.resolve();
    const next = prev
      .then(() => this.deps.db.query(`INSERT INTO yjs_updates (uid, update, origin) VALUES ($1,$2,$3)`, [uid, Buffer.from(update), JSON.stringify({ ...origin, actor: plainActor(origin.actor) })]))
      .then(
        () => undefined,
        (e) => this.deps.log.error({ err: e, uid }, 'failed to persist yjs update'),
      );
    this.chains.set(uid, next);
    void next.then(() => {
      if (this.chains.get(uid) === next) this.chains.delete(uid);
    });
  }

  /** Await every pending `yjs_updates` append (all docs, or one). */
  async flush(uid?: string): Promise<void> {
    if (uid) {
      await this.chains.get(uid);
      return;
    }
    await Promise.all([...this.chains.values()]);
  }

  // --- Wipeout guard ([07] §6) -------------------------------------------------------------------

  private async guard(uid: string, doc: Y.Doc, connection: any, type: number, payload: Uint8Array): Promise<void> {
    if (type !== 1 && type !== 2) return;
    if (connection?.readOnly) return;
    const total = docCharCount(doc);
    if (total < WIPEOUT_MIN_CHARS) return;
    const deleted = countDeletedChars(doc, payload);
    if (!deleted) return;
    const settings = await this.deps.settings();
    if (deleted / total <= settings.knowledge.wipeout_fraction) return;
    const ctx = (connection?.context ?? {}) as SyncContext;
    if (ctx.confirmWipeout) {
      ctx.confirmWipeout = false;
      return;
    }
    if (ctx.wipeoutAllowUntil && ctx.wipeoutAllowUntil > Date.now()) {
      ctx.wipeoutAllowUntil = 0;
      return;
    }
    try {
      connection?.sendStateless?.(JSON.stringify({ type: 'wipeout-blocked', deleted, total }));
    } catch {
      /* socket gone */
    }
    const node = await this.deps.nodes.get(uid);
    await this.deps.events.publish('node.updated', { uid, wipeout_blocked: true, deleted_chars: deleted, total_chars: total, actor: ctx.principal?.actor ?? null }, node ? nodeVisibility(node) : { scope: 'team', node_uid: uid });
    throw Object.assign(new Error('wipeout-blocked'), WIPEOUT_CLOSE);
  }

  // --- Head refresh -----------------------------------------------------------------------------

  /** Refresh the `body_text` mirror, write back dirty properties, reindex links, publish, compact. */
  async refreshHead(uid: string, doc: Y.Doc): Promise<void> {
    const node = await this.deps.nodes.get(uid);
    if (!node) return;
    const md = docToMarkdown(doc);
    const dirty = this.dirtyProps.get(uid);
    this.dirtyProps.delete(uid);
    let changed = false;
    let title = node.title;
    let properties = node.properties;
    if (dirty?.size) {
      const props = propertiesMap(doc);
      const patch: Record<string, unknown> = {};
      let newTitle: string | undefined;
      for (const k of dirty) {
        if (RESERVED_PROPERTIES.has(k) || k === 'tags') continue;
        const v = props.get(k);
        if (k === 'title') {
          if (typeof v === 'string' && v.trim() && v !== node.title) newTitle = v.trim();
          continue;
        }
        patch[k] = v === undefined ? null : JSON.parse(JSON.stringify(v));
      }
      if (Object.keys(patch).length || newTitle) {
        const updated = await this.deps.nodes.patch(uid, { ...(Object.keys(patch).length ? { properties: patch } : {}), ...(newTitle ? { title: newTitle } : {}) });
        title = updated.title;
        properties = updated.properties;
        changed = true;
      }
    }
    if (md !== (node.body_text ?? '')) {
      await this.deps.nodes.setBodyText(uid, md);
      changed = true;
    }
    if (changed) {
      await this.deps.linkIndexer.reindex({ uid, title, properties, body: node.body, body_text: md });
      const settings = await this.deps.settings();
      const size = md.length;
      await this.deps.events.publish('node.updated', { uid, type: node.type, title, chars: size, ...(size > settings.knowledge.size_warning_chars ? { size_warning: true } : {}) }, nodeVisibility(node));
      try {
        this.deps.onHeadChanged?.(uid);
      } catch (e) {
        this.deps.log.warn({ err: e }, 'onHeadChanged failed');
      }
    }
    await this.compactOne(uid, false).catch((e) => this.deps.log.warn({ err: e, uid }, 'compaction failed'));
  }

  // --- Compaction ([07] §6) ---------------------------------------------------------------------

  /** Compact one node (forced) or sweep all nodes with update logs over threshold. Returns updates pruned. */
  async compact(uid?: string): Promise<number> {
    if (uid) return this.compactOne(uid, true);
    const r = await this.deps.db.query(`SELECT DISTINCT uid FROM yjs_updates`);
    let n = 0;
    for (const row of r.rows) n += await this.compactOne(String(row.uid).trim(), false);
    return n;
  }

  private async compactOne(uid: string, force: boolean): Promise<number> {
    const settings = await this.deps.settings();
    const { compaction_update_threshold: threshold, base_revision_retention_hours: hours } = settings.knowledge;
    await this.flush(uid);
    const pending = await this.deps.db.query(
      `SELECT count(*)::int AS n FROM yjs_updates u WHERE u.uid=$1 AND u.created_at > coalesce((SELECT max(created_at) FROM node_revisions r WHERE r.uid=$1 AND r.ydoc_state IS NOT NULL), '-infinity'::timestamptz)`,
      [uid],
    );
    const n = Number(pending.rows[0]?.n ?? 0);
    if (!force && n < threshold) return 0;
    const node = await this.deps.nodes.get(uid);
    if (!node || !node.crdt) return 0;
    const doc = await this.openDoc(uid);
    await this.flush(uid);
    const maxSeq = await this.deps.db.query(`SELECT max(seq) AS s FROM yjs_updates WHERE uid=$1`, [uid]);
    const s = maxSeq.rows[0]?.s;
    const snap = await cutSnapshot({ db: this.deps.db, nodes: this.deps.nodes, linkIndexer: this.deps.linkIndexer }, uid, doc, ['compaction'], SERVICE_ACTOR('compaction'));
    let pruned = 0;
    if (s !== null && s !== undefined) {
      const del = await this.deps.db.query(`DELETE FROM yjs_updates WHERE uid=$1 AND seq <= $2 AND created_at < now() - ($3::double precision * interval '1 hour')`, [uid, s, hours]);
      pruned = del.rowCount;
    }
    // Old pure-compaction snapshots past the retention window drop their Y state (body stays readable);
    // a base_revision older than the window then fails with `base-revision-too-old` ([07] §5.2). The AI result
    // revision right after a `pre-ai-edit` keeps its state: it is the three-way base for revert-ai-edit.
    await this.deps.db.query(
      `UPDATE node_revisions SET ydoc_state=NULL, ydoc_vector=NULL
        WHERE uid=$1 AND revision_id < $2 AND ydoc_state IS NOT NULL AND labels = ARRAY['compaction']::text[]
          AND created_at < now() - ($3::double precision * interval '1 hour')
          AND NOT EXISTS (SELECT 1 FROM node_revisions p WHERE p.uid = node_revisions.uid AND p.revision_id = node_revisions.revision_id - 1 AND 'pre-ai-edit' = ANY(p.labels))`,
      [uid, snap.revision.revision_id, hours],
    );
    return pruned;
  }

  // --- Server-side document access ---------------------------------------------------------------

  async openDoc(uid: string): Promise<Y.Doc> {
    const conn = await this.directConnection(uid);
    return conn.document!;
  }

  private async directConnection(uid: string): Promise<DirectConnection> {
    if (this.stopped) throw new BreadboardError('invalid-state', 'sync server stopped');
    const hit = this.direct.get(uid);
    if (hit && hit.conn.document) {
      this.touch(uid);
      return hit.conn;
    }
    const inflight = this.opening.get(uid);
    if (inflight) return inflight;
    const node = await this.deps.nodes.get(uid);
    if (!node) throw new BreadboardError('note-not-found', `node ${uid} not found`);
    if (!node.crdt) throw new BreadboardError('invalid-state', `node ${uid} is not CRDT-backed`);
    const p = this.hocuspocus.openDirectConnection(uid, {}).then((conn) => {
      this.direct.set(uid, { conn, timer: null });
      this.opening.delete(uid);
      this.touch(uid);
      return conn;
    });
    p.catch(() => this.opening.delete(uid));
    this.opening.set(uid, p);
    return p;
  }

  private touch(uid: string): void {
    const e = this.direct.get(uid);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      this.direct.delete(uid);
      e.conn.disconnect({ unloadImmediately: false }).catch((err) => this.deps.log.warn({ err, uid }, 'direct connection release failed'));
    }, this.directIdleMs);
    e.timer.unref?.();
  }

  async transact(uid: string, origin: Actor & { session_id?: string }, fn: (doc: Y.Doc) => void): Promise<void> {
    const doc = await this.openDoc(uid);
    const { session_id, ...actor } = origin;
    doc.transact(() => fn(doc), localOrigin({ actor: actor as Actor, ...(session_id ?? origin.session_id ? { session_id: session_id ?? origin.session_id } : {}) }));
    await this.flush(uid);
  }

  /** Apply an encoded update (e.g. a reconcile delta) to the live doc with a server-asserted origin. */
  async applyUpdate(uid: string, update: Uint8Array, origin: SyncOrigin): Promise<Y.Doc> {
    const doc = await this.openDoc(uid);
    Y.applyUpdate(doc, update, localOrigin(origin));
    await this.flush(uid);
    return doc;
  }

  /** Force the debounced head refresh for a doc now (tests, shutdown). */
  async storeNow(uid: string): Promise<void> {
    const doc = this.hocuspocus.documents.get(uid);
    if (doc) await this.refreshHead(uid, doc);
  }

  onChange(fn: (uid: string, origin: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    if (this.compactTimer) clearInterval(this.compactTimer);
    this.compactTimer = null;
    this.hocuspocus.closeConnections();
    this.hocuspocus.flushPendingStores();
    const conns = [...this.direct.entries()];
    this.direct.clear();
    for (const [, e] of conns) {
      if (e.timer) clearTimeout(e.timer);
      await e.conn.disconnect({ unloadImmediately: true }).catch(() => undefined);
    }
    this.stopped = true;
    await this.flush();
  }
}

function bearerFrom(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const q = (req.query as any)?.access_token;
  if (typeof q === 'string' && q) return q;
  const cookie = (req as any).cookies?.bb_session;
  if (typeof cookie === 'string' && cookie) return cookie;
  const raw = req.headers.cookie;
  if (raw) {
    const m = /(?:^|;\s*)bb_session=([^;]+)/.exec(raw);
    if (m) return decodeURIComponent(m[1]!);
  }
  return null;
}

export function createSyncServer(deps: SyncServerDeps): HocuspocusSyncServer {
  return new HocuspocusSyncServer(deps);
}
