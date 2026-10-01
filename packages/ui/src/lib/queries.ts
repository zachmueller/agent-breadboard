/**
 * TanStack Query hooks per resource. Other areas should reuse these (and `qk` for invalidation)
 * rather than issuing raw fetches, so caches stay coherent across views.
 */
import { useCallback, useMemo, useRef } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import type {
  ConfigDefinitionDto,
  LineageDto,
  NodeDto,
  NodeRevision,
  Page,
  ReviewQueueItemDto,
  SessionEvent,
  SessionSummaryDto,
  StreamEvent,
  Turn,
} from '@breadboard/shared';
import { TERMINAL_SESSION_STATES } from '@breadboard/shared';
import { asPage, del, get, patch, post, type Query } from './api';
import { payloadNodeUid, payloadSessionId, useLiveEvents } from './live';
import type {
  AuthModeDto,
  CommentAnchor,
  CommentDto,
  ConfigSearchHit,
  DispatcherCapacityDto,
  ExecutionDto,
  MeDto,
  RoleDto,
} from './types';

// ------------------------------------------------------------ query keys ---

export const qk = {
  authMode: ['auth', 'mode'] as const,
  me: ['me'] as const,
  node: (uid: string) => ['node', uid] as const,
  nodes: (filter: Query) => ['nodes', filter] as const,
  nodeRevisions: (uid: string) => ['node', uid, 'revisions'] as const,
  nodeRevision: (uid: string, rev: number) => ['node', uid, 'revision', rev] as const,
  lineage: (uid: string, direction: 'up' | 'down', depth: number) => ['node', uid, 'lineage', direction, depth] as const,
  edges: (uid: string, q: Query) => ['node', uid, 'edges', q] as const,
  comments: (uid: string) => ['node', uid, 'comments'] as const,
  markdown: (uid: string) => ['node', uid, 'markdown'] as const,
  session: (id: string) => ['session', id] as const,
  sessions: (filter: Query) => ['sessions', filter] as const,
  sessionEvents: (id: string) => ['session', id, 'events'] as const,
  stepTurns: (id: string, step: string) => ['session', id, 'turns', step] as const,
  sessionTurns: (id: string) => ['session', id, 'turns'] as const,
  executions: (id: string) => ['session', id, 'executions'] as const,
  reviewQueue: ['review-queue'] as const,
  reviewCount: ['review-queue', 'count'] as const,
  dashboard: ['dashboard'] as const,
  needInputHealth: (days: number) => ['health', 'need-input', days] as const,
  capacity: ['dispatcher', 'capacity'] as const,
  configSearch: (q: string) => ['config', 'search', q] as const,
  configTree: ['config', 'tree'] as const,
  configDefinition: (uid: string, ref?: string) => ['config', 'definition', uid, ref ?? 'main'] as const,
  roles: ['roles'] as const,
  admin: (what: string) => ['admin', what] as const,
};

/** Shared cursor-paging plumbing for `{items, next_cursor}` endpoints. */
function useCursorList<T>(key: readonly unknown[], path: string, query: Query, opts: { enabled?: boolean; limit?: number; refetchInterval?: number | false } = {}) {
  const q = useInfiniteQuery({
    queryKey: key,
    queryFn: async ({ pageParam, signal }) => asPage<T>(await get(path, { ...query, limit: opts.limit ?? 50, cursor: pageParam ?? undefined }, { signal })),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: opts.enabled ?? true,
    placeholderData: keepPreviousData,
    refetchInterval: opts.refetchInterval,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return { ...q, items };
}

// ------------------------------------------------------------------ auth ---

export function useAuthMode() {
  return useQuery({ queryKey: qk.authMode, queryFn: () => get<AuthModeDto>('/auth/mode'), staleTime: Infinity, retry: 1 });
}

export function useMe(enabled = true) {
  return useQuery({
    queryKey: qk.me,
    queryFn: async () => {
      // Server shape: `{user, roles, is_admin, actor, scopes, token_kind}`; tolerate a flat MeDto too.
      const r = await get<MeDto | { user: MeDto; roles?: unknown[]; is_admin?: boolean }>('/me');
      const wrapped = r as { user?: MeDto; roles?: unknown[]; is_admin?: boolean };
      const u: MeDto = wrapped.user ? { ...wrapped.user, is_admin: wrapped.is_admin ?? wrapped.user.is_admin, roles: (wrapped.roles as string[] | undefined) ?? wrapped.user.roles ?? [] } : (r as MeDto);
      const roles = (u.roles ?? []).map((x: unknown) => (typeof x === 'string' ? x : String((x as { slug?: string; role_id?: string })?.slug ?? (x as { role_id?: string })?.role_id ?? '')));
      return { ...u, roles, is_admin: !!u.is_admin } as MeDto;
    },
    staleTime: 5 * 60_000,
    retry: false,
    enabled,
  });
}

// ----------------------------------------------------------------- nodes ---

export interface NodeFilter {
  type?: string | string[];
  tag?: string | string[];
  scope?: string;
  need_input_role?: string;
  circuit?: string;
  q?: string;
  created_after?: string;
  [k: string]: Query[string];
}

export function useNode(uid: string | null | undefined, opts: Partial<UseQueryOptions<NodeDto>> = {}) {
  return useQuery<NodeDto>({
    queryKey: qk.node(uid ?? ''),
    queryFn: ({ signal }) => get<NodeDto>(`/nodes/${uid}`, undefined, { signal }),
    enabled: !!uid && (opts.enabled ?? true),
    staleTime: 15_000,
    ...opts,
  } as UseQueryOptions<NodeDto>);
}

export function useNodes(filter: NodeFilter, opts: { enabled?: boolean; limit?: number } = {}) {
  return useCursorList<NodeDto>(qk.nodes(filter), '/nodes', filter, opts);
}

export function useNodeRevisions(uid: string, enabled = true) {
  return useCursorList<NodeRevision>(qk.nodeRevisions(uid), `/nodes/${uid}/revisions`, {}, { enabled });
}

export function useNodeRevision(uid: string, rev: number | null) {
  return useQuery({ queryKey: qk.nodeRevision(uid, rev ?? -1), queryFn: () => get<NodeRevision>(`/nodes/${uid}/revisions/${rev}`), enabled: rev !== null, staleTime: Infinity });
}

export function useLineage(uid: string | null | undefined, direction: 'up' | 'down', depth = 1, enabled = true) {
  return useQuery({
    queryKey: qk.lineage(uid ?? '', direction, depth),
    queryFn: () => get<LineageDto>(`/nodes/${uid}/lineage`, { direction, depth }),
    enabled: !!uid && enabled,
    staleTime: 30_000,
  });
}

export function useNodeComments(uid: string) {
  return useQuery({
    queryKey: qk.comments(uid),
    queryFn: async () => asPage<CommentDto>(await get(`/nodes/${uid}/comments`, { limit: 200 })).items,
  });
}

/** Rendered Markdown for CRDT-backed nodes. */
export function useNodeMarkdown(uid: string, enabled = true) {
  return useQuery({
    queryKey: qk.markdown(uid),
    queryFn: async () => {
      const r = await get<unknown>(`/knowledge/${uid}/markdown`);
      if (typeof r === 'string') return { markdown: r, base_revision: null as number | null };
      const o = (r ?? {}) as { markdown?: string; body?: string; base_revision?: number | null };
      return { markdown: o.markdown ?? o.body ?? '', base_revision: o.base_revision ?? null };
    },
    enabled,
  });
}

export function usePatchNode(uid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Pick<NodeDto, 'title' | 'tags' | 'scope' | 'properties'>>) => patch<NodeDto>(`/nodes/${uid}`, body),
    onSuccess: (node) => {
      if (node && typeof node === 'object' && 'uid' in node) qc.setQueryData(qk.node(uid), node);
      qc.invalidateQueries({ queryKey: qk.node(uid) });
      qc.invalidateQueries({ queryKey: ['nodes'] });
    },
  });
}

export function useCreateComment(targetUid: string, invalidateUid?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { body: string; anchor?: CommentAnchor }) => post<NodeDto>(`/nodes/${targetUid}/comments`, body, { idempotencyKey: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.comments(invalidateUid ?? targetUid) }),
  });
}

function invalidateReview(qc: QueryClient, uid: string) {
  qc.invalidateQueries({ queryKey: qk.reviewQueue });
  qc.invalidateQueries({ queryKey: qk.node(uid) });
  qc.invalidateQueries({ queryKey: qk.dashboard });
  qc.invalidateQueries({ queryKey: ['sessions'] });
}

export function useResolveRequest(uid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ request_id, comment }: { request_id: string; comment?: string }) =>
      post(`/nodes/${uid}/need-input/${request_id}/resolve`, comment ? { comment } : {}),
    onSuccess: () => invalidateReview(qc, uid),
  });
}

export function useGateVerdict(uid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { request_id: string; verdict: 'approve' | 'request-changes'; comment?: string; edits?: unknown }) =>
      post(`/nodes/${uid}/gate-verdict`, body, { idempotencyKey: true }),
    onSuccess: () => invalidateReview(qc, uid),
  });
}

// -------------------------------------------------------------- sessions ---

export interface SessionFilter {
  state?: string | string[];
  kind?: string | string[];
  circuit?: string;
  task?: string;
  created_after?: string;
  [k: string]: Query[string];
}

const isLive = (s?: { state?: string } | null) => !!s && !TERMINAL_SESSION_STATES.includes(s.state as never);

/** Throttled invalidation helper for live-follow. */
function useThrottledInvalidate(ms = 400) {
  const qc = useQueryClient();
  const pending = useRef(new Map<string, readonly unknown[]>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(
    (...keys: Array<readonly unknown[]>) => {
      for (const k of keys) pending.current.set(JSON.stringify(k), k);
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        for (const k of pending.current.values()) qc.invalidateQueries({ queryKey: k });
        pending.current.clear();
      }, ms);
    },
    [qc, ms],
  );
}

export function useSession(id: string | null | undefined, opts: { live?: boolean } = {}) {
  const q = useQuery({
    queryKey: qk.session(id ?? ''),
    queryFn: ({ signal }) => get<SessionSummaryDto>(`/sessions/${id}`, undefined, { signal }),
    enabled: !!id,
  });
  const invalidate = useThrottledInvalidate();
  useLiveEvents(
    ['session.state', 'session.event'],
    (e) => {
      if (payloadSessionId(e) !== id) return;
      invalidate(qk.session(id!));
      if (e.topic === 'session.event') invalidate(qk.executions(id!), ['session', id!, 'turns']);
    },
    !!id && (opts.live ?? true) && isLive(q.data),
  );
  return q;
}

export function useSessions(filter: SessionFilter, opts: { enabled?: boolean; live?: boolean; limit?: number } = {}) {
  const list = useCursorList<SessionSummaryDto>(qk.sessions(filter), '/sessions', filter, opts);
  const invalidate = useThrottledInvalidate(1000);
  useLiveEvents(['session.state'], () => invalidate(['sessions']), opts.live ?? true);
  return list;
}

/** Event log with `after_seq` paging; live-follows (SSE `session.state`/`session.event`) while the session runs. */
export function useSessionEvents(id: string, opts: { live?: boolean; limit?: number } = {}) {
  const limit = opts.limit ?? 200;
  const q = useInfiniteQuery({
    queryKey: qk.sessionEvents(id),
    queryFn: async ({ pageParam, signal }) => {
      const r = await get<unknown>(`/sessions/${id}/events`, { after_seq: pageParam, limit }, { signal });
      return asPage<SessionEvent>(r);
    },
    initialPageParam: 0,
    getNextPageParam: (last) => {
      if (!last.items.length) return undefined;
      const lastSeq = last.items[last.items.length - 1]!.seq;
      // Cursor present, or a full page: there may be more.
      return last.next_cursor || last.items.length >= limit ? lastSeq : undefined;
    },
  });
  const invalidate = useThrottledInvalidate(300);
  useLiveEvents(
    ['session.state', 'session.event'],
    (e) => {
      if (payloadSessionId(e) === id) invalidate(qk.sessionEvents(id));
    },
    opts.live ?? true,
  );
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return { ...q, items };
}

/** Turn-by-turn chat for one step (LLM steps). */
export function useStepTurns(id: string, step: string | null, enabled = true) {
  return useQuery({
    queryKey: qk.stepTurns(id, step ?? ''),
    queryFn: async () => asPage<Turn & { attempt?: number; latency_ms?: number; fallback_from?: string | null }>(await get(`/sessions/${id}/steps/${encodeURIComponent(step!)}/turns`, { limit: 200 })).items,
    enabled: !!step && enabled,
  });
}

export function useSessionTurns(id: string, enabled = true) {
  return useQuery({
    queryKey: qk.sessionTurns(id),
    queryFn: async () => asPage<Turn>(await get(`/sessions/${id}/turns`, { limit: 200 })).items,
    enabled,
  });
}

export function useSessionExecutions(id: string, enabled = true) {
  return useQuery({
    queryKey: qk.executions(id),
    queryFn: async () => asPage<ExecutionDto>(await get(`/sessions/${id}/executions`, { limit: 200 })).items,
    enabled,
  });
}

export type SessionAction =
  | { action: 'retry'; step_id?: string }
  | { action: 'cancel'; reason?: string }
  | { action: 'resume'; budget?: { max_cost_usd?: number; max_tokens?: number } }
  | { action: 'route'; exit: string; output?: unknown }
  | { action: 'promote-fixture'; fixture_title: string };

export function useSessionAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: SessionAction) => {
      const { action, ...body } = a;
      return post<unknown>(`/sessions/${id}/${action}`, body, { idempotencyKey: true });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.session(id) });
      qc.invalidateQueries({ queryKey: qk.sessionEvents(id) });
      qc.invalidateQueries({ queryKey: ['sessions'] });
      qc.invalidateQueries({ queryKey: qk.reviewQueue });
      qc.invalidateQueries({ queryKey: qk.dashboard });
    },
  });
}

// ---------------------------------------------------------- review queue ---

export function useReviewQueue() {
  return useQuery({
    queryKey: qk.reviewQueue,
    queryFn: async () => asPage<ReviewQueueItemDto>(await get('/review-queue', { limit: 200 })).items,
  });
}

export function useReviewCount(enabled = true) {
  return useQuery({
    queryKey: qk.reviewCount,
    queryFn: async () => {
      const r = await get<unknown>('/review-queue/count');
      if (typeof r === 'number') return { count: r, gated: 0 };
      const o = (r ?? {}) as { count?: number; total?: number; gated?: number; gates?: number };
      return { count: o.count ?? o.total ?? 0, gated: o.gated ?? o.gates ?? 0 };
    },
    refetchInterval: 60_000,
    enabled,
  });
}

/** App-wide: keep the review badge / dashboard / content caches fresh from the event stream. */
export function useGlobalLiveInvalidation(active: boolean) {
  const invalidate = useThrottledInvalidate(800);
  useLiveEvents(
    ['need-input.tagged', 'need-input.resolved', 'session.state', 'node.updated', 'task.status'],
    (e: StreamEvent) => {
      if (e.topic.startsWith('need-input') || e.topic === 'session.state') invalidate(qk.reviewQueue, qk.dashboard);
      if (e.topic === 'node.updated' || e.topic.startsWith('need-input')) {
        const uid = payloadNodeUid(e);
        if (uid) invalidate(qk.node(uid));
      }
    },
    active,
  );
}

// -------------------------------------------------------------- dashboard ---

export function useDashboard() {
  return useQuery({ queryKey: qk.dashboard, queryFn: () => get<Record<string, unknown>>('/dashboard'), refetchInterval: 60_000 });
}

export function useNeedInputHealth(days = 30) {
  return useQuery({ queryKey: qk.needInputHealth(days), queryFn: () => get<unknown>('/health/need-input', { days }), staleTime: 5 * 60_000 });
}

export function useDispatcherCapacity() {
  return useQuery({ queryKey: qk.capacity, queryFn: () => get<DispatcherCapacityDto>('/dispatcher/capacity'), refetchInterval: 30_000 });
}

// ----------------------------------------------------------------- config ---

export function useConfigSearch(q: string, enabled = true) {
  return useQuery({
    queryKey: qk.configSearch(q),
    queryFn: async ({ signal }) => {
      const r = await get<unknown>('/config/search', { q, limit: 20 }, { signal });
      const o = r as { results?: ConfigSearchHit[] };
      return Array.isArray(o?.results) ? o.results : asPage<ConfigSearchHit>(r).items;
    },
    enabled: enabled && q.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useConfigDefinition(uid: string | null | undefined, ref?: string) {
  return useQuery({
    queryKey: qk.configDefinition(uid ?? '', ref),
    queryFn: () => get<ConfigDefinitionDto>(`/config/definitions/${uid}`, { ref }),
    enabled: !!uid,
    staleTime: 30_000,
  });
}

/** All config definitions at main (`GET /config/tree`) — used to label circuit/subagent/tool UIDs with slugs. */
export function useConfigTree(enabled = true) {
  return useQuery({
    queryKey: qk.configTree,
    queryFn: async () => {
      const r = await get<unknown>('/config/tree');
      const o = r as { entries?: ConfigSearchHit[] };
      return Array.isArray(o?.entries) ? o.entries : asPage<ConfigSearchHit>(r).items;
    },
    staleTime: 5 * 60_000,
    enabled,
  });
}

/** uid → tree entry lookup over `useConfigTree`. */
export function useConfigIndex() {
  const t = useConfigTree();
  const data = t.data;
  return useMemo(() => {
    const m = new Map<string, ConfigSearchHit>();
    for (const e of data ?? []) if (e.uid) m.set(e.uid, e);
    return m;
  }, [data]);
}

export function useRoles() {
  return useQuery({ queryKey: qk.roles, queryFn: async () => asPage<RoleDto>(await get('/roles')).items, staleTime: 5 * 60_000 });
}

// ------------------------------------------------------------------ admin ---

export function useAdminList<T>(what: string, path: string, enabled = true) {
  return useQuery({ queryKey: qk.admin(what), queryFn: async () => asPage<T>(await get(path, { limit: 200 })).items, enabled });
}

export function useAdminMutation<TVars>(fn: (v: TVars) => Promise<unknown>, invalidate: string[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const w of invalidate) qc.invalidateQueries({ queryKey: qk.admin(w) });
      qc.invalidateQueries({ queryKey: qk.roles });
    },
  });
}

export { del, get, patch, post };
export type { Page };
