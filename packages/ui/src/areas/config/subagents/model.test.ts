import { describe, it, expect } from 'vitest';
import { subagentFieldDiff, effectivePrimitives, grantHints, DEFAULT_PRIMITIVES } from './model';

const base = {
  title: 'Scout',
  model_preset: 'medium',
  system_prompt: 'hi',
  tools: [{ tool: 'T1' }, { mcp: 'M1', allow: ['search'] }],
  circuits: [{ circuit: 'C1', access: 'read' }],
  knowledge: { read: ['glossary'], write: [] },
};

describe('subagentFieldDiff', () => {
  it('reports nothing for equal configs', () => {
    expect(subagentFieldDiff(base, structuredClone(base))).toEqual([]);
  });
  it('summarizes grant, preset, knowledge and primitive changes', () => {
    const next = structuredClone(base) as any;
    next.model_preset = 'large';
    next.system_prompt = 'hello';
    next.tools = [{ tool: 'T1', settings: { domains: ['glossary'] } }, { tool: 'T2' }];
    next.circuits = [{ circuit: 'C1', access: 'execute' }];
    next.knowledge = { read: ['glossary', 'prior-art'], write: ['glossary'] };
    next.primitives = [...DEFAULT_PRIMITIVES, 'run_circuit'];
    const d = subagentFieldDiff(base, next, (k, u) => `${k}/${u}`);
    const txt = d.map((x) => `${x.field}:${x.kind}:${x.detail}`);
    expect(txt).toContain('model_preset:changed:medium -> large');
    expect(txt).toContain('system_prompt:changed:system prompt edited');
    expect(txt).toContain('tools:added:tool tool/T2 granted');
    expect(txt).toContain('tools:removed:MCP mcp/M1 revoked');
    expect(txt.some((t) => t.startsWith('tools:changed:tool tool/T1 settings'))).toBe(true);
    expect(txt).toContain('circuits:changed:circuit/C1 read -> execute');
    expect(txt).toContain('knowledge.read:added:prior-art');
    expect(txt).toContain('knowledge.write:added:glossary');
    expect(txt).toContain('primitives:changed:+run_circuit');
  });
  it('reports repository grants', () => {
    const d = subagentFieldDiff({ ...base, repos: ['old'] }, { ...base, repos: ['handbook'] });
    expect(d.map((x) => `${x.field}:${x.kind}:${x.detail}`)).toEqual(['repos:added:handbook', 'repos:removed:old']);
  });
});

describe('primitives and hints', () => {
  it('falls back to the default allowlist', () => {
    expect(effectivePrimitives({}).custom).toBe(false);
    expect(effectivePrimitives({ primitives: [] })).toEqual({ custom: true, list: [] });
  });
  it('hints at grants that cannot be used', () => {
    const h = grantHints({ circuits: [{ circuit: 'C', access: 'execute' }], knowledge: { read: [], write: ['x'] } });
    expect(h.join('\n')).toMatch(/run_circuit primitive/);
    expect(h.join('\n')).toMatch(/propose_note_edit primitive/);
    expect(h.join('\n')).toMatch(/Writable but not readable: x/);
    expect(grantHints({ primitives: ['search_repo'] }).join('\n')).toMatch(/no repository is granted/);
    expect(grantHints({ primitives: ['search_repo'], repos: ['r'] }).join('\n')).not.toMatch(/repository/);
  });
});
