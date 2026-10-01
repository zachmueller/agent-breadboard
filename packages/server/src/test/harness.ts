/**
 * Shared test harness: in-memory PGlite + migrations + the foundation stores.
 * Subsystem tests build on this and add their own services; keep it dependency-light.
 */
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

export async function createFoundation(envOverrides: Record<string, string | boolean | number> = {}): Promise<Foundation> {
  const db = await connectDb({ url: 'pglite://memory' });
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
