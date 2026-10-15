/**
 * The Breadboard MCP server ([11] §4): the primitive catalog (filtered by the principal's grants) plus,
 * for external connections, every tool extension that opts into `exposure.external_mcp` ([06] §8).
 *
 * Tools are served through low-level `tools/list` / `tools/call` handlers because primitive and tool
 * input schemas are plain JSON Schema (the high-level `registerTool` API expects zod shapes), and the
 * external-tool list is dynamic (re-read from config on every `tools/list`).
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BreadboardError, type Tool } from '@breadboard/shared';
import type { Services } from '../core/services.js';
import type { Principal } from '../core/principal.js';

export interface BreadboardMcpServerOptions {
  /** External connection (a user's local harness): appends `external_mcp` tool extensions. */
  external: boolean;
  /** Breadboard session the connection is logged on (`kind: conversation` for external connections). */
  session_id: string;
  /** Record `tool-call` / `tool-result` events on `session_id` (default: true). */
  record_events?: boolean;
}

type McpServices = Pick<Services, 'primitives' | 'toolbox' | 'sessions' | 'log'>;

const MAX_LOGGED_OUTPUT_BYTES = 64 * 1024;

export function createBreadboardMcpServer(services: McpServices, principal: Principal, opts: BreadboardMcpServerOptions): McpServer {
  const mcp = new McpServer({ name: 'agent-breadboard', version: '0.1.0' }, { capabilities: { tools: { listChanged: false }, resources: {} } });
  const record = opts.record_events ?? true;
  let callIndex = 0;

  /** External tool name → tool; primitives win on a slug collision (the tool is then exposed as `tool_<slug>`). */
  async function externalTools(): Promise<Map<string, Tool>> {
    const out = new Map<string, Tool>();
    if (!opts.external) return out;
    const names = new Set(services.primitives.names);
    for (const { tool } of await services.toolbox.externalTools()) {
      const name = names.has(tool.slug) ? `tool_${tool.slug}` : tool.slug;
      if (!out.has(name)) out.set(name, tool);
    }
    return out;
  }

  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Array<{ name: string; description: string; inputSchema: any }> = services.primitives.specsFor(principal).map((s) => ({ name: s.name, description: s.description, inputSchema: s.input_schema }));
    for (const [name, tool] of await externalTools()) {
      tools.push({ name, description: `${tool.title}${tool.description ? ` — ${tool.description}` : ''} (team tool extension ${tool.uid})`, inputSchema: { type: 'object', ...(tool.input as object) } });
    }
    return { tools };
  });

  mcp.server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    const idx = callIndex++;
    if (record) await safeAppend(services, opts.session_id, 'tool-call', { name, input: args, call_index: idx, via: 'mcp', external: opts.external, actor: principal.actor });
    const started = Date.now();
    try {
      let result: unknown;
      if (services.primitives.names.includes(name)) {
        result = await services.primitives.call(name, args, principal, { session_id: opts.session_id, call_index: idx, depth: 0 });
      } else {
        const tool = (await externalTools()).get(name);
        if (!tool) throw new BreadboardError('not-found', `unknown tool '${name}'`);
        const r = await services.toolbox.invoke({
          tool_uid: tool.uid,
          input: args,
          principal,
          ambient: { invocation: 'mcp-external', session_id: opts.session_id },
          session_id: opts.session_id,
          call_index: idx,
        });
        result = r.output;
      }
      if (record) await safeAppend(services, opts.session_id, 'tool-result', { name, call_index: idx, is_error: false, output: clip(result), duration_ms: Date.now() - started });
      return toResult(result);
    } catch (err) {
      const e = toErrorBody(err);
      if (record) await safeAppend(services, opts.session_id, 'tool-result', { name, call_index: idx, is_error: true, error: e, duration_ms: Date.now() - started });
      if (e.code === 'internal') services.log.warn({ err, tool: name }, 'mcp tool call failed');
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(e) }] };
    }
  });

  mcp.registerResource(
    'node',
    new ResourceTemplate('breadboard://nodes/{uid}', { list: undefined }),
    { title: 'Breadboard content node', description: 'A content node (Task, Artifact, Comment, Knowledge Note) by UID — head revision.', mimeType: 'application/json' },
    async (uri, vars) => {
      const node = await services.primitives.call('read_node', { uid: String(vars.uid) }, principal, { session_id: opts.session_id });
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(node) }] };
    },
  );
  mcp.registerResource(
    'config',
    new ResourceTemplate('breadboard://config/{uid}', { list: undefined }),
    { title: 'Breadboard config definition', description: 'A configuration-plane definition (circuit, subagent, tool, MCP onboarding) by UID or slug at main.', mimeType: 'application/json' },
    async (uri, vars) => {
      const def = await services.primitives.call('read_config', { ref: String(vars.uid) }, principal, { session_id: opts.session_id });
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(def) }] };
    },
  );

  return mcp;
}

function toResult(result: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
}

export function toErrorBody(err: unknown): { code: string; message: string; detail?: unknown } {
  if (err instanceof BreadboardError) return { code: err.code, message: err.message, ...(err.detail !== undefined ? { detail: err.detail } : {}) };
  const e = err as { code?: unknown; message?: unknown };
  return { code: typeof e?.code === 'string' && e.code ? e.code : 'internal', message: String(e?.message ?? err) };
}

function clip(v: unknown): unknown {
  const s = JSON.stringify(v ?? null);
  if (s.length <= MAX_LOGGED_OUTPUT_BYTES) return v ?? null;
  return { truncated: true, bytes: s.length, preview: s.slice(0, 2048) };
}

async function safeAppend(services: McpServices, sessionId: string, type: 'tool-call' | 'tool-result', payload: Record<string, unknown>): Promise<void> {
  try {
    await services.sessions.appendEvent(sessionId, type, payload);
  } catch (err) {
    services.log.warn({ err, session_id: sessionId, type }, 'failed to record MCP session event');
  }
}
