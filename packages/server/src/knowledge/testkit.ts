/** Test helpers for the knowledge subsystem (fakes + a wired sync server + service on the PGlite harness). */
import { createHash } from 'node:crypto';
import { BreadboardError, SCHEMA_TAGS, type StreamEvent, zBreadboardConfig, type BreadboardConfig } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import type { Principal } from '../core/principal.js';
import type { EventBus } from '../core/services.js';
import { createSyncServer, type HocuspocusSyncServer } from './sync.js';
import { createKnowledgeService, type KnowledgeServiceImpl } from './service.js';

export const DIMS = 64;

export function testSettings(over: Record<string, unknown> = {}): BreadboardConfig {
  return zBreadboardConfig.parse({
    schema: SCHEMA_TAGS.breadboard,
    knowledge: {
      domains: [
        { slug: 'ops', description: 'Operations' },
        { slug: 'data', description: 'Data' },
        { slug: 'secret', description: 'Restricted' },
      ],
      ...((over.knowledge as object) ?? {}),
    },
    knowledge_injection: [{ domain: 'data', trigger: { kind: 'reference-match', pattern: '\\b(?:FROM|JOIN)\\s+(\\w+)' }, inject: { notes_tagged: 'table:$1' }, max_notes: 3 }],
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'knowledge')),
  });
}

/** Deterministic bag-of-words embedding: each word hashes into one of DIMS buckets. */
export function hashEmbed(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2)) {
    const h = createHash('sha1').update(w).digest();
    v[h[0]! % DIMS]! += 1;
  }
  return v;
}

export function fakeGateway(opts: { fail?: boolean } = {}) {
  const calls: string[][] = [];
  return {
    calls,
    async embed(texts: string[]) {
      calls.push(texts);
      if (opts.fail) throw new Error('embedding provider down');
      return { model_id: 'fake-embed', vectors: texts.map(hashEmbed) };
    },
  };
}

export function fakeEvents(): Pick<EventBus, 'publish'> & { published: Array<{ topic: string; payload: any; visibility?: any }> } {
  const published: Array<{ topic: string; payload: any; visibility?: any }> = [];
  return {
    published,
    async publish(topic, payload, visibility) {
      published.push({ topic, payload, visibility });
      return { id: String(published.length), topic, payload, visibility: visibility ?? { scope: 'team' }, at: new Date().toISOString() } as unknown as StreamEvent;
    },
  };
}

export function aiPrincipal(f: Foundation, opts: { read: string[]; write?: string[]; session_id?: string; scopes?: string[] | null }): Principal {
  const session_id = opts.session_id ?? 'SESSION0000000000001';
  return {
    actor: { kind: 'subagent', id: 'writer', session_id },
    team_id: f.team_id,
    user: null,
    roles: [],
    is_admin: false,
    scopes: opts.scopes ?? null,
    grants: {
      subagent_uid: 'writer',
      tools: new Map(),
      mcp: new Map(),
      circuits: { read: new Set(), execute: new Set() },
      knowledge: { read: new Set(opts.read), write: new Set(opts.write ?? []) },
      primitives: new Set(),
      tools_override: null,
    },
    session_id,
    visible_sessions: [session_id],
    config_commit: null,
    execution_key: null,
    token_kind: 'actor',
  };
}

export interface KnowledgeKit {
  f: Foundation;
  sync: HocuspocusSyncServer;
  knowledge: KnowledgeServiceImpl;
  events: ReturnType<typeof fakeEvents>;
  gateway: ReturnType<typeof fakeGateway>;
  tokens: Map<string, Principal>;
  settings: BreadboardConfig;
  close(): Promise<void>;
}

export async function createKnowledgeKit(opts: { settings?: BreadboardConfig; gatewayFail?: boolean; debounceMs?: number } = {}): Promise<KnowledgeKit> {
  const f = await createFoundation();
  const settings = opts.settings ?? testSettings();
  const events = fakeEvents();
  const gateway = fakeGateway({ fail: opts.gatewayFail });
  const tokens = new Map<string, Principal>();
  const auth = {
    async authenticate(token: string | null | undefined) {
      const p = token ? tokens.get(token) : undefined;
      if (!p) throw new BreadboardError('unauthorized', 'bad token');
      return p;
    },
  };
  const sync = createSyncServer({
    db: f.db,
    team_id: f.team_id,
    nodes: f.nodes,
    linkIndexer: f.linkIndexer,
    auth: auth as any,
    events,
    settings: () => settings,
    log: f.log,
    debounceMs: opts.debounceMs ?? 50,
    maxDebounceMs: 200,
    compactIntervalMs: 0,
  });
  const knowledge = createKnowledgeService({ db: f.db, team_id: f.team_id, nodes: f.nodes, linkIndexer: f.linkIndexer, sync, gateway, settings: () => settings, events, log: f.log, embedDebounceMs: 0 });
  return {
    f,
    sync,
    knowledge,
    events,
    gateway,
    tokens,
    settings,
    async close() {
      knowledge.close();
      await sync.stop();
      await f.close();
    },
  };
}
