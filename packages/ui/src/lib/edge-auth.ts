/**
 * Recovery from an authenticating proxy in front of the server (e.g. CloudFront with a signed-cookie gate). Its session
 * expires on its own clock and only a top-level navigation renews it. Until then every request (fetch, EventSource,
 * WebSocket upgrade) gets the proxy's HTML 403 page instead of the API. The server itself only ever answers JSON, so a
 * 403 with an HTML body identifies the proxy; reloading the page sends the browser through the proxy's sign-in and
 * back to the same URL.
 *
 * A proxy that rewrites every 403 also rewrites the server's own permission denials. The public, never-403
 * `GET /api/v1/health` tells the two apart before anything reloads.
 *
 * Kept free of imports from `api.ts`, which imports this module.
 */
export const EDGE_AUTH_CODE = 'edge-auth-expired';
/** Matches `API_BASE` in api.ts. Public on the server, never 403. */
const HEALTH_URL = '/api/v1/health';
const RELOAD_KEY = 'bb_edge_reload_at';
/** At most one automatic reload per this interval, so a misbehaving proxy cannot put the page in a reload loop. */
export const RELOAD_MIN_INTERVAL_MS = 30_000;
/** Status-less transports (EventSource, WebSocket) fail in bursts; probe at most this often. */
const LOSS_PROBE_INTERVAL_MS = 5_000;

export type EdgeProbe = 'ok' | 'edge-auth' | 'unknown';

/** A 403 whose body is an HTML page: something other than the API answered. */
export function looksLikeEdgeAuthPage(status: number, contentType: string | null, body: string): boolean {
  if (status !== 403) return false;
  if (contentType && /\bjson\b/i.test(contentType)) return false;
  if (contentType && /\btext\/html\b/i.test(contentType)) return true;
  return /^\s*<(?:!doctype html|html)[\s>]/i.test(body);
}

export interface EdgeAuthDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
  /** null: storage unavailable. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  reload?: () => void;
}

function sessionStore(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Reload the page unless one was triggered within RELOAD_MIN_INTERVAL_MS (tracked in sessionStorage, which survives
 * the reload). Returns whether it reloaded. Without storage there is no loop guard, so it does not reload at all.
 */
export function reloadForEdgeAuth(deps: EdgeAuthDeps = {}): boolean {
  const now = (deps.now ?? Date.now)();
  const storage = deps.storage !== undefined ? deps.storage : sessionStore();
  if (!storage) return false;
  try {
    const last = storage.getItem(RELOAD_KEY);
    if (last !== null && Number.isFinite(Number(last)) && now - Number(last) < RELOAD_MIN_INTERVAL_MS) return false;
    storage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  (deps.reload ?? (() => globalThis.location.reload()))();
  return true;
}

let inflight: Promise<EdgeProbe> | null = null;

/** Ask the public health endpoint whether the proxy (rather than the server) is refusing this browser. */
export function probeEdgeAuth(fetchFn: typeof fetch = globalThis.fetch): Promise<EdgeProbe> {
  inflight ??= (async (): Promise<EdgeProbe> => {
    try {
      const res = await fetchFn(HEALTH_URL, { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (res.ok) return 'ok';
      const body = await res.text().catch(() => '');
      return looksLikeEdgeAuthPage(res.status, res.headers.get('content-type'), body) ? 'edge-auth' : 'unknown';
    } catch {
      return 'unknown';
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export interface EdgeAuthError {
  code: string;
  message: string;
  /** True when a reload is already under way (the UI should keep showing a spinner rather than an error). */
  reloading: boolean;
}

/**
 * For a fetch that came back as an HTML 403: either the proxy session expired (reload, or ask the user to) or the
 * proxy replaced the server's own JSON 403 (a plain permission denial).
 */
export async function classifyEdgeForbidden(deps: EdgeAuthDeps = {}): Promise<EdgeAuthError> {
  if ((await probeEdgeAuth(deps.fetchFn)) !== 'edge-auth') {
    return { code: 'forbidden', message: 'You don’t have access to this.', reloading: false };
  }
  if (reloadForEdgeAuth(deps)) return { code: EDGE_AUTH_CODE, message: 'Your sign-in to this site expired; signing in again…', reloading: true };
  return { code: EDGE_AUTH_CODE, message: 'Your sign-in to this site expired. Reload the page to continue.', reloading: false };
}

let lastLossProbeAt = 0;

/** For transports without status codes: on a dropped EventSource or WebSocket, check the proxy and reload if it expired. */
export async function handleEdgeAuthLoss(deps: EdgeAuthDeps = {}): Promise<boolean> {
  const now = (deps.now ?? Date.now)();
  if (now - lastLossProbeAt < LOSS_PROBE_INTERVAL_MS) return false;
  lastLossProbeAt = now;
  if ((await probeEdgeAuth(deps.fetchFn)) !== 'edge-auth') return false;
  return reloadForEdgeAuth(deps);
}

/** Test hook: forget the loss-probe debounce. */
export function resetEdgeAuthForTests(): void {
  lastLossProbeAt = 0;
  inflight = null;
}
