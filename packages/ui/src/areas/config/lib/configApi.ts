/**
 * Typed wrappers over the configuration-plane, evals, and conversation REST surface ([11] §3).
 * Response normalizers are deliberately tolerant (array vs `{items}` envelopes, field aliases)
 * so the editors keep working while the server modules converge.
 */
import { useQuery, useQueries } from '@tanstack/react-query';
import type { ConfigDefinitionDto, ConfigTreeEntry, ProposalDto } from '@breadboard/shared';
import { api } from '../ui';

export type Validation = { ok: boolean; errors: string[]; warnings: string[] };
export type FileChange = { path: string; content: string | null };

export interface HistoryEntry {
  commit: string;
  author: string;
  date: string | null;
  message: string;
}

export interface EvalResultRow {
  fixture_id: string;
  scored_session: string | null;
  dimension: string;
  dim_type: string;
  value: unknown;
  rationale: string | null;
  cost_usd: number | null;
}

export interface EvalRunDto {
  eval_run_id: string;
  circuit_uid: string;
  circuit_commit: string | null;
  rubric_commit: string | null;
  status: string;
  aggregate: number | null;
  pass_rate: number | null;
  cost_usd: number | null;
  created_at: string | null;
  fixture_tags: string[];
  model_overrides: Record<string, string> | null;
  judge_model_id: string | null;
  proposal_id: string | null;
  results: EvalResultRow[];
  raw: Record<string, unknown>;
}

/* ------------------------------------------------------------------ normalizers */

export function listOf<T = any>(r: unknown, ...keys: string[]): T[] {
  if (Array.isArray(r)) return r as T[];
  if (r && typeof r === 'object') {
    for (const k of [...keys, 'items', 'entries', 'data', 'results', 'rows']) {
      const v = (r as any)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export function normalizeHistory(r: unknown): HistoryEntry[] {
  return listOf<any>(r, 'commits', 'history').map((c) => ({
    commit: String(c.commit ?? c.hash ?? c.sha ?? c.id ?? ''),
    author: typeof c.author === 'string' ? c.author : (c.author?.name ?? c.author?.handle ?? c.author_name ?? c.actor?.id ?? ''),
    date: c.date ?? c.committed_at ?? c.timestamp ?? c.created_at ?? c.author?.date ?? null,
    message: String(c.message ?? c.subject ?? c.summary ?? ''),
  }));
}

export function normalizeResultRow(x: any): EvalResultRow {
  return {
    fixture_id: String(x.fixture_id ?? x.fixture ?? ''),
    scored_session: x.scored_session ?? x.scored_session_id ?? x.session_id ?? null,
    dimension: String(x.dimension ?? x.key ?? '*'),
    dim_type: String(x.dim_type ?? x.type ?? ''),
    value: x.value,
    rationale: x.rationale ?? null,
    cost_usd: num(x.cost_usd),
  };
}

/**
 * `GET /evals/runs/:id` groups results per fixture (`{fixture_id, scored_session, aggregate,
 * dimensions[{dimension,type,value,rationale,cost_usd}]}`); flat result rows are accepted too.
 */
export function flattenResults(items: any[]): EvalResultRow[] {
  const out: EvalResultRow[] = [];
  for (const it of items) {
    if (it && Array.isArray(it.dimensions)) {
      const base = { fixture_id: it.fixture_id, scored_session: it.scored_session ?? it.session_id };
      if (it.aggregate !== undefined && it.aggregate !== null) out.push(normalizeResultRow({ ...base, dimension: '*', dim_type: 'aggregate', value: it.aggregate, cost_usd: 0 }));
      for (const d of it.dimensions) out.push(normalizeResultRow({ ...base, ...d }));
    } else if (it) out.push(normalizeResultRow(it));
  }
  return out;
}

/** Numeric reading of an aggregate-row value (number | {score}). */
export function scoreOf(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v && typeof v === 'object') return num((v as any).score ?? (v as any).value ?? (v as any).aggregate);
  return num(v);
}

export function normalizeRun(x: any): EvalRunDto {
  const run = x?.run ?? x;
  const results = flattenResults(listOf<any>(x?.results ?? run?.results ?? []));
  const aggRows = results.filter((r) => r.dimension === '*');
  const summary = run?.summary ?? x?.summary ?? {};
  let aggregate = num(run?.aggregate ?? summary.aggregate ?? summary.mean_aggregate);
  if (aggregate === null && aggRows.length) {
    const vals = aggRows.map((r) => scoreOf(r.value)).filter((v): v is number => v !== null);
    if (vals.length) aggregate = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  let pass_rate = num(run?.pass_rate ?? summary.pass_rate);
  if (pass_rate === null && aggRows.length) {
    const passes = aggRows.filter((r) => (r.value as any)?.pass === true || (r.value as any)?.passed === true);
    if (passes.length) pass_rate = passes.length / aggRows.length;
  }
  let cost = num(run?.cost_usd ?? summary.cost_usd ?? summary.total_cost_usd);
  if (cost === null && results.length) cost = results.reduce((a, r) => a + (r.cost_usd ?? 0), 0);
  return {
    eval_run_id: String(run?.eval_run_id ?? run?.id ?? ''),
    circuit_uid: String(run?.circuit_uid ?? run?.circuit ?? ''),
    circuit_commit: run?.circuit_commit ?? run?.ref ?? null,
    rubric_commit: run?.rubric_commit ?? null,
    status: String(run?.status ?? run?.state ?? (results.length ? 'completed' : 'unknown')),
    aggregate,
    pass_rate,
    cost_usd: cost,
    created_at: run?.created_at ?? null,
    fixture_tags: Array.isArray(run?.fixture_tags) ? run.fixture_tags : [],
    model_overrides: run?.model_overrides ?? null,
    judge_model_id: run?.judge_model_id ?? null,
    proposal_id: run?.proposal_id ?? null,
    results,
    raw: run ?? {},
  };
}

export const isRunTerminal = (status: string) => ['completed', 'failed', 'cancelled', 'error', 'done'].includes(status);

/* ------------------------------------------------------------------ endpoints */

export interface ConversationTurn {
  turn_id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  username: string | null;
  content: unknown;
  created_at: string;
  cost_usd: number | null;
}


const enc = encodeURIComponent;
const q = (params: Record<string, string | number | undefined | null>) => {
  const s = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`)
    .join('&');
  return s ? `?${s}` : '';
};

export const configApi = {
  tree: async (ref?: string): Promise<ConfigTreeEntry[]> => listOf<ConfigTreeEntry>(await api.get(`/config/tree${q({ ref })}`), 'tree', 'definitions'),
  definition: (uidOrPath: string, ref?: string) => api.get<ConfigDefinitionDto>(`/config/definitions/${enc(uidOrPath)}${q({ ref })}`),
  /** Try each id form in turn (e.g. `breadboard` then `breadboard.yaml`); returns null when all 404. */
  definitionAny: async (ids: string[], ref?: string): Promise<ConfigDefinitionDto | null> => {
    let lastErr: unknown = null;
    for (const id of ids) {
      try {
        return await configApi.definition(id, ref);
      } catch (e) {
        lastErr = e;
        const status = (e as any)?.status;
        if (status !== undefined && status !== 404 && status !== 400) throw e;
      }
    }
    if ((lastErr as any)?.status === 404 || (lastErr as any)?.status === 400) return null;
    if (lastErr) throw lastErr;
    return null;
  },
  validate: (changes: FileChange[], base?: string | null) => api.post<Validation>('/config/validate', { changes, ...(base ? { base } : {}) }),
  commit: (changes: FileChange[], message: string) => api.post<{ commit?: string; head?: string }>('/config/commit', { changes, message }),
  newDefinition: (body: { kind: string; slug: string; title: string; language?: string }) => api.post<{ changes: FileChange[]; uid?: string }>('/config/new', body),
  history: async (path: string, limit = 50) => normalizeHistory(await api.get(`/config/history${q({ path, limit })}`)),
  main: async (): Promise<string | null> => {
    const r: any = await api.get('/config/main');
    return typeof r === 'string' ? r : (r?.commit ?? r?.head ?? r?.main ?? null);
  },
  revert: (to_commit: string, path?: string) => api.post<{ commit?: string }>('/config/revert', { to_commit, ...(path ? { path } : {}) }),
  proposals: async (status = 'open') => listOf<ProposalDto>(await api.get(`/config/proposals${q({ status })}`), 'proposals'),
  proposal: async (id: string): Promise<ProposalDto> => {
    const r: any = await api.get(`/config/proposals/${enc(id)}`);
    return (r?.proposal ?? r) as ProposalDto;
  },
  createProposal: (changes: FileChange[], message: string) => api.post<ProposalDto>('/config/proposals', { changes, message }),
  merge: (id: string) => api.post<unknown>(`/config/proposals/${enc(id)}/merge`, {}),
  discard: (id: string) => api.post<unknown>(`/config/proposals/${enc(id)}/discard`, {}),
  amend: (id: string, changes: FileChange[], message: string) => api.post<ProposalDto>(`/config/proposals/${enc(id)}/amend`, { changes, message }),
};

export const evalsApi = {
  launch: async (body: { circuit: string; ref?: string; fixture_tags?: string[]; model_overrides?: Record<string, string>; proposal_id?: string }) => normalizeRun(await api.post('/evals/runs', body)),
  runs: async (circuit: string) => listOf<any>(await api.get(`/evals/runs${q({ circuit })}`), 'runs').map(normalizeRun),
  run: async (id: string) => normalizeRun(await api.get(`/evals/runs/${enc(id)}`)),
  analysis: <T = any>(circuit: string, view: string, params: Record<string, string | undefined> = {}) => api.get<T>(`/evals/analysis/${enc(circuit)}${q({ view, ...params })}`),
  /** "Promote to fixture" ([04] §3): commits the session's input into fixtures.yaml on main. */
  promoteFixture: (body: { session_id: string; fixture_title: string; tags?: string[]; notes?: string }) => api.post<{ fixture_id: string; commit: string }>('/evals/fixtures', body),
};

export interface KnowledgeHit {
  uid: string;
  title: string;
  domains?: string[];
}

export const miscApi = {
  roles: async (): Promise<string[]> => {
    const r = await api.get('/roles');
    return listOf<any>(r, 'roles')
      .map((x) => (typeof x === 'string' ? x : (x.role ?? x.name ?? x.slug)))
      .filter(Boolean);
  },
  knowledgeDomains: async (): Promise<Array<{ slug: string; description?: string }>> =>
    listOf<any>(await api.get('/knowledge/domains'), 'domains').map((d) => (typeof d === 'string' ? { slug: d } : { slug: d.slug ?? d.name, description: d.description })),
  knowledgeSearch: async (text: string): Promise<KnowledgeHit[]> =>
    listOf<any>(await api.get(`/knowledge/search${q({ q: text })}`), 'hits', 'notes').map((h) => ({
      uid: h.uid ?? h.node?.uid,
      title: h.title ?? h.node?.title ?? h.uid,
      domains: h.domains ?? h.properties?.domains,
    })),
  node: (uid: string) => api.get<{ uid: string; title: string; type: string }>(`/nodes/${enc(uid)}`),
};

/* ------------------------------------------------------------------ query hooks */

export interface ConversationSnapshot {
  state: string | null;
  turns: ConversationTurn[];
  busy: boolean;
  last_error: string | null;
  proposals: string[];
}

export const convApi = {
  /** `POST /conversations` returns the session record ([08] §4 / [10] §4 designer chat). */
  start: async (body: { kind: 'conversation'; subagent_uid: string; context: Record<string, unknown>; title: string }): Promise<{ session_id: string }> => {
    const r = await api.post<any>('/conversations', body);
    const s = r?.session ?? r;
    return { session_id: String(s?.session_id ?? s?.id ?? '') };
  },
  /** Transcript plus reply progress: `busy` while the server runs a reply, `last_error` when the last one failed. */
  get: async (id: string): Promise<ConversationSnapshot> => {
    const r = await api.get<any>(`/conversations/${enc(id)}`);
    return {
      state: r?.session?.state ?? null,
      turns: listOf<ConversationTurn>(r?.turns ?? []),
      busy: r?.busy === true,
      last_error: typeof r?.last_error === 'string' && r.last_error ? r.last_error : null,
      proposals: listOf<unknown>(r?.proposals ?? []).map(String).filter(Boolean),
    };
  },
  /**
   * Hand a message to the designer. The server accepts it at once (`Prefer: respond-async`) and replies in the
   * background, since a reply can outlast any proxy timeout; follow it with `get`. The key makes a resend safe.
   */
  submit: async (id: string, text: string, context: Record<string, unknown>, idempotencyKey: string): Promise<void> => {
    await api.post(`/conversations/${enc(id)}/messages`, { text, context }, { headers: { Prefer: 'respond-async' }, idempotencyKey });
  },
};

export const qk = {
  tree: (ref?: string) => ['config', 'tree', ref ?? 'main'] as const,
  def: (id: string, ref?: string) => ['config', 'definition', id, ref ?? 'main'] as const,
  history: (path: string) => ['config', 'history', path] as const,
  runs: (circuit: string) => ['evals', 'runs', circuit] as const,
  run: (id: string) => ['evals', 'run', id] as const,
  proposal: (id: string) => ['config', 'proposal', id] as const,
};

export function useConfigTree(ref?: string) {
  return useQuery({ queryKey: qk.tree(ref), queryFn: () => configApi.tree(ref), staleTime: 15_000 });
}

export function useTreeOfKind(kind: string) {
  const t = useConfigTree();
  return { ...t, data: (t.data ?? []).filter((e) => e.kind === kind) };
}

/** uid → tree entry, for slug display of UID references. */
export function useTreeIndex() {
  const t = useConfigTree();
  const map = new Map<string, ConfigTreeEntry>();
  for (const e of t.data ?? []) if (e.uid && (!map.has(e.uid) || e.kind === 'circuit' || e.kind === 'tool')) map.set(`${e.kind}:${e.uid}`, e);
  return {
    loading: t.isLoading,
    get: (kind: string, uid: string | null | undefined) => (uid ? map.get(`${kind}:${uid}`) : undefined),
  };
}

export function useDefinition(id: string | null | undefined, ref?: string) {
  return useQuery({ queryKey: qk.def(id ?? '', ref), queryFn: () => configApi.definition(id!, ref), enabled: !!id, staleTime: 15_000, retry: false });
}

export function useDefinitions(ids: string[]) {
  return useQueries({
    queries: ids.map((id) => ({ queryKey: qk.def(id), queryFn: () => configApi.definition(id), staleTime: 30_000, retry: false })),
  });
}

export function useHistory(path: string | null, limit = 50) {
  return useQuery({ queryKey: [...qk.history(path ?? ''), limit], queryFn: () => configApi.history(path!, limit), enabled: !!path, staleTime: 15_000 });
}

/** Breadboard settings (`breadboard.yaml`) — designers, knowledge domains, etc. */
export function useBreadboardSettings() {
  return useQuery({
    queryKey: ['config', 'breadboard-settings'],
    queryFn: async () => (await configApi.definitionAny(['breadboard', 'breadboard.yaml']))?.definition as any,
    staleTime: 60_000,
    retry: false,
  });
}

/** Model presets (`presets/models.yaml`) parsed definition. */
export function usePresets() {
  return useQuery({
    queryKey: ['config', 'presets'],
    queryFn: async () => (await configApi.definitionAny(['presets', 'presets/models.yaml']))?.definition as { presets?: Record<string, Array<{ model_id: string; provider?: string }>> } | undefined,
    staleTime: 60_000,
    retry: false,
  });
}

export function useRoles() {
  return useQuery({ queryKey: ['roles'], queryFn: miscApi.roles, staleTime: 60_000, retry: false });
}

export function useKnowledgeDomains() {
  const settings = useBreadboardSettings();
  const q1 = useQuery({ queryKey: ['knowledge', 'domains'], queryFn: miscApi.knowledgeDomains, staleTime: 60_000, retry: false });
  const fromSettings: Array<{ slug: string; description?: string }> = settings.data?.knowledge?.domains ?? [];
  return { ...q1, data: q1.data && q1.data.length ? q1.data : fromSettings };
}

export function useLatestRun(circuit: string) {
  return useQuery({ queryKey: qk.runs(circuit), queryFn: () => evalsApi.runs(circuit), staleTime: 30_000, retry: false, select: (runs) => latestFirst(runs)[0] ?? null });
}

export function latestFirst(runs: EvalRunDto[]): EvalRunDto[] {
  return [...runs].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
}
