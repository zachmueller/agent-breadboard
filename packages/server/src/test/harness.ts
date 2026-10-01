/**
 * Shared test harness: a test database + migrations + the foundation stores.
 * Subsystem tests build on this and add their own services; keep it dependency-light.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { SERVICE_ACTOR } from '@breadboard/shared';
import { connectDb, type Db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { NodeStore } from '../content/nodes.js';
import { EdgeStore } from '../content/edges.js';
import { GraphQueries } from '../content/graph-queries.js';
import { LinkIndexer } from '../content/link-indexer.js';
import { IdentityStore, type UserRecord } from '../identity/identity.js';
import { MemoryObjectStore } from '../core/object-store.js';
import { silentLogger } from '../core/logger.js';
import { loadEnv, type Env } from '../core/env.js';
import { userPrincipal, servicePrincipal, type Principal } from '../core/principal.js';

export interface Foundation {
  db: Db;
  team_id: string;
  env: Env;
  log: typeof silentLogger;
  objects: MemoryObjectStore;
  identity: IdentityStore;
  nodes: NodeStore;
  edges: EdgeStore;
  graph: GraphQueries;
  linkIndexer: LinkIndexer;
  admin: UserRecord;
  member: UserRecord;
  adminPrincipal: Principal;
  memberPrincipal: Principal;
  servicePrincipal: Principal;
  close(): Promise<void>;
}

export const TEST_ACTOR = SERVICE_ACTOR('test');

async function onServer(base: string, sql: string): Promise<void> {
  const c = new pg.Client({ connectionString: base });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

/**
 * The database a test runs on: in-memory PGlite by default. With `TEST_DATABASE_URL=postgres://…`, a fresh database
 * on that server per call (created here, dropped by `drop`), so parallel test files never share state.
 */
export async function testDatabaseUrl(): Promise<{ url: string; drop(): Promise<void> }> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return { url: 'pglite://memory', drop: async () => undefined };
  const name = `bb_test_${randomBytes(6).toString('hex')}`;
  await onServer(base, `CREATE DATABASE ${name}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  return { url: url.toString(), drop: () => onServer(base, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`) };
}

/** `connectDb` on `testDatabaseUrl()`; `close()` also drops the database. */
export async function connectTestDb(): Promise<Db> {
  const t = await testDatabaseUrl();
  const db = await connectDb({ url: t.url });
  const close = db.close.bind(db);
  return Object.assign(db, {
    close: async () => {
      await close();
      await t.drop();
    },
  });
}

export async function createFoundation(envOverrides: Record<string, string | boolean | number> = {}): Promise<Foundation> {
  const db = await connectTestDb();
  await migrate(db);
  const identity = new IdentityStore(db);
  const team = await identity.ensureTeam('test-team');
  const nodes = new NodeStore(db, team.team_id);
  const edges = new EdgeStore(db);
  const graph = new GraphQueries(db);
  const linkIndexer = new LinkIndexer(db, edges);
  const admin = await identity.upsertUser({ team_id: team.team_id, handle: 'admin', display_name: 'Admin', is_admin: true });
  const member = await identity.upsertUser({ team_id: team.team_id, handle: 'member', display_name: 'Member', is_admin: false });
  const role = await identity.ensureRole(team.team_id, 'scientist');
  await identity.setMembership(role.role_id, member.user_id, true);
  const env = loadEnv({ DATABASE_URL: 'pglite://memory', MODEL_PROVIDER: 'mock', SANDBOX_RUNNER: 'process', LOG_PRETTY: false, ...envOverrides } as any);
  return {
    db,
    team_id: team.team_id,
    env,
    log: silentLogger,
    objects: new MemoryObjectStore(),
    identity,
    nodes,
    edges,
    graph,
    linkIndexer,
    admin,
    member,
    adminPrincipal: userPrincipal(admin, []),
    memberPrincipal: userPrincipal(member, ['scientist']),
    servicePrincipal: servicePrincipal(team.team_id, 'test'),
    close: () => db.close(),
  };
}
