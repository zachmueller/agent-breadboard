/**
 * Read-only knowledge connectors ([07] §8): a scheduler that drives connector tool extensions through the
 * Toolbox (`list(cursor)` → `[{external_id, title, updated_at}]`, `fetch(external_id)` → `{markdown, metadata}`)
 * and materializes documents as `knowledge` nodes tagged `read-only` + `connector:<tool uid>`. Re-syncs
 * write through the CRDT as a server-origin transaction (`service` actor, revision label `connector-sync`).
 */
import { BreadboardError, SERVICE_ACTOR, TAG, type Actor } from '@breadboard/shared';
import type { Db } from '../db/index.js';
import type { Logger } from '../core/logger.js';
import type { ConfigService, ConnectorScheduler, KnowledgeService, Toolbox } from '../core/services.js';
import type { NodeStore } from '../content/nodes.js';
import { servicePrincipal as mkServicePrincipal, type Principal } from '../core/principal.js';
import type { SettingsSource } from './sync.js';

export const MAX_LIST_ITEMS = 10_000;
export const TICK_MS = 60_000;

export interface ConnectorSchedulerDeps {
  db: Db;
  team_id: string;
  nodes: NodeStore;
  knowledge: Pick<KnowledgeService, 'replaceBody'>;
  toolbox: Pick<Toolbox, 'invoke'>;
  config: Pick<ConfigService, 'tool'>;
  settings: SettingsSource;
  log: Logger;
  /** Principal tool invocations run under (defaults to `servicePrincipal(team_id, 'connector')`). */
  servicePrincipal?: Principal;
  tickMs?: number;
}

interface ListItem {
  external_id: string;
  title?: string;
  updated_at?: string | null;
}

interface ConnectorEntry {
  tool: string;
  slug: string;
  schedule_minutes: number;
  domains: string[];
  settings: Record<string, unknown>;
  enabled: boolean;
}

function asItems(out: unknown): { items: ListItem[]; next_cursor: string | null } {
  const o = out as any;
  const raw: unknown[] = Array.isArray(o) ? o : Array.isArray(o?.items) ? o.items : [];
  const items = raw
    .filter((x: any) => x && typeof x.external_id === 'string' && x.external_id)
    .map((x: any) => ({ external_id: x.external_id as string, title: typeof x.title === 'string' ? x.title : undefined, updated_at: x.updated_at == null ? null : String(x.updated_at) }));
  const next = Array.isArray(o) ? null : typeof o?.next_cursor === 'string' && o.next_cursor ? o.next_cursor : null;
  return { items, next_cursor: next };
}

function newer(a: string | null | undefined, b: unknown): boolean {
  if (!a) return true; // unknown upstream timestamp → always refetch
  if (typeof b !== 'string' || !b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a !== b;
  return ta > tb;
}

export class ConnectorSchedulerImpl implements ConnectorScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = new Map<string, Promise<{ fetched: number; updated: number; errors: string[] }>>();
  private stopped = false;
  private readonly principal: Principal;
  private readonly actor: Actor = SERVICE_ACTOR('connector');

  constructor(private deps: ConnectorSchedulerDeps) {
    this.principal = deps.servicePrincipal ?? mkServicePrincipal(deps.team_id, 'connector');
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    // Crash recovery: no sync survives a restart.
    this.deps.db.query(`UPDATE connector_state SET running=false WHERE running`).catch((e) => this.deps.log.warn({ err: e }, 'connector state reset failed'));
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.running.values()]);
  }

  /** Connector instances from settings, merged with manifest defaults. */
  private async entries(): Promise<ConnectorEntry[]> {
    const settings = await this.deps.settings();
    const out: ConnectorEntry[] = [];
    const seen = new Set<string>();
    for (const c of settings.connectors ?? []) {
      if (seen.has(c.tool)) {
        this.deps.log.warn({ tool: c.tool }, 'duplicate connector entry for the same tool; only the first is used');
        continue;
      }
      seen.add(c.tool);
      let slug = c.tool;
      let manifest: { schedule_minutes: number; domains: string[] } | undefined;
      try {
        const t = await this.deps.config.tool(c.tool);
        slug = t.tool.slug;
        manifest = t.tool.connector;
        if (!manifest) this.deps.log.warn({ tool: c.tool }, 'connector entry points at a tool without a `connector` manifest block');
      } catch (e) {
        this.deps.log.warn({ err: e, tool: c.tool }, 'connector tool not found');
      }
      out.push({
        tool: c.tool,
        slug,
        schedule_minutes: c.schedule_minutes ?? manifest?.schedule_minutes ?? 360,
        domains: c.domains?.length ? c.domains : (manifest?.domains ?? []),
        settings: (c.settings ?? {}) as Record<string, unknown>,
        enabled: c.enabled ?? true,
      });
    }
    return out;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    let entries: ConnectorEntry[];
    try {
      entries = await this.entries();
    } catch (e) {
      this.deps.log.warn({ err: e }, 'connector tick: settings unavailable');
      return;
    }
    const states = await this.states();
    const now = Date.now();
    for (const e of entries) {
      if (!e.enabled || this.running.has(e.tool)) continue;
      const last = states.get(e.tool)?.last_sync_at;
      if (last && Date.parse(last) + e.schedule_minutes * 60_000 > now) continue;
      void this.run(e).catch((err) => this.deps.log.warn({ err, tool: e.tool }, 'scheduled connector sync failed'));
    }
  }

  private async states(): Promise<Map<string, { last_sync_at: string | null; last_error: string | null; running: boolean; doc_count: number; cursor: string | null }>> {
    const r = await this.deps.db.query(`SELECT tool_uid, cursor, last_sync_at, last_error, running, doc_count FROM connector_state`);
    return new Map(
      r.rows.map((row: any) => [
        String(row.tool_uid).trim(),
        {
          cursor: row.cursor ?? null,
          last_sync_at: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null,
          last_error: row.last_error ?? null,
          running: !!row.running,
          doc_count: Number(row.doc_count ?? 0),
        },
      ]),
    );
  }

  async syncNow(toolUid: string, by: Principal): Promise<{ fetched: number; updated: number; errors: string[] }> {
    if (!by.is_admin) throw new BreadboardError('forbidden', 'only admins can trigger a connector sync');
    const entry = (await this.entries()).find((e) => e.tool === toolUid);
    if (!entry) throw new BreadboardError('not-found', `no connector configured for tool ${toolUid}`);
    return this.run(entry);
  }

  private run(entry: ConnectorEntry): Promise<{ fetched: number; updated: number; errors: string[] }> {
    const existing = this.running.get(entry.tool);
    if (existing) return existing;
    const p = this.syncOne(entry).finally(() => this.running.delete(entry.tool));
    this.running.set(entry.tool, p);
    return p;
  }

  private async setState(tool: string, patch: { running: boolean; last_error?: string | null; done?: boolean; doc_count?: number }): Promise<void> {
    await this.deps.db.query(
      `INSERT INTO connector_state (tool_uid, running, last_error, last_sync_at, doc_count)
       VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN now() ELSE NULL END, coalesce($5::int, 0))
       ON CONFLICT (tool_uid) DO UPDATE SET running = EXCLUDED.running,
         last_error = CASE WHEN $4::boolean THEN EXCLUDED.last_error ELSE connector_state.last_error END,
         last_sync_at = CASE WHEN $4::boolean THEN now() ELSE connector_state.last_sync_at END,
         doc_count = coalesce($5::int, connector_state.doc_count)`,
      [tool, patch.running, patch.last_error ?? null, !!patch.done, patch.doc_count ?? null],
    );
  }

  private async syncOne(entry: ConnectorEntry): Promise<{ fetched: number; updated: number; errors: string[] }> {
    const errors: string[] = [];
    let fetched = 0;
    let updated = 0;
    await this.setState(entry.tool, { running: true });
    try {
      const settings = await this.deps.settings();
      const declared = new Set(settings.knowledge.domains.map((d) => d.slug));
      const domains = entry.domains.filter((d) => declared.has(d));
      const undeclared = entry.domains.filter((d) => !declared.has(d));
      if (undeclared.length) this.deps.log.warn({ tool: entry.tool, undeclared }, 'connector domains not declared in breadboard.yaml; skipped');

      const tag = TAG.connector(entry.tool);
      const existing = new Map<string, { uid: string; source_updated_at: unknown; title: string }>();
      const r = await this.deps.db.query(
        `SELECT uid, title, properties FROM nodes WHERE team_id=$1 AND type='knowledge' AND deleted_at IS NULL AND $2 = ANY(tags)`,
        [this.deps.team_id, tag],
      );
      for (const row of r.rows as any[]) {
        const ext = row.properties?.external_id;
        if (typeof ext === 'string') existing.set(ext, { uid: String(row.uid).trim(), source_updated_at: row.properties?.source_updated_at, title: row.title });
      }

      // Enumerate.
      const items: ListItem[] = [];
      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      for (;;) {
        const res = await this.invoke(entry, 'list', [cursor]);
        const page = asItems(res.output);
        items.push(...page.items);
        if (!page.next_cursor || items.length >= MAX_LIST_ITEMS || seenCursors.has(page.next_cursor)) {
          if (items.length >= MAX_LIST_ITEMS) errors.push(`list truncated at ${MAX_LIST_ITEMS} items`);
          break;
        }
        seenCursors.add(page.next_cursor);
        cursor = page.next_cursor;
      }

      // Fetch new/changed documents.
      for (const item of items.slice(0, MAX_LIST_ITEMS)) {
        if (this.stopped) break;
        const cur = existing.get(item.external_id);
        if (cur && !newer(item.updated_at, cur.source_updated_at)) continue;
        try {
          const res = await this.invoke(entry, 'fetch', [item.external_id]);
          const out = (res.output ?? {}) as { markdown?: unknown; metadata?: Record<string, unknown> };
          if (typeof out.markdown !== 'string') throw new Error('fetch returned no markdown');
          fetched++;
          const meta = out.metadata ?? {};
          const title = (typeof meta.title === 'string' && meta.title.trim()) || item.title || item.external_id;
          const sourceUpdated = item.updated_at ?? (typeof meta.updated_at === 'string' ? meta.updated_at : null);
          const props = { external_id: item.external_id, source_url: typeof meta.source_url === 'string' ? meta.source_url : null, source_updated_at: sourceUpdated, domains, connector: entry.tool };
          if (!cur) {
            const node = await this.deps.nodes.create({
              type: 'knowledge',
              title,
              // source_updated_at is recorded only after the body landed, so a failed first sync retries.
              properties: { ...props, source_updated_at: null },
              body_text: out.markdown,
              crdt: true,
              tags: [TAG.readOnly, tag],
              scope: 'team',
              created_by: this.actor,
            });
            await this.deps.knowledge.replaceBody({ uid: node.uid, markdown: out.markdown, by: this.actor, label: 'connector-sync' });
            await this.deps.nodes.patch(node.uid, { properties: { source_updated_at: sourceUpdated } });
            existing.set(item.external_id, { uid: node.uid, source_updated_at: sourceUpdated, title });
          } else {
            await this.deps.knowledge.replaceBody({ uid: cur.uid, markdown: out.markdown, by: this.actor, label: 'connector-sync' });
            await this.deps.nodes.patch(cur.uid, { ...(title !== cur.title ? { title } : {}), properties: props });
          }
          updated++;
        } catch (e) {
          errors.push(`${item.external_id}: ${(e as Error).message}`);
          this.deps.log.warn({ err: e, tool: entry.tool, external_id: item.external_id }, 'connector fetch failed');
        }
      }
      await this.setState(entry.tool, { running: false, done: true, last_error: errors.length ? errors.slice(0, 5).join('; ') : null, doc_count: existing.size });
    } catch (e) {
      errors.push((e as Error).message);
      await this.setState(entry.tool, { running: false, done: true, last_error: (e as Error).message }).catch(() => undefined);
      this.deps.log.warn({ err: e, tool: entry.tool }, 'connector sync failed');
    }
    return { fetched, updated, errors };
  }

  private invoke(entry: ConnectorEntry, exp: 'list' | 'fetch', input: unknown[]) {
    return this.deps.toolbox.invoke({ tool_uid: entry.tool, input, settings: entry.settings, principal: this.principal, ambient: { invocation: 'connector' }, export: exp });
  }

  async status(): Promise<Array<{ tool_uid: string; slug: string; last_sync_at: string | null; last_error: string | null; running: boolean; doc_count: number; schedule_minutes: number }>> {
    const [entries, states] = await Promise.all([this.entries(), this.states()]);
    return entries.map((e) => {
      const s = states.get(e.tool);
      return {
        tool_uid: e.tool,
        slug: e.slug,
        last_sync_at: s?.last_sync_at ?? null,
        last_error: s?.last_error ?? null,
        running: this.running.has(e.tool) || !!s?.running,
        doc_count: s?.doc_count ?? 0,
        schedule_minutes: e.schedule_minutes,
      };
    });
  }
}

export function createConnectorScheduler(deps: ConnectorSchedulerDeps): ConnectorSchedulerImpl {
  return new ConnectorSchedulerImpl(deps);
}
