import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../core/services.js';
import {
  BedrockProvider,
  bedrockCapabilities,
  classifyBedrockError,
  fromConverseResponse,
  mapStopReason,
  modelFamily,
  supportsForcedToolChoice,
  toConverseMessages,
  toConverseRequest,
  novaToolSchema,
  toolNameAliases,
} from './bedrock.js';
import { isProviderUnavailable } from './errors.js';
import { DEFAULT_PRICE, computeCost, lookupPrice, normalizeModelId, priceFor } from './pricing.js';

const OPUS5 = 'anthropic.claude-opus-5';
const OPUS55 = 'us.anthropic.claude-opus-5-5';
const finish = { name: 'breadboard_finish', description: 'finish', input_schema: { type: 'object', properties: { exit: { enum: ['done'] } }, required: ['exit'] } };

const awsError = (name: string, message = name, status?: number) => Object.assign(new Error(message), { name, ...(status ? { $metadata: { httpStatusCode: status } } : {}) });

describe('toConverseRequest', () => {
  it('maps system, tool_use/tool_result, tools and forced tool choice', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] },
    ];
    const input = toConverseRequest({ model_id: OPUS5, system: 'be brief', messages, tools: [finish], force_tool: 'breadboard_finish' });
    expect(input.modelId).toBe(OPUS5);
    expect(input.system).toEqual([{ text: 'be brief' }]);
    expect(input.messages).toEqual([
      { role: 'user', content: [{ text: 'hi' }] },
      { role: 'assistant', content: [{ text: 'calling' }, { toolUse: { toolUseId: 't1', name: 'search', input: { q: 'x' } } }] },
      { role: 'user', content: [{ toolResult: { toolUseId: 't1', content: [{ text: 'boom' }], status: 'error' } }] },
    ]);
    expect(input.toolConfig?.tools?.[0]).toEqual({ toolSpec: { name: 'breadboard_finish', description: 'finish', inputSchema: { json: finish.input_schema } } });
    expect(input.toolConfig?.toolChoice).toEqual({ tool: { name: 'breadboard_finish' } });
    expect(input.inferenceConfig?.maxTokens).toBe(16000);
  });

  it('downgrades forcing to an instruction for models that reject forced tool_choice', () => {
    const input = toConverseRequest({ system: '', model_id: OPUS55, messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], tools: [finish], force_tool: 'breadboard_finish' });
    expect(input.toolConfig?.toolChoice).toBeUndefined();
    expect(input.system?.[0]).toMatchObject({ text: expect.stringContaining('`breadboard_finish`') });
  });

  it('drops temperature on newer Claude models and keeps it elsewhere', () => {
    const m: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }];
    expect(toConverseRequest({ system: '', model_id: OPUS55, messages: m, temperature: 0.2 }).inferenceConfig?.temperature).toBeUndefined();
    expect(toConverseRequest({ system: '', model_id: 'amazon.nova-pro-v1:0', messages: m, temperature: 0.2 }).inferenceConfig?.temperature).toBe(0.2);
  });

  it('uses greedy decoding and top-level-only tool schemas for Nova tool calls', () => {
    const m: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }];
    const schema = {
      type: 'object',
      required: ['exit', 'output'],
      additionalProperties: false,
      properties: { exit: { type: 'string' }, output: { type: 'object', properties: { a: { $ref: '#/defs/ref', description: 'the ref' } } } },
      defs: { ref: { type: 'object', required: ['uid'], properties: { uid: { type: 'string' } } } },
    };
    const tools = [{ name: 'breadboard_finish', description: 'finish', input_schema: schema }];
    const nova = toConverseRequest({ system: '', model_id: 'us.amazon.nova-pro-v1:0', messages: m, tools, temperature: 0.7 });
    expect(nova.inferenceConfig?.temperature).toBe(0);
    expect(nova.additionalModelRequestFields).toEqual({ inferenceConfig: { topK: 1 } });
    const json = nova.toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json as any;
    expect(Object.keys(json).sort()).toEqual(['properties', 'required', 'type']);
    expect(json.properties.output.properties.a).toEqual({ type: 'object', required: ['uid'], properties: { uid: { type: 'string' } }, description: 'the ref' });
    // Claude keeps the schema as given and gets no Nova-specific fields; Nova without tools keeps its temperature.
    const claude = toConverseRequest({ system: '', model_id: OPUS5, messages: m, tools });
    expect(claude.toolConfig?.tools?.[0]?.toolSpec?.inputSchema?.json).toEqual(schema);
    expect(claude.additionalModelRequestFields).toBeUndefined();
    expect(toConverseRequest({ system: '', model_id: 'us.amazon.nova-pro-v1:0', messages: m, temperature: 0.7 }).inferenceConfig?.temperature).toBe(0.7);
    expect(novaToolSchema(undefined)).toEqual({ type: 'object', properties: {} });
  });

  it('aliases hyphenated tool names for Nova and maps tool calls back', () => {
    const NOVA = 'us.amazon.nova-pro-v1:0';
    const tools = [
      { name: 'search-scholarly', description: 's', input_schema: { type: 'object', properties: {} } },
      { name: 'search_scholarly', description: 'clash', input_schema: { type: 'object', properties: {} } },
      { name: 'breadboard_finish', description: 'f', input_schema: { type: 'object', properties: {} } },
    ];
    const aliases = toolNameAliases(NOVA, tools.map((t) => t.name))!;
    expect([...aliases]).toEqual([['search-scholarly', 'search_scholarly'], ['search_scholarly', 'search_scholarly_2'], ['breadboard_finish', 'breadboard_finish']]);
    expect(toolNameAliases(OPUS5, tools.map((t) => t.name))).toBeNull();
    expect(toolNameAliases(NOVA, ['breadboard_finish'])).toBeNull();
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search-scholarly', input: { query: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '[]' }] },
    ];
    const input = toConverseRequest({ system: '', model_id: NOVA, messages, tools, force_tool: 'search-scholarly' });
    expect(input.toolConfig?.tools?.map((t) => t.toolSpec?.name)).toEqual(['search_scholarly', 'search_scholarly_2', 'breadboard_finish']);
    expect(input.toolConfig?.toolChoice).toEqual({ tool: { name: 'search_scholarly' } });
    expect((input.messages?.[1]?.content?.[0] as any).toolUse.name).toBe('search_scholarly');
    const res = fromConverseResponse(
      { output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 't2', name: 'search_scholarly', input: { query: 'y' } } }] } }, stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      NOVA,
      5,
      'bedrock',
      aliases,
    );
    expect(res.message.content).toEqual([{ type: 'tool_use', id: 't2', name: 'search-scholarly', input: { query: 'y' } }]);
    expect((res.message as any).bedrock_raw.content[0].toolUse.name).toBe('search_scholarly'); // replayed to Nova as sent
  });

  it('marks non-Claude tool errors in text instead of status', () => {
    const [, , user] = toConverseMessages(
      [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
        { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't', content: 'bad', is_error: true }] },
      ],
      'amazon.nova-pro-v1:0',
    );
    expect(user).toEqual({ role: 'user', content: [{ toolResult: { toolUseId: 't', content: [{ text: 'ERROR: bad' }] } }] });
  });

  it('merges same-role turns, folds system/tool roles, puts tool results first, starts with user', () => {
    const out = toConverseMessages(
      [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'x', input: {} }] },
        { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
        { role: 'system', content: [{ type: 'text', text: 'note' }] },
        { role: 'user', content: [{ type: 'text', text: '' }] },
      ],
      OPUS5,
    );
    expect(out[0]).toEqual({ role: 'user', content: [{ text: '(conversation start)' }] });
    expect(out[1]!.role).toBe('assistant');
    expect(out[2]).toEqual({ role: 'user', content: [{ toolResult: { toolUseId: 'a', content: [{ text: 'ok' }] } }, { text: '[system] note' }] });
    expect(out).toHaveLength(3);
  });
});

describe('fromConverseResponse', () => {
  it('maps text + toolUse back, keeps raw blocks (incl. reasoning) for same-model replay', () => {
    const res = fromConverseResponse(
      {
        output: { message: { role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: 'think', signature: 'sig' } } } as any, { text: 'ok' }, { toolUse: { toolUseId: 'tu', name: 'search', input: { q: 1 } } }] } },
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
      OPUS5,
      42,
    );
    expect(res.message.content).toEqual([{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu', name: 'search', input: { q: 1 } }]);
    expect(res.stop_reason).toBe('tool_use');
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(res.latency_ms).toBe(42);
    expect(Object.keys(res.message)).toEqual(['role', 'content']); // raw is non-enumerable
    const replay = toConverseMessages([{ role: 'user', content: [{ type: 'text', text: 'q' }] }, res.message], OPUS5);
    expect(replay[1]!.content).toHaveLength(3);
    const other = toConverseMessages([{ role: 'user', content: [{ type: 'text', text: 'q' }] }, res.message], 'amazon.nova-pro-v1:0');
    expect(other[1]!.content).toHaveLength(2); // reasoning dropped for a different model
  });

  it('maps stop reasons', () => {
    expect(mapStopReason('end_turn')).toBe('end_turn');
    expect(mapStopReason('model_context_window_exceeded')).toBe('max_tokens');
    expect(mapStopReason('guardrail_intervened')).toBe('other');
  });
});

describe('capabilities, families, errors', () => {
  it('derives capabilities by family', () => {
    expect(modelFamily(OPUS55)).toBe('anthropic');
    expect(bedrockCapabilities(OPUS55)).toMatchObject({ 'tool-use': true, vision: true, context_tokens: 1_000_000, embeddings: false });
    expect(bedrockCapabilities('amazon.nova-micro-v1:0')).toMatchObject({ 'tool-use': true, vision: false });
    expect(bedrockCapabilities('amazon.titan-embed-text-v2:0')).toMatchObject({ 'tool-use': false, embeddings: true });
    expect(bedrockCapabilities('meta.llama3-8b-instruct-v1:0')['tool-use']).toBe(false);
    expect(supportsForcedToolChoice(OPUS5)).toBe(true);
    expect(supportsForcedToolChoice(OPUS55)).toBe(false);
    expect(supportsForcedToolChoice('anthropic.claude-fable-5-1')).toBe(false);
  });

  it('classifies Bedrock errors', () => {
    expect(classifyBedrockError(awsError('ThrottlingException'))).toBe('retryable');
    expect(classifyBedrockError(awsError('ServiceUnavailableException'))).toBe('retryable');
    expect(classifyBedrockError(awsError('Unknown', 'x', 429))).toBe('retryable');
    expect(classifyBedrockError(awsError('AccessDeniedException'))).toBe('unavailable');
    expect(classifyBedrockError(awsError('ValidationException', 'tool_choice is not supported'))).toBe('forced-tool-rejected');
    expect(classifyBedrockError(awsError('ValidationException', 'malformed input'))).toBe('fatal');
  });
});

describe('BedrockProvider (fake client)', () => {
  const ok = { output: { message: { role: 'assistant', content: [{ text: 'hello' }] } }, stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 100 } };
  const req = { system: '', model_id: OPUS5, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }] };

  it('retries throttles with backoff, then succeeds', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const p = new BedrockProvider({ client: { send: async () => (++n < 3 ? Promise.reject(awsError('ThrottlingException')) : ok) }, sleep: async (ms) => void sleeps.push(ms) });
    const res = await p.invoke(req);
    expect(n).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(res.message.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(p.cost(OPUS5, res.usage)).toBeCloseTo((1000 * 5 + 100 * 25) / 1e6, 9);
  });

  it('surfaces ProviderUnavailableError after 3 attempts', async () => {
    let n = 0;
    const p = new BedrockProvider({ client: { send: async () => Promise.reject(awsError('ServiceUnavailableException')) }, sleep: async () => void n++ });
    const err = await p.invoke(req).catch((e) => e);
    expect(isProviderUnavailable(err)).toBe(true);
    expect(n).toBe(2);
  });

  it('rethrows fatal errors without retry', async () => {
    let n = 0;
    const p = new BedrockProvider({ client: { send: async () => (n++, Promise.reject(awsError('ValidationException', 'bad'))) }, sleep: async () => {} });
    const err = await p.invoke(req).catch((e) => e);
    expect(isProviderUnavailable(err)).toBe(false);
    expect(n).toBe(1);
  });

  it('retries once with auto tool choice when forcing is rejected', async () => {
    const inputs: any[] = [];
    const p = new BedrockProvider({
      client: { send: async (cmd: any) => (inputs.push(cmd.input), inputs.length === 1 ? Promise.reject(awsError('ValidationException', 'toolChoice not supported')) : ok) },
      sleep: async () => {},
    });
    await p.invoke({ ...req, tools: [finish], force_tool: 'breadboard_finish' });
    expect(inputs[0].toolConfig.toolChoice).toEqual({ tool: { name: 'breadboard_finish' } });
    expect(inputs[1].toolConfig.toolChoice).toBeUndefined();
  });

  it('embeds with Titan v2 (one call per text) and Cohere (batched)', async () => {
    const bodies: any[] = [];
    const p = new BedrockProvider({
      client: {
        send: async (cmd: any) => {
          const body = JSON.parse(new TextDecoder().decode(cmd.input.body));
          bodies.push({ modelId: cmd.input.modelId, body });
          const out = cmd.input.modelId.startsWith('cohere') ? { embeddings: { float: body.texts.map(() => [1, 0]) } } : { embedding: [0, 1] };
          return { body: new TextEncoder().encode(JSON.stringify(out)) };
        },
      },
    });
    expect(await p.embed('amazon.titan-embed-text-v2:0', ['a', 'b'])).toEqual([[0, 1], [0, 1]]);
    expect(bodies[0].body).toEqual({ inputText: 'a', normalize: true });
    expect(await p.embed('cohere.embed-v4:0', ['a', 'b'])).toEqual([[1, 0], [1, 0]]);
    expect(bodies[2].body).toMatchObject({ texts: ['a', 'b'], input_type: 'search_document', embedding_types: ['float'] });
  });
});

describe('pricing', () => {
  it('normalizes ids and falls back conservatively', () => {
    expect(normalizeModelId('arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-opus-5-5')).toBe('anthropic.claude-opus-5-5');
    expect(lookupPrice(OPUS55)).toEqual({ input_per_m: 4, output_per_m: 20 });
    expect(lookupPrice('anthropic.claude-sonnet-4-6')).toEqual({ input_per_m: 3, output_per_m: 15 });
    expect(priceFor('vendor.unknown-model')).toEqual(DEFAULT_PRICE);
    expect(priceFor(OPUS55, { input_per_m: 1, output_per_m: 1 })).toEqual({ input_per_m: 1, output_per_m: 1 });
    expect(computeCost({ input_per_m: 2, output_per_m: 10 }, { input_tokens: 1_000_000, output_tokens: 500_000 })).toBe(7);
  });
});
