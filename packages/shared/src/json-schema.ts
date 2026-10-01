import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { ARTIFACT_REF_SCHEMA } from './nodes.js';

export type JsonSchema = Record<string, any>;

/** System-provided definitions available to every circuit under `#/defs/...` ([03] §4). */
export const SYSTEM_DEFS: Record<string, JsonSchema> = {
  'artifact-ref': ARTIFACT_REF_SCHEMA as unknown as JsonSchema,
};

const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: true, coerceTypes: false, allowUnionTypes: true });
addFormats.default ? addFormats.default(ajv) : (addFormats as any)(ajv);

const cache = new WeakMap<object, ValidateFunction>();

/** Inject system defs so `$ref: "#/defs/artifact-ref"` resolves. */
export function withSystemDefs(schema: JsonSchema): JsonSchema {
  const defs = { ...SYSTEM_DEFS, ...(schema.defs ?? {}) };
  return { ...schema, defs };
}

export function compileSchema(schema: JsonSchema): ValidateFunction {
  const hit = cache.get(schema);
  if (hit) return hit;
  const fn = ajv.compile(withSystemDefs(schema));
  cache.set(schema, fn);
  return fn;
}

export interface SchemaValidationResult {
  ok: boolean;
  errors: string[];
  /** The value after `useDefaults` filled in defaults (same object, mutated). */
  value: unknown;
}

export function validateAgainst(schema: JsonSchema | undefined | null, value: unknown): SchemaValidationResult {
  if (!schema) return { ok: true, errors: [], value };
  const fn = compileSchema(schema);
  // Ajv mutates with defaults; clone first so callers' inputs are untouched.
  const v = value === undefined ? undefined : structuredClone(value);
  const ok = fn(v) as boolean;
  return { ok, errors: ok ? [] : formatErrors(fn.errors ?? []), value: v };
}

export function formatErrors(errors: ErrorObject[]): string[] {
  return errors.map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}${e.params && Object.keys(e.params).length ? ' ' + JSON.stringify(e.params) : ''}`);
}

/** Is `schema` itself a plausible JSON Schema (object with type/properties/$ref/enum/…)? */
export function looksLikeSchema(v: unknown): v is JsonSchema {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return 'type' in o || 'properties' in o || '$ref' in o || 'enum' in o || 'oneOf' in o || 'anyOf' in o || 'allOf' in o || 'items' in o || 'const' in o;
}

/** Check that a JSON Schema compiles (used by config validation). Returns an error message or null. */
export function schemaCompileError(schema: JsonSchema): string | null {
  try {
    ajv.compile(withSystemDefs(schema));
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Does `candidate` output (statically) satisfy `target`? v1: structural subset check on `required` + property names. */
export function schemaRequiredSubset(candidate: JsonSchema | undefined, target: JsonSchema | undefined): string[] {
  if (!target || !candidate) return [];
  const problems: string[] = [];
  const treq: string[] = target.required ?? [];
  const cprops = candidate.properties ?? {};
  const creq: string[] = candidate.required ?? [];
  for (const r of treq) {
    if (!(r in cprops)) problems.push(`required property '${r}' is not produced`);
    else if (!creq.includes(r)) problems.push(`required property '${r}' is optional in the producing schema`);
  }
  return problems;
}
