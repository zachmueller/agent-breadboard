/**
 * Egress proxy ([06] §4, [12] §6): the sole route out of the sandbox network. An HTTP forward proxy that
 *  - forwards absolute-URI `http://` requests, and
 *  - tunnels `CONNECT host:port` for HTTPS,
 * each only when the destination matches the per-execution allowlist compiled from the tool manifest's
 * `egress.allow`. Everything else is denied (default-deny) and every decision is written to `egress_audit`.
 *
 * Executions identify themselves with `Proxy-Authorization: Basic base64(<execution_key>:<nonce>)`; runners
 * put those credentials in `HTTP_PROXY`/`HTTPS_PROXY`. The nonce is minted per registration, so a tool cannot
 * borrow another execution's allowlist by guessing its key. Non-HTTP protocols cannot leave the sandbox
 * network at all: the only thing reachable is this proxy, and it only tunnels to allowed host:port pairs.
 */
import http from 'node:http';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { Logger } from '../core/logger.js';

export interface EgressRule {
  /** Exact host (`api.example.com`, `127.0.0.1`) or a leading wildcard (`*.example.com`, subdomains only). */
  host: string;
  ports: number[];
}

export interface EgressRegistration {
  allow: EgressRule[];
  tool_uid: string | null;
}

interface Entry extends EgressRegistration {
  nonce: string;
}

export interface EgressDecision {
  allowed: boolean;
  execution_key: string | null;
  tool_uid: string | null;
  host: string;
  port: number;
  reason: string;
}

export interface EgressProxyOptions {
  port: number;
  /** Bind address (default all interfaces so containers on the sandbox network can reach it). */
  bindHost?: string;
  db: Db | null;
  log: Logger;
  /** Destinations every registered execution may reach (the Breadboard API — [06] §4 "implicit destinations"). */
  implicitAllow?: EgressRule[];
  /** Upstream connect/idle timeout for tunnels and forwarded requests. */
  upstreamTimeoutMs?: number;
}

/** Normalize a hostname for comparison: lowercase, no trailing dot, no IPv6 brackets. */
export function normalizeHost(h: string): string {
  let s = h.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.endsWith('.')) s = s.slice(0, -1);
  return s;
}

/** Exact or `*.suffix` wildcard match. `*.example.com` matches `a.example.com` and `a.b.example.com`, not `example.com`. */
export function hostMatches(pattern: string, host: string): boolean {
  const p = normalizeHost(pattern);
  const h = normalizeHost(host);
  if (!p || !h) return false;
  if (p === '*') return false; // a bare wildcard would defeat default-deny; never honoured
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return h.length > suffix.length && h.endsWith(suffix);
  }
  return p === h;
}

export function ruleAllows(rules: EgressRule[], host: string, port: number): boolean {
  return rules.some((r) => hostMatches(r.host, host) && (r.ports ?? []).includes(port));
}

/** Parse a `CONNECT` authority (`host:port`, `[v6]:port`). */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(authority) ?? /^([^:\s/]+):(\d+)$/.exec(authority);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: normalizeHost(m[1]!), port };
}

/** Decode `Basic base64(key:nonce)`. The key may itself contain `:` (raw or `%3A`); the nonce (hex) never does. */
export function parseProxyAuthorization(header: string | string[] | undefined): { execution_key: string; nonce: string } | null {
  const v = Array.isArray(header) ? header[0] : header;
  if (!v) return null;
  const m = /^\s*Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(v);
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const i = decoded.lastIndexOf(':');
  if (i <= 0) return null;
  // Some clients send the proxy-URL userinfo still percent-encoded; execution keys never contain a literal '%'.
  let key = decoded.slice(0, i);
  if (key.includes('%')) {
    try {
      key = decodeURIComponent(key);
    } catch {
      return null;
    }
  }
  return { execution_key: key, nonce: decoded.slice(i + 1) };
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export class EgressProxy {
  private server: http.Server | null = null;
  private entries = new Map<string, Entry>();
  private sockets = new Set<net.Socket>();
  private boundPort: number;

  constructor(private opts: EgressProxyOptions) {
    this.boundPort = opts.port;
  }

  /** Actual listening port (differs from the configured one when started with port 0). */
  get port(): number {
    return this.boundPort;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.onRequest(req, res));
    server.on('connect', (req, socket, head) => void this.onConnect(req, socket as net.Socket, head));
    server.on('connection', (s: net.Socket) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    server.on('clientError', (_e, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.bindHost ?? '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    const addr = server.address();
    if (addr && typeof addr === 'object') this.boundPort = addr.port;
    this.opts.log.info({ port: this.boundPort }, 'egress proxy listening');
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    for (const sock of this.sockets) sock.destroy();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** Register an execution's allowlist; returns the per-registration nonce used as the proxy password. */
  register(executionKey: string, reg: EgressRegistration): { nonce: string } {
    const existing = this.entries.get(executionKey);
    const nonce = existing?.nonce ?? randomBytes(18).toString('hex');
    this.entries.set(executionKey, { allow: reg.allow.map((r) => ({ host: r.host, ports: [...(r.ports ?? [443])] })), tool_uid: reg.tool_uid, nonce });
    return { nonce };
  }

  release(executionKey: string): void {
    this.entries.delete(executionKey);
  }

  isRegistered(executionKey: string): boolean {
    return this.entries.has(executionKey);
  }

  /** Proxy URL with embedded execution credentials, as seen from `host` (e.g. `127.0.0.1` or the sandbox gateway). */
  proxyUrlFor(executionKey: string, host: string): string | null {
    const e = this.entries.get(executionKey);
    if (!e) return null;
    const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `http://${encodeURIComponent(executionKey)}:${e.nonce}@${h}:${this.boundPort}`;
  }

  /** Pure decision (no audit); exported for tests and for the broker's implicit-destination logic. */
  decide(auth: { execution_key: string; nonce: string } | null, host: string, port: number): EgressDecision {
    const base = { execution_key: auth?.execution_key ?? null, tool_uid: null as string | null, host: normalizeHost(host), port };
    if (!auth) return { ...base, allowed: false, reason: 'missing proxy credentials' };
    const e = this.entries.get(auth.execution_key);
    if (!e || !safeEqual(e.nonce, auth.nonce)) return { ...base, allowed: false, reason: 'unknown execution' };
    base.tool_uid = e.tool_uid;
    if (ruleAllows(e.allow, host, port)) return { ...base, allowed: true, reason: 'allowlisted' };
    if (ruleAllows(this.opts.implicitAllow ?? [], host, port)) return { ...base, allowed: true, reason: 'implicit' };
    return { ...base, allowed: false, reason: 'not in allowlist' };
  }

  private async audit(d: EgressDecision): Promise<void> {
    const fields = { execution_key: d.execution_key, tool_uid: d.tool_uid, host: d.host, port: d.port, reason: d.reason };
    if (d.allowed) this.opts.log.info(fields, 'egress allowed');
    else this.opts.log.warn(fields, 'egress denied');
    if (!this.opts.db) return;
    try {
      await this.opts.db.query(`INSERT INTO egress_audit (execution_key, tool_uid, host, port, allowed) VALUES ($1, $2, $3, $4, $5)`, [
        d.execution_key?.slice(0, 500) ?? null,
        d.tool_uid,
        d.host.slice(0, 500),
        d.port,
        d.allowed,
      ]);
    } catch (e) {
      this.opts.log.error({ err: e }, 'egress audit write failed');
    }
  }

  private async onConnect(req: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
    client.on('error', () => client.destroy());
    const target = parseAuthority(req.url ?? '');
    if (!target) {
      client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const auth = parseProxyAuthorization(req.headers['proxy-authorization']);
    const d = this.decide(auth, target.host, target.port);
    await this.audit(d);
    if (!d.allowed) {
      client.end(denialHead(auth ? 403 : 407, d.reason));
      return;
    }
    const upstream = net.connect({ host: target.host, port: target.port });
    upstream.setTimeout(this.opts.upstreamTimeoutMs ?? 120_000, () => upstream.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', (e) => {
      if (client.writable && !upstream.readableEnded) client.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n`);
      else client.destroy();
      this.opts.log.debug({ err: e.message, host: target.host }, 'egress tunnel upstream error');
    });
    client.on('close', () => upstream.destroy());
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('egress proxy: absolute-form request URI required\n');
      return;
    }
    if (url.protocol !== 'http:') {
      // https must use CONNECT; anything else (ftp:, ws: …) is not HTTP egress.
      res.writeHead(400, { 'content-type': 'text/plain' }).end(`egress proxy: unsupported scheme ${url.protocol}\n`);
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    const auth = parseProxyAuthorization(req.headers['proxy-authorization']);
    const d = this.decide(auth, url.hostname, port);
    await this.audit(d);
    if (!d.allowed) {
      const status = auth ? 403 : 407;
      res.writeHead(status, { 'content-type': 'text/plain', ...(status === 407 ? { 'proxy-authenticate': 'Basic realm="breadboard-egress"' } : {}) });
      res.end(`egress denied: ${d.host}:${port} (${d.reason})\n`);
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
    headers.host = url.host;
    const upstream = http.request(
      { host: normalizeHost(url.hostname), port, method: req.method, path: url.pathname + url.search, headers, timeout: this.opts.upstreamTimeoutMs ?? 120_000 },
      (up) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) out[k] = v;
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end(`egress upstream error: ${e.message}\n`);
      else res.destroy();
    });
    req.pipe(upstream);
  }
}

function denialHead(status: 403 | 407, reason: string): string {
  const body = `egress denied (${reason})\n`;
  const text = status === 403 ? 'Forbidden' : 'Proxy Authentication Required';
  const extra = status === 407 ? 'Proxy-Authenticate: Basic realm="breadboard-egress"\r\n' : '';
  return `HTTP/1.1 ${status} ${text}\r\n${extra}Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
