import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EDGE_AUTH_CODE,
  RELOAD_MIN_INTERVAL_MS,
  classifyEdgeForbidden,
  handleEdgeAuthLoss,
  isEdgeRedirect,
  looksLikeEdgeAuthPage,
  probeEdgeAuth,
  reloadForEdgeAuth,
  resetEdgeAuthForTests,
} from './edge-auth';

const CFS_PAGE = '<!DOCTYPE html>\n<html>\n<head>\n    <script src="/js/cfs-handler.js"></script>\n</head>\n<body>…</body>\n</html>\n';
const ALB_401 = '<html>\r\n<head><title>401 Authorization Required</title></head>\r\n<body>\r\n<center><h1>401 Authorization Required</h1></center>\r\n</body>\r\n</html>\r\n';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}
function fakeFetch(status: number, contentType: string, body: string): typeof fetch {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': contentType }), text: async () => body }) as unknown as Response) as unknown as typeof fetch;
}

afterEach(() => resetEdgeAuthForTests());

describe('looksLikeEdgeAuthPage', () => {
  it('recognises a 403 HTML page and nothing else', () => {
    expect(looksLikeEdgeAuthPage(403, 'text/html', CFS_PAGE)).toBe(true);
    expect(looksLikeEdgeAuthPage(403, 'text/html; charset=utf-8', '')).toBe(true);
    expect(looksLikeEdgeAuthPage(403, null, CFS_PAGE)).toBe(true);
    expect(looksLikeEdgeAuthPage(403, null, '  <html><body>no</body></html>')).toBe(true);
    expect(looksLikeEdgeAuthPage(403, 'application/json; charset=utf-8', '{"error":{"code":"forbidden"}}')).toBe(false);
    expect(looksLikeEdgeAuthPage(403, 'application/json', CFS_PAGE)).toBe(false);
    expect(looksLikeEdgeAuthPage(403, null, '{"error":"forbidden"}')).toBe(false);
    expect(looksLikeEdgeAuthPage(200, 'text/html', CFS_PAGE)).toBe(false);
    expect(looksLikeEdgeAuthPage(500, 'text/html', CFS_PAGE)).toBe(false);
  });

  it('recognises a load balancer’s 401, but not the server’s JSON one', () => {
    expect(looksLikeEdgeAuthPage(401, 'text/html', ALB_401)).toBe(true);
    expect(looksLikeEdgeAuthPage(401, null, '')).toBe(true);
    expect(looksLikeEdgeAuthPage(401, 'text/plain', 'Unauthorized')).toBe(true);
    expect(looksLikeEdgeAuthPage(401, 'application/json; charset=utf-8', '{"error":{"code":"unauthorized","message":"missing credentials"}}')).toBe(false);
    expect(looksLikeEdgeAuthPage(401, null, '{"error":{"code":"unauthorized"}}')).toBe(false);
  });
});

describe('isEdgeRedirect', () => {
  it('is a fetch with redirect: manual that was redirected', () => {
    expect(isEdgeRedirect({ type: 'opaqueredirect' })).toBe(true);
    expect(isEdgeRedirect({ type: 'basic' })).toBe(false);
    expect(isEdgeRedirect({ type: 'cors' })).toBe(false);
  });
});

describe('reloadForEdgeAuth', () => {
  it('reloads at most once per interval, remembering across reloads', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(reloadForEdgeAuth({ storage, reload, now: () => 1_000_000 })).toBe(true);
    expect(reloadForEdgeAuth({ storage, reload, now: () => 1_000_000 + RELOAD_MIN_INTERVAL_MS - 1 })).toBe(false);
    expect(reloadForEdgeAuth({ storage, reload, now: () => 1_000_000 + RELOAD_MIN_INTERVAL_MS })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('never reloads without a working storage (no loop guard)', () => {
    const reload = vi.fn();
    expect(reloadForEdgeAuth({ storage: null, reload })).toBe(false);
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => undefined };
    expect(reloadForEdgeAuth({ storage: throwing, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('probeEdgeAuth', () => {
  it('tells an expired proxy session from a healthy or unreachable server', async () => {
    expect(await probeEdgeAuth(fakeFetch(200, 'application/json', '{"ok":true}'))).toBe('ok');
    expect(await probeEdgeAuth(fakeFetch(403, 'text/html', CFS_PAGE))).toBe('edge-auth');
    expect(await probeEdgeAuth(fakeFetch(401, 'text/html', ALB_401))).toBe('edge-auth');
    const redirected = vi.fn(async () => ({ ok: false, status: 0, type: 'opaqueredirect', headers: new Headers(), text: async () => '' }) as unknown as Response) as unknown as typeof fetch;
    expect(await probeEdgeAuth(redirected)).toBe('edge-auth');
    expect(redirected).toHaveBeenCalledWith('/api/v1/health', expect.objectContaining({ redirect: 'manual' }));
    expect(await probeEdgeAuth(fakeFetch(502, 'text/html', '<html>bad gateway</html>'))).toBe('unknown');
    expect(await probeEdgeAuth(vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch)).toBe('unknown');
  });

  it('shares one request between concurrent callers', async () => {
    const f = fakeFetch(200, 'application/json', '{}');
    await Promise.all([probeEdgeAuth(f), probeEdgeAuth(f), probeEdgeAuth(f)]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith('/api/v1/health', expect.objectContaining({ credentials: 'include' }));
  });
});

describe('classifyEdgeForbidden', () => {
  it('treats an HTML 403 as a permission denial when the health probe passes', async () => {
    const reload = vi.fn();
    expect(await classifyEdgeForbidden({ fetchFn: fakeFetch(200, 'application/json', '{}'), reload, storage: memoryStorage() })).toEqual({ code: 'forbidden', message: expect.any(String), reloading: false });
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when the proxy session expired, and asks the user when a reload just happened', async () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    const fetchFn = fakeFetch(403, 'text/html', CFS_PAGE);
    expect(await classifyEdgeForbidden({ fetchFn, reload, storage, now: () => 5_000_000 })).toMatchObject({ code: EDGE_AUTH_CODE, reloading: true });
    expect(await classifyEdgeForbidden({ fetchFn, reload, storage, now: () => 5_000_001 })).toMatchObject({ code: EDGE_AUTH_CODE, reloading: false, message: expect.stringMatching(/Reload the page/) });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('handleEdgeAuthLoss', () => {
  it('reloads only when the proxy refuses us, and debounces bursts', async () => {
    const reload = vi.fn();
    const storage = memoryStorage();
    expect(await handleEdgeAuthLoss({ fetchFn: fakeFetch(200, 'application/json', '{}'), reload, storage, now: () => 1 })).toBe(false);
    expect(await handleEdgeAuthLoss({ fetchFn: fakeFetch(403, 'text/html', CFS_PAGE), reload, storage, now: () => 2 })).toBe(false); // debounced
    expect(await handleEdgeAuthLoss({ fetchFn: fakeFetch(403, 'text/html', CFS_PAGE), reload, storage, now: () => 10_000 })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
