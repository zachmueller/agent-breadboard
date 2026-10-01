import { describe, it, expect } from 'vitest';
import { connect, deleteEdges, deleteNodes, newStep, newCircuitExit, renameCircuitExit } from './ops';
import { editYaml } from '../lib/yamlDoc';
import { LIT_REVIEW_YAML } from '../lib/__tests__/fixtures';

const base = () => ({
  entry: 'a',
  exits: [{ name: 'done' }, { name: 'failed' }],
  steps: [
    { id: 'a', kind: 'llm', exits: [{ name: 'done', to: 'b' }] },
    { id: 'b', kind: 'gate', exits: [{ name: 'approve', to: '$exit.done' }] },
  ],
});

describe('circuit ops', () => {
  it('retargets an existing exit', () => {
    const d = base();
    expect(connect(d, 'step:a', 'x:done', 'exit:failed')).toBe('done');
    expect(d.steps[0]!.exits[0]!.to).toBe('$exit.failed');
  });
  it('adds a new exit from the + handle, named after a circuit-exit target', () => {
    const d = base();
    expect(connect(d, 'step:a', 'x:+', 'exit:failed')).toBe('failed');
    expect(d.steps[0]!.exits).toContainEqual({ name: 'failed', to: '$exit.failed' });
    expect(connect(d, 'step:b', 'x:+', 'step:a')).toBe('changes');
  });
  it('sets entry from the start node', () => {
    const d = base();
    connect(d, 'start', 'start', 'step:b');
    expect(d.entry).toBe('b');
    expect(connect(d, 'start', 'start', 'exit:done')).toBeNull();
  });
  it('deletes edges as exits and nodes as steps', () => {
    const d = base();
    deleteEdges(d, ['e:a:done']);
    expect(d.steps[0]!.exits).toEqual([]);
    deleteNodes(d, ['step:a', 'exit:failed']);
    expect(d.steps.map((s) => s.id)).toEqual(['b']);
    expect(d.entry).toBe('b');
    expect(d.exits.map((x) => x.name)).toEqual(['done']);
  });
  it('creates kind templates with unique ids', () => {
    const d: any = base();
    const id = newStep(d, 'gate');
    expect(id).toBe('review');
    const g = d.steps.find((s: any) => s.id === id);
    expect(g.exits.map((x: any) => x.name)).toEqual(['approve', 'changes']);
    expect(newStep(d, 'gate')).toBe('review-2');
    expect(newCircuitExit(d)).toBe('done-2');
  });
  it('renames circuit exits with their routes', () => {
    const d = base();
    renameCircuitExit(d, 'done', 'complete');
    expect(d.exits[0]!.name).toBe('complete');
    expect(d.steps[1]!.exits[0]!.to).toBe('$exit.complete');
  });
  it('keeps YAML comments through a canvas connect', () => {
    const out = editYaml(LIT_REVIEW_YAML, (d) => {
      const s = d.steps[0];
      connect(d, `step:${s.id}`, `x:${s.exits[0].name}`, 'exit:' + d.exits[0].name);
    });
    const a = LIT_REVIEW_YAML.split('\n');
    const b = out.split('\n');
    expect(b.length).toBe(a.length);
    const changed = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
    // Only the retargeted route changes; alignment, inline comments, flow spacing stay byte-identical.
    expect(changed).toEqual([['        to: summarize', '        to: $exit.done']]);
  });
});

describe('convertStepKind', () => {
  it('keeps base fields and swaps kind-specific ones', async () => {
    const { convertStepKind } = await import('./ops');
    const d: any = { exits: [{ name: 'done' }], steps: [{ id: 'a', kind: 'llm', title: 'A', subagent: 'X', prompt: 'p.md', output: {}, exits: [{ name: 'done', to: '$exit.done' }], retry: { max_attempts: 2 } }] };
    convertStepKind(d, 'a', 'gate');
    const s = d.steps[0];
    expect(s.kind).toBe('gate');
    expect(s.title).toBe('A');
    expect(s.retry).toEqual({ max_attempts: 2 });
    expect(s.subagent).toBeUndefined();
    expect(s.review).toBeDefined();
    expect(s.exits.map((x: any) => x.name)).toEqual(['done', 'approve', 'changes']);
  });
});
