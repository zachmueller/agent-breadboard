import { describe, it, expect } from 'vitest';
import { parseConfigYaml, parseConfigPath, definitionPath, owningDefinition, knowledgeTokens, zBreadboardConfig, MIRROR_BRANCH_RE } from './config/index.js';
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
    // The document is still handed back for warnings that do not need it to be valid.
    expect(JSON.stringify(r.doc)).toContain('lowercase-uid');
    expect(r.value).toBeUndefined();
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
  it('maps paths to the definition that owns them', () => {
    expect(owningDefinition('circuits/01J8C1RCV1TREV000000/fixtures.yaml')).toEqual({ kind: 'circuit', uid: '01J8C1RCV1TREV000000' });
    expect(owningDefinition('circuits/01J8C1RCV1TREV000000/prompts/gather.md')).toEqual({ kind: 'circuit', uid: '01J8C1RCV1TREV000000' });
    expect(owningDefinition('tools/01J8T00XCHKC1TAT1N00/src/index.ts')).toEqual({ kind: 'tool', uid: '01J8T00XCHKC1TAT1N00' });
    expect(owningDefinition('mcp/01J8T00XCHKC1TAT1N00.yaml')).toEqual({ kind: 'mcp', uid: '01J8T00XCHKC1TAT1N00' });
    expect(owningDefinition('tenets.md')).toBeNull();
    expect(owningDefinition('INDEX.md')).toBeNull();
  });
  it('extracts knowledge tokens', () => {
    expect(knowledgeTokens('a {{knowledge:01J8FQ2ZK7XW9MBT4PVN}} b {{ knowledge:01J8FQ2ZK7XW9MBT4PVM }}')).toEqual(['01J8FQ2ZK7XW9MBT4PVN', '01J8FQ2ZK7XW9MBT4PVM']);
  });
});

describe('repository mirrors in breadboard.yaml', () => {
  const parse = (repos: unknown[]) => zBreadboardConfig.safeParse({ schema: 'breadboard/breadboard@v1', repos });

  it('applies defaults', () => {
    const r = parse([{ name: 'docs', url: 'https://git.example.com/team/docs.git' }]);
    expect(r.success).toBe(true);
    expect(r.data!.repos[0]).toEqual({ name: 'docs', description: '', url: 'https://git.example.com/team/docs.git', branch: 'main', refresh_minutes: 5, max_file_bytes: 1_048_576, max_notebook_bytes: 52_428_800, exclude: [], fetch_timeout_s: 600, enabled: true });
    expect(zBreadboardConfig.parse({ schema: 'breadboard/breadboard@v1' }).repos).toEqual([]);
  });

  it('rejects duplicate names, embedded credentials, odd schemes and bad branches', () => {
    expect(parse([{ name: 'a', url: 'https://x.example/a.git' }, { name: 'a', url: 'https://x.example/b.git' }]).success).toBe(false);
    expect(parse([{ name: 'a', url: 'https://user:pw@x.example/a.git' }]).success).toBe(false);
    expect(parse([{ name: 'a', url: 'ssh://x.example/a.git' }]).success).toBe(false);
    expect(parse([{ name: 'a', url: 'not a url' }]).success).toBe(false);
    expect(parse([{ name: 'A b', url: 'https://x.example/a.git' }]).success).toBe(false);
    for (const b of ['main', 'release/2026.10', 'feature-x']) expect(MIRROR_BRANCH_RE.test(b)).toBe(true);
    for (const b of ['-x', 'a..b', 'a//b', 'x.lock', 'x/', 'a@{1}', 'a b']) expect(MIRROR_BRANCH_RE.test(b)).toBe(false);
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
