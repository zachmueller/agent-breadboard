import { describe, expect, it } from 'vitest';
import { resultText, toBlocks } from './turns.js';

describe('toBlocks', () => {
  it('normalises strings, text parts and Anthropic-style tool blocks', () => {
    expect(toBlocks('hi')).toEqual([{ kind: 'text', text: 'hi' }]);
    expect(toBlocks('')).toEqual([]);
    expect(toBlocks(null)).toEqual([]);
    expect(toBlocks([{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't1', name: 'search', input: { q: 1 } }])).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'tool_use', id: 't1', name: 'search', input: { q: 1 } },
    ]);
    expect(toBlocks([{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: true }])).toEqual([{ kind: 'tool_result', id: 't1', content: 'ok', is_error: true }]);
  });

  it('accepts Bedrock Converse blocks and tool_calls arrays', () => {
    expect(toBlocks([{ toolUse: { toolUseId: 'x', name: 'n', input: {} } }, { toolResult: { toolUseId: 'x', content: [{ text: 'r' }], status: 'error' } }])).toEqual([
      { kind: 'tool_use', id: 'x', name: 'n', input: {} },
      { kind: 'tool_result', id: 'x', content: [{ text: 'r' }], is_error: true },
    ]);
    expect(toBlocks({ role: 'assistant', text: 'lead', tool_calls: [{ id: 'c', name: 'f', arguments: { a: 1 } }] })).toEqual([
      { kind: 'text', text: 'lead' },
      { kind: 'tool_use', id: 'c', name: 'f', input: { a: 1 } },
    ]);
    expect(toBlocks({ kind: 'finish-nudge' })).toEqual([{ kind: 'other', value: { kind: 'finish-nudge' } }]);
  });

  it('resultText flattens strings and text parts only', () => {
    expect(resultText('s')).toBe('s');
    expect(resultText([{ text: 'a' }, { text: 'b' }])).toBe('a\nb');
    expect(resultText({ a: 1 })).toBeNull();
  });
});
