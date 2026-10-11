/**
 * Service container wiring. Construction order follows the dependency graph; the few cycles
 * (orchestrator ↔ subagent runtime ↔ primitives ↔ evals) are broken with `lazy()` proxies.
 */
import { resolve } from 'node:path';
import { assertProductionSecrets, trustedProxyConfig, type Env } from './env.js';
import type { Logger } from './logger.js';
import type { Services, EventBus, Orchestrator, EvalService } from './services.js';
import { lazy } from './lazy.js';
import { connectDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { FsObjectStore, S3ObjectStore, type ObjectStore } from './object-store.js';
import { IdentityStore } from '../identity/identity.js';
import { NodeStore } from '../content/nodes.js';
import { EdgeStore } from '../content/edges.js';
import { GraphQueries } from '../content/graph-queries.js';
import { LinkIndexer } from '../content/link-indexer.js';
import { createConfigRepo } from '../config/repo.js';
import { createConfigService } from '../config/service.js';
import { seedIfEmpty } from '../config/seed.js';
import { createEventBus } from '../events/bus.js';
import { createModelGateway, createProviders } from '../gateway/index.js';
import { createSessionStore } from '../orchestrator/session-store.js';
import { createOrchestrator } from '../orchestrator/orchestrator.js';
import { createDispatcher } from '../orchestrator/dispatcher.js';
import { createAuthService } from '../auth/service.js';
import { createSyncServer } from '../knowledge/sync.js';
import { createKnowledgeService } from '../knowledge/service.js';
import { createConnectorScheduler } from '../knowledge/connectors.js';
import { createContentService } from '../content/service.js';
import { createTaskService } from '../intake/tasks.js';
import { createConversationService } from '../intake/conversations.js';
import { createEvalService } from '../evals/service.js';
import { createCredentialBroker } from '../toolbox/broker.js';
import { createEgressProxy, createSandboxRunner } from '../toolbox/index.js';
import { createToolbox } from '../toolbox/toolbox.js';
import { createMcpClientManager } from '../toolbox/mcp-clients.js';
import { createPrimitives } from '../toolbox/primitives.js';
import { createSubagentRuntime } from '../subagents/runtime.js';
import { servicePrincipal } from './principal.js';

export interface BuildOptions {
  env: Env;
  log: Logger;
  /** Repo root used to resolve relative paths in env (default: cwd). */
  root?: string;
  /** Skip the egress proxy / sandbox start (tests). */
  startSandbox?: boolean;
}

export interface BuiltServices extends Services {
  timers: NodeJS.Timeout[];
  proxy: import('../toolbox/egress-proxy.js').EgressProxy;
}

export async function buildServices(opts: BuildOptions): Promise<BuiltServices> {
  const { env, log } = opts;
  assertProductionSecrets(env);
  const trustedProxy = trustedProxyConfig(env); // throws on a half-configured or weak trust
  const root = opts.root ?? process.cwd();
  const path = (p: string) => (p.startsWith('pglite://') || /^postgres/.test(p) ? p : resolve(root, p));

  // --- storage ---------------------------------------------------------------------------------
  const dbUrl = env.DATABASE_URL.startsWith('pglite://') && !env.DATABASE_URL.includes('memory') ? `pglite://${resolve(root, env.DATABASE_URL.slice('pglite://'.length))}` : env.DATABASE_URL;
  const db = await connectDb({ url: dbUrl, ssl: env.DATABASE_SSL, sslCaFile: env.DATABASE_SSL_CA_FILE, iamAuth: env.DATABASE_IAM_AUTH, awsRegion: env.AWS_REGION, poolSize: env.DATABASE_POOL_SIZE });
  const mig = await migrate(db, log);
  if (mig.applied.length) log.info({ applied: mig.applied }, 'database migrated');
  const objects: ObjectStore = env.OBJECT_STORE === 's3' && env.OBJECT_STORE_S3_BUCKET ? new S3ObjectStore(env.OBJECT_STORE_S3_BUCKET, env.OBJECT_STORE_S3_PREFIX, env.AWS_REGION) : new FsObjectStore(path(env.OBJECT_STORE_DIR));

  // --- identity + content foundation ---------------------------------------------------------------
  const identity = new IdentityStore(db);
  const team = await identity.ensureTeam('Breadboard');
  const team_id = team.team_id;
  const nodes = new NodeStore(db, team_id);
  const edges = new EdgeStore(db);
  const graph = new GraphQueries(db);
  const linkIndexer = new LinkIndexer(db, edges);

  // --- configuration plane ----------------------------------------------------------------------
  const eventsLazy = lazy<EventBus>('events');
  const configRepo = createConfigRepo({ dir: path(env.CONFIG_REPO_DIR), cacheDir: path(env.CONFIG_WORKTREE_CACHE_DIR), log });
  const seeded = await seedIfEmpty(configRepo, env.CONFIG_SEED_DIR ? path(env.CONFIG_SEED_DIR) : null, log);
  if (seeded.seeded) log.info({ head: seeded.head }, 'config repo seeded');
  let gatewayProviderNames: () => string[] = () => ['bedrock', 'mock'];
  const config = createConfigService({ repo: configRepo, db, team_id, log, events: eventsLazy.proxy, gatewayProviders: () => gatewayProviderNames() });
  const settings = () => config.settings();
  try {
    const s = await settings();
    if (s.team.name && s.team.name !== team.name) await identity.ensureTeam(s.team.name);
  } catch (e) {
    log.error({ err: e }, 'breadboard.yaml failed to load; continuing with defaults');
  }

  // --- events, gateway, sessions, auth ---------------------------------------------------------------
  const sessions = createSessionStore({ db, team_id });
  const events = createEventBus({ db, log, settings, sessions: () => sessions });
  eventsLazy.set(events);
  const providers = createProviders(env, log);
  const gateway = createModelGateway({ providers, presets: () => config.presets(), log, onFallback: (e) => log.warn(e, 'model fallback') });
  // In mock-only mode the gateway routes `provider: bedrock` preset entries to the mock, so the config
  // validator must accept them too (the shipped seed is Bedrock-internal by construction, [05] §4).
  gatewayProviderNames = () => (env.MODEL_PROVIDER === 'mock' ? [...new Set([...gateway.providers(), 'bedrock'])] : gateway.providers());
  const auth = createAuthService({
    db,
    identity,
    team_id,
    settings,
    signingKey: env.TOKEN_SIGNING_KEY,
    publicUrl: env.PUBLIC_URL,
    log,
    sessions: () => sessions,
    rejectWellKnownTokens: env.NODE_ENV === 'production',
    // Unset or empty: disabled (deploy/aws's bootstrapAdmin=false passes an empty value).
    bootstrapAdminToken: env.BREADBOARD_BOOTSTRAP_ADMIN_TOKEN || null,
    trustedProxy,
  });

  // --- knowledge -----------------------------------------------------------------------------------
  const sync = createSyncServer({ db, team_id, nodes, linkIndexer, auth, events, settings, log, onHeadChanged: (uid) => void knowledge.reindexEmbeddings(uid).catch((e) => log.warn({ err: e, uid }, 'embedding reindex failed')) });
  const knowledge = createKnowledgeService({ db, team_id, nodes, linkIndexer, sync, gateway, settings, events, log });

  // --- content + intake ----------------------------------------------------------------------------
  const orchestratorLazy = lazy<Orchestrator>('orchestrator');
  const evalsLazy = lazy<EvalService>('evals');
  const content = createContentService({ db, team_id, nodes, edges, graph, linkIndexer, identity, events, settings, knowledge: () => knowledge, sessions: () => sessions, log, objects, objectThresholdBytes: env.OBJECT_STORE_THRESHOLD_BYTES });
  const tasks = createTaskService({ db, team_id, nodes, edges, graph, content, orchestrator: () => orchestratorLazy.proxy, sessions: () => sessions, config, knowledge: () => knowledge, events, log });

  // --- toolbox -------------------------------------------------------------------------------------
  const broker = await createCredentialBroker({ db, team_id, masterKey: env.BROKER_MASTER_KEY, fallbackKey: env.TOKEN_SIGNING_KEY, log });
  // Tool code reaches the API at SANDBOX_API_URL, which differs from the browser-facing PUBLIC_URL when the server
  // joins the sandbox network under its container name (deploy/sandbox/README.md).
  const sandboxApiUrl = env.SANDBOX_API_URL ?? env.PUBLIC_URL;
  const proxy = createEgressProxy(env, { db, log, publicUrl: sandboxApiUrl });
  const sandbox = createSandboxRunner(env, { log, proxy, objects, publicUrl: sandboxApiUrl, settings });
  const toolbox = createToolbox({ config, sandbox, proxy, auth, objects, db, team_id, publicUrl: sandboxApiUrl, log, settings, pythonBin: env.PYTHON_BIN });
  const mcpClients = createMcpClientManager({ config, broker, log });
  const primitives = createPrimitives({ content, knowledge, tasks, orchestrator: orchestratorLazy.proxy, sessions, evals: evalsLazy.proxy, config, toolbox: () => toolbox, broker, gateway, db, log });
  const subagents = createSubagentRuntime({ config, knowledge, toolbox, mcp: mcpClients, primitives, gateway, sessions, team_id, log });

  // --- orchestrator, evals, conversations --------------------------------------------------------------
  const orchestrator = createOrchestrator({ sessions, config, subagents, toolbox, content, tasks, events, nodes, edges, log, team_id, settings });
  orchestratorLazy.set(orchestrator);
  const evals = createEvalService({ db, team_id, config, orchestrator, sessions, subagents, toolbox, content, events, log });
  evalsLazy.set(evals);
  const conversations = createConversationService({ db, team_id, sessions, config, subagents, content, tasks, events, log, settings });
  const dispatcher = createDispatcher({ sessions, orchestrator, settings, tasks, log });
  const connectors = createConnectorScheduler({ db, team_id, nodes, knowledge, toolbox, config, settings, log, servicePrincipal: servicePrincipal(team_id, 'connector') });

  return {
    env,
    log,
    db,
    team_id,
    objects,
    identity,
    nodes,
    edges,
    graph,
    linkIndexer,
    configRepo,
    config,
    events,
    auth,
    gateway,
    sessions,
    orchestrator,
    dispatcher,
    subagents,
    toolbox,
    sandbox,
    broker,
    mcpClients,
    primitives,
    knowledge,
    sync,
    connectors,
    tasks,
    content,
    evals,
    conversations,
    publicUrl: env.PUBLIC_URL,
    timers: [],
    proxy,
  };
}

/** Start background loops after the HTTP server is listening. */
export async function startBackground(s: BuiltServices): Promise<void> {
  await s.auth.syncLocalUsers();
  s.events.start();
  if (s.env.ORCHESTRATOR_ENABLED) {
    try {
      await s.proxy.start();
    } catch (e) {
      s.log.warn({ err: e }, 'egress proxy failed to start; sandboxed tools cannot reach the network');
    }
    await s.sandbox.start();
    const recovered = await s.orchestrator.recover();
    if (recovered) s.log.info({ recovered }, 'recovered running sessions from checkpoints');
    const evalRuns = await s.evals.recover();
    if (evalRuns) s.log.info({ eval_runs: evalRuns }, 'resumed running eval runs');
    s.dispatcher.start();
  }
  if (s.env.CONNECTORS_ENABLED) s.connectors.start();
  s.timers.push(setInterval(() => void s.configRepo.gcTrees().catch(() => {}), 10 * 60 * 1000));
  s.timers.push(setInterval(() => void s.tasks.archiveStaleDrafts().catch((e) => s.log.warn({ err: e }, 'draft archive failed')), 60 * 60 * 1000));
  for (const t of s.timers) t.unref?.();
}

export async function stopServices(s: BuiltServices): Promise<void> {
  for (const t of s.timers) clearInterval(t);
  s.evals.stop();
  await s.dispatcher.stop().catch(() => {});
  await s.connectors.stop().catch(() => {});
  await s.events.stop().catch(() => {});
  await s.mcpClients.stop().catch(() => {});
  await s.sandbox.stop().catch(() => {});
  await s.proxy.stop().catch(() => {});
  (s.knowledge as any).close?.();
  await s.sync.stop().catch(() => {});
  await s.db.close().catch(() => {});
}
