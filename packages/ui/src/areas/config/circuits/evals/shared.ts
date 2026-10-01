import { SCHEMA_TAGS } from '@breadboard/shared';
import type { WorkingTree } from '../../model/workingTree';

export const rubricPathOf = (wt: WorkingTree) => (wt.state.dir ? `${wt.state.dir}/rubric.yaml` : null);
export const fixturesPathOf = (wt: WorkingTree) => (wt.state.dir ? `${wt.state.dir}/fixtures.yaml` : null);

/** Server validation errors are prefixed with the file path (`circuits/<uid>/rubric.yaml: …`). */
export const errorsForFile = (errors: string[], path: string | null) => (path ? errors.filter((e) => e.includes(path) || e.startsWith(path.split('/').pop()!)) : []);

/** Builtin programmatic assertions ([04] §2). */
export const BUILTIN_ASSERTIONS = ['assert-output-schema', 'assert-citations-exist', 'assert-exit'];

export function rubricTemplate(circuitUid: string, judgeSubagent = '', judgeModel = ''): string {
  return `schema: ${SCHEMA_TAGS.rubric}
circuit: ${circuitUid}
judge:
  subagent: ${judgeSubagent || "''"}
  # Pin an explicit model ID (never a preset tier); changing it starts a new baseline.
  model_id: ${judgeModel || "''"}
dimensions:
  - key: quality
    type: numeric
    scale: { min: 0, max: 10 }
    prompt: >
      Score the overall quality of the output for the given input.
  - key: schema-valid
    type: programmatic
    tool: assert-output-schema
aggregate:
  method: weighted-mean
  weights: { quality: 3, schema-valid: 1 }
  gate: { min: 0.7 }
`;
}

export function fixturesTemplate(circuitUid: string): string {
  return `schema: ${SCHEMA_TAGS.fixtures}
circuit: ${circuitUid}
fixtures: []
`;
}

/** Text of a dimension value for tables (number | level | bool | {score, detail}). */
export function showValue(v: unknown): string {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'boolean') return v ? 'pass' : 'fail';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as any;
    if ('score' in o) return `${showValue(o.score)}${o.pass === true ? ' (pass)' : o.pass === false ? ' (fail)' : ''}`;
    if ('value' in o) return showValue(o.value);
    if ('passed' in o) return showValue(o.passed);
  }
  return JSON.stringify(v);
}

export function passOf(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v && typeof v === 'object') {
    const o = v as any;
    if (typeof o.pass === 'boolean') return o.pass;
    if (typeof o.passed === 'boolean') return o.passed;
  }
  return null;
}
