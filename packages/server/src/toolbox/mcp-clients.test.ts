import { describe, it, expect, afterEach } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BreadboardError, mintUid, zMcpServer, type McpServer } from '@breadboard/shared';
import { silentLogger } from '../core/logger.js';
import type { CredentialBroker } from '../core/services.js';
import { authMaterial, contentText, createMcpClientManager, filterTools, type McpClientManagerImpl } from './mcp-clients.js';
import { fakeConfig } from './test-helpers.js';

function def(patch: Partial<McpServer> = {}): McpServer {
  return zMcpServer.parse({ schema: 'breadboard/mcp@v1', uid: mintUid(), slug: 'demo', title: 'Demo', transport: 'stdio', command: 'unused', ...patch });
}

/** A low-level MCP server exposing three tools, connected over an in-memory transport pair. */
function demoServer(stats: { connects: number; calls: string[] }) {
  const server = new Server({ name: 'demo', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ['echo', 'fail', 'secret'].map((name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } } } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    stats.calls.push(req.params.name);
    if (req.params.name === 'fail') return { content: [{ type: 'text' as const, text: 'it broke' }], isError: true };
    return { content: [{ type: 'text' as const, text: `echo: ${(req.params.arguments as any)?.text}` }, { type: 'text' as const, text: 'line 2' }] };
  });
  const [client, srv] = InMemoryTransport.createLinkedPair();
  stats.connects++;
  void server.connect(srv);
  return client;
}

const broker = { credentialFor: async () => ({ kind: 'bearer', token: 'tok' }) } as unknown as CredentialBroker;
let mgr: McpClientManagerImpl | null = null;
afterEach(async () => {
  await mgr?.stop();
  mgr = null;
});

describe('MCP client helpers', () => {
  it('filters tools by server allowlist ∩ grant allowlist', () => {
    const t = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    expect(filterTools(t, undefined, null).map((x) => x.name)).toEqual(['a', 'b', 'c']);
    expect(filterTools(t, ['a', 'b'], null).map((x) => x.name)).toEqual(['a', 'b']);
    expect(filterTools(t, ['a', 'b'], ['b', 'c']).map((x) => x.name)).toEqual(['b']);
    expect(filterTools(t, undefined, []).map((x) => x.name)).toEqual([]);
  });

  it('applies broker credentials as headers or env', () => {
    expect(authMaterial(def(), null)).toEqual({ headers: {}, env: {} });
    expect(authMaterial(def({ auth: { capability: 'c', apply: 'header' } }), { kind: 'bearer', token: 't' })).toEqual({ headers: { Authorization: 'Bearer t' }, env: {} });
    expect(authMaterial(def({ auth: { capability: 'c', apply: 'header' } }), { kind: 'header', 'X-Key': 'k' }).headers).toEqual({ 'X-Key': 'k' });
    expect(authMaterial(def({ auth: { capability: 'c', apply: 'header' } }), { kind: 'basic', username: 'u', password: 'p' }).headers.Authorization).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`,
    );
    expect(authMaterial(def({ auth: { capability: 'c', apply: 'env:GITHUB_TOKEN' } }), { kind: 'bearer', token: 't' })).toEqual({ headers: {}, env: { GITHUB_TOKEN: 't' } });
    expect(() => authMaterial(def({ auth: { capability: 'c', apply: 'env:BAD-NAME' } }), { kind: 'bearer', token: 't' })).toThrow(BreadboardError);
    expect(() => authMaterial(def({ auth: { capability: 'c', apply: 'header' } }), null)).toThrow(/has no credential/);
  });

  it('joins content parts into text', () => {
    expect(contentText({ content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png', data: '' }, { type: 'resource', resource: { uri: 'x', text: 'r' } }] })).toBe('a\n[image: image/png]\nr');
    expect(contentText({ structuredContent: { x: 1 } })).toBe('{"x":1}');
  });
});

describe('McpClientManagerImpl (in-memory MCP server)', () => {
  it('connects lazily, lists filtered tools, calls tools, caches the connection, and enforces the server allowlist', async () => {
    const d = def({ tools: { allow: ['echo', 'fail'] }, auth: { capability: 'demo-cap', apply: 'header' } });
    const stats = { connects: 0, calls: [] as string[] };
    const seenAuth: unknown[] = [];
    mgr = createMcpClientManager({
      config: fakeConfig({ mcp: [d] }),
      broker,
      log: silentLogger,
      transportFactory: (_def, auth) => {
        seenAuth.push(auth);
        return demoServer(stats);
      },
    });
    expect(stats.connects).toBe(0);
    expect((await mgr.tools(d.uid, null)).map((t) => t.name)).toEqual(['echo', 'fail']);
    expect((await mgr.tools(d.uid, ['fail', 'secret'])).map((t) => t.name)).toEqual(['fail']);
    expect(seenAuth).toEqual([{ headers: { Authorization: 'Bearer tok' }, env: {} }]);

    expect(await mgr.call(d.uid, 'echo', { text: 'hi' })).toMatchObject({ content: 'echo: hi\nline 2', is_error: false });
    expect(await mgr.call(d.uid, 'fail', {})).toMatchObject({ content: 'it broke', is_error: true });
    await expect(mgr.call(d.uid, 'secret', {})).rejects.toMatchObject({ code: 'grant-denied' });
    expect(stats.calls).toEqual(['echo', 'fail']);
    expect(stats.connects).toBe(1);
  });

  it('reconnects after the connection closes', async () => {
    const d = def();
    const stats = { connects: 0, calls: [] as string[] };
    const transports: InMemoryTransport[] = [];
    mgr = createMcpClientManager({
      config: fakeConfig({ mcp: [d] }),
      broker,
      log: silentLogger,
      transportFactory: () => {
        const t = demoServer(stats);
        transports.push(t);
        return t;
      },
    });
    await mgr.call(d.uid, 'echo', { text: '1' });
    await transports[0]!.close();
    expect(await mgr.call(d.uid, 'echo', { text: '2' })).toMatchObject({ content: 'echo: 2\nline 2' });
    expect(stats.connects).toBe(2);
  });
});
