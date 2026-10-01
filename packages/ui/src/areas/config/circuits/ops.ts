/**
 * Pure circuit-draft mutations behind canvas gestures. Each takes the plain-object draft handed out
 * by `editYaml` (comment-preserving reconcile happens afterwards) and mutates it in place.
 */
import { EXIT_PREFIX } from '@breadboard/shared';
import { START_ID, NEW_EXIT_HANDLE, uniqueName, type StepKind } from '../lib/circuitGraph';

const stepIdOf = (nodeId: string) => (nodeId.startsWith('step:') ? nodeId.slice(5) : null);
const exitNameOf = (nodeId: string) => (nodeId.startsWith('exit:') ? nodeId.slice(5) : null);

export function targetString(targetNodeId: string): string | null {
  const s = stepIdOf(targetNodeId);
  if (s) return s;
  const x = exitNameOf(targetNodeId);
  return x ? `${EXIT_PREFIX}${x}` : null;
}

function steps(draft: any): any[] {
  if (!Array.isArray(draft.steps)) draft.steps = [];
  return draft.steps;
}

/** Drag from a source handle onto a node. Returns the exit name written (or 'entry'). */
export function connect(draft: any, sourceNodeId: string, sourceHandle: string, targetNodeId: string): string | null {
  if (sourceNodeId === START_ID) {
    const s = stepIdOf(targetNodeId);
    if (!s) return null;
    draft.entry = s;
    return 'entry';
  }
  const stepId = stepIdOf(sourceNodeId);
  const to = targetString(targetNodeId);
  if (!stepId || !to) return null;
  const step = steps(draft).find((s) => s?.id === stepId);
  if (!step) return null;
  if (!Array.isArray(step.exits)) step.exits = [];
  if (sourceHandle === NEW_EXIT_HANDLE) {
    const taken = step.exits.map((x: any) => x?.name);
    const preferred = exitNameOf(targetNodeId) ?? (step.kind === 'gate' ? (taken.includes('approve') ? 'changes' : 'approve') : 'next');
    const name = uniqueName(preferred, taken);
    step.exits.push({ name, to });
    return name;
  }
  const name = sourceHandle.startsWith('x:') ? sourceHandle.slice(2) : sourceHandle;
  const exit = step.exits.find((x: any) => x?.name === name);
  if (exit) exit.to = to;
  else step.exits.push({ name, to });
  return name;
}

/** Deleting an edge removes that route (the step's exit declaration). */
export function deleteEdges(draft: any, edgeIds: string[]): void {
  for (const id of edgeIds) {
    const m = /^e:([^:]+):(.+)$/.exec(id);
    if (!m) continue;
    const step = steps(draft).find((s) => s?.id === m[1]);
    if (step && Array.isArray(step.exits)) step.exits = step.exits.filter((x: any) => x?.name !== m[2]);
  }
}

/** Remove steps / circuit exits. Routes into them are kept (shown dangling) so the author retargets them. */
export function deleteNodes(draft: any, nodeIds: string[]): void {
  const stepIds = new Set(nodeIds.map(stepIdOf).filter(Boolean) as string[]);
  const exitNames = new Set(nodeIds.map(exitNameOf).filter(Boolean) as string[]);
  if (stepIds.size) draft.steps = steps(draft).filter((s) => !stepIds.has(s?.id));
  if (exitNames.size && Array.isArray(draft.exits)) draft.exits = draft.exits.filter((x: any) => !exitNames.has(x?.name));
  if (draft.entry && stepIds.has(draft.entry)) draft.entry = draft.steps[0]?.id ?? '';
}

export function newStep(draft: any, kind: StepKind): string {
  const all = steps(draft);
  const id = uniqueName(kind === 'llm' ? 'think' : kind === 'code' ? 'run' : kind === 'circuit' ? 'delegate' : 'review', all.map((s) => s?.id));
  const firstExit = Array.isArray(draft.exits) && draft.exits[0]?.name ? `${EXIT_PREFIX}${draft.exits[0].name}` : '';
  const base = { id, kind } as Record<string, unknown>;
  switch (kind) {
    case 'llm':
      Object.assign(base, { subagent: '', prompt: `prompts/${id}.md`, output: { type: 'object', properties: {} }, exits: [{ name: 'done', to: firstExit }] });
      break;
    case 'code':
      Object.assign(base, { tool: '', input_map: {}, exits: [{ name: 'done', to: firstExit }] });
      break;
    case 'circuit':
      Object.assign(base, { circuit: '', input_map: {}, exits: [{ name: 'done', to: firstExit }] });
      break;
    case 'gate': {
      const prev = all[all.length - 1]?.id;
      Object.assign(base, {
        review: { artifacts: prev ? [`$steps.${prev}.output.artifact`] : [], reviewers: { role: 'reviewer' } },
        output: { type: 'object', properties: { verdict: { type: 'string' } } },
        exits: [
          { name: 'approve', to: firstExit },
          { name: 'changes', to: prev ?? firstExit },
        ],
      });
      break;
    }
  }
  all.push(base);
  if (!draft.entry) draft.entry = id;
  return id;
}

export function newCircuitExit(draft: any): string {
  if (!Array.isArray(draft.exits)) draft.exits = [];
  const name = uniqueName('done', draft.exits.map((x: any) => x?.name));
  draft.exits.push({ name, output: { type: 'object', properties: {} } });
  return name;
}

/** Rename a circuit exit and every `$exit.<old>` route. */
export function renameCircuitExit(draft: any, from: string, to: string): void {
  for (const x of draft.exits ?? []) if (x?.name === from) x.name = to;
  for (const s of steps(draft)) for (const x of s?.exits ?? []) if (x?.to === `${EXIT_PREFIX}${from}`) x.to = `${EXIT_PREFIX}${to}`;
}

const BASE_KEYS = ['id', 'kind', 'title', 'description', 'exits', 'retry', 'max_visits', 'artifacts'];

/** Change a step's kind in place: base fields survive, kind-specific fields are replaced by the template's. */
export function convertStepKind(draft: any, stepId: string, kind: StepKind): void {
  const all = steps(draft);
  const i = all.findIndex((s) => s?.id === stepId);
  if (i < 0 || all[i].kind === kind) return;
  const tmp: any = { steps: [], exits: draft.exits };
  newStep(tmp, kind);
  const template = tmp.steps[0];
  const old = all[i];
  const next: any = {};
  for (const k of Object.keys(old)) if (BASE_KEYS.includes(k)) next[k] = old[k];
  next.kind = kind;
  for (const [k, v] of Object.entries(template)) if (!BASE_KEYS.includes(k)) next[k] = v;
  if (kind === 'llm') next.prompt = `prompts/${stepId}.md`;
  if (kind === 'gate') {
    const names = new Set((next.exits ?? []).map((x: any) => x?.name));
    for (const x of template.exits) if (!names.has(x.name)) (next.exits ??= []).push(x);
  }
  all[i] = next;
}
