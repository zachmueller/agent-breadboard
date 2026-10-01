/**
 * Autocomplete for `input_map` / gate `review.artifacts` expressions ([03] §3.2, §4):
 * `$input.<path>`, `$steps.<id>.output.<path>`, and the closed ambient channel `$ambient.*`.
 */
import type { LooseCircuit } from './circuitGraph';

export interface PathSuggestion {
  path: string;
  detail: string;
}

/** System-defined ambient channel ([03] §4, shared `AmbientContext`). */
export const AMBIENT_PATHS: PathSuggestion[] = [
  { path: '$ambient.task', detail: 'triggering Task ref' },
  { path: '$ambient.task.uid', detail: 'string' },
  { path: '$ambient.task.revision_id', detail: 'integer' },
  { path: '$ambient.session_id', detail: 'string' },
  { path: '$ambient.budget', detail: 'remaining budget' },
  { path: '$ambient.budget.remaining_usd', detail: 'number' },
  { path: '$ambient.budget.remaining_tokens', detail: 'number' },
  { path: '$ambient.artifacts', detail: 'artifact refs produced so far' },
];

const ARTIFACT_REF = '#/defs/artifact-ref';

function typeLabel(schema: any): string {
  if (!schema || typeof schema !== 'object') return 'any';
  if (schema.$ref === ARTIFACT_REF) return 'artifact-ref';
  if (schema.type === 'array') return `${typeLabel(schema.items)}[]`;
  if (Array.isArray(schema.enum)) return schema.enum.map(String).join(' | ');
  return String(schema.type ?? 'any');
}

/** Flatten a JSON-schema subset into dotted property paths (depth-bounded). */
export function schemaPaths(prefix: string, schema: any, depth = 3): PathSuggestion[] {
  const out: PathSuggestion[] = [];
  if (!schema || typeof schema !== 'object' || depth < 0) return out;
  if (schema.$ref === ARTIFACT_REF) {
    out.push({ path: `${prefix}.uid`, detail: 'string' }, { path: `${prefix}.revision_id`, detail: 'integer' });
    return out;
  }
  const props = schema.properties;
  if (props && typeof props === 'object') {
    for (const [k, v] of Object.entries(props)) {
      const p = `${prefix}.${k}`;
      out.push({ path: p, detail: typeLabel(v) });
      out.push(...schemaPaths(p, v, depth - 1));
    }
  }
  return out;
}

export function suggestPaths(c: LooseCircuit | null | undefined, forStepId?: string): PathSuggestion[] {
  const out: PathSuggestion[] = [{ path: '$input', detail: 'circuit input' }, ...schemaPaths('$input', (c as any)?.input)];
  for (const s of c?.steps ?? []) {
    if (!s?.id) continue;
    const base = `$steps.${s.id}.output`;
    const loop = s.id === forStepId ? ' (previous visit)' : '';
    out.push({ path: base, detail: `${s.kind} step output${loop}` });
    out.push(...schemaPaths(base, (s as any).output));
  }
  out.push(...AMBIENT_PATHS);
  return out;
}

/** Prefix filter used by the editor's autocomplete: exact-prefix matches first, then substring. */
export function filterSuggestions(all: PathSuggestion[], typed: string, limit = 50): PathSuggestion[] {
  const t = typed.trim();
  if (!t) return all.slice(0, limit);
  const pre = all.filter((s) => s.path.startsWith(t) && s.path !== t);
  const sub = all.filter((s) => !s.path.startsWith(t) && s.path.includes(t));
  return [...pre, ...sub].slice(0, limit);
}
