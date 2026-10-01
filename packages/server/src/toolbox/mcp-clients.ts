/**
 * Clients for centrally onboarded MCP servers ([06] §9). Each `config/mcp/<uid>.yaml` server is connected
 * lazily on first use and cached (keyed by its definition, so a changed definition reconnects); a failed call
 * drops the connection and retries once on a fresh one. Credentials come from the broker
 * (`auth.capability`): applied as `Authorization: Bearer …` (or the credential's own headers) for HTTP/SSE,
 * or as an environment variable (`apply: env:<NAME>`) for stdio servers. MCP servers run outside the sandbox.
 */
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { BreadboardError, type McpServer } from '@breadboard/shared';
import type { Logger } from '../core/logger.js';
import type { ConfigService, CredentialBroker, McpClientManager, ToolSpec } from '../core/services.js';

export interface McpClientDeps {
  config: ConfigService;
  broker: CredentialBroker;
  log: Logger;
  clientInfo?: { name: string; version: string };
  /** Per-request timeout for listTools/callTool. */
  requestTimeoutMs?: number;
  /** Injected for tests: build a transport for a server definition. */
  transportFactory?: (def: McpServer, auth: AuthMaterial) => Transport;
}

export interface AuthMaterial {
  headers: Record<string, string>;
  env: Record<string, string>;
}

interface Conn {
  defHash: string;
  def: McpServer;
  client: Client;
  tools: ToolSpec[] | null;
}

/** Translate broker credential material into transport headers/env per the server's `auth.apply`. */
export function authMaterial(def: McpServer, cred: Record<string, string> | null): AuthMaterial {
  const out: AuthMaterial = { headers: {}, env: {} };
  if (!def.auth) return out;
  if (!cred) throw new BreadboardError('invalid-state', `MCP server ${def.slug}: broker capability '${def.auth.capability}' has no credential`);
  const { kind, ...m } = cred;
  const secret = m.token ?? m.value ?? Object.values(m)[0] ?? '';
  const apply = def.auth.apply ?? 'header';
  if (apply.startsWith('env:')) {
    const name = apply.slice(4);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new BreadboardError('validation-failed', `MCP server ${def.slug}: invalid env name in auth.apply '${apply}'`);
    out.env[name] = secret;
    return out;
  }
  if (kind === 'header') Object.assign(out.headers, m);
  else if (kind === 'basic') out.headers.Authorization = `Basic ${Buffer.from(`${m.username}:${m.password}`).toString('base64')}`;
  else out.headers.Authorization = `Bearer ${secret}`;
  return out;
}

/** Server default allowlist ∩ grant allowlist (null grant = server default; undefined server list = all). */
export function filterTools<T extends { name: string }>(tools: T[], serverAllow: string[] | undefined, grantAllow: string[] | null): T[] {
  return tools.filter((t) => (!serverAllow || serverAllow.includes(t.name)) && (grantAllow === null || grantAllow.includes(t.name)));
}

/** Join an MCP CallToolResult's content into text (non-text parts are summarized). */
export function contentText(result: unknown): string {
  const r = result as { content?: Array<Record<string, any>>; structuredContent?: unknown; toolResult?: unknown };
  if (Array.isArray(r?.content)) {
    return r.content
      .map((c) => {
        if (c.type === 'text') return String(c.text ?? '');
        if (c.type === 'resource' && c.resource?.text !== undefined) return String(c.resource.text);
        if (c.type === 'resource_link') return `[resource: ${c.uri}]`;
        if (c.type === 'image' || c.type === 'audio') return `[${c.type}: ${c.mimeType ?? 'binary'}]`;
        return JSON.stringify(c);
      })
      .join('\n');
  }
  if (r?.structuredContent !== undefined) return JSON.stringify(r.structuredContent);
  if (r?.toolResult !== undefined) return typeof r.toolResult === 'string' ? r.toolResult : JSON.stringify(r.toolResult);
  return '';
}

export class McpClientManagerImpl implements McpClientManager {
  private conns = new Map<string, Conn>();
  private connecting = new Map<string, Promise<Conn>>();

  constructor(private deps: McpClientDeps) {}

  private async transport(def: McpServer, auth: AuthMaterial): Promise<Transport> {
    if (this.deps.transportFactory) return this.deps.transportFactory(def, auth);
    switch (def.transport) {
      case 'stdio': {
        if (!def.command) throw new BreadboardError('validation-failed', `MCP server ${def.slug}: stdio transport requires 'command'`);
        return new StdioClientTransport({ command: def.command, args: def.args, env: { ...getDefaultEnvironment(), ...def.env, ...auth.env }, stderr: 'pipe' });
      }
      case 'http': {
        if (!def.endpoint) throw new BreadboardError('validation-failed', `MCP server ${def.slug}: http transport requires 'endpoint'`);
        return new StreamableHTTPClientTransport(new URL(def.endpoint), { requestInit: { headers: auth.headers } });
      }
      case 'sse': {
        if (!def.endpoint) throw new BreadboardError('validation-failed', `MCP server ${def.slug}: sse transport requires 'endpoint'`);
        const headers = auth.headers;
        // The SSE GET stream and the POSTs both go through this fetch, so auth headers apply to both.
        const authedFetch = (url: string | URL, init?: RequestInit) => {
          const h = new Headers(init?.headers);
          for (const [k, v] of Object.entries(headers)) h.set(k, v);
          return fetch(url, { ...init, headers: h });
        };
        return new SSEClientTransport(new URL(def.endpoint), { requestInit: { headers }, fetch: authedFetch });
      }
    }
  }

  private async conn(uid: string, ref?: string): Promise<Conn> {
    const def = await this.deps.config.mcp(uid, ref);
    const defHash = createHash('sha256').update(JSON.stringify(def)).digest('hex');
    const cacheKey = `${uid}:${defHash}`;
    const existing = this.conns.get(uid);
    if (existing?.defHash === defHash) return existing;
    const pending = this.connecting.get(cacheKey);
    if (pending) return pending;
    const p = (async () => {
      if (existing) await this.drop(uid);
      const cred = def.auth ? await this.deps.broker.credentialFor(def.auth.capability) : null;
      const transport = await this.transport(def, authMaterial(def, cred));
      const client = new Client(this.deps.clientInfo ?? { name: 'agent-breadboard', version: '0.1.0' }, { capabilities: {} });
      try {
        await client.connect(transport, { timeout: this.deps.requestTimeoutMs ?? 30_000 });
      } catch (e) {
        await client.close().catch(() => undefined);
        throw new BreadboardError('internal', `MCP server ${def.slug}: connect failed: ${(e as Error).message}`, { server: uid });
      }
      client.onclose = () => {
        if (this.conns.get(uid)?.client === client) this.conns.delete(uid);
      };
      const c: Conn = { defHash, def, client, tools: null };
      this.conns.set(uid, c);
      this.deps.log.info({ server: def.slug, uid, transport: def.transport }, 'MCP server connected');
      return c;
    })().finally(() => this.connecting.delete(cacheKey));
    this.connecting.set(cacheKey, p);
    return p;
  }

  private async drop(uid: string): Promise<void> {
    const c = this.conns.get(uid);
    this.conns.delete(uid);
    if (c) await c.client.close().catch(() => undefined);
  }

  /** Run `fn` on a live connection; on failure drop it and retry once on a fresh connection. */
  private async withConn<T>(uid: string, ref: string | undefined, fn: (c: Conn) => Promise<T>): Promise<T> {
    const c = await this.conn(uid, ref);
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof BreadboardError) throw e;
      this.deps.log.warn({ uid, err: (e as Error).message }, 'MCP call failed; reconnecting');
      await this.drop(uid);
      return fn(await this.conn(uid, ref));
    }
  }

  private async allTools(c: Conn): Promise<ToolSpec[]> {
    if (c.tools) return c.tools;
    const out: ToolSpec[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.client.listTools(cursor ? { cursor } : {}, { timeout: this.deps.requestTimeoutMs ?? 30_000 });
      for (const t of page.tools) out.push({ name: t.name, description: t.description ?? '', input_schema: (t.inputSchema as Record<string, any>) ?? { type: 'object' } });
      cursor = page.nextCursor;
    } while (cursor);
    c.tools = out;
    return out;
  }

  async tools(serverUid: string, allow: string[] | null, ref?: string): Promise<ToolSpec[]> {
    return this.withConn(serverUid, ref, async (c) => filterTools(await this.allTools(c), c.def.tools.allow, allow));
  }

  async call(serverUid: string, toolName: string, args: unknown, ref?: string): Promise<{ content: string; is_error: boolean; raw: unknown }> {
    return this.withConn(serverUid, ref, async (c) => {
      // The server-level default allowlist is enforced here; per-grant narrowing is the caller's (tool surface's) job.
      if (c.def.tools.allow && !c.def.tools.allow.includes(toolName)) {
        throw new BreadboardError('grant-denied', `MCP tool ${toolName} is not in server ${c.def.slug}'s allowlist`, { server: serverUid, tool: toolName });
      }
      const raw = await c.client.callTool({ name: toolName, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { timeout: this.deps.requestTimeoutMs ?? 120_000 });
      return { content: contentText(raw), is_error: (raw as { isError?: boolean }).isError === true, raw };
    });
  }

  async stop(): Promise<void> {
    const uids = [...this.conns.keys()];
    await Promise.allSettled(uids.map((u) => this.drop(u)));
  }
}

export function createMcpClientManager(deps: McpClientDeps): McpClientManagerImpl {
  return new McpClientManagerImpl(deps);
}
