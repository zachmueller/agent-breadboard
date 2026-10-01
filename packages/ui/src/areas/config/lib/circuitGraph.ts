/**
 * Pure derivation of the flow graph from a (possibly invalid, work-in-progress) circuit value,
 * plus dagre auto-layout and base↔next graph diffing for proposal/history views ([03] §8.2, [10] §4).
 */
import { Graph, layout } from '@dagrejs/dagre';
import { EXIT_PREFIX } from '@breadboard/shared';

export type StepKind = 'llm' | 'code' | 'circuit' | 'gate';
export type DiffMark = 'added' | 'removed' | 'modified' | undefined;

export interface LooseStep {
  id: string;
  kind: StepKind | string;
  title?: string;
  exits?: Array<{ name: string; to: string; description?: string }>;
  [k: string]: unknown;
}
export interface LooseCircuit {
  uid?: string;
  slug?: string;
  title?: string;
  entry?: string;
  exits?: Array<{ name: string; description?: string; output?: unknown }>;
  steps?: LooseStep[];
  [k: string]: unknown;
}

export const START_ID = 'start';
export const stepNodeId = (id: string) => `step:${id}`;
export const exitNodeId = (name: string) => `exit:${name}`;
export const exitHandleId = (exitName: string) => `x:${exitName}`;
export const NEW_EXIT_HANDLE = 'x:+';

export interface StepNodeData {
  type: 'step';
  stepId: string;
  kind: string;
  title?: string;
  /** UID the step references (subagent / tool / child circuit). */
  ref?: string;
  isEntry: boolean;
  exits: Array<{ name: string; to: string; dangling: boolean }>;
  diff?: DiffMark;
  [k: string]: unknown;
}
export interface ExitNodeData {
  type: 'exit';
  exitName: string;
  description?: string;
  unreachable: boolean;
  diff?: DiffMark;
  [k: string]: unknown;
}
export interface StartNodeData {
  type: 'start';
  entry?: string;
  [k: string]: unknown;
}
export type FlowNodeData = StepNodeData | ExitNodeData | StartNodeData;

export interface GraphNode {
  id: string;
  data: FlowNodeData;
}
export interface GraphEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  label: string;
  tone: 'approve' | 'changes' | 'entry' | 'default';
  /** Back-edge (loop) for styling. */
  loop: boolean;
  diff?: DiffMark;
}

export function stepRef(step: LooseStep): string | undefined {
  const s = step as any;
  if (step.kind === 'llm') return s.subagent;
  if (step.kind === 'code') return s.tool;
  if (step.kind === 'circuit') return s.circuit;
  return undefined;
}

export function targetNodeId(to: string): string {
  return to.startsWith(EXIT_PREFIX) ? exitNodeId(to.slice(EXIT_PREFIX.length)) : stepNodeId(to);
}

export function deriveGraph(c: LooseCircuit | null | undefined): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const steps = Array.isArray(c?.steps) ? c!.steps!.filter((s) => s && typeof s === 'object' && typeof s.id === 'string') : [];
  const exits = Array.isArray(c?.exits) ? c!.exits!.filter((e) => e && typeof e.name === 'string') : [];
  const nodeIds = new Set<string>([...steps.map((s) => stepNodeId(s.id)), ...exits.map((e) => exitNodeId(e.name))]);
  const order = new Map(steps.map((s, i) => [s.id, i]));

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  nodes.push({ id: START_ID, data: { type: 'start', entry: c?.entry } });
  if (c?.entry && nodeIds.has(stepNodeId(c.entry))) {
    edges.push({ id: 'e:start', source: START_ID, sourceHandle: 'start', target: stepNodeId(c.entry), label: 'entry', tone: 'entry', loop: false });
  }
  const reachedExits = new Set<string>();
  for (const s of steps) {
    const stepExits = (Array.isArray(s.exits) ? s.exits : []).filter((x) => x && typeof x.name === 'string');
    const data: StepNodeData = {
      type: 'step',
      stepId: s.id,
      kind: String(s.kind ?? '?'),
      title: typeof s.title === 'string' ? s.title : undefined,
      ref: stepRef(s),
      isEntry: c?.entry === s.id,
      exits: stepExits.map((x) => ({ name: x.name, to: String(x.to ?? ''), dangling: !x.to || !nodeIds.has(targetNodeId(String(x.to))) })),
    };
    nodes.push({ id: stepNodeId(s.id), data });
    for (const x of data.exits) {
      if (x.dangling) continue;
      const target = targetNodeId(x.to);
      if (target.startsWith('exit:')) reachedExits.add(target);
      const tOrder = x.to.startsWith(EXIT_PREFIX) ? Infinity : (order.get(x.to) ?? Infinity);
      edges.push({
        id: edgeKey(s.id, x.name),
        source: stepNodeId(s.id),
        sourceHandle: exitHandleId(x.name),
        target,
        label: x.name,
        tone: x.name === 'approve' ? 'approve' : x.name === 'changes' ? 'changes' : 'default',
        loop: tOrder <= (order.get(s.id) ?? 0),
      });
    }
  }
  for (const e of exits) {
    nodes.push({ id: exitNodeId(e.name), data: { type: 'exit', exitName: e.name, description: e.description, unreachable: !reachedExits.has(exitNodeId(e.name)) } });
  }
  return { nodes, edges };
}

export const edgeKey = (stepId: string, exitName: string) => `e:${stepId}:${exitName}`;

/* ------------------------------------------------------------------ layout */

export interface Size {
  width: number;
  height: number;
}
export function estimateSize(n: GraphNode): Size {
  if (n.data.type === 'start') return { width: 90, height: 36 };
  if (n.data.type === 'exit') return { width: 150, height: 44 };
  const exits = (n.data as StepNodeData).exits.length;
  return { width: Math.max(220, exits * 92 + 24), height: 96 };
}

/** Top-to-bottom dagre layout; returns top-left positions keyed by node id. */
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[], sizeOf: (n: GraphNode) => Size = estimateSize): Record<string, { x: number; y: number }> {
  const g = new Graph({ multigraph: true });
  g.setGraph({ rankdir: 'TB', nodesep: 48, ranksep: 70, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    const s = sizeOf(n);
    g.setNode(n.id, { width: s.width, height: s.height });
  }
  for (const e of edges) {
    // Loop edges don't constrain rank order (keeps the main flow top-to-bottom).
    if (e.loop) continue;
    g.setEdge(e.source, e.target, { label: e.label, width: 60, height: 18 }, e.id);
  }
  layout(g);
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    const p = g.node(n.id) as { x: number; y: number; width: number; height: number } | undefined;
    if (p) out[n.id] = { x: p.x - p.width / 2, y: p.y - p.height / 2 };
  }
  return out;
}

/* ------------------------------------------------------------------ diff */

export interface CircuitDiff {
  steps: Record<string, Exclude<DiffMark, undefined>>;
  exits: Record<string, Exclude<DiffMark, undefined>>;
  edges: Record<string, 'added' | 'removed' | 'modified'>;
  /** Top-level keys (other than steps/exits) whose value changed. */
  circuitFields: string[];
  entryChanged: boolean;
}

const json = (v: unknown) => JSON.stringify(v ?? null);

/**
 * Classify steps/exits/edges between two circuit versions. `promptOf(stepId, side)` lets prompt
 * template file changes mark their step as modified.
 */
export function diffCircuits(base: LooseCircuit | null | undefined, next: LooseCircuit | null | undefined, promptOf?: (stepId: string, side: 'base' | 'next') => string | undefined): CircuitDiff {
  const bSteps = new Map((base?.steps ?? []).filter((s) => s?.id).map((s) => [s.id, s]));
  const nSteps = new Map((next?.steps ?? []).filter((s) => s?.id).map((s) => [s.id, s]));
  const steps: CircuitDiff['steps'] = {};
  const edges: CircuitDiff['edges'] = {};
  for (const [id, s] of nSteps) {
    const b = bSteps.get(id);
    if (!b) steps[id] = 'added';
    else if (json(b) !== json(s) || (promptOf && promptOf(id, 'base') !== promptOf(id, 'next'))) steps[id] = 'modified';
  }
  for (const id of bSteps.keys()) if (!nSteps.has(id)) steps[id] = 'removed';

  const exitsOf = (s?: LooseStep) => new Map((s?.exits ?? []).map((x) => [x.name, x.to]));
  for (const id of new Set([...bSteps.keys(), ...nSteps.keys()])) {
    const be = exitsOf(bSteps.get(id));
    const ne = exitsOf(nSteps.get(id));
    for (const [name, to] of ne) {
      if (!be.has(name)) edges[edgeKey(id, name)] = 'added';
      else if (be.get(name) !== to) edges[edgeKey(id, name)] = 'modified';
    }
    for (const name of be.keys()) if (!ne.has(name)) edges[edgeKey(id, name)] = 'removed';
  }

  const bExits = new Map((base?.exits ?? []).map((e) => [e.name, e]));
  const nExits = new Map((next?.exits ?? []).map((e) => [e.name, e]));
  const exits: CircuitDiff['exits'] = {};
  for (const [name, e] of nExits) {
    const b = bExits.get(name);
    if (!b) exits[name] = 'added';
    else if (json(b) !== json(e)) exits[name] = 'modified';
  }
  for (const name of bExits.keys()) if (!nExits.has(name)) exits[name] = 'removed';

  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(next ?? {})]);
  const circuitFields = [...keys].filter((k) => k !== 'steps' && k !== 'exits' && json((base as any)?.[k]) !== json((next as any)?.[k]));
  return { steps, exits, edges, circuitFields, entryChanged: base?.entry !== next?.entry };
}

/** Whether the circuit definition itself changes (steps, routes, exits, entry, fields), not only files it references such as prompts. */
export function hasFlowChanges(base: LooseCircuit | null | undefined, next: LooseCircuit | null | undefined): boolean {
  const d = diffCircuits(base, next);
  return d.entryChanged || d.circuitFields.length > 0 || [d.steps, d.edges, d.exits].some((m) => Object.keys(m).length > 0);
}

/** Annotate a derived graph with diff marks for one side of a side-by-side view. */
export function markGraph(g: { nodes: GraphNode[]; edges: GraphEdge[] }, d: CircuitDiff, side: 'base' | 'next'): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const keep = (m: DiffMark) => (side === 'base' ? (m === 'removed' || m === 'modified' ? m : undefined) : m === 'added' || m === 'modified' ? m : undefined);
  return {
    nodes: g.nodes.map((n) => {
      if (n.data.type === 'step') return { ...n, data: { ...n.data, diff: keep(d.steps[n.data.stepId]) } };
      if (n.data.type === 'exit') return { ...n, data: { ...n.data, diff: keep(d.exits[n.data.exitName]) } };
      return n;
    }),
    edges: g.edges.map((e) => ({ ...e, diff: keep(d.edges[e.id]) })),
  };
}

/* ------------------------------------------------------------------ step refactors */

/** Rename a step id everywhere it is referenced (entry, exits, `$steps.<id>.` expressions). */
export function renameStep(c: any, from: string, to: string): void {
  if (!c || from === to) return;
  if (c.entry === from) c.entry = to;
  const rewrite = (v: unknown): unknown => {
    if (typeof v === 'string') return v.split(`$steps.${from}.`).join(`$steps.${to}.`).replace(new RegExp(`\\$steps\\.${escapeRe(from)}$`), `$steps.${to}`);
    if (Array.isArray(v)) return v.map(rewrite);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x)]));
    return v;
  };
  for (const s of c.steps ?? []) {
    if (s.id === from) s.id = to;
    for (const x of s.exits ?? []) if (x.to === from) x.to = to;
    if (s.input_map) s.input_map = rewrite(s.input_map);
    if (s.review?.artifacts) s.review.artifacts = rewrite(s.review.artifacts);
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`;
}
