import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { deriveGraph, diffCircuits, layoutGraph, markGraph, renameStep, stepNodeId, exitNodeId, START_ID } from '../circuitGraph';
import { LIT_REVIEW_YAML } from './fixtures';

const circuit = () => parse(LIT_REVIEW_YAML);

describe('deriveGraph', () => {
  it('creates one node per step, one per declared exit, plus start', () => {
    const g = deriveGraph(circuit());
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toEqual([START_ID, ...['gather', 'summarize', 'quality-check', 'quality-gate', 'report-empty'].map(stepNodeId), exitNodeId('done'), exitNodeId('empty')]);
    const gate = g.nodes.find((n) => n.id === stepNodeId('quality-gate'))!.data as any;
    expect(gate.kind).toBe('gate');
    expect(g.nodes.find((n) => n.id === stepNodeId('gather'))!.data).toMatchObject({ isEntry: true, kind: 'llm' });
  });

  it('creates labelled edges per step exit, coloring approve/changes and flagging loops', () => {
    const g = deriveGraph(circuit());
    const byId = Object.fromEntries(g.edges.map((e) => [e.id, e]));
    expect(byId['e:start']).toMatchObject({ target: stepNodeId('gather'), tone: 'entry' });
    expect(byId['e:quality-gate:approve']).toMatchObject({ target: exitNodeId('done'), tone: 'approve', label: 'approve', sourceHandle: 'x:approve' });
    expect(byId['e:quality-gate:changes']).toMatchObject({ target: stepNodeId('summarize'), tone: 'changes', loop: true });
    expect(byId['e:quality-check:fail'].loop).toBe(true);
    expect(byId['e:gather:found-sources'].loop).toBe(false);
    expect(g.edges).toHaveLength(1 + 2 + 1 + 2 + 2 + 1);
  });

  it('marks dangling exits and unreachable circuit exits instead of drawing edges', () => {
    const c = circuit();
    c.steps[4].exits[0].to = 'nowhere';
    const g = deriveGraph(c);
    const report = g.nodes.find((n) => n.id === stepNodeId('report-empty'))!.data as any;
    expect(report.exits[0].dangling).toBe(true);
    expect(g.edges.find((e) => e.id === 'e:report-empty:done')).toBeUndefined();
    expect((g.nodes.find((n) => n.id === exitNodeId('empty'))!.data as any).unreachable).toBe(true);
  });

  it('tolerates garbage input', () => {
    expect(deriveGraph(null).nodes).toHaveLength(1);
    expect(deriveGraph({ steps: [null as any, { id: 'a', kind: 'llm', exits: 'x' as any }] }).nodes).toHaveLength(2);
  });

  it('lays out every node top-to-bottom', () => {
    const g = deriveGraph(circuit());
    const pos = layoutGraph(g.nodes, g.edges);
    expect(Object.keys(pos)).toHaveLength(g.nodes.length);
    expect(pos[START_ID]!.y).toBeLessThan(pos[stepNodeId('gather')]!.y);
    expect(pos[stepNodeId('gather')]!.y).toBeLessThan(pos[stepNodeId('summarize')]!.y);
  });
});

describe('diffCircuits', () => {
  it('classifies added/removed/modified steps and edges', () => {
    const base = circuit();
    const next = circuit();
    next.steps = next.steps.filter((s: any) => s.id !== 'report-empty');
    next.steps[0].exits[1].to = '$exit.empty';
    next.steps.push({ id: 'polish', kind: 'llm', subagent: 'X', output: {}, exits: [{ name: 'done', to: 'quality-check' }] });
    const d = diffCircuits(base, next, (id, side) => (id === 'summarize' && side === 'next' ? 'changed' : 'same'));
    expect(d.steps).toEqual({ 'report-empty': 'removed', polish: 'added', gather: 'modified', summarize: 'modified' });
    expect(d.edges['e:gather:nothing-found']).toBe('modified');
    expect(d.edges['e:polish:done']).toBe('added');
    expect(d.edges['e:report-empty:done']).toBe('removed');
    const marked = markGraph(deriveGraph(base), d, 'base');
    expect((marked.nodes.find((n) => n.id === stepNodeId('report-empty'))!.data as any).diff).toBe('removed');
    expect((marked.nodes.find((n) => n.id === stepNodeId('gather'))!.data as any).diff).toBe('modified');
  });
});

describe('renameStep', () => {
  it('rewrites entry, exits, input_map and gate artifact expressions', () => {
    const c = circuit();
    renameStep(c, 'summarize', 'write');
    expect(c.steps[1].id).toBe('write');
    expect(c.steps[0].exits[0].to).toBe('write');
    expect(c.steps[2].input_map.artifact).toBe('$steps.write.output.summary_artifact');
    expect(c.steps[3].review.artifacts).toEqual(['$steps.write.output.summary_artifact']);
    renameStep(c, 'gather', 'find');
    expect(c.entry).toBe('find');
  });
});
