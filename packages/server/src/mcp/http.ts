/**
 * Streamable HTTP transport for the Breadboard MCP server ([11] §4) at `POST|GET|DELETE /api/v1/mcp`.
 *
 * Authentication is the normal `/api` preHandler (bearer token → Principal). Each MCP session is bound to
 * the user who initialized it and is logged as a Breadboard Session of `kind: conversation` whose tool
 * calls are recorded as `tool-call` / `tool-result` events under the connecting user's actor.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BreadboardError } from '@breadboard/shared';
import type { Services } from '../core/services.js';
import { requireScope, requireUser, type Principal } from '../core/principal.js';
import { principalOf } from '../api/util.js';
import { createBreadboardMcpServer } from './server.js';

export const MCP_PATH = '/api/v1/mcp';
export const MCP_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

interface McpConnection {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  session_id: string;
  actor_key: string;
  last_seen: number;
  closed: boolean;
}

type HttpServices = Pick<Services, 'primitives' | 'toolbox' | 'sessions' | 'log'>;

export interface McpHttpOptions {
  idle_timeout_ms?: number;
  sweep_interval_ms?: number;
}

export async function register(app: FastifyInstance, services: HttpServices, opts: McpHttpOptions = {}): Promise<void> {
  const idleMs = opts.idle_timeout_ms ?? MCP_IDLE_TIMEOUT_MS;
  const connections = new Map<string, McpConnection>();
  await closeOrphans(services);

  async function close(mcpSessionId: string, reason: string): Promise<void> {
    const c = connections.get(mcpSessionId);
    if (!c || c.closed) return;
    c.closed = true;
    connections.delete(mcpSessionId);
    try {
      await c.server.close();
    } catch {
      /* already closed */
    }
    try {
      await services.sessions.update(c.session_id, { state: 'completed', ended_at: new Date().toISOString(), state_detail: { mcp: true, external: true, closed_reason: reason } });
    } catch (err) {
      services.log.warn({ err, session_id: c.session_id }, 'failed to close MCP conversation session');
    }
  }

  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, c] of connections) if (c.last_seen < cutoff) void close(id, 'idle');
  }, opts.sweep_interval_ms ?? 60_000);
  sweep.unref();

  // preClose, not onClose: a connected client holds an SSE stream open, and `app.close()` waits for in-flight
  // requests before onClose hooks run, so closing the connections there would never happen.
  app.addHook('preClose', async () => {
    clearInterval(sweep);
    await Promise.all([...connections.keys()].map((id) => close(id, 'server-shutdown')));
  });

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = principalOf(req);
    // Edge identity (trusted proxy, load balancer) vouches on the strength of browser cookies, which an MCP client
    // never has; refusing it here keeps an edge rule that passes this path through from handing out that identity.
    if (principal.token_kind === 'proxy') throw new BreadboardError('unauthorized', 'MCP connections need an explicit bearer token: mint a personal access token on your Account page');
    requireScope(principal, 'mcp:call');
    const header = req.headers['mcp-session-id'];
    const mcpSessionId = Array.isArray(header) ? header[0] : header;

    if (mcpSessionId) {
      const c = connections.get(mcpSessionId);
      if (!c) return jsonRpcError(reply, 404, -32001, 'MCP session not found');
      if (c.actor_key !== actorKey(principal)) throw new BreadboardError('forbidden', 'MCP session belongs to a different principal');
      c.last_seen = Date.now();
      await delegate(req, reply, c.transport);
      if (req.method === 'DELETE') await close(mcpSessionId, 'client-delete');
      return reply;
    }

    if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
      return jsonRpcError(reply, 400, -32000, 'Bad Request: no valid MCP session id; send an initialize request first');
    }

    // External connections are user connections, logged with the `user` actor ([11] §4).
    requireUser(principal);
    const session = await services.sessions.create({
      kind: 'conversation',
      budget: { max_cost_usd: 0, max_tokens: 0, spent_usd: 0, spent_tokens: 0 },
      created_by: principal.actor,
      state: 'running',
      state_detail: { mcp: true, external: true, client: clientInfo(req.body) },
    });
    await services.sessions.update(session.session_id, { started_at: new Date().toISOString() }).catch(() => undefined);
    const scoped: Principal = { ...principal, session_id: session.session_id, actor: { ...principal.actor, session_id: session.session_id } };
    const server = createBreadboardMcpServer(services, scoped, { external: true, session_id: session.session_id });
    let conn: McpConnection | null = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        conn = { transport, server, session_id: session.session_id, actor_key: actorKey(principal), last_seen: Date.now(), closed: false };
        connections.set(id, conn);
        services.log.info({ mcp_session: id, session_id: session.session_id, actor: principal.actor }, 'MCP connection opened');
      },
      onsessionclosed: (id) => {
        void close(id, 'client-delete');
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) void close(transport.sessionId, 'transport-closed');
    };
    await server.connect(transport);
    await delegate(req, reply, transport);
    if (!conn) {
      // initialize failed: nothing to keep open
      await services.sessions.update(session.session_id, { state: 'cancelled', ended_at: new Date().toISOString() }).catch(() => undefined);
      await server.close().catch(() => undefined);
    }
    return reply;
  };

  app.route({ method: ['POST', 'GET', 'DELETE'], url: MCP_PATH, handler });
}

/** Hand the raw Node request/response to the SDK transport; Fastify has already parsed the JSON body. */
/**
 * Connections live in this process only, so an MCP conversation the database still shows `running` when the
 * endpoint registers was left by an earlier process (a restart that skipped the graceful shutdown, a crash):
 * nothing would ever close it. Other conversations (designer and intake chats) outlive restarts and are untouched.
 */
async function closeOrphans(services: HttpServices): Promise<void> {
  const before = new Date().toISOString();
  let closed = 0;
  try {
    let cursor: string | null = null;
    do {
      const page = await services.sessions.list({ kind: ['conversation'], state: ['running'], created_before: before, cursor, limit: 200 });
      for (const s of page.items) {
        if (s.state_detail?.mcp !== true) continue;
        await services.sessions.update(s.session_id, { state: 'completed', ended_at: before, state_detail: { ...s.state_detail, closed_reason: 'server-restart' } });
        closed++;
      }
      cursor = page.next_cursor;
    } while (cursor);
  } catch (err) {
    services.log.warn({ err }, 'failed to close MCP conversations left by an earlier process');
  }
  if (closed) services.log.info({ closed }, 'closed MCP conversations left by an earlier process');
}

async function delegate(req: FastifyRequest, reply: FastifyReply, transport: StreamableHTTPServerTransport): Promise<void> {
  reply.hijack();
  // Carry headers set by earlier hooks (CORS) onto the raw response.
  for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) reply.raw.setHeader(k, v as any);
  reply.raw.setHeader('access-control-expose-headers', 'mcp-session-id');
  await transport.handleRequest(req.raw, reply.raw, req.method === 'POST' ? req.body : undefined);
}

function jsonRpcError(reply: FastifyReply, status: number, code: number, message: string) {
  return reply.status(status).send({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function actorKey(p: Principal): string {
  return `${p.actor.kind}:${p.actor.id}`;
}

function clientInfo(body: unknown): unknown {
  const info = (body as any)?.params?.clientInfo;
  return info && typeof info === 'object' ? { name: info.name ?? null, version: info.version ?? null } : null;
}
