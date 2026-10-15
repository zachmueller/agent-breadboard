import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BreadboardError, type SessionEvent, type SessionRecord } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import type { Principal } from '../core/principal.js';
import type { Services } from '../core/services.js';
import { createPrimitives } from '../toolbox/primitives.js';
import { register, MCP_PATH } from './http.js';

const ECHO_TOOL = '01J8FQ2ZK7XW9MBT4PVE';

/** Minimal in-memory session store: create / appendEvent / update / events / get. */
function memorySessions(teamId: string) {
  const rows = new Map<string, SessionRecord>();
  const log: SessionEvent[] = [];
  let n = 0;
  const store = {
    rows,
    async create(i: any): Promise<SessionRecord> {
      const id = `sess_${String(++n).padStart(19, '0')}`;
      const r: SessionRecord = { session_id: id, team_id: teamId, kind: i.kind, circuit_uid: null, config_commit: null, task_uid: null, parent_session: null, parent_step_id: null, state: i.state ?? 'queued', state_detail: i.state_detail ?? {}, budget: i.budget, created_at: new Date().toISOString(), started_at: null, ended_at: null };
      (r as any).created_by = i.created_by;
      rows.set(id, r);
      return r;
    },
    async get(id: string) {
      return rows.get(id) ?? null;
    },
    async update(id: string, patch: any) {
      const r = { ...rows.get(id)!, ...patch };
      rows.set(id, r);
      return r;
    },
    async appendEvent(id: string, type: any, payload: any, stepId?: string | null) {
      const e: SessionEvent = { session_id: id, seq: log.filter((x) => x.session_id === id).length + 1, event_type: type, step_id: stepId ?? null, payload, created_at: new Date().toISOString() };
      log.push(e);
      return e;
    },
    async events(id: string): Promise<SessionEvent[]> {
      return log.filter((e) => e.session_id === id);
    },
  };
  return store;
}

let f: Foundation;
let app: FastifyInstance;
let url: URL;
let sessions: ReturnType<typeof memorySessions>;
const invocations: any[] = [];
let principal: Principal;

beforeAll(async () => {
  f = await createFoundation();
  principal = f.memberPrincipal;
  sessions = memorySessions(f.team_id);
  const unimpl = () => {
    throw new BreadboardError('not-implemented');
  };
  const content: any = {
    getNode: async (uid: string) => {
      if (uid === 'MISSING') throw new BreadboardError('not-found', `node ${uid} not found`);
      return { uid, type: 'artifact', title: 'Hello', properties: {}, body: '# hello', body_text: '# hello', crdt: false, tags: ['deliverable'], scope: 'team', head_revision: 1, created_at: '', created_by: { kind: 'service', id: 'x' }, updated_at: '' };
    },
  };
  const toolbox: any = {
    externalTools: async () => [{ commit: 'c', tool: { uid: ECHO_TOOL, slug: 'echo', title: 'Echo', description: 'Echo input', input: { type: 'object', properties: { msg: { type: 'string' } } } } }],
    invoke: async (inv: any) => {
      invocations.push(inv);
      return { output: { echoed: inv.input }, logs: [], execution_key: 'k', replayed: false, cost_units: 0, duration_ms: 1 };
    },
  };
  const proxy = new Proxy({}, { get: () => unimpl });
  const primitives = createPrimitives({
    content,
    knowledge: proxy as any,
    tasks: proxy as any,
    orchestrator: proxy as any,
    sessions: sessions as any,
    evals: proxy as any,
    config: { definition: async (ref: string) => ({ uid: ref, kind: 'tool', raw: 'r' }) } as any,
    toolbox: () => toolbox,
    broker: proxy as any,
    gateway: proxy as any,
    db: f.db,
    log: f.log,
    team_id: f.team_id,
    identity: proxy as any,
    events: proxy as any,
    conversations: () => proxy as any,
    dispatcher: () => proxy as any,
    connectors: () => proxy as any,
    instance: { name: 'agent-breadboard', version: 'test', db: 'pglite', sandbox: 'process', public_url: 'http://localhost:4000' },
  });
  const services = { primitives, toolbox, sessions, log: f.log } as unknown as Services;

  app = Fastify();
  app.decorateRequest('principal', null);
  // Stub auth: any bearer → the member user.
  app.addHook('preHandler', async (req) => {
    if (!req.headers.authorization) throw new BreadboardError('unauthorized', 'missing credentials');
    (req as any).principal = principal;
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof BreadboardError) return reply.status(err.status).send(err.toJSON());
    return reply.status(500).send({ error: { code: 'internal', message: String(err?.message) } });
  });
  await register(app, services);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  url = new URL(`http://127.0.0.1:${addr.port}${MCP_PATH}`);
});

afterAll(async () => {
  await app?.close();
  await f?.close();
});

async function connect(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer member-token' } } });
  const client = new Client({ name: 'test-harness', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

describe('Breadboard MCP over streamable HTTP', () => {
  it('lists primitives + external tools, calls read_node, and logs a conversation session', async () => {
    const { client, transport } = await connect();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('read_node');
    expect(names).toContain('create_task');
    expect(names).toContain('echo');
    expect(names).not.toContain('broker_fetch');
    expect(names).not.toContain('run_tool');

    const res = await client.callTool({ name: 'read_node', arguments: { uid: 'NODE1' } });
    expect(res.isError).toBeFalsy();
    const node = JSON.parse((res.content as any)[0].text);
    expect(node).toMatchObject({ uid: 'NODE1', title: 'Hello', markdown: '# hello' });

    const err = await client.callTool({ name: 'read_node', arguments: { uid: 'MISSING' } });
    expect(err.isError).toBe(true);
    expect(JSON.parse((err.content as any)[0].text)).toMatchObject({ code: 'not-found' });

    const bad = await client.callTool({ name: 'read_node', arguments: {} });
    expect(bad.isError).toBe(true);
    expect(JSON.parse((bad.content as any)[0].text).code).toBe('validation-failed');

    const echo = await client.callTool({ name: 'echo', arguments: { msg: 'hi' } });
    expect(JSON.parse((echo.content as any)[0].text)).toEqual({ echoed: { msg: 'hi' } });
    expect(invocations[0]).toMatchObject({ tool_uid: ECHO_TOOL, input: { msg: 'hi' }, ambient: { invocation: 'mcp-external' } });

    const resource = await client.readResource({ uri: 'breadboard://nodes/NODE2' });
    expect(JSON.parse((resource.contents[0] as any).text)).toMatchObject({ uid: 'NODE2' });

    // A conversation session was created for the connection, with the user actor, and tool calls were logged on it.
    const convo = [...sessions.rows.values()].filter((s) => s.kind === 'conversation');
    expect(convo).toHaveLength(1);
    const s = convo[0]!;
    expect(s.state).toBe('running');
    expect(s.state_detail).toMatchObject({ mcp: true, external: true });
    expect((s as any).created_by).toMatchObject({ kind: 'user', id: f.member.user_id });
    expect(invocations[0].session_id).toBe(s.session_id);
    expect(invocations[0].principal.session_id).toBe(s.session_id);
    const evs = await sessions.events(s.session_id);
    const toolCalls = evs.filter((e) => e.event_type === 'tool-call');
    expect(toolCalls.map((e) => e.payload.name)).toEqual(['read_node', 'read_node', 'read_node', 'echo']);
    expect(toolCalls[0]!.payload.actor).toMatchObject({ kind: 'user', id: f.member.user_id });
    const results = evs.filter((e) => e.event_type === 'tool-result');
    expect(results.map((e) => e.payload.is_error)).toEqual([false, true, true, false]);

    // DELETE ends the MCP session and closes the conversation.
    await transport.terminateSession();
    await client.close();
    expect(sessions.rows.get(s.session_id)!.state).toBe('completed');
  });

  it('tells the harness how to navigate and lists the inspection tools', async () => {
    const { client, transport } = await connect();
    expect(client.getInstructions()).toMatch(/get_breadboard_overview/);
    expect(client.getInstructions()).toMatch(/read_session_transcript/);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['whoami', 'list_sessions', 'read_session_transcript', 'read_session_events', 'inspect_node', 'list_proposals']) expect(names).toContain(n);
    const who = await client.callTool({ name: 'whoami', arguments: {} });
    expect(JSON.parse((who.content as any)[0].text)).toMatchObject({ user: { handle: 'member' }, token_kind: 'user' });
    await transport.terminateSession();
    await client.close();
  });

  it('refuses edge identity: an MCP connection needs an explicit bearer token', async () => {
    const before = principal;
    const sessionsBefore = sessions.rows.size;
    principal = { ...f.memberPrincipal, token_kind: 'proxy' };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer proxy', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
      });
      expect(res.status).toBe(401);
      expect(sessions.rows.size).toBe(sessionsBefore); // refused before a conversation session was opened
    } finally {
      principal = before;
    }
  });

  it('rejects unknown MCP session ids and non-initialize requests without a session', async () => {
    const unknown = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer x', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'nope' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(unknown.status).toBe(404);
    const noSession = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer x', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(noSession.status).toBe(400);
    const unauth = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauth.status).toBe(401);
  });

  it('binds an MCP session to the principal that opened it', async () => {
    const { client, transport } = await connect();
    const sid = transport.sessionId!;
    const before = principal;
    principal = f.adminPrincipal;
    try {
      const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer admin', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) });
      expect(res.status).toBe(403);
    } finally {
      principal = before;
    }
    await client.close();
  });
});
