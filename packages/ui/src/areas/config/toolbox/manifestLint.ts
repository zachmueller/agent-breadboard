/**
 * Tool manifest lint + security diff ([06] §10: "manifest lint surfaces limit/egress/capability
 * changes prominently — they're the security-relevant part of any diff"). Pure; operates on loosely
 * parsed `tool.yaml` values so it works on schema-invalid drafts too.
 */

export type Severity = 'risk' | 'warn' | 'info';
export type Area = 'limits' | 'egress' | 'capabilities' | 'exposure' | 'settings' | 'connector' | 'runtime';

export interface Finding {
  area: Area;
  severity: Severity;
  text: string;
}

/** Schema defaults ([06] §2 / shared `zTool`), used so an omitted key compares as its default. */
export const LIMIT_DEFAULTS = { timeout_s: 120, memory_mb: 512, cpus: 1, pids: 256, max_cost_units: 1 } as const;
type LimitKey = keyof typeof LIMIT_DEFAULTS;
const LIMIT_KEYS = Object.keys(LIMIT_DEFAULTS) as LimitKey[];

export interface EgressRule {
  host: string;
  ports: number[];
}

export function limitsOf(t: any): Record<LimitKey, number> {
  const l = t?.limits ?? {};
  const out = {} as Record<LimitKey, number>;
  for (const k of LIMIT_KEYS) out[k] = typeof l[k] === 'number' ? l[k] : LIMIT_DEFAULTS[k];
  return out;
}

export function egressOf(t: any): EgressRule[] {
  const a = t?.egress?.allow;
  if (!Array.isArray(a)) return [];
  return a.filter((r) => r && typeof r.host === 'string').map((r) => ({ host: r.host, ports: Array.isArray(r.ports) && r.ports.length ? [...r.ports].sort((x: number, y: number) => x - y) : [443] }));
}

export function capabilitiesOf(t: any): Array<{ name: string; scope: string }> {
  const a = t?.capabilities;
  if (!Array.isArray(a)) return [];
  return a.filter((c) => c && typeof c.name === 'string').map((c) => ({ name: c.name, scope: typeof c.scope === 'string' ? c.scope : 'read' }));
}

const isWildcard = (host: string) => host.includes('*') || host === '0.0.0.0' || host === '::';
const isWriteScope = (scope: string) => /write|admin|delete|\*/.test(scope);

/** Static lint of one manifest. `files` lets it check the entrypoint exists (dir-relative or full paths). */
export function lintManifest(t: any, opts: { entrypointExists?: boolean } = {}): Finding[] {
  if (!t || typeof t !== 'object') return [];
  const out: Finding[] = [];
  const lim = limitsOf(t);
  if (lim.timeout_s > 600) out.push({ area: 'limits', severity: 'warn', text: `timeout_s ${lim.timeout_s}s is long; prefer splitting work or a harness tool.` });
  if (lim.memory_mb > 4096) out.push({ area: 'limits', severity: 'warn', text: `memory_mb ${lim.memory_mb} is high for a per-execution container.` });
  if (lim.cpus > 4) out.push({ area: 'limits', severity: 'warn', text: `cpus ${lim.cpus} is high for a per-execution container.` });
  for (const r of egressOf(t)) {
    if (isWildcard(r.host)) out.push({ area: 'egress', severity: 'risk', text: `egress to wildcard host "${r.host}" defeats default-deny.` });
    const odd = r.ports.filter((p) => p !== 443);
    if (odd.length) out.push({ area: 'egress', severity: 'warn', text: `egress to ${r.host} on non-TLS/unusual port(s) ${odd.join(', ')}.` });
  }
  for (const c of capabilitiesOf(t)) if (isWriteScope(c.scope)) out.push({ area: 'capabilities', severity: 'warn', text: `capability ${c.name} has write-level scope "${c.scope}".` });
  if (t?.exposure?.external_mcp === true) out.push({ area: 'exposure', severity: 'warn', text: 'exposed to external MCP clients.' });
  const lang = t?.language;
  const ep: string = typeof t?.entrypoint === 'string' ? t.entrypoint : '';
  if (ep && lang === 'python' && !ep.endsWith('.py')) out.push({ area: 'runtime', severity: 'warn', text: `python tool entrypoint "${ep}" is not a .py file.` });
  if (ep && lang === 'typescript' && !/\.(ts|mts|js|mjs)$/.test(ep)) out.push({ area: 'runtime', severity: 'warn', text: `typescript tool entrypoint "${ep}" is not a .ts/.js file.` });
  if (ep && opts.entrypointExists === false) out.push({ area: 'runtime', severity: 'risk', text: `entrypoint "${ep}" does not exist in the tool directory.` });
  if (egressOf(t).length && !capabilitiesOf(t).length) out.push({ area: 'egress', severity: 'info', text: 'direct egress without a broker capability: credentials must never be embedded in code; use broker_fetch for authenticated calls.' });
  return out;
}

/** Security-relevant differences between two manifests (base -> next). */
export function securityDiff(base: any, next: any): Finding[] {
  const out: Finding[] = [];
  if (!next) return out;
  const isNew = !base;
  const b = limitsOf(base);
  const n = limitsOf(next);
  for (const k of LIMIT_KEYS) {
    if (isNew) continue;
    if (n[k] > b[k]) out.push({ area: 'limits', severity: 'risk', text: `${k} raised ${b[k]} -> ${n[k]}` });
    else if (n[k] < b[k]) out.push({ area: 'limits', severity: 'info', text: `${k} lowered ${b[k]} -> ${n[k]}` });
  }
  const be = new Map(egressOf(base).map((r) => [r.host, r.ports]));
  const ne = new Map(egressOf(next).map((r) => [r.host, r.ports]));
  for (const [host, ports] of ne) {
    const old = be.get(host);
    if (!old) out.push({ area: 'egress', severity: 'risk', text: `egress allowed to ${host}:${ports.join(',')}` });
    else {
      const added = ports.filter((p) => !old.includes(p));
      const removed = old.filter((p) => !ports.includes(p));
      if (added.length) out.push({ area: 'egress', severity: 'risk', text: `egress to ${host} gains port(s) ${added.join(', ')}` });
      if (removed.length) out.push({ area: 'egress', severity: 'info', text: `egress to ${host} drops port(s) ${removed.join(', ')}` });
    }
  }
  for (const host of be.keys()) if (!ne.has(host)) out.push({ area: 'egress', severity: 'info', text: `egress to ${host} removed` });
  const bc = new Map(capabilitiesOf(base).map((c) => [c.name, c.scope]));
  const nc = new Map(capabilitiesOf(next).map((c) => [c.name, c.scope]));
  for (const [name, scope] of nc) {
    const old = bc.get(name);
    if (old === undefined) out.push({ area: 'capabilities', severity: 'risk', text: `capability ${name} (${scope}) requested` });
    else if (old !== scope) out.push({ area: 'capabilities', severity: isWriteScope(scope) && !isWriteScope(old) ? 'risk' : 'warn', text: `capability ${name} scope ${old} -> ${scope}` });
  }
  for (const name of bc.keys()) if (!nc.has(name)) out.push({ area: 'capabilities', severity: 'info', text: `capability ${name} dropped` });
  const bx = base?.exposure?.external_mcp === true;
  const nx = next?.exposure?.external_mcp === true;
  if (nx && !bx) out.push({ area: 'exposure', severity: 'risk', text: 'now exposed to external MCP clients' });
  if (bx && !nx) out.push({ area: 'exposure', severity: 'info', text: 'no longer exposed to external MCP clients' });
  const bs = base?.settings ?? {};
  const ns = next?.settings ?? {};
  for (const k of Object.keys(bs)) {
    if (bs[k]?.hidden === true && ns[k] && ns[k].hidden !== true) out.push({ area: 'settings', severity: 'risk', text: `setting ${k} is no longer hidden (becomes visible to/overridable by the model)` });
    if (bs[k]?.hidden === true && !ns[k]) out.push({ area: 'settings', severity: 'risk', text: `hidden setting ${k} removed (its server-side restriction disappears)` });
  }
  for (const k of Object.keys(ns)) if (ns[k]?.hidden === true && !(bs[k]?.hidden === true)) out.push({ area: 'settings', severity: 'info', text: `setting ${k} is now hidden` });
  if (!isNew && JSON.stringify(base?.connector ?? null) !== JSON.stringify(next?.connector ?? null)) out.push({ area: 'connector', severity: 'warn', text: 'connector schedule/domains changed' });
  if (!isNew && base?.language !== next?.language) out.push({ area: 'runtime', severity: 'warn', text: `language ${base?.language} -> ${next?.language}` });
  if (!isNew && base?.entrypoint !== next?.entrypoint) out.push({ area: 'runtime', severity: 'warn', text: `entrypoint ${base?.entrypoint} -> ${next?.entrypoint}` });
  if (isNew) {
    for (const r of egressOf(next)) if (!out.some((f) => f.text.includes(r.host))) out.push({ area: 'egress', severity: 'risk', text: `egress allowed to ${r.host}` });
  }
  return out;
}

export const SEVERITY_ORDER: Record<Severity, number> = { risk: 0, warn: 1, info: 2 };
export const sortFindings = (f: Finding[]) => [...f].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
