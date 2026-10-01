import { describe, it, expect } from 'vitest';
import { uidFromChanges, matchesQuery } from '../inventory';

describe('uidFromChanges', () => {
  it('reads the uid from the definition root path', () => {
    expect(uidFromChanges([{ path: 'circuits/01J8CRCT0000000000A1/prompts/draft.md', content: '' }, { path: 'circuits/01J8CRCT0000000000A1/circuit.yaml', content: '' }], 'circuit')).toBe('01J8CRCT0000000000A1');
    expect(uidFromChanges([{ path: 'subagents/01J8SAEVA1JVDGE00000.yaml', content: '' }], 'subagent')).toBe('01J8SAEVA1JVDGE00000');
    expect(uidFromChanges([{ path: 'mcp/01J8MCP000000000SRCH.yaml', content: '' }], 'mcp')).toBe('01J8MCP000000000SRCH');
  });
  it('returns null without a uid-bearing path', () => {
    expect(uidFromChanges([{ path: 'tenets.md', content: '' }], 'tool')).toBeNull();
  });
});

describe('matchesQuery', () => {
  it('requires every term somewhere in the fields', () => {
    expect(matchesQuery('', 'x')).toBe(true);
    expect(matchesQuery('lit rev', 'lit-review', 'Literature review')).toBe(true);
    expect(matchesQuery('lit xyz', 'lit-review')).toBe(false);
    expect(matchesQuery('smoke', 'a', ['regression', 'smoke'])).toBe(true);
  });
});
