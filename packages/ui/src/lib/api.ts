/**
 * Typed fetch client for the Breadboard REST API ([11] §2–§3, §5).
 * Base `/api/v1`; bearer token from `localStorage.bb_token` (cookies are sent too);
 * `{error:{code,message,detail}}` responses become `ApiError`.
 */
import type { Page, StreamEvent } from '@breadboard/shared';
import { classifyEdgeForbidden, isEdgeRedirect, looksLikeEdgeAuthPage } from './edge-auth';

export const API_BASE = '/api/v1';
export const TOKEN_KEY = 'bb_token';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;
  constructor(code: string, message: string, status: number, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
  get isNotFound() {
    return this.status === 404 || this.code === 'not-found' || this.code === 'note-not-found';
  }
  get isUnauthorized() {
    return this.status === 401 || this.code === 'unauthorized';
  }
  get isForbidden() {
    return this.status === 403 || this.code === 'forbidden' || this.code === 'grant-denied';
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

const STATUS_CODES: Record<number, string> = {
  400: 'validation-failed',
  401: 'unauthorized',
  402: 'budget-exceeded',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
  422: 'validation-failed',
  429: 'rate-limited',
  501: 'not-implemented',
};

/** Map an HTTP failure (status + parsed body, if any) to an ApiError. Pure; exported for tests. */
export function toApiError(status: number, body: unknown, statusText = ''): ApiError {
  const err = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown; detail?: unknown };
    const code = typeof e.code === 'string' && e.code ? e.code : (STATUS_CODES[status] ?? (status >= 500 ? 'internal' : 'error'));
    const message = typeof e.message === 'string' && e.message ? e.message : statusText || code;
    return new ApiError(code, message, status, e.detail);
  }
  if (typeof err === 'string') return new ApiError(STATUS_CODES[status] ?? 'error', err, status);
  const code = STATUS_CODES[status] ?? (status >= 500 ? 'internal' : 'error');
  const message = typeof body === 'string' && body.trim() && body.length < 300 ? body.trim() : statusText || `Request failed (${status})`;
  return new ApiError(code, message, status, body ?? undefined);
}

/** Human-readable error text for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---------------------------------------------------------------- token ---

const unauthorizedListeners = new Set<() => void>();

export function getToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Subscribe to 401 responses (the auth layer uses this to drop to the login screen). */
export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

// ------------------------------------------------------------------ url ---

export type QueryValue = string | number | boolean | null | undefined | Array<string | number | boolean>;
export type Query = Record<string, QueryValue>;

/** Build `/api/v1/<path>?…`. Arrays become repeated params (OR within a field, [11] §2); empty values are dropped. */
export function buildUrl(path: string, query?: Query): string {
  const p = path.startsWith('http') || path.startsWith(API_BASE) ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  if (!query) return p;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      for (const x of v) if (x !== '' && x !== null && x !== undefined) sp.append(k, String(x));
    } else sp.append(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${p}${p.includes('?') ? '&' : '?'}${qs}` : p;
}

// -------------------------------------------------------------- request ---

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Send an Idempotency-Key header ([11] §2). `true` mints one. */
  idempotencyKey?: string | true;
  /** Return raw text instead of parsing JSON. */
  text?: boolean;
}

export async function request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (typeof FormData !== 'undefined' && opts.body instanceof FormData) body = opts.body;
    else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
  } else if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
    // Fastify rejects empty JSON bodies; send `{}` for bodiless mutations.
    headers['Content-Type'] = 'application/json';
    body = '{}';
  }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey === true ? crypto.randomUUID() : opts.idempotencyKey;

  let res: Response;
  try {
    // `manual`: the API never redirects, so a redirect is a proxy sending us to its sign-in page; following it would
    // end in a cross-origin CORS failure that looks like the server being down.
    res = await fetch(buildUrl(path, opts.query), { method, headers, body, credentials: 'include', redirect: 'manual', signal: opts.signal });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ApiError('network', 'Could not reach the Breadboard server', 0, e);
  }
  if (isEdgeRedirect(res)) {
    const edge = await classifyEdgeForbidden();
    throw new ApiError(edge.code, edge.message, 403, { edgeAuth: true, reloading: edge.reloading });
  }
  const raw = await res.text();
  let parsed: unknown = undefined;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }
  if (!res.ok) {
    // An authenticating proxy answered instead of the API (edge-auth.ts): reload through its sign-in, or report a
    // permission denial whose JSON body the proxy replaced.
    if (looksLikeEdgeAuthPage(res.status, res.headers.get('content-type'), raw)) {
      const edge = await classifyEdgeForbidden();
      throw new ApiError(edge.code, edge.message, 403, { edgeAuth: true, reloading: edge.reloading });
    }
    const err = toApiError(res.status, parsed, res.statusText);
    if (err.isUnauthorized) for (const fn of unauthorizedListeners) fn();
    throw err;
  }
  if (opts.text) return raw as T;
  return parsed as T;
}

export const get = <T = unknown>(path: string, query?: Query, opts: Omit<RequestOptions, 'query'> = {}) => request<T>('GET', path, { ...opts, query });
export const post = <T = unknown>(path: string, body?: unknown, opts: RequestOptions = {}) => request<T>('POST', path, { ...opts, body });
export const put = <T = unknown>(path: string, body?: unknown, opts: RequestOptions = {}) => request<T>('PUT', path, { ...opts, body });
export const patch = <T = unknown>(path: string, body?: unknown, opts: RequestOptions = {}) => request<T>('PATCH', path, { ...opts, body });
export const del = <T = unknown>(path: string, opts: RequestOptions = {}) => request<T>('DELETE', path, opts);

/** Accept either a `{items, next_cursor}` page or a bare array (tolerant of endpoints that return lists). */
export function asPage<T>(x: unknown): Page<T> {
  if (Array.isArray(x)) return { items: x as T[], next_cursor: null };
  if (x && typeof x === 'object' && Array.isArray((x as Page<T>).items)) {
    const p = x as Page<T>;
    return { items: p.items, next_cursor: p.next_cursor ?? null };
  }
  return { items: [], next_cursor: null };
}

/** Iterate every item across cursor pages. */
export async function* pages<T>(path: string, query: Query = {}, opts: { limit?: number; max?: number; signal?: AbortSignal } = {}): AsyncGenerator<T> {
  let cursor: string | null = null;
  let n = 0;
  do {
    const page: Page<T> = asPage<T>(await get(path, { ...query, limit: opts.limit ?? query.limit ?? 50, cursor: cursor ?? undefined }, { signal: opts.signal }));
    for (const item of page.items) {
      yield item;
      if (opts.max && ++n >= opts.max) return;
    }
    cursor = page.next_cursor;
  } while (cursor);
}

/** Collect all pages into an array (bounded by `max`, default 1000). */
export async function getAll<T>(path: string, query: Query = {}, max = 1000): Promise<T[]> {
  const out: T[] = [];
  for await (const item of pages<T>(path, query, { max })) out.push(item);
  return out;
}

// ------------------------------------------------------------------ SSE ---

export interface SseHandle {
  close(): void;
}

export interface SseOptions {
  /** Resume after this event id (sent as `last_event_id`; the browser also sends `Last-Event-ID` on auto-reconnect). */
  lastEventId?: string | null;
  onOpen?: () => void;
  onError?: (e: Event) => void;
}

/** Normalize an SSE message into a StreamEvent (server may send named events or a JSON envelope). */
export function parseStreamEvent(data: string, fallbackTopic: string | null, lastEventId: string): StreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Partial<StreamEvent> & Record<string, unknown>;
  const topic = (typeof o.topic === 'string' ? o.topic : fallbackTopic) as StreamEvent['topic'] | null;
  if (!topic) return null;
  const payload = o.payload && typeof o.payload === 'object' ? (o.payload as Record<string, unknown>) : (o as Record<string, unknown>);
  return {
    id: typeof o.id === 'string' ? o.id : lastEventId,
    topic,
    at: typeof o.at === 'string' ? o.at : new Date().toISOString(),
    payload,
    visibility: (o.visibility as StreamEvent['visibility']) ?? { scope: 'team' },
  };
}

/**
 * Subscribe to the Breadboard event stream (`GET /api/v1/events?topics=…`, [11] §5).
 * EventSource can't set headers, so the bearer goes in `?access_token=` (the server accepts it).
 * Delivery is at-least-once: duplicates are dropped by event id.
 */
export function sse(topics: readonly string[], onEvent: (e: StreamEvent) => void, opts: SseOptions = {}): SseHandle {
  if (typeof EventSource === 'undefined') return { close() {} };
  let lastId = opts.lastEventId ?? null;
  const seen = new Set<string>();
  let es: EventSource | null = null;
  let closed = false;
  let retry = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const handle = (fallbackTopic: string | null) => (msg: MessageEvent) => {
    const ev = parseStreamEvent(String(msg.data), fallbackTopic, msg.lastEventId);
    if (!ev) return;
    if (ev.id) {
      if (seen.has(ev.id)) return;
      seen.add(ev.id);
      if (seen.size > 2000) seen.delete(seen.values().next().value as string);
      lastId = ev.id;
    }
    onEvent(ev);
  };

  const open = () => {
    if (closed) return;
    const url = buildUrl('/events', { topics: topics.join(','), access_token: getToken() ?? undefined, last_event_id: lastId ?? undefined });
    es = new EventSource(url, { withCredentials: true });
    es.onopen = () => {
      retry = 1000;
      opts.onOpen?.();
    };
    es.onmessage = handle(null);
    for (const t of topics) es.addEventListener(t, handle(t) as EventListener);
    es.onerror = (e) => {
      opts.onError?.(e);
      // The browser auto-reconnects while CONNECTING; if it gave up (CLOSED), reopen with backoff.
      if (es && es.readyState === EventSource.CLOSED && !closed) {
        es = null;
        timer = setTimeout(open, retry);
        retry = Math.min(retry * 2, 30_000);
      }
    };
  };
  open();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      es?.close();
      es = null;
    },
  };
}
