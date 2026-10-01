import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type net from 'node:net';
import { createFoundation, type Foundation } from '../test/harness.js';
import { EgressProxy, hostMatches, parseProxyAuthorization, ruleAllows } from './egress-proxy.js';

let f: Foundation;
let proxy: EgressProxy;
let target: http.Server;
let targetPort: number;

function basic(key: string, nonce: string): string {
  return `Basic ${Buffer.from(`${key}:${nonce}`).toString('base64')}`;
}

/** Plain-HTTP forward request through the proxy (absolute-form URI). */
function viaProxy(url: string, auth?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: url, headers: auth ? { 'proxy-authorization': auth } : {} }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** CONNECT tunnel; on success, sends a plain HTTP request through the tunnel and returns the upstream status line. */
function connectVia(authority: string, auth?: string): Promise<{ status: number; upstream?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: authority, headers: auth ? { 'proxy-authorization': auth } : {} });
    req.on('connect', (res, socket: net.Socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return resolve({ status: res.statusCode ?? 0 });
      }
      let data = '';
      socket.on('data', (c) => (data += c));
      socket.on('end', () => resolve({ status: 200, upstream: data.split('\r\n')[0] }));
      socket.write(`GET /tunnel HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
    });
    req.on('error', reject);
    req.end();
  });
}

async function auditFor(key: string) {
  const r = await f.db.query(`SELECT host, port, allowed, tool_uid FROM egress_audit WHERE execution_key = $1 ORDER BY audit_id`, [key]);
  return r.rows.map((x: any) => ({ host: x.host, port: x.port, allowed: x.allowed, tool_uid: x.tool_uid ? String(x.tool_uid).trim() : null }));
}

beforeAll(async () => {
  f = await createFoundation();
  target = http.createServer((req, res) => res.writeHead(200, { 'x-saw-proxy-auth': String(!!req.headers['proxy-authorization']) }).end(`target ${req.url}`));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  targetPort = (target.address() as any).port;
  proxy = new EgressProxy({ port: 0, bindHost: '127.0.0.1', db: f.db, log: f.log, implicitAllow: [{ host: 'api.breadboard.internal', ports: [8080] }] });
  await proxy.start();
});

afterAll(async () => {
  await proxy?.stop();
  await new Promise((r) => target?.close(r));
  await f?.close();
});

describe('egress rule matching', () => {
  it('matches exact hosts and *. wildcards (subdomains only); a bare * is never honoured', () => {
    expect(hostMatches('api.example.com', 'API.example.com.')).toBe(true);
    expect(hostMatches('*.example.com', 'a.b.example.com')).toBe(true);
    expect(hostMatches('*.example.com', 'example.com')).toBe(false);
    expect(hostMatches('*.example.com', 'evilexample.com')).toBe(false);
    expect(hostMatches('*', 'anything.com')).toBe(false);
    expect(ruleAllows([{ host: '127.0.0.1', ports: [443] }], '127.0.0.1', 80)).toBe(false);
    expect(ruleAllows([{ host: '[::1]', ports: [443] }], '::1', 443)).toBe(true);
  });

  it('parses Basic proxy credentials whose username contains colons', () => {
    expect(parseProxyAuthorization(basic('ses_A:step:1:0', 'n0nce'))).toEqual({ execution_key: 'ses_A:step:1:0', nonce: 'n0nce' });
    expect(parseProxyAuthorization(basic(encodeURIComponent('ses_A:step:1:0'), 'n0nce'))).toEqual({ execution_key: 'ses_A:step:1:0', nonce: 'n0nce' });
    expect(parseProxyAuthorization(undefined)).toBeNull();
    expect(parseProxyAuthorization('Bearer x')).toBeNull();
  });
});

describe('EgressProxy', () => {
  it('forwards allowlisted plain-HTTP requests and strips proxy credentials before forwarding', async () => {
    const key = 'ses_T:fetch:1:0';
    const { nonce } = proxy.register(key, { allow: [{ host: '127.0.0.1', ports: [targetPort] }], tool_uid: 'TOOLUID0000000000001' });
    const r = await viaProxy(`http://127.0.0.1:${targetPort}/hello?x=1`, basic(key, nonce));
    expect(r).toEqual({ status: 200, body: 'target /hello?x=1' });
    expect(await auditFor(key)).toEqual([{ host: '127.0.0.1', port: targetPort, allowed: true, tool_uid: 'TOOLUID0000000000001' }]);
    proxy.release(key);
  });

  it('denies hosts outside the allowlist with 403 and audits the denial', async () => {
    const key = 'ses_T:deny:1:0';
    const { nonce } = proxy.register(key, { allow: [{ host: '127.0.0.1', ports: [targetPort] }], tool_uid: null });
    const r = await viaProxy(`http://localhost:${targetPort}/x`, basic(key, nonce));
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/egress denied: localhost/);
    const wrongPort = await viaProxy(`http://127.0.0.1:${targetPort + 1}/x`, basic(key, nonce));
    expect(wrongPort.status).toBe(403);
    expect(await auditFor(key)).toEqual([
      { host: 'localhost', port: targetPort, allowed: false, tool_uid: null },
      { host: '127.0.0.1', port: targetPort + 1, allowed: false, tool_uid: null },
    ]);
    proxy.release(key);
  });

  it('requires valid execution credentials (407 when missing; 403 for a wrong nonce or a released execution)', async () => {
    const key = 'ses_T:auth:1:0';
    const { nonce } = proxy.register(key, { allow: [{ host: '127.0.0.1', ports: [targetPort] }], tool_uid: null });
    expect((await viaProxy(`http://127.0.0.1:${targetPort}/`)).status).toBe(407);
    expect((await viaProxy(`http://127.0.0.1:${targetPort}/`, basic(key, 'wrong'))).status).toBe(403);
    proxy.release(key);
    expect((await viaProxy(`http://127.0.0.1:${targetPort}/`, basic(key, nonce))).status).toBe(403);
    expect(proxy.decide({ execution_key: key, nonce }, '127.0.0.1', targetPort)).toMatchObject({ allowed: false, reason: 'unknown execution' });
    expect((await auditFor(key)).every((a) => !a.allowed)).toBe(true);
  });

  it('tunnels CONNECT to allowlisted authorities and refuses others', async () => {
    const key = 'ses_T:connect:1:0';
    const { nonce } = proxy.register(key, { allow: [{ host: '127.0.0.1', ports: [targetPort] }], tool_uid: null });
    const ok = await connectVia(`127.0.0.1:${targetPort}`, basic(key, nonce));
    expect(ok.status).toBe(200);
    expect(ok.upstream).toBe('HTTP/1.1 200 OK');
    expect((await connectVia(`localhost:${targetPort}`, basic(key, nonce))).status).toBe(403);
    expect((await connectVia(`127.0.0.1:${targetPort}`)).status).toBe(407);
    expect((await auditFor(key)).map((a) => [a.host, a.allowed])).toEqual([
      ['127.0.0.1', true],
      ['localhost', false],
    ]);
    proxy.release(key);
  });

  it('allows implicit destinations (the Breadboard API) for any registered execution only', () => {
    const { nonce } = proxy.register('k', { allow: [], tool_uid: null });
    expect(proxy.decide({ execution_key: 'k', nonce }, 'api.breadboard.internal', 8080)).toMatchObject({ allowed: true, reason: 'implicit' });
    expect(proxy.decide(null, 'api.breadboard.internal', 8080).allowed).toBe(false);
    expect(proxy.proxyUrlFor('k', '127.0.0.1')).toBe(`http://k:${nonce}@127.0.0.1:${proxy.port}`);
    const n2 = proxy.register('a:b', { allow: [], tool_uid: null }).nonce;
    expect(proxy.proxyUrlFor('a:b', '::1')).toBe(`http://a%3Ab:${n2}@[::1]:${proxy.port}`);
    expect(proxy.proxyUrlFor('unregistered', '127.0.0.1')).toBeNull();
    proxy.release('k');
    proxy.release('a:b');
  });

  it('rejects non-http schemes and origin-form URIs with 400', async () => {
    const key = 'ses_T:scheme:1:0';
    const { nonce } = proxy.register(key, { allow: [{ host: '127.0.0.1', ports: [targetPort] }], tool_uid: null });
    expect((await viaProxy(`/relative`, basic(key, nonce))).status).toBe(400);
    expect((await viaProxy(`ftp://127.0.0.1:${targetPort}/`, basic(key, nonce))).status).toBe(400);
    proxy.release(key);
  });
});
