/**
 * Toolbox runtime ([06]): sandbox runners, egress proxy, credential broker, execution journal, MCP clients.
 * `build.ts` wires these through the factories below; other subsystems reach them only via `Services`.
 */
import type { BreadboardConfig } from '@breadboard/shared';
import type { Env } from '../core/env.js';
import type { Logger } from '../core/logger.js';
import type { ObjectStore } from '../core/object-store.js';
import type { Db } from '../db/index.js';
import type { SandboxRunner } from '../core/services.js';
import { EgressProxy, type EgressRule } from './egress-proxy.js';
import { DockerSandboxRunner } from './sandbox/docker.js';
import { ProcessSandboxRunner } from './sandbox/process.js';

export interface SandboxDeps {
  log: Logger;
  proxy: EgressProxy | null;
  objects: ObjectStore | null;
  /** Public base URL tool code calls back to (routed through the egress proxy in docker mode). */
  publicUrl: string;
  settings: () => Promise<BreadboardConfig>;
}

/** `SANDBOX_RUNNER=docker` → isolated per-execution containers; `process` → unisolated local fallback (dev/test). */
export function createSandboxRunner(env: Env, deps: SandboxDeps): SandboxRunner {
  if (env.SANDBOX_RUNNER === 'docker') {
    return new DockerSandboxRunner({
      log: deps.log,
      proxy: deps.proxy,
      socket: env.SANDBOX_DOCKER_SOCKET,
      images: async () => (await deps.settings()).sandbox.images,
      warmPoolSize: env.SANDBOX_WARM_POOL_SIZE,
      ociRuntime: env.SANDBOX_OCI_RUNTIME ?? null,
      proxyHost: env.SANDBOX_EGRESS_PROXY_HOST ?? 'host.docker.internal',
      objects: deps.objects,
    });
  }
  return new ProcessSandboxRunner({ log: deps.log, proxy: deps.proxy, apiUrl: deps.publicUrl, pythonBin: env.PYTHON_BIN, objects: deps.objects });
}

/** The Breadboard API host:port as an implicit egress destination ([06] §4). */
export function apiEgressRule(publicUrl: string): EgressRule[] {
  try {
    const u = new URL(publicUrl);
    return [{ host: u.hostname.replace(/^\[|\]$/g, ''), ports: [u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80] }];
  } catch {
    return [];
  }
}

export function createEgressProxy(env: Env, deps: { db: Db | null; log: Logger; publicUrl: string }): EgressProxy {
  return new EgressProxy({ port: env.SANDBOX_EGRESS_PROXY_PORT, db: deps.db, log: deps.log, implicitAllow: apiEgressRule(deps.publicUrl) });
}

export { EgressProxy, hostMatches, ruleAllows, normalizeHost, parseProxyAuthorization, type EgressRule, type EgressRegistration } from './egress-proxy.js';
export { ProcessSandboxRunner, type ProcessSandboxOptions } from './sandbox/process.js';
export { DockerSandboxRunner, buildHostConfig, buildCreateOptions, resourceLimits, SANDBOX_NETWORK, type DockerSandboxOptions } from './sandbox/docker.js';
export { createTar, tarDirectory } from './sandbox/tar.js';
export { CredentialBrokerImpl, createCredentialBroker, checkScope, deriveBrokerKey, type BrokerDeps, type CapabilityScope } from './broker.js';
export { ToolJournal, executionKey, inputHash, canonicalJson } from './journal.js';
export { ToolboxImpl, createToolbox, canInvokeTool, mergeSettings, type ToolboxDeps } from './toolbox.js';
export { McpClientManagerImpl, createMcpClientManager, type McpClientDeps } from './mcp-clients.js';
export { signSigV4 } from './sigv4.js';
