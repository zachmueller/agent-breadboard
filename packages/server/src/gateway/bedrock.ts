/**
 * AWS Bedrock reference provider ([12] §7): Converse / ConverseStream for chat + tool use, InvokeModel for embeddings.
 * Credentials come from the default AWS credential chain (SigV4); region/endpoint from constructor options.
 *
 * The request/response mapping is exported as pure functions (`toConverseRequest` / `fromConverseResponse`) so it
 * can be unit-tested without AWS.
 */
import { createHash } from 'node:crypto';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ConverseStreamOutput,
  type Message,
  type Tool,
  type ToolChoice,
} from '@aws-sdk/client-bedrock-runtime';
import type { ChatContent, ChatMessage, ModelCapabilities, ModelProvider, ModelRequest, ModelResponse, ReasoningContent, TokenUsage } from '../core/services.js';
import type { Logger } from '../core/logger.js';
import { ProviderUnavailableError, errorMessage } from './errors.js';
import { computeCost, normalizeModelId, priceFor } from './pricing.js';

type ProviderResponse = Omit<ModelResponse, 'fallback_from' | 'cost_usd'>;
type ProviderRequest = ModelRequest & { model_id: string };

// ---------------------------------------------------------------------------
// Model-family heuristics
// ---------------------------------------------------------------------------
export type ModelFamily = 'anthropic' | 'nova' | 'llama' | 'mistral' | 'cohere' | 'titan' | 'other';

export function modelFamily(modelId: string): ModelFamily {
  const id = normalizeModelId(modelId);
  if (id.startsWith('anthropic.') || id.includes('claude')) return 'anthropic';
  if (id.startsWith('amazon.nova') || id.includes('nova-')) return 'nova';
  if (id.startsWith('amazon.titan')) return 'titan';
  if (id.startsWith('meta.') || id.includes('llama')) return 'llama';
  if (id.startsWith('mistral.') || id.includes('mistral') || id.includes('mixtral') || id.includes('pixtral')) return 'mistral';
  if (id.startsWith('cohere.')) return 'cohere';
  return 'other';
}

export function isEmbeddingModel(modelId: string): boolean {
  return /embed/.test(normalizeModelId(modelId));
}

/**
 * Claude models from Opus/Sonnet 5.5 and Fable/Mythos 5.1 onward reject forced `tool_choice` (`any`/`tool`) with a
 * 400; for those the provider sends `auto` plus an explicit instruction naming the tool.
 */
export function supportsForcedToolChoice(modelId: string): boolean {
  const id = normalizeModelId(modelId);
  switch (modelFamily(id)) {
    case 'anthropic': {
      if (/claude-(?:opus|sonnet)-5-[5-9]|claude-(?:fable|mythos)-5-[1-9]/.test(id)) return false;
      const m = /claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)/.exec(id);
      if (m && Number(m[1]) >= 6) return false;
      return true;
    }
    case 'nova':
      return true;
    case 'mistral':
      return true; // via `any` (see toolChoiceFor)
    default:
      return false;
  }
}

/** Newer Claude models reject sampling parameters; only send `temperature` where accepted. */
export function acceptsTemperature(modelId: string): boolean {
  const id = normalizeModelId(modelId);
  if (modelFamily(id) !== 'anthropic') return true;
  if (/claude-3|claude-haiku-4-5|claude-(?:opus|sonnet)-4-[0-6]\b|claude-(?:opus|sonnet)-4(?:-\d{8})?(?:-v|$)/.test(id)) return true;
  return false;
}

/**
 * Output ceiling when the request sets none. Claude models with a 128K output cap (the 4.6+ Opus/Sonnet family and
 * every 5.x model) get 32K: designer chats write whole files into one tool call, and 16K cut those calls off mid-input.
 */
export function defaultMaxTokens(modelId: string): number {
  const id = normalizeModelId(modelId);
  switch (modelFamily(id)) {
    case 'anthropic':
      if (/claude-3-(?:haiku|opus)|claude-3-5/.test(id)) return 4096;
      return /claude-(?:opus|sonnet)-4-[6-9]|claude-(?:opus|sonnet|haiku|fable|mythos)-(?:[5-9]|\d{2,})/.test(id) ? 32000 : 16000;
    case 'nova':
      return 5000;
    case 'llama':
      return 2048;
    case 'mistral':
      return 8192;
    default:
      return 4096;
  }
}

/**
 * How a model reasons: `default-on` models (every Claude 5.x and later) think adaptively whether asked or not, so the
 * provider always asks for summarized reasoning it can show and replay; `opt-in` models (Opus/Sonnet 4.6-4.9) think
 * only when the request sets an effort; `none` models get no reasoning fields at all.
 */
export function reasoningMode(modelId: string): 'default-on' | 'opt-in' | 'none' {
  const id = normalizeModelId(modelId);
  if (modelFamily(id) !== 'anthropic') return 'none';
  if (/claude-(?:opus|sonnet|haiku|fable|mythos)-(?:[5-9]|\d{2,})/.test(id)) return 'default-on';
  if (/claude-(?:opus|sonnet)-4-[6-9]/.test(id)) return 'opt-in';
  return 'none';
}

/** Whether the request runs with thinking on (then forced tool choice and sampling parameters are not sent). */
function thinkingActive(req: Pick<ModelRequest, 'effort'> & { model_id: string }): boolean {
  const mode = reasoningMode(req.model_id);
  return mode === 'default-on' || (mode === 'opt-in' && !!req.effort);
}

/**
 * Models that honour Converse cache points, and where. Claude caches the tool list, the system prompt and any message;
 * Nova caches the system prompt and messages, but rejects a cache point in a message holding tool results ("extraneous
 * key [cachePoint]", verified 2026-10-15).
 */
export function promptCaching(modelId: string): { tools: boolean; toolResults: boolean } | null {
  const id = normalizeModelId(modelId);
  switch (modelFamily(id)) {
    case 'anthropic':
      return /claude-3-(?:haiku|opus|sonnet)|claude-3-5-sonnet|claude-v2|claude-instant/.test(id) ? null : { tools: true, toolResults: true };
    case 'nova':
      return /nova-(?:micro|lite|pro|premier|2)/.test(id) ? { tools: false, toolResults: false } : null;
    default:
      return null;
  }
}

export function bedrockCapabilities(modelId: string): ModelCapabilities {
  const id = normalizeModelId(modelId);
  const none: ModelCapabilities = { 'tool-use': false, 'structured-output': false, streaming: false, embeddings: false, vision: false, 'prompt-caching': false, reasoning: false, context_tokens: 0 };
  if (isEmbeddingModel(id)) {
    return { ...none, embeddings: true, context_tokens: id.startsWith('cohere.') ? 512 : 8192 };
  }
  const caps = (tool: boolean, vision: boolean, context: number): ModelCapabilities => ({
    'tool-use': tool,
    // Structured output is delivered via the forced finish-tool ([03] §10.3), so it tracks tool-use.
    'structured-output': tool,
    streaming: true,
    embeddings: false,
    vision,
    'prompt-caching': promptCaching(id) !== null,
    reasoning: reasoningMode(id) !== 'none',
    context_tokens: context,
  });
  switch (modelFamily(id)) {
    case 'anthropic': {
      const million = /claude-(?:opus|sonnet)-4-[6-9]|claude-(?:opus|sonnet|fable|mythos)-[5-9]/.test(id);
      return caps(!/claude-v2|claude-instant/.test(id), !/claude-v2|claude-instant/.test(id), million ? 1_000_000 : 200_000);
    }
    case 'nova': {
      if (/nova-micro/.test(id)) return caps(true, false, 128_000);
      if (/nova-premier|nova-2-lite|nova-lite-v2/.test(id)) return caps(true, true, 1_000_000);
      return caps(true, true, 300_000);
    }
    case 'llama': {
      const tool = /llama3-[1-9]-|llama[4-9]/.test(id);
      const vision = /llama3-2-(?:11|90)b|llama[4-9]/.test(id);
      const ctx = /llama4-scout/.test(id) ? 3_500_000 : /llama[4-9]/.test(id) ? 1_000_000 : /llama3-[1-9]-/.test(id) ? 128_000 : 8_000;
      return caps(tool, vision, ctx);
    }
    case 'mistral': {
      const tool = /mistral-large|pixtral-large|mistral-small/.test(id);
      return caps(tool, /pixtral/.test(id), /2407|pixtral/.test(id) ? 128_000 : 32_000);
    }
    case 'cohere':
      return caps(/command-r/.test(id), false, 128_000);
    case 'titan':
      return caps(false, false, 8_000);
    default:
      return caps(false, false, 32_000);
  }
}

// ---------------------------------------------------------------------------
// Pure mapping: ChatMessage[] → Converse
// ---------------------------------------------------------------------------
function toolChoiceFor(modelId: string, forceTool: string, toolCount: number): ToolChoice | null {
  if (!supportsForcedToolChoice(modelId)) return null;
  if (modelFamily(modelId) === 'mistral') return toolCount === 1 ? ({ any: {} } as ToolChoice) : null;
  return { tool: { name: forceTool } } as ToolChoice;
}

function forcedToolInstruction(name: string): string {
  return `You must respond by calling the \`${name}\` tool now. Do not reply with plain text.`;
}

/**
 * Tool names as sent to the model. Nova's tool-call grammar fails on names outside `[A-Za-z0-9_]` ("Model produced
 * invalid sequence as part of ToolUse" for `search-scholarly`; verified 2026-10-01), and tool-extension slugs are
 * hyphenated, so Nova gets underscore aliases (deduplicated in tool order). Null for every other model family.
 */
export function toolNameAliases(modelId: string, names: string[]): Map<string, string> | null {
  if (modelFamily(modelId) !== 'nova' || !names.some((n) => /[^A-Za-z0-9_]/.test(n))) return null;
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const name of names) {
    const base = name.replace(/[^A-Za-z0-9_]/g, '_');
    let alias = base;
    for (let i = 2; used.has(alias); i++) alias = `${base}_${i}`;
    used.add(alias);
    out.set(name, alias);
  }
  return out;
}

type Rename = (name: string) => string;
const asIs: Rename = (n) => n;

/**
 * Fingerprint of the prefix a reasoning block is bound to (system prompt + tool specs as sent). A block is replayed
 * only under the same fingerprint, so a changed system prompt (a designer chat whose config moved on) drops the old
 * blocks instead of failing the request.
 */
export function prefixFingerprint(input: Pick<ConverseCommandInput, 'system' | 'toolConfig'>): string {
  return createHash('sha256')
    .update(JSON.stringify({ system: input.system ?? [], tools: input.toolConfig?.tools ?? [] }))
    .digest('hex')
    .slice(0, 16);
}

/** Replay rules for a stored reasoning block: same model, and same prefix when the block recorded one. */
export function replayableReasoning(c: ReasoningContent, modelId: string, prefixFp: string | null): boolean {
  if (normalizeModelId(c.model_id) !== normalizeModelId(modelId)) return false;
  return !c.prefix_fp || !prefixFp || c.prefix_fp === prefixFp;
}

function contentToConverse(c: ChatContent, modelId: string, rename: Rename = asIs, prefixFp: string | null = null): ContentBlock | null {
  switch (c.type) {
    case 'reasoning': {
      if (!replayableReasoning(c, modelId, prefixFp)) return null;
      if (c.redacted) return { reasoningContent: { redactedContent: Uint8Array.from(Buffer.from(c.redacted, 'base64')) } } as ContentBlock;
      return { reasoningContent: { reasoningText: { text: c.text, ...(c.signature ? { signature: c.signature } : {}) } } } as ContentBlock;
    }
    case 'text':
      return c.text.length ? ({ text: c.text } as ContentBlock) : null;
    case 'tool_use':
      return { toolUse: { toolUseId: c.id, name: rename(c.name), input: (c.input ?? {}) as any } } as ContentBlock;
    case 'tool_result': {
      const anthropic = modelFamily(modelId) === 'anthropic';
      const text = c.content.length ? c.content : c.is_error ? 'error' : '(empty)';
      return {
        toolResult: {
          toolUseId: c.tool_use_id,
          content: [{ text: c.is_error && !anthropic ? `ERROR: ${text}` : text }],
          // `status` is only honoured by Claude; others get the error marker in the text.
          ...(c.is_error && anthropic ? { status: 'error' } : {}),
        },
      } as ContentBlock;
    }
  }
}

/**
 * Converse requires alternating user/assistant turns starting with `user`. Our `system`/`tool` roles fold into
 * user turns; consecutive same-role messages merge (tool results first, as Claude requires). Reasoning blocks are
 * replayed verbatim when `replayableReasoning` allows, and dropped otherwise.
 */
export function toConverseMessages(messages: ChatMessage[], modelId: string, rename: Rename = asIs, prefixFp: string | null = null): Message[] {
  const out: Array<{ role: 'user' | 'assistant'; content: ContentBlock[] }> = [];
  for (const m of messages) {
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    let blocks = m.content.map((c) => contentToConverse(c, modelId, rename, prefixFp)).filter((b): b is ContentBlock => b !== null);
    if (m.role === 'system') blocks = blocks.map((b) => ('text' in b && b.text ? ({ text: `[system] ${b.text}` } as ContentBlock) : b));
    if (!blocks.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  }
  for (const m of out) {
    if (m.role === 'user') {
      const results = m.content.filter((b) => 'toolResult' in b && b.toolResult);
      if (results.length && results.length < m.content.length) m.content = [...results, ...m.content.filter((b) => !('toolResult' in b && b.toolResult))];
    }
  }
  if (!out.length || out[0]!.role !== 'user') out.unshift({ role: 'user', content: [{ text: '(conversation start)' } as ContentBlock] });
  return out as Message[];
}

/**
 * Nova reads only `type`, `properties`, and `required` at a tool schema's top level (Nova user guide, "Troubleshooting
 * tool calls"), so local `#/defs/…` and `#/$defs/…` refs are inlined before the other top-level keys are dropped.
 */
export function novaToolSchema(schema: unknown): Record<string, unknown> {
  const root = (schema && typeof schema === 'object' ? schema : {}) as Record<string, any>;
  const defs: Record<string, unknown> = { ...(root.$defs ?? {}), ...(root.defs ?? {}) };
  const inline = (v: unknown, depth: number): unknown => {
    if (Array.isArray(v)) return v.map((x) => inline(x, depth));
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    const m = typeof o.$ref === 'string' ? /^#\/\$?defs\/(.+)$/.exec(o.$ref) : null;
    if (m && defs[m[1]!] !== undefined && depth < 8) {
      const { $ref: _ref, ...rest } = o;
      return inline({ ...(defs[m[1]!] as object), ...rest }, depth + 1);
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, inline(x, depth)]));
  };
  const required = Array.isArray(root.required) && root.required.length ? { required: root.required } : {};
  return { type: 'object', properties: inline(root.properties ?? {}, 0), ...required };
}

const CACHE_POINT = { cachePoint: { type: 'default' } } as const;

/**
 * Converse request for a provider call. Thinking models get adaptive thinking with summarized reasoning (and the
 * request's effort); they are never sent a forced tool choice or sampling parameters, which thinking rejects. Models
 * with prompt caching get cache points after the tools, after the system prompt, and at the end of the history.
 */
export function toConverseRequest(req: ProviderRequest): ConverseCommandInput {
  const modelId = req.model_id;
  const nova = modelFamily(modelId) === 'nova';
  const thinking = thinkingActive(req);
  const caching = promptCaching(modelId);
  const aliases = toolNameAliases(modelId, (req.tools ?? []).map((t) => t.name));
  const rename: Rename = aliases ? (n) => aliases.get(n) ?? n.replace(/[^A-Za-z0-9_]/g, '_') : asIs;
  const system: string[] = [];
  if (req.system?.trim()) system.push(req.system);
  const input: ConverseCommandInput = {
    modelId,
    messages: [],
    inferenceConfig: {
      maxTokens: req.max_tokens ?? defaultMaxTokens(modelId),
      ...(req.temperature !== undefined && !thinking && acceptsTemperature(modelId) ? { temperature: req.temperature } : {}),
    },
  };
  if (req.tools?.length) {
    const tools: Tool[] = req.tools.map((t) => ({
      toolSpec: { name: rename(t.name), description: t.description || t.name, inputSchema: { json: (nova ? novaToolSchema(t.input_schema) : (t.input_schema ?? { type: 'object' })) as any } },
    }));
    if (caching?.tools) tools.push(CACHE_POINT as Tool);
    input.toolConfig = { tools };
    // Nova calls tools reliably only with greedy decoding; otherwise it fails with "Model produced invalid sequence
    // as part of ToolUse" (Nova user guide, "Troubleshooting tool calls").
    if (nova) {
      input.inferenceConfig = { ...input.inferenceConfig, temperature: 0 };
      input.additionalModelRequestFields = { inferenceConfig: { topK: 1 } };
    }
    if (req.force_tool && req.tools.some((t) => t.name === req.force_tool)) {
      const choice = thinking ? null : toolChoiceFor(modelId, rename(req.force_tool), req.tools.length);
      if (choice) input.toolConfig.toolChoice = choice;
      else system.push(forcedToolInstruction(rename(req.force_tool)));
    }
  }
  if (system.length) input.system = [...system.map((text) => ({ text })), ...(caching ? [CACHE_POINT] : [])];
  if (thinking) {
    input.additionalModelRequestFields = { ...(input.additionalModelRequestFields as object | undefined), thinking: { type: 'adaptive', display: 'summarized' } };
    if (req.effort) input.outputConfig = { effort: req.effort };
  }
  input.messages = toConverseMessages(req.messages, modelId, rename, prefixFingerprint(input));
  if (caching) {
    const last = input.messages[input.messages.length - 1];
    const holdsResults = !!last?.content?.some((b) => 'toolResult' in b && b.toolResult);
    if (last?.content?.length && (caching.toolResults || !holdsResults)) last.content = [...last.content, CACHE_POINT as ContentBlock];
  }
  return input;
}

/** Drop every reasoning block from a request's history (recovery when the model rejects replayed reasoning). */
export function withoutReasoning(req: ProviderRequest): ProviderRequest {
  return { ...req, messages: req.messages.map((m) => ({ ...m, content: m.content.filter((c) => c.type !== 'reasoning') })) };
}

/** Downgrade a forced tool choice to `auto` + instruction (used when a model rejects forcing at runtime). */
export function withoutForcedToolChoice(input: ConverseCommandInput, forceTool: string): ConverseCommandInput {
  if (!input.toolConfig?.toolChoice) return input;
  const { toolChoice: _drop, ...toolConfig } = input.toolConfig;
  return { ...input, toolConfig, system: [...(input.system ?? []), { text: forcedToolInstruction(forceTool) }] };
}

// ---------------------------------------------------------------------------
// Pure mapping: Converse → ModelResponse
// ---------------------------------------------------------------------------
export function mapStopReason(r: string | undefined): ModelResponse['stop_reason'] {
  switch (r) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      return 'other';
  }
}

function contentFromConverse(blocks: ContentBlock[], modelId: string, prefixFp: string | null): ChatContent[] {
  const out: ChatContent[] = [];
  const bound = { model_id: modelId, ...(prefixFp ? { prefix_fp: prefixFp } : {}) };
  for (const b of blocks) {
    if ('text' in b && typeof b.text === 'string') {
      if (b.text.length) out.push({ type: 'text', text: b.text });
    } else if ('toolUse' in b && b.toolUse) {
      out.push({ type: 'tool_use', id: b.toolUse.toolUseId ?? '', name: b.toolUse.name ?? '', input: b.toolUse.input ?? {} });
    } else if ('reasoningContent' in b && b.reasoningContent) {
      const r = b.reasoningContent;
      if ('redactedContent' in r && r.redactedContent) out.push({ type: 'reasoning', text: '', redacted: Buffer.from(r.redactedContent).toString('base64'), ...bound });
      else if ('reasoningText' in r && r.reasoningText) out.push({ type: 'reasoning', text: r.reasoningText.text ?? '', ...(r.reasoningText.signature ? { signature: r.reasoningText.signature } : {}), ...bound });
    }
  }
  return out;
}

/** Converse usage → TokenUsage; cache counts appear only when non-zero. */
export function usageFromConverse(u: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number } | undefined): TokenUsage {
  return {
    input_tokens: u?.inputTokens ?? 0,
    output_tokens: u?.outputTokens ?? 0,
    ...(u?.cacheReadInputTokens ? { cache_read_tokens: u.cacheReadInputTokens } : {}),
    ...(u?.cacheWriteInputTokens ? { cache_write_tokens: u.cacheWriteInputTokens } : {}),
  };
}

/**
 * `aliases` (original → sent, from `toolNameAliases`) maps tool calls back to the real tool names. `prefixFp`
 * (from `prefixFingerprint` of the request) is stamped on reasoning blocks so replay can check it.
 */
export function fromConverseResponse(
  out: Pick<ConverseCommandOutput, 'output' | 'stopReason' | 'usage'>,
  modelId: string,
  latencyMs: number,
  provider = 'bedrock',
  aliases: Map<string, string> | null = null,
  prefixFp: string | null = null,
): ProviderResponse {
  const raw = (out.output && 'message' in out.output ? out.output.message?.content : undefined) ?? [];
  const original = aliases ? new Map([...aliases].map(([name, alias]) => [alias, name])) : null;
  const content = contentFromConverse(raw, modelId, prefixFp).map((c) => (original && c.type === 'tool_use' && original.has(c.name) ? { ...c, name: original.get(c.name)! } : c));
  let stop = mapStopReason(out.stopReason);
  if (stop !== 'tool_use' && content.some((c) => c.type === 'tool_use') && stop === 'other') stop = 'tool_use';
  return {
    model_id: modelId,
    provider,
    message: { role: 'assistant', content },
    stop_reason: stop,
    usage: usageFromConverse(out.usage),
    latency_ms: latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------
const RETRYABLE = new Set(['ThrottlingException', 'ServiceUnavailableException', 'ServiceUnavailable', 'ModelNotReadyException', 'InternalServerException', 'ModelTimeoutException', 'TooManyRequestsException']);
/** Not worth retrying, but the model is unusable right now → fall back. */
const UNAVAILABLE = new Set(['ResourceNotFoundException', 'AccessDeniedException', 'ServiceQuotaExceededException']);

export function classifyBedrockError(e: unknown): 'retryable' | 'unavailable' | 'forced-tool-rejected' | 'reasoning-rejected' | 'fatal' {
  const name = (e as { name?: string } | null)?.name ?? '';
  const status = (e as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  if (RETRYABLE.has(name) || status === 429 || status === 503) return 'retryable';
  if (UNAVAILABLE.has(name)) return 'unavailable';
  // A replayed thinking block the model will not accept (bound to another conversation prefix, or a bad signature).
  if (name === 'ValidationException' && /thinking|reasoning/i.test(errorMessage(e)) && /signature|different conversation|block_binding/i.test(errorMessage(e))) return 'reasoning-rejected';
  if (name === 'ValidationException' && /tool_?choice/i.test(errorMessage(e))) return 'forced-tool-rejected';
  if (name === 'ValidationException' && /end of (?:its )?life|deprecated|legacy|not supported for (?:this|on-demand)/i.test(errorMessage(e))) return 'unavailable';
  return 'fatal';
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
export interface BedrockSendClient {
  send(command: any, options?: any): Promise<any>;
}

export interface BedrockProviderOptions {
  region?: string;
  endpoint?: string;
  /** Inject a client (tests). Defaults to a BedrockRuntimeClient using the default AWS credential chain. */
  client?: BedrockSendClient;
  /** Total attempts per call on throttles/outages (default 3). */
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
}

export class BedrockProvider implements ModelProvider {
  readonly name = 'bedrock';
  private readonly client: BedrockSendClient;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log?: Logger;

  constructor(opts: BedrockProviderOptions = {}) {
    // SDK-level retries disabled: this provider owns retry/backoff so the gateway sees one consistent signal.
    this.client = opts.client ?? new BedrockRuntimeClient({ region: opts.region ?? 'us-east-1', ...(opts.endpoint ? { endpoint: opts.endpoint } : {}), maxAttempts: 1 });
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log;
  }

  capabilities(modelId: string): ModelCapabilities {
    return bedrockCapabilities(modelId);
  }

  cost(modelId: string, usage: TokenUsage): number {
    return computeCost(priceFor(modelId), usage);
  }

  /** Run `fn` with bounded retry+backoff; exhausted/unavailable → ProviderUnavailableError. */
  private async withRetry<T>(modelId: string, fn: (attempt: number) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await fn(attempt);
      } catch (e) {
        lastErr = e;
        const kind = classifyBedrockError(e);
        if (kind === 'unavailable') throw new ProviderUnavailableError(this.name, modelId, `${(e as Error).name}: ${errorMessage(e)}`, e);
        if (kind !== 'retryable') throw e;
        if (attempt < this.maxAttempts) {
          const delay = Math.min(this.baseDelayMs * 2 ** (attempt - 1), 8000) * (0.75 + Math.random() * 0.5);
          this.log?.warn({ model_id: modelId, attempt, err: errorMessage(e) }, 'bedrock throttled/unavailable; backing off');
          await this.sleep(delay);
        }
      }
    }
    throw new ProviderUnavailableError(this.name, modelId, `${(lastErr as Error)?.name ?? 'error'} after ${this.maxAttempts} attempts: ${errorMessage(lastErr)}`, lastErr);
  }

  /**
   * Send `input`, recovering once from each request shape a model can reject: a forced tool choice (→ `auto` +
   * instruction) and replayed reasoning (→ the same history without reasoning blocks).
   */
  private async sendWithRecovery<T>(req: ProviderRequest, input: ConverseCommandInput, send: (input: ConverseCommandInput) => Promise<T>): Promise<{ out: T; input: ConverseCommandInput }> {
    const aliases = toolNameAliases(req.model_id, (req.tools ?? []).map((t) => t.name));
    let forcedDowngraded = false;
    let reasoningStripped = false;
    for (;;) {
      try {
        return { out: await send(input), input };
      } catch (e) {
        const kind = classifyBedrockError(e);
        if (kind === 'forced-tool-rejected' && req.force_tool && input.toolConfig?.toolChoice && !forcedDowngraded) {
          this.log?.info({ model_id: req.model_id }, 'model rejected forced tool_choice; retrying with auto + instruction');
          input = withoutForcedToolChoice(input, aliases?.get(req.force_tool) ?? req.force_tool);
          forcedDowngraded = true;
        } else if (kind === 'reasoning-rejected' && !reasoningStripped && req.messages.some((m) => m.content.some((c) => c.type === 'reasoning'))) {
          this.log?.warn({ model_id: req.model_id, err: errorMessage(e) }, 'model rejected replayed reasoning; retrying without reasoning blocks');
          const stripped = toConverseRequest(withoutReasoning(req));
          input = forcedDowngraded ? withoutForcedToolChoice(stripped, aliases?.get(req.force_tool!) ?? req.force_tool!) : stripped;
          reasoningStripped = true;
        } else {
          throw e;
        }
      }
    }
  }

  async invoke(req: ProviderRequest): Promise<ProviderResponse> {
    let input = toConverseRequest(req);
    const aliases = toolNameAliases(req.model_id, (req.tools ?? []).map((t) => t.name));
    const started = Date.now();
    const out: ConverseCommandOutput = await this.withRetry(req.model_id, async () => {
      const sent = await this.sendWithRecovery(req, input, (i) => this.client.send(new ConverseCommand(i)));
      input = sent.input;
      return sent.out;
    });
    return fromConverseResponse(out, req.model_id, Date.now() - started, this.name, aliases, prefixFingerprint(input));
  }

  async *stream(req: ProviderRequest): AsyncIterable<{ type: 'text'; text: string } | { type: 'done'; response: ProviderResponse }> {
    let input = toConverseRequest(req);
    const aliases = toolNameAliases(req.model_id, (req.tools ?? []).map((t) => t.name));
    const started = Date.now();
    // Retries only apply to opening the stream (before any event was yielded).
    const res = await this.withRetry(req.model_id, async () => {
      const sent = await this.sendWithRecovery(req, input, (i) => this.client.send(new ConverseStreamCommand(i)));
      input = sent.input;
      return sent.out;
    });
    const blocks = new Map<number, { text?: string; tool?: { id: string; name: string; json: string }; reasoning?: { text: string; signature?: string; redacted?: Uint8Array } }>();
    let stopReason: string | undefined;
    let usage: ConverseCommandOutput['usage'];
    for await (const ev of (res.stream ?? []) as AsyncIterable<ConverseStreamOutput>) {
      if ('contentBlockStart' in ev && ev.contentBlockStart) {
        const idx = ev.contentBlockStart.contentBlockIndex ?? 0;
        const tu = ev.contentBlockStart.start && 'toolUse' in ev.contentBlockStart.start ? ev.contentBlockStart.start.toolUse : undefined;
        if (tu) blocks.set(idx, { tool: { id: tu.toolUseId ?? '', name: tu.name ?? '', json: '' } });
      } else if ('contentBlockDelta' in ev && ev.contentBlockDelta) {
        const idx = ev.contentBlockDelta.contentBlockIndex ?? 0;
        const d = ev.contentBlockDelta.delta as any;
        const b = blocks.get(idx) ?? {};
        if (typeof d?.text === 'string') {
          b.text = (b.text ?? '') + d.text;
          blocks.set(idx, b);
          yield { type: 'text', text: d.text };
        } else if (d?.toolUse) {
          if (b.tool) b.tool.json += d.toolUse.input ?? '';
          blocks.set(idx, b);
        } else if (d?.reasoningContent) {
          b.reasoning = b.reasoning ?? { text: '' };
          if (typeof d.reasoningContent.text === 'string') b.reasoning.text += d.reasoningContent.text;
          if (typeof d.reasoningContent.signature === 'string') b.reasoning.signature = d.reasoningContent.signature;
          if (d.reasoningContent.redactedContent) b.reasoning.redacted = d.reasoningContent.redactedContent;
          blocks.set(idx, b);
        }
      } else if ('messageStop' in ev && ev.messageStop) {
        stopReason = ev.messageStop.stopReason;
      } else if ('metadata' in ev && ev.metadata) {
        usage = ev.metadata.usage;
      } else {
        const errKey = Object.keys(ev).find((k) => /Exception$/.test(k));
        if (errKey) {
          const err = Object.assign(new Error((ev as any)[errKey]?.message ?? errKey), { name: errKey.charAt(0).toUpperCase() + errKey.slice(1) });
          if (classifyBedrockError(err) !== 'fatal') throw new ProviderUnavailableError(this.name, req.model_id, `stream ${err.name}: ${err.message}`, err);
          throw err;
        }
      }
    }
    const raw: ContentBlock[] = [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => {
        if (b.tool) {
          let parsed: unknown = {};
          try {
            parsed = b.tool.json ? JSON.parse(b.tool.json) : {};
          } catch {
            parsed = { _raw: b.tool.json };
          }
          return { toolUse: { toolUseId: b.tool.id, name: b.tool.name, input: parsed as any } } as ContentBlock;
        }
        if (b.reasoning?.redacted) return { reasoningContent: { redactedContent: b.reasoning.redacted } } as ContentBlock;
        if (b.reasoning) return { reasoningContent: { reasoningText: { text: b.reasoning.text, ...(b.reasoning.signature ? { signature: b.reasoning.signature } : {}) } } } as ContentBlock;
        return { text: b.text ?? '' } as ContentBlock;
      });
    const response = fromConverseResponse(
      { output: { message: { role: 'assistant', content: raw } }, stopReason: stopReason as any, usage },
      req.model_id,
      Date.now() - started,
      this.name,
      aliases,
      prefixFingerprint(input),
    );
    yield { type: 'done', response };
  }

  async embed(modelId: string, texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const id = normalizeModelId(modelId);
    const invoke = async (body: unknown): Promise<any> => {
      const res = await this.withRetry(modelId, () =>
        this.client.send(new InvokeModelCommand({ modelId, contentType: 'application/json', accept: 'application/json', body: new TextEncoder().encode(JSON.stringify(body)) })),
      );
      return JSON.parse(new TextDecoder().decode(res.body));
    };
    if (id.startsWith('cohere.')) {
      const out: number[][] = [];
      const v4 = /embed-v4/.test(id);
      for (let i = 0; i < texts.length; i += 96) {
        const batch = texts.slice(i, i + 96).map((t) => t.slice(0, 20_000));
        const json = await invoke({ texts: batch, input_type: 'search_document', truncate: 'END', ...(v4 ? { embedding_types: ['float'] } : {}) });
        const vecs: number[][] = Array.isArray(json.embeddings) ? json.embeddings : json.embeddings?.float;
        if (!Array.isArray(vecs)) throw new Error(`unexpected Cohere embed response from ${modelId}`);
        out.push(...vecs);
      }
      return out;
    }
    if (/titan-embed/.test(id)) {
      const out: number[][] = [];
      for (const t of texts) {
        const json = await invoke(/v2/.test(id) ? { inputText: t.slice(0, 50_000) || ' ', normalize: true } : { inputText: t.slice(0, 50_000) || ' ' });
        if (!Array.isArray(json.embedding)) throw new Error(`unexpected Titan embed response from ${modelId}`);
        out.push(json.embedding);
      }
      return out;
    }
    throw new ProviderUnavailableError(this.name, modelId, 'not a supported embedding model');
  }
}
