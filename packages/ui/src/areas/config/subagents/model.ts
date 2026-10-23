/** Subagent editor model ([05] §2): primitive catalog, grant helpers, form-level diff. Pure. */

export interface PrimitiveInfo {
  name: string;
  group: 'Content' | 'Knowledge' | 'Repositories' | 'Intake' | 'Sessions & circuits' | 'Evals' | 'Configuration';
  description: string;
}

/** Breadboard MCP primitives a Subagent may be allowlisted for (server `toolbox/primitives.ts`). Tool-code-only primitives (`run_tool`, `broker_fetch`) are excluded. */
export const PRIMITIVES: PrimitiveInfo[] = [
  { name: 'create_artifact', group: 'Content', description: 'Create an Artifact (intermediate or deliverable).' },
  { name: 'update_artifact', group: 'Content', description: 'Replace body/title, merge properties, add/remove tags; cuts a revision.' },
  { name: 'read_node', group: 'Content', description: 'Read any visible content node, head or a specific revision.' },
  { name: 'add_comment', group: 'Content', description: 'Comment on a node, optionally anchored to a revision + quote.' },
  { name: 'emit_edge', group: 'Content', description: 'Emit a typed lineage edge between nodes.' },
  { name: 'tag_need_input', group: 'Content', description: 'Ask for direction/review on an Artifact (non-blocking).' },
  { name: 'resolve_need_input', group: 'Content', description: 'Resolve an open need-input request.' },
  { name: 'query_knowledge', group: 'Knowledge', description: 'Search readable Knowledge Notes (text, semantic, hybrid).' },
  { name: 'read_note', group: 'Knowledge', description: 'Read a Note as Markdown plus its base revision.' },
  { name: 'propose_note_edit', group: 'Knowledge', description: 'Propose an edit to a Note in a writable domain (reconcile path).' },
  { name: 'create_note', group: 'Knowledge', description: 'Create a new Note in writable domains; queued for human review.' },
  { name: 'search_repo', group: 'Repositories', description: 'Search a granted repository mirror like grep (implied by a repos grant).' },
  { name: 'read_repo_file', group: 'Repositories', description: 'Read a file or directory of a granted repository mirror (implied by a repos grant).' },
  { name: 'create_task', group: 'Intake', description: 'Create a Task in the Intake queue.' },
  { name: 'find_similar_tasks', group: 'Intake', description: 'Find similar existing Tasks (duplicate detection).' },
  { name: 'run_circuit', group: 'Sessions & circuits', description: 'Invoke a circuit with an execute grant as a sub-session.' },
  { name: 'get_session_summary', group: 'Sessions & circuits', description: 'Summarize a visible session: state, cost, steps, children.' },
  { name: 'start_eval_run', group: 'Evals', description: 'Start an eval run of a circuit (main, a commit, or a proposal) with an execute grant.' },
  { name: 'record_score', group: 'Evals', description: "Record a rubric dimension's score (evaluator Subagents)." },
  { name: 'get_rubric', group: 'Evals', description: "Read a circuit's eval rubric." },
  { name: 'get_fixture_output', group: 'Evals', description: 'Read the output produced for a fixture in an eval run.' },
  { name: 'read_config', group: 'Configuration', description: 'Read a configuration-plane definition by UID, slug, or path.' },
  { name: 'search_config', group: 'Configuration', description: 'Find definitions by slug, title, UID, or path (metadata only).' },
  { name: 'validate_config', group: 'Configuration', description: 'Validate a prospective change set without committing.' },
  { name: 'propose_config_change', group: 'Configuration', description: 'Open or amend a config proposal for human review.' },
];

/** Applied when `primitives` is omitted (server `DEFAULT_PRIMITIVES`). */
export const DEFAULT_PRIMITIVES = ['create_artifact', 'update_artifact', 'read_node', 'add_comment', 'emit_edge', 'tag_need_input', 'query_knowledge', 'read_note', 'find_similar_tasks', 'get_session_summary'];

export function effectivePrimitives(s: any): { custom: boolean; list: string[] } {
  return Array.isArray(s?.primitives) ? { custom: true, list: s.primitives.filter((x: unknown) => typeof x === 'string') } : { custom: false, list: DEFAULT_PRIMITIVES };
}

export type Grant = { tool: string; settings?: Record<string, unknown> } | { mcp: string; allow?: string[] };
export const isMcpGrant = (g: any): g is { mcp: string; allow?: string[] } => !!g && typeof g === 'object' && 'mcp' in g;
export const isToolGrant = (g: any): g is { tool: string; settings?: Record<string, unknown> } => !!g && typeof g === 'object' && 'tool' in g;

/** Primitives whose usefulness depends on other grants; returned as human hints. */
export function grantHints(s: any): string[] {
  const out: string[] = [];
  const prim = new Set(effectivePrimitives(s).list);
  const circuits: any[] = Array.isArray(s?.circuits) ? s.circuits : [];
  const read: string[] = s?.knowledge?.read ?? [];
  const write: string[] = s?.knowledge?.write ?? [];
  if (prim.has('run_circuit') && !circuits.some((c) => c?.access === 'execute')) out.push('run_circuit is allowed but no circuit has an execute grant.');
  if (!prim.has('run_circuit') && circuits.some((c) => c?.access === 'execute')) out.push('Execute grants need the run_circuit primitive to be usable.');
  if (prim.has('propose_note_edit') && !write.length) out.push('propose_note_edit is allowed but no knowledge domain is writable.');
  if (prim.has('create_note') && !write.length) out.push('create_note is allowed but no knowledge domain is writable.');
  if (write.length && !prim.has('propose_note_edit')) out.push('Writable domains need the propose_note_edit primitive to be usable.');
  if ((prim.has('query_knowledge') || prim.has('read_note')) && !read.length) out.push('Knowledge primitives are allowed but no domain is readable.');
  const repos: string[] = Array.isArray(s?.repos) ? s.repos : [];
  if ((prim.has('search_repo') || prim.has('read_repo_file')) && !repos.length) out.push('Repository primitives are allowed but no repository is granted (repos).');
  const notRead = write.filter((d) => !read.includes(d));
  if (notRead.length) out.push(`Writable but not readable: ${notRead.join(', ')}.`);
  return out;
}

export interface FieldChange {
  field: string;
  kind: 'added' | 'removed' | 'changed';
  detail: string;
}

const j = (v: unknown) => JSON.stringify(v ?? null);
const grantKey = (g: any) => (isMcpGrant(g) ? `mcp:${g.mcp}` : isToolGrant(g) ? `tool:${g.tool}` : j(g));

/** Form-level diff for proposal review: what changed in each configuration component. */
export function subagentFieldDiff(base: any, next: any, label: (kind: string, uid: string) => string = (_k, u) => u): FieldChange[] {
  const out: FieldChange[] = [];
  base ??= {};
  next ??= {};
  for (const k of ['title', 'slug', 'description', 'model_preset'] as const) {
    if (j(base[k]) !== j(next[k])) out.push({ field: k, kind: base[k] === undefined ? 'added' : next[k] === undefined ? 'removed' : 'changed', detail: `${base[k] ?? '(none)'} -> ${next[k] ?? '(none)'}` });
  }
  if ((base.system_prompt ?? '') !== (next.system_prompt ?? '')) out.push({ field: 'system_prompt', kind: 'changed', detail: 'system prompt edited' });
  const bt = new Map<string, any>((base.tools ?? []).map((g: any) => [grantKey(g), g]));
  const nt = new Map<string, any>((next.tools ?? []).map((g: any) => [grantKey(g), g]));
  const nameOf = (g: any) => (isMcpGrant(g) ? `MCP ${label('mcp', g.mcp)}` : `tool ${label('tool', g.tool)}`);
  for (const [k, g] of nt) {
    const old = bt.get(k);
    if (!old) out.push({ field: 'tools', kind: 'added', detail: `${nameOf(g)} granted${isMcpGrant(g) && g.allow ? ` (allow: ${g.allow.join(', ') || 'none'})` : ''}` });
    else if (j(old) !== j(g)) out.push({ field: 'tools', kind: 'changed', detail: isMcpGrant(g) ? `${nameOf(g)} allowlist ${j(old.allow ?? 'server default')} -> ${j(g.allow ?? 'server default')}` : `${nameOf(g)} settings ${j(old.settings ?? {})} -> ${j(g.settings ?? {})}` });
  }
  for (const [k, g] of bt) if (!nt.has(k)) out.push({ field: 'tools', kind: 'removed', detail: `${nameOf(g)} revoked` });
  const bc = new Map<string, string>((base.circuits ?? []).map((c: any) => [c.circuit, c.access]));
  const nc = new Map<string, string>((next.circuits ?? []).map((c: any) => [c.circuit, c.access]));
  for (const [c, a] of nc) {
    if (!bc.has(c)) out.push({ field: 'circuits', kind: 'added', detail: `${a} on ${label('circuit', c)}` });
    else if (bc.get(c) !== a) out.push({ field: 'circuits', kind: 'changed', detail: `${label('circuit', c)} ${bc.get(c)} -> ${a}` });
  }
  for (const c of bc.keys()) if (!nc.has(c)) out.push({ field: 'circuits', kind: 'removed', detail: `${label('circuit', c)} revoked` });
  for (const side of ['read', 'write'] as const) {
    const b = new Set<string>(base.knowledge?.[side] ?? []);
    const n = new Set<string>(next.knowledge?.[side] ?? []);
    const add = [...n].filter((d) => !b.has(d));
    const rem = [...b].filter((d) => !n.has(d));
    if (add.length) out.push({ field: `knowledge.${side}`, kind: 'added', detail: add.join(', ') });
    if (rem.length) out.push({ field: `knowledge.${side}`, kind: 'removed', detail: rem.join(', ') });
  }
  const br = new Set<string>(base.repos ?? []);
  const nr = new Set<string>(next.repos ?? []);
  const addRepos = [...nr].filter((r) => !br.has(r));
  const remRepos = [...br].filter((r) => !nr.has(r));
  if (addRepos.length) out.push({ field: 'repos', kind: 'added', detail: addRepos.join(', ') });
  if (remRepos.length) out.push({ field: 'repos', kind: 'removed', detail: remRepos.join(', ') });
  const bp = effectivePrimitives(base);
  const np = effectivePrimitives(next);
  if (bp.custom !== np.custom || j([...bp.list].sort()) !== j([...np.list].sort())) {
    const add = np.list.filter((p) => !bp.list.includes(p));
    const rem = bp.list.filter((p) => !np.list.includes(p));
    out.push({ field: 'primitives', kind: 'changed', detail: [add.length && `+${add.join(', +')}`, rem.length && `-${rem.join(', -')}`, !add.length && !rem.length && (np.custom ? 'pinned explicitly' : 'reset to default')].filter(Boolean).join(' ') });
  }
  return out;
}
