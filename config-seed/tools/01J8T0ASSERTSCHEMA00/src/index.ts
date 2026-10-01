import type { BreadboardContext } from '@breadboard/sandbox-runtime';

interface Input {
  fixture: { fixture_id?: string };
  output: unknown;
  exit?: string;
  session_id?: string;
  circuit_uid?: string;
}
interface Output {
  pass: boolean;
  score: number;
  detail: string;
}
type Schema = Record<string, any>;

/** System defs available to every circuit schema ([03] §4). */
const DEFS: Record<string, Schema> = {
  'artifact-ref': { type: 'object', required: ['uid', 'revision_id'], properties: { uid: { type: 'string' }, revision_id: { type: 'integer' } } },
};

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/** Small structural JSON Schema subset validator (type, enum, const, required, properties, items, oneOf/anyOf, $ref to #/defs). */
export function check(schema: Schema | undefined, value: unknown, path: string, defs: Record<string, Schema>, errors: string[]): void {
  if (!schema || typeof schema !== 'object') return;
  if (typeof schema.$ref === 'string') {
    const m = /^#\/(?:defs|\$defs)\/(.+)$/.exec(schema.$ref);
    const target = m ? defs[m[1]!] : undefined;
    if (!target) return void errors.push(`${path}: unresolvable $ref ${schema.$ref}`);
    return check(target, value, path, defs, errors);
  }
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    if (!types.some((x) => x === t || (x === 'number' && t === 'integer'))) return void errors.push(`${path}: expected ${types.join('|')}, got ${t}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${path}: not one of ${JSON.stringify(schema.enum)}`);
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  for (const key of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(schema[key])) {
      const ok = schema[key].filter((s: Schema) => {
        const e: string[] = [];
        check(s, value, path, defs, e);
        return e.length === 0;
      }).length;
      if (key === 'oneOf' ? ok !== 1 : ok === 0) errors.push(`${path}: does not match ${key}`);
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in obj)) errors.push(`${path}: missing required property '${r}'`);
    for (const [k, s] of Object.entries<Schema>(schema.properties ?? {})) if (k in obj) check(s, obj[k], `${path}.${k}`, defs, errors);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => check(schema.items, v, `${path}[${i}]`, defs, errors));
}

export async function handler(input: Input, ctx: BreadboardContext): Promise<Output> {
  const settings = ctx.ambient.settings ?? {};
  const circuitUid = input.circuit_uid || String(settings.circuit ?? '');
  const exitName = input.exit || String(settings.exit ?? '');
  if (!circuitUid) return { pass: false, score: 0, detail: 'no circuit_uid given and no `circuit` setting configured' };

  const raw = (await ctx.readConfig(circuitUid)) as any;
  const circuit = raw?.value ?? raw?.definition ?? raw;
  const exits: Array<{ name: string; output?: Schema }> = circuit?.exits ?? [];
  const exit = exitName ? exits.find((e) => e.name === exitName) : exits.length === 1 ? exits[0] : undefined;
  if (!exit) return { pass: false, score: 0, detail: `cannot determine which exit schema applies (exit='${exitName}', circuit has ${exits.map((e) => e.name).join(', ')})` };
  if (!exit.output) return { pass: true, score: 1, detail: `exit '${exit.name}' declares no output schema` };

  const errors: string[] = [];
  check(exit.output, input.output, '$', { ...DEFS, ...(exit.output.defs ?? {}) }, errors);
  const pass = errors.length === 0;
  return { pass, score: pass ? 1 : 0, detail: pass ? `output conforms to exit '${exit.name}'` : errors.slice(0, 20).join('; ') };
}
