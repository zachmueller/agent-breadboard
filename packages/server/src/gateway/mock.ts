/**
 * Deterministic, scriptable model provider for dev and tests ([docs/architecture.md] "anything needing a model uses
 * the mock provider").
 *
 * Resolution order per call: queued responses (`enqueue`) → script function (`script`) → default behaviour.
 * Default behaviour:
 *   - `force_tool` set (and offered) → call it with an input synthesized from its JSON schema;
 *   - else a `breadboard_finish` tool is offered → call it the same way;
 *   - else echo the last user text (`end_turn`).
 * Usage is ~ceil(chars/4) tokens. `embed` returns deterministic unit-length 64-dim vectors hashed from the text.
 */
import { createHash } from 'node:crypto';
import type { ChatContent, ChatMessage, ModelCapabilities, ModelProvider, ModelRequest, ModelResponse, TokenUsage, ToolSpec } from '../core/services.js';
import { computeCost, lookupPrice, type ModelPrice } from './pricing.js';

type ProviderResponse = Omit<ModelResponse, 'fallback_from' | 'cost_usd'>;
type ProviderRequest = ModelRequest & { model_id: string };

export const FINISH_TOOL_NAME = 'breadboard_finish';
export const MOCK_EMBED_DIMS = 64;

/** What a script/queue entry may return: any part of a response, plus conveniences. */
export type MockReply = Partial<Omit<ProviderResponse, 'message'>> & {
  message?: ChatMessage;
  /** Assistant content blocks (overrides `text`/`tool_calls`). */
  content?: ChatContent[];
  text?: string;
  tool_calls?: Array<{ name: string; input?: unknown; id?: string }>;
};
export type MockScriptFn = (req: ProviderRequest, callIndex: number) => MockReply | Error | null | undefined | Promise<MockReply | Error | null | undefined>;
type QueueEntry = MockReply | Error | MockScriptFn;

export interface MockProviderOptions {
  /** Provider name (default `mock`); register a second instance under another name for multi-provider tests. */
  name?: string;
  /** Capability overrides (all capabilities default to true). */
  capabilities?: Partial<ModelCapabilities> | ((modelId: string) => Partial<ModelCapabilities>);
  /** Price used for cost (default: pricing table for known ids, else $1/$5 per 1M). */
  pricing?: ModelPrice;
  latencyMs?: number;
}

const MOCK_DEFAULT_PRICE: ModelPrice = { input_per_m: 1, output_per_m: 5 };

export class MockProvider implements ModelProvider {
  readonly name: string;
  /** Every request received, in order (tests inspect these). */
  readonly calls: ProviderRequest[] = [];
  private queue: QueueEntry[] = [];
  private scriptFn: MockScriptFn | null = null;
  private readonly opts: MockProviderOptions;

  constructor(opts: MockProviderOptions = {}) {
    this.name = opts.name ?? 'mock';
    this.opts = opts;
  }

  /** Persistent script consulted when the queue is empty; return null/undefined to use the default behaviour. */
  script(fn: MockScriptFn | null): this {
    this.scriptFn = fn;
    return this;
  }

  /** One-shot replies consumed in order. An `Error` entry is thrown; a function entry is evaluated like a script. */
  enqueue(...entries: QueueEntry[]): this {
    this.queue.push(...entries);
    return this;
  }

  reset(): this {
    this.queue = [];
    this.scriptFn = null;
    this.calls.length = 0;
    return this;
  }

  get pending(): number {
    return this.queue.length;
  }

  capabilities(modelId: string): ModelCapabilities {
    const base: ModelCapabilities = { 'tool-use': true, 'structured-output': true, streaming: true, embeddings: true, vision: true, 'prompt-caching': false, reasoning: false, context_tokens: 200_000 };
    const o = typeof this.opts.capabilities === 'function' ? this.opts.capabilities(modelId) : this.opts.capabilities;
    return { ...base, ...(o ?? {}) };
  }

  cost(modelId: string, usage: TokenUsage): number {
    return computeCost(this.opts.pricing ?? lookupPrice(modelId) ?? MOCK_DEFAULT_PRICE, usage);
  }

  async invoke(req: ProviderRequest): Promise<ProviderResponse> {
    const callIndex = this.calls.length;
    this.calls.push(req);
    let reply: MockReply | null | undefined;
    const next = this.queue.shift();
    if (next !== undefined) {
      const r = typeof next === 'function' ? await next(req, callIndex) : next;
      if (r instanceof Error) throw r;
      reply = r;
    } else if (this.scriptFn) {
      const r = await this.scriptFn(req, callIndex);
      if (r instanceof Error) throw r;
      reply = r;
    }
    return this.build(req, reply ?? defaultReply(req), callIndex);
  }

  async *stream(req: ProviderRequest): AsyncIterable<{ type: 'text'; text: string } | { type: 'done'; response: ProviderResponse }> {
    const response = await this.invoke(req);
    for (const c of response.message.content) if (c.type === 'text') yield { type: 'text', text: c.text };
    yield { type: 'done', response };
  }

  async embed(_modelId: string, texts: string[]): Promise<number[][]> {
    return texts.map(mockEmbedding);
  }

  private build(req: ProviderRequest, reply: MockReply, callIndex: number): ProviderResponse {
    let content: ChatContent[];
    if (reply.message) content = reply.message.content;
    else if (reply.content) content = reply.content;
    else {
      content = [];
      if (reply.text !== undefined) content.push({ type: 'text', text: reply.text });
      (reply.tool_calls ?? []).forEach((tc, i) => {
        const spec = req.tools?.find((t) => t.name === tc.name);
        content.push({ type: 'tool_use', id: tc.id ?? `toolu_mock_${callIndex}_${i}`, name: tc.name, input: tc.input ?? (spec ? synthesizeFromSchema(spec.input_schema) : {}) });
      });
    }
    const hasToolUse = content.some((c) => c.type === 'tool_use');
    const inChars = (req.system?.length ?? 0) + JSON.stringify(req.messages).length + (req.tools ? JSON.stringify(req.tools).length : 0);
    const outChars = JSON.stringify(content).length;
    return {
      model_id: reply.model_id ?? req.model_id,
      provider: reply.provider ?? this.name,
      message: { role: 'assistant', content },
      stop_reason: reply.stop_reason ?? (hasToolUse ? 'tool_use' : 'end_turn'),
      usage: reply.usage ?? { input_tokens: Math.max(1, Math.ceil(inChars / 4)), output_tokens: Math.max(1, Math.ceil(outChars / 4)) },
      latency_ms: reply.latency_ms ?? this.opts.latencyMs ?? 0,
    };
  }
}

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    const text = m.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text).join('\n');
    if (text) return text;
  }
  return '';
}

function defaultReply(req: ProviderRequest): MockReply {
  const tools = req.tools ?? [];
  const pick = (name: string | undefined): ToolSpec | undefined => (name ? tools.find((t) => t.name === name) : undefined);
  const tool = pick(req.force_tool) ?? pick(FINISH_TOOL_NAME);
  if (tool) {
    // Realistic dev behaviour: a finish schema that wants artifact refs is satisfied by first creating an
    // artifact through the `create_artifact` primitive (when offered), then filling the refs from its result.
    const refs = collectArtifactRefs(req.messages);
    const creator = pick('create_artifact');
    if (creator && refs.length === 0 && schemaWantsArtifactRef(tool.input_schema)) {
      const topic = lastUserText(req.messages).split('\n').find((l) => l.trim())?.slice(0, 80) ?? 'Mock artifact';
      return { text: 'Creating an artifact for the result.', tool_calls: [{ name: creator.name, input: { title: `Mock: ${topic}`, body: `# ${topic}\n\nGenerated by the mock model provider.\n`, tags: ['deliverable'] } }] };
    }
    return { tool_calls: [{ name: tool.name, input: synthesizeFromSchema(tool.input_schema, tool.input_schema, '', 0, refs) }] };
  }
  return { text: lastUserText(req.messages) };
}

/** Artifact refs returned by earlier tool calls in this conversation (parsed from tool_result JSON). */
export function collectArtifactRefs(messages: ChatMessage[]): Array<{ uid: string; revision_id: number }> {
  const out: Array<{ uid: string; revision_id: number }> = [];
  for (const m of messages) {
    for (const c of m.content) {
      if (c.type !== 'tool_result' || c.is_error) continue;
      try {
        const v = JSON.parse(c.content);
        const cand = v && typeof v === 'object' ? [v, (v as any).ref, (v as any).artifact] : [];
        for (const x of cand) if (x && typeof x.uid === 'string' && /^[0-9A-HJKMNP-TV-Z]{20}$/.test(x.uid)) out.push({ uid: x.uid, revision_id: Number(x.revision_id ?? 1) });
      } catch {}
    }
  }
  return out;
}

function isArtifactRefSchema(schema: any): boolean {
  if (!schema || typeof schema !== 'object') return false;
  if (typeof schema.$ref === 'string' && /artifact-ref$/.test(schema.$ref)) return true;
  const req: string[] = schema.required ?? [];
  return req.includes('uid') && req.includes('revision_id');
}

function schemaWantsArtifactRef(schema: any, depth = 0): boolean {
  if (!schema || typeof schema !== 'object' || depth > 10) return false;
  if (isArtifactRefSchema(schema)) return true;
  for (const key of (schema.required as string[] | undefined) ?? []) if (schemaWantsArtifactRef(schema.properties?.[key], depth + 1)) return true;
  if (schema.items && schemaWantsArtifactRef(schema.items, depth + 1)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Schema-driven input synthesis
// ---------------------------------------------------------------------------
function resolveRef(root: any, ref: string): any {
  if (!ref.startsWith('#/')) return undefined;
  let cur = root;
  for (const part of ref.slice(2).split('/')) {
    if (cur == null) return undefined;
    cur = cur[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return cur;
}

/**
 * Build a value that satisfies a JSON Schema's required structure: required properties filled with type-appropriate
 * placeholders, `enum` → first value (so an `exit` enum picks the first declared exit), `const`/`default` honoured.
 */
export function synthesizeFromSchema(schema: any, root: any = schema, name = '', depth = 0, refs: Array<{ uid: string; revision_id: number }> = []): unknown {
  if (!schema || typeof schema !== 'object' || depth > 12) return null;
  if (refs.length && isArtifactRefSchema(schema)) return refs[refs.length - 1];
  if (refs.length && schema.type === 'array' && isArtifactRefSchema(schema.items)) return refs;
  if (schema.$ref) return synthesizeFromSchema(resolveRef(root, schema.$ref), root, name, depth + 1, refs);
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) return synthesizeFromSchema(schema.oneOf[0], root, name, depth + 1, refs);
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) return synthesizeFromSchema(schema.anyOf[0], root, name, depth + 1, refs);
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    const parts = schema.allOf.map((s: any) => synthesizeFromSchema(s, root, name, depth + 1, refs));
    if (parts.every((x: unknown) => x && typeof x === 'object' && !Array.isArray(x))) return Object.assign({}, ...parts);
    return parts[0];
  }
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((t: string) => t !== 'null') ?? type[0];
  if (!type) type = schema.properties || schema.required ? 'object' : schema.items ? 'array' : 'string';
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const key of (schema.required as string[] | undefined) ?? []) {
        out[key] = synthesizeFromSchema(schema.properties?.[key] ?? {}, root, key, depth + 1, refs);
      }
      return out;
    }
    case 'array': {
      const n = typeof schema.minItems === 'number' ? schema.minItems : 0;
      return Array.from({ length: n }, () => synthesizeFromSchema(schema.items ?? {}, root, name, depth + 1, refs));
    }
    case 'integer':
      return typeof schema.minimum === 'number' ? Math.ceil(schema.minimum) : typeof schema.exclusiveMinimum === 'number' ? Math.floor(schema.exclusiveMinimum) + 1 : 0;
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum + 1 : 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'string':
    default: {
      if (schema.format === 'date-time') return '2026-01-01T00:00:00.000Z';
      if (schema.format === 'date') return '2026-01-01';
      if (schema.format === 'uri' || schema.format === 'url') return 'https://example.com/mock';
      if (schema.format === 'email') return 'mock@example.com';
      let s = name ? `mock ${name}` : 'mock';
      if (typeof schema.minLength === 'number' && s.length < schema.minLength) s = s.padEnd(schema.minLength, 'x');
      if (typeof schema.maxLength === 'number' && s.length > schema.maxLength) s = s.slice(0, schema.maxLength);
      return s;
    }
  }
}

/** Deterministic unit vector from a text hash: identical texts → cosine similarity 1. */
export function mockEmbedding(text: string): number[] {
  const bytes: number[] = [];
  for (let block = 0; bytes.length < MOCK_EMBED_DIMS; block++) {
    bytes.push(...createHash('sha256').update(`${block}:${text}`).digest());
  }
  const v = bytes.slice(0, MOCK_EMBED_DIMS).map((b) => b / 127.5 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
