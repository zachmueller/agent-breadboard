import { describe, expect, it } from 'vitest';
import type { Presets } from '@breadboard/shared';
import { BreadboardError } from '@breadboard/shared';
import { silentLogger } from '../core/logger.js';
import type { ChatMessage } from '../core/services.js';
import { createModelGateway, type FallbackEvent } from './gateway.js';
import { ProviderUnavailableError, isProviderUnavailable } from './errors.js';
import { MOCK_EMBED_DIMS, MockProvider, synthesizeFromSchema } from './mock.js';
import { createProviders } from './index.js';

const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const tool = { name: 'search', description: 's', input_schema: { type: 'object' } };

function presets(p: Partial<Presets> = {}): Presets {
  return {
    schema: 'breadboard/presets@1',
    presets: {
      small: [{ provider: 'mock', model_id: 'm-small-a' }, { provider: 'mock2', model_id: 'm-small-b' }],
      large: [
        { provider: 'mock2', model_id: 'm-large-notools' },
        { provider: 'mock', model_id: 'm-large', pricing: { input_per_m: 1000, output_per_m: 0 } },
      ],
    },
    ...p,
  } as Presets;
}

function setup(p?: Presets) {
  const mock = new MockProvider();
  const mock2 = new MockProvider({ name: 'mock2', capabilities: { 'tool-use': false, 'structured-output': false } });
  const events: FallbackEvent[] = [];
  const gw = createModelGateway({ providers: [mock, mock2], presets: async () => p ?? presets(), log: silentLogger, onFallback: (e) => void events.push(e) });
  return { gw, mock, mock2, events };
}

describe('ModelGateway', () => {
  it('resolves presets in order, with overrides first and capability filtering', async () => {
    const { gw } = setup();
    expect(await gw.resolvePreset('small')).toEqual([
      { provider: 'mock', model_id: 'm-small-a' },
      { provider: 'mock2', model_id: 'm-small-b' },
    ]);
    expect(await gw.resolvePreset('small', ['tool-use'])).toEqual([{ provider: 'mock', model_id: 'm-small-a' }]);
    expect(await gw.resolvePreset('small', undefined, { small: 'm-large' })).toEqual([{ provider: 'mock', model_id: 'm-large' }]);
    await expect(gw.resolvePreset('nope')).rejects.toMatchObject({ code: 'validation-failed' });
  });

  it('skips non-tool-capable candidates when tools are present (no fallback event)', async () => {
    const { gw, mock, mock2, events } = setup();
    const res = await gw.complete({ system: '', preset: 'large', messages: [user('hi')], tools: [tool] });
    expect(res.provider).toBe('mock');
    expect(res.model_id).toBe('m-large');
    expect(res.fallback_from).toBeNull();
    expect(mock2.calls).toHaveLength(0);
    expect(mock.calls).toHaveLength(1);
    expect(events).toHaveLength(0);
    // Without tools the first entry is eligible.
    const plain = await gw.complete({ system: '', preset: 'large', messages: [user('hi')] });
    expect(plain.provider).toBe('mock2');
    expect(plain.message.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('falls back on ProviderUnavailableError, sets fallback_from and records an event', async () => {
    const { gw, mock, mock2, events } = setup();
    mock.enqueue(new ProviderUnavailableError('mock', 'm-small-a', 'throttled'));
    const res = await gw.complete({ system: '', preset: 'small', messages: [user('ping')], session_id: 'S1' });
    expect(res.provider).toBe('mock2');
    expect(res.fallback_from).toBe('m-small-a');
    expect(mock2.calls).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from: 'mock:m-small-a', to: 'mock2:m-small-b', reason: expect.stringContaining('throttled') });
    expect(gw.fallbackEvents()).toHaveLength(1);
  });

  it('falls back on generic errors too, and fails when every candidate fails', async () => {
    const { gw, mock, mock2 } = setup();
    mock.enqueue(new Error('boom'));
    expect((await gw.complete({ system: '', preset: 'small', messages: [user('x')] })).provider).toBe('mock2');
    mock.enqueue(new ProviderUnavailableError('mock', 'm-small-a', 'down'));
    mock2.enqueue(new ProviderUnavailableError('mock2', 'm-small-b', 'down'));
    expect(isProviderUnavailable(await gw.complete({ system: '', preset: 'small', messages: [user('x')] }).catch((e) => e))).toBe(true);
    mock.enqueue(new ProviderUnavailableError('mock', 'm-small-a', 'down'));
    mock2.enqueue(new Error('fatal'));
    await expect(gw.complete({ system: '', preset: 'small', messages: [user('x')] })).rejects.toThrow('fatal');
  });

  it('keeps only the last 100 fallback events', async () => {
    const { gw, mock } = setup();
    for (let i = 0; i < 105; i++) {
      mock.enqueue(new Error(`e${i}`));
      await gw.complete({ system: '', preset: 'small', messages: [user('x')] });
    }
    const ev = gw.fallbackEvents();
    expect(ev).toHaveLength(100);
    expect(ev[ev.length - 1]!.reason).toBe('e104');
  });

  it('honours model_overrides and explicit model_id', async () => {
    const { gw, mock } = setup();
    const res = await gw.complete({ system: '', preset: 'small', messages: [user('x')], model_overrides: { small: 'custom-1' } });
    expect(res.model_id).toBe('custom-1');
    expect(res.provider).toBe('mock');
    const explicit = await gw.complete({ system: '', model_id: 'direct', provider: 'mock2', messages: [user('x')] });
    expect(explicit.provider).toBe('mock2');
    expect(mock.calls.at(-1)!.model_id).toBe('custom-1');
    await expect(gw.complete({ system: '', model_id: 'x', provider: 'openai', messages: [user('x')] })).rejects.toMatchObject({ code: 'validation-failed' });
  });

  it('computes cost from preset pricing, else provider pricing', async () => {
    const { gw, mock } = setup();
    mock.enqueue({ text: 'a', usage: { input_tokens: 1000, output_tokens: 1000 } }, { text: 'b', usage: { input_tokens: 1000, output_tokens: 1000 } });
    const priced = await gw.complete({ system: '', preset: 'large', messages: [user('x')], tools: [tool] });
    expect(priced.cost_usd).toBeCloseTo(1, 9); // 1000 tokens * $1000/M
    const fallbackPrice = await gw.complete({ system: '', preset: 'small', messages: [user('x')] });
    expect(fallbackPrice.cost_usd).toBeCloseTo((1000 * 1 + 1000 * 5) / 1e6, 9); // mock default $1/$5
  });

  it('rejects unknown providers and unsatisfiable requirements', async () => {
    const { gw } = setup(presets({ presets: { only: [{ provider: 'openai', model_id: 'gpt' }], weak: [{ provider: 'mock2', model_id: 'w' }] } as any }));
    await expect(gw.complete({ system: '', preset: 'only', messages: [user('x')] })).rejects.toMatchObject({ code: 'validation-failed' });
    await expect(gw.complete({ system: '', preset: 'weak', messages: [user('x')], tools: [tool] })).rejects.toBeInstanceOf(BreadboardError);
  });

  it('routes every entry to the mock in mock-only mode', async () => {
    const mock = new MockProvider();
    const gw = createModelGateway({ providers: [mock], presets: async () => presets({ presets: { medium: [{ provider: 'bedrock', model_id: 'anthropic.claude-sonnet-5-5' }] } as any }), log: silentLogger });
    const res = await gw.complete({ system: '', preset: 'medium', messages: [user('hello')] });
    expect(res.provider).toBe('mock');
    expect(res.model_id).toBe('anthropic.claude-sonnet-5-5');
    expect(res.message.content).toEqual([{ type: 'text', text: 'hello' }]);
    const e = await gw.embed(['a']);
    expect(e.model_id).toBe('amazon.titan-embed-text-v2:0');
  });

  it('embeds deterministically', async () => {
    const { gw } = setup(presets({ embeddings: { provider: 'mock', model_id: 'emb' } as any }));
    const a = await gw.embed(['hello', 'world']);
    const b = await gw.embed(['hello']);
    expect(a.model_id).toBe('emb');
    expect(a.vectors[0]).toHaveLength(MOCK_EMBED_DIMS);
    expect(a.vectors[0]).toEqual(b.vectors[0]);
    expect(a.vectors[0]).not.toEqual(a.vectors[1]);
    const norm = Math.sqrt(a.vectors[0]!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 9);
  });
});

describe('MockProvider defaults', () => {
  it('synthesizes the finish tool input (exit → first enum) and scripts override', async () => {
    const mock = new MockProvider();
    const finish = { name: 'breadboard_finish', description: '', input_schema: { type: 'object', properties: { exit: { type: 'string', enum: ['approve', 'reject'] }, summary: { type: 'string' }, n: { type: 'integer', minimum: 2 } }, required: ['exit', 'summary', 'n'] } };
    const res = await mock.invoke({ system: '', model_id: 'm', messages: [user('x')], tools: [tool, finish] });
    expect(res.stop_reason).toBe('tool_use');
    expect(res.message.content).toEqual([{ type: 'tool_use', id: 'toolu_mock_0_0', name: 'breadboard_finish', input: { exit: 'approve', summary: 'mock summary', n: 2 } }]);
    mock.script((req) => ({ text: `script:${req.model_id}` }));
    expect((await mock.invoke({ system: '', model_id: 'z', messages: [user('x')] })).message.content).toEqual([{ type: 'text', text: 'script:z' }]);
    expect(synthesizeFromSchema({ $defs: { a: { const: 7 } }, type: 'object', properties: { v: { $ref: '#/$defs/a' } }, required: ['v'] })).toEqual({ v: 7 });
  });

  it('createProviders reflects MODEL_PROVIDER', () => {
    expect(createProviders({ MODEL_PROVIDER: 'mock', AWS_REGION: 'us-east-1' }).map((p) => p.name)).toEqual(['mock']);
    expect(createProviders({ MODEL_PROVIDER: 'bedrock', AWS_REGION: 'us-west-2' }).map((p) => p.name)).toEqual(['bedrock', 'mock']);
  });
});
