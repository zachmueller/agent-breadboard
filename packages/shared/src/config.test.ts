import { describe, it, expect } from 'vitest';
import { parseConfigYaml, parseConfigPath, definitionPath, knowledgeTokens } from './config/index.js';
import { validateAgainst, schemaRequiredSubset } from './json-schema.js';
import { needInputTags, requestTargetsUser } from './need-input.js';

const circuitYaml = `
schema: breadboard/circuit@v1
uid: 01J8C1RCV1TREV000000
slug: lit-review
title: Literature review
exits:
  - name: done
    output: { type: object, required: [summary_artifact], properties: { summary_artifact: { $ref: "#/defs/artifact-ref" } } }
entry: gather
steps:
  - id: gather
    kind: llm
    subagent: 01J8SVBAG0RSRCHSCT00
    prompt: prompts/gather.md
    output: { type: object, properties: { sources: { type: array } } }
    exits:
      - { name: done, to: $exit.done }
`;

describe('config parsing', () => {
  it('parses a circuit', () => {
    const r = parseConfigYaml(circuitYaml);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('circuit');
    expect((r.value as any).steps[0].max_reasks).toBe(2);
  });
  it('rejects bad uids', () => {
    const r = parseConfigYaml(circuitYaml.replace('01J8SVBAG0RSRCHSCT00', 'lowercase-uid'));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/UID/);
  });
  it('rejects unknown schema tags', () => {
    expect(parseConfigYaml('schema: nope@v9\n').ok).toBe(false);
  });
  it('classifies paths', () => {
    expect(parseConfigPath('subagents/01J8SVBAG0RSRCHSCT00.yaml')).toEqual({ kind: 'subagent', uid: '01J8SVBAG0RSRCHSCT00', sub: null });
    expect(parseConfigPath('circuits/01J8C1RCV1TREV000000/prompts/gather.md')).toEqual({ kind: 'circuit', uid: '01J8C1RCV1TREV000000', sub: 'prompts/gather.md' });
    expect(parseConfigPath('circuits/01J8C1RCV1TREV000000/rubric.yaml')?.kind).toBe('rubric');
    expect(parseConfigPath('tools/01J8T00XCHKC1TAT1N00/src/index.ts')).toEqual({ kind: 'tool', uid: '01J8T00XCHKC1TAT1N00', sub: 'src/index.ts' });
    expect(parseConfigPath('random.txt')).toBeNull();
    expect(definitionPath('circuit', '01J8C1RCV1TREV000000')).toBe('circuits/01J8C1RCV1TREV000000/circuit.yaml');
  });
  it('extracts knowledge tokens', () => {
    expect(knowledgeTokens('a {{knowledge:01J8FQ2ZK7XW9MBT4PVN}} b {{ knowledge:01J8FQ2ZK7XW9MBT4PVM }}')).toEqual(['01J8FQ2ZK7XW9MBT4PVN', '01J8FQ2ZK7XW9MBT4PVM']);
  });
});

describe('json schema', () => {
  it('resolves #/defs/artifact-ref', () => {
    const schema = { type: 'object', required: ['a'], properties: { a: { $ref: '#/defs/artifact-ref' } } };
    expect(validateAgainst(schema, { a: { uid: '01J8FQ2ZK7XW9MBT4PVN', revision_id: 3 } }).ok).toBe(true);
    const bad = validateAgainst(schema, { a: { uid: 'x', revision_id: 3 } });
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
  });
  it('applies defaults without mutating input', () => {
    const schema = { type: 'object', properties: { depth: { type: 'string', default: 'quick' } } };
    const input = {};
    const r = validateAgainst(schema, input);
    expect(r.value).toEqual({ depth: 'quick' });
    expect(input).toEqual({});
  });
  it('required subset check', () => {
    expect(schemaRequiredSubset({ type: 'object', required: ['a'], properties: { a: {} } }, { type: 'object', required: ['a', 'b'] })).toEqual(["required property 'b' is not produced"]);
  });
});

describe('need-input', () => {
  it('derives tags', () => {
    const tags = needInputTags([{ request_id: 'nir_x', role: 'scientist', username: null, prompt: null, requested_by: { kind: 'service', id: 'x' }, requested_at: '', gate: null }]);
    expect(tags.sort()).toEqual(['need-input', 'need-input:role=scientist']);
  });
  it('targets users', () => {
    expect(requestTargetsUser({ role: 'scientist' }, { handle: 'z', roles: ['scientist'] })).toBe(true);
    expect(requestTargetsUser({ role: 'legal' }, { handle: 'z', roles: ['scientist'] })).toBe(false);
    expect(requestTargetsUser({ username: 'z' }, { handle: 'z', roles: [] })).toBe(true);
    expect(requestTargetsUser({}, { handle: 'z', roles: [] })).toBe(true);
  });
});
