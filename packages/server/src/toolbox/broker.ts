/**
 * Credential broker ([06] §5, [12] §5). Holds every credential; tools never do.
 *
 * - Storage: secrets are encrypted at rest with libsodium `crypto_secretbox_easy` (XSalsa20-Poly1305) under a
 *   32-byte key derived from `BROKER_MASTER_KEY`; they are never returned by list/get and never leave the server.
 * - Capabilities bind a credential (or none, for allowlist-only `raw` use) to a scope
 *   `{hosts (exact | *.wildcard), methods, path_prefixes, scopes}`.
 * - `fetch()` validates that the calling tool's manifest declares the capability ∧ the request is within scope,
 *   attaches the credential, executes the request itself, and audits every call (allowed or denied).
 */
import { createHash, hkdfSync } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import { BreadboardError, mintUid, type Tool } from '@breadboard/shared';
import type { Db } from '../db/index.js';
import type { Logger } from '../core/logger.js';
import { requireAdmin, type Principal } from '../core/principal.js';
import type { CredentialBroker } from '../core/services.js';
import { hostMatches, normalizeHost } from './egress-proxy.js';
import { signSigV4 } from './sigv4.js';

export const CREDENTIAL_KINDS = ['bearer', 'header', 'basic', 'query', 'aws-sigv4', 'raw'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export interface CapabilityScope {
  hosts: string[];
  methods?: string[];
  path_prefixes?: string[];
  scopes?: string[];
}

export const BROKER_FETCH_TIMEOUT_MS = 30_000;
export const BROKER_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const STRIP_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-connection', 'authorization', 'cookie']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

export interface BrokerDeps {
  db: Db;
  team_id: string;
  /** `BROKER_MASTER_KEY` (base64; 32 bytes used directly, other lengths are HKDF-expanded). */
  masterKey: string | undefined;
  /** `TOKEN_SIGNING_KEY`: dev-only fallback key material when no master key is configured. */
  fallbackKey?: string;
  log: Logger;
  fetchImpl?: typeof fetch;
}

/** Derive the 32-byte secretbox key. Exported for tests. */
export function deriveBrokerKey(masterKey: string | undefined, fallbackKey: string | undefined, log?: Logger): Uint8Array {
  if (masterKey) {
    const raw = Buffer.from(masterKey, 'base64');
    if (raw.length === 32) return new Uint8Array(raw);
    if (raw.length < 16) throw new Error('BROKER_MASTER_KEY must be base64 of at least 16 (ideally exactly 32) random bytes');
    log?.warn('BROKER_MASTER_KEY is not exactly 32 bytes; deriving the secretbox key with HKDF-SHA256');
    return new Uint8Array(hkdfSync('sha256', raw, Buffer.alloc(0), 'breadboard-broker-v1', 32));
  }
  if (!fallbackKey) throw new Error('credential broker needs BROKER_MASTER_KEY (or TOKEN_SIGNING_KEY as a dev-only fallback)');
  log?.warn(
    '!!! BROKER_MASTER_KEY is not set: broker credentials are encrypted with a key derived from TOKEN_SIGNING_KEY. This is for development only — set BROKER_MASTER_KEY (openssl rand -base64 32) before storing real credentials. !!!',
  );
  return new Uint8Array(hkdfSync('sha256', Buffer.from(fallbackKey, 'utf8'), Buffer.alloc(0), 'breadboard-broker-dev-fallback-v1', 32));
}

type Material = Record<string, string>;

/** Normalize registered secret input into the material shape for its kind; throws `validation-failed`. */
export function normalizeSecret(kind: CredentialKind, secret: Record<string, string> | string): Material {
  const bad = (msg: string) => new BreadboardError('validation-failed', `credential kind '${kind}': ${msg}`);
  const obj = typeof secret === 'string' ? null : secret;
  switch (kind) {
    case 'bearer': {
      const token = typeof secret === 'string' ? secret : (obj!.token ?? obj!.value);
      if (!token) throw bad('expected a token string or {token}');
      return { token };
    }
    case 'basic': {
      if (typeof secret === 'string') {
        const i = secret.indexOf(':');
        if (i <= 0) throw bad("expected 'user:password' or {username, password}");
        return { username: secret.slice(0, i), password: secret.slice(i + 1) };
      }
      if (!obj!.username || obj!.password === undefined) throw bad('expected {username, password}');
      return { username: obj!.username, password: obj!.password };
    }
    case 'header':
    case 'query': {
      if (!obj || !Object.keys(obj).length) throw bad(`expected {${kind === 'header' ? 'Header-Name' : 'param'}: value, …}`);
      for (const [k, v] of Object.entries(obj)) if (!k || typeof v !== 'string') throw bad(`invalid pair '${k}'`);
      return { ...obj };
    }
    case 'aws-sigv4': {
      if (!obj?.access_key_id || !obj.secret_access_key || !obj.region || !obj.service) throw bad('expected {access_key_id, secret_access_key, region, service, session_token?}');
      return { ...obj };
    }
    case 'raw':
      return typeof secret === 'string' ? (secret ? { value: secret } : {}) : { ...obj };
  }
}

function isKind(k: string): k is CredentialKind {
  return (CREDENTIAL_KINDS as readonly string[]).includes(k);
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

export interface ScopeCheck {
  ok: boolean;
  reason?: string;
}

/** Pure scope check: tool-declared capability scope + capability host/method/path scope. Exported for tests. */
export function checkScope(scope: CapabilityScope, toolScope: string, req: { method: string; url: URL }): ScopeCheck {
  const method = req.method.toUpperCase();
  const host = normalizeHost(req.url.hostname);
  if (req.url.protocol !== 'https:' && !(req.url.protocol === 'http:' && LOOPBACK.has(host))) return { ok: false, reason: `scheme ${req.url.protocol} not allowed (https only; http only for loopback)` };
  if (req.url.username || req.url.password) return { ok: false, reason: 'credentials in URL are not allowed' };
  if (scope.scopes?.length && !scope.scopes.includes(toolScope)) return { ok: false, reason: `tool requests scope '${toolScope}' but capability allows ${scope.scopes.join(', ')}` };
  if (toolScope === 'read' && !SAFE_METHODS.has(method)) return { ok: false, reason: `method ${method} not allowed for a read-scoped capability declaration` };
  if (!(scope.hosts ?? []).some((p) => hostMatches(p, host))) return { ok: false, reason: `host ${host} not in capability scope` };
  if (scope.methods?.length && !scope.methods.map((m) => m.toUpperCase()).includes(method)) return { ok: false, reason: `method ${method} not in capability scope` };
  if (scope.path_prefixes?.length && !scope.path_prefixes.some((p) => req.url.pathname.startsWith(p))) return { ok: false, reason: `path ${req.url.pathname} not in capability scope` };
  return { ok: true };
}

export class CredentialBrokerImpl implements CredentialBroker {
  private key: Uint8Array;
  private fetchImpl: typeof fetch;

  private constructor(
    private deps: BrokerDeps,
    key: Uint8Array,
  ) {
    this.key = key;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  static async create(deps: BrokerDeps): Promise<CredentialBrokerImpl> {
    await sodium.ready;
    return new CredentialBrokerImpl(deps, deriveBrokerKey(deps.masterKey, deps.fallbackKey, deps.log));
  }

  /** Key fingerprint (for ops: detect a changed master key without revealing it). */
  keyFingerprint(): string {
    return createHash('sha256').update(this.key).digest('hex').slice(0, 16);
  }

  // -- crypto ------------------------------------------------------------
  encrypt(plain: string): { ciphertext: Buffer; nonce: Buffer } {
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ct = sodium.crypto_secretbox_easy(sodium.from_string(plain), nonce, this.key);
    return { ciphertext: Buffer.from(ct), nonce: Buffer.from(nonce) };
  }

  decrypt(ciphertext: Buffer, nonce: Buffer): string {
    try {
      return sodium.to_string(sodium.crypto_secretbox_open_easy(new Uint8Array(ciphertext), new Uint8Array(nonce), this.key));
    } catch {
      throw new BreadboardError('internal', 'broker credential could not be decrypted (wrong BROKER_MASTER_KEY?)');
    }
  }

  // -- credentials -------------------------------------------------------
  async registerCredential(input: { name: string; kind: string; secret: Record<string, string> | string; by: Principal }): Promise<{ credential_id: string; name: string }> {
    requireAdmin(input.by);
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(input.name)) throw new BreadboardError('validation-failed', 'credential name must be 1-100 chars of [A-Za-z0-9._-]');
    if (!isKind(input.kind)) throw new BreadboardError('validation-failed', `unknown credential kind '${input.kind}' (expected ${CREDENTIAL_KINDS.join(', ')})`);
    const material = normalizeSecret(input.kind, input.secret);
    const { ciphertext, nonce } = this.encrypt(JSON.stringify(material));
    const r = await this.deps.db.query<{ credential_id: string }>(
      `INSERT INTO broker_credentials (credential_id, team_id, name, kind, ciphertext, nonce, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (team_id, name) DO UPDATE SET kind = EXCLUDED.kind, ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, updated_at = now()
       RETURNING credential_id`,
      [mintUid(), this.deps.team_id, input.name, input.kind, ciphertext, nonce, JSON.stringify(input.by.actor)],
    );
    this.deps.log.info({ name: input.name, kind: input.kind, by: input.by.actor }, 'broker credential registered');
    return { credential_id: String(r.rows[0]!.credential_id).trim(), name: input.name };
  }

  async deleteCredential(name: string, by: Principal): Promise<void> {
    requireAdmin(by);
    const cred = await this.credentialRow(name);
    if (!cred) throw new BreadboardError('not-found', `credential ${name} not found`);
    const used = await this.deps.db.query<{ name: string }>(`SELECT name FROM broker_capabilities WHERE credential_id = $1`, [cred.credential_id]);
    if (used.rows.length) throw new BreadboardError('conflict', `credential ${name} is used by capabilities: ${used.rows.map((r) => r.name).join(', ')}`);
    await this.deps.db.query(`DELETE FROM broker_credentials WHERE credential_id = $1`, [cred.credential_id]);
  }

  async listCredentials(): Promise<Array<{ credential_id: string; name: string; kind: string; created_at: string }>> {
    const r = await this.deps.db.query(`SELECT credential_id, name, kind, created_at FROM broker_credentials WHERE team_id = $1 ORDER BY name`, [this.deps.team_id]);
    return r.rows.map((x: any) => ({ credential_id: String(x.credential_id).trim(), name: x.name, kind: x.kind, created_at: iso(x.created_at) }));
  }

  private async credentialRow(name: string): Promise<{ credential_id: string; kind: CredentialKind; ciphertext: Buffer; nonce: Buffer } | null> {
    const r = await this.deps.db.query(`SELECT credential_id, kind, ciphertext, nonce FROM broker_credentials WHERE team_id = $1 AND name = $2`, [this.deps.team_id, name]);
    const x: any = r.rows[0];
    return x ? { credential_id: String(x.credential_id).trim(), kind: x.kind, ciphertext: Buffer.from(x.ciphertext), nonce: Buffer.from(x.nonce) } : null;
  }

  // -- capabilities ------------------------------------------------------
  async defineCapability(input: { name: string; credential: string | null; description?: string; scope: CapabilityScope; by: Principal }): Promise<{ capability_id: string; name: string }> {
    requireAdmin(input.by);
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(input.name)) throw new BreadboardError('validation-failed', 'capability name must be 1-100 chars of [A-Za-z0-9._-]');
    const hosts = (input.scope?.hosts ?? []).map((h) => h.trim()).filter(Boolean);
    if (!hosts.length) throw new BreadboardError('validation-failed', 'capability scope.hosts must list at least one host pattern');
    for (const h of hosts) if (h === '*' || (h.includes('*') && !/^\*\.[^*]+$/.test(h))) throw new BreadboardError('validation-failed', `invalid host pattern '${h}' (exact host or leading '*.' wildcard)`);
    let credentialId: string | null = null;
    if (input.credential) {
      const cred = await this.credentialRow(input.credential);
      if (!cred) throw new BreadboardError('not-found', `credential ${input.credential} not found`);
      credentialId = cred.credential_id;
    }
    const scope: CapabilityScope = {
      hosts,
      ...(input.scope.methods?.length ? { methods: input.scope.methods.map((m) => m.toUpperCase()) } : {}),
      ...(input.scope.path_prefixes?.length ? { path_prefixes: input.scope.path_prefixes } : {}),
      ...(input.scope.scopes?.length ? { scopes: input.scope.scopes } : {}),
    };
    const r = await this.deps.db.query<{ capability_id: string }>(
      `INSERT INTO broker_capabilities (capability_id, team_id, name, credential_id, description, scope)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (team_id, name) DO UPDATE SET credential_id = EXCLUDED.credential_id, description = EXCLUDED.description, scope = EXCLUDED.scope
       RETURNING capability_id`,
      [mintUid(), this.deps.team_id, input.name, credentialId, input.description ?? '', JSON.stringify(scope)],
    );
    this.deps.log.info({ name: input.name, credential: input.credential, scope, by: input.by.actor }, 'broker capability defined');
    return { capability_id: String(r.rows[0]!.capability_id).trim(), name: input.name };
  }

  async deleteCapability(name: string, by: Principal): Promise<void> {
    requireAdmin(by);
    const r = await this.deps.db.query(`DELETE FROM broker_capabilities WHERE team_id = $1 AND name = $2`, [this.deps.team_id, name]);
    if (!r.rowCount) throw new BreadboardError('not-found', `capability ${name} not found`);
  }

  async listCapabilities(): Promise<Array<{ capability_id: string; name: string; credential: string | null; description: string; scope: Record<string, unknown> }>> {
    const r = await this.deps.db.query(
      `SELECT c.capability_id, c.name, c.description, c.scope, k.name AS credential
         FROM broker_capabilities c LEFT JOIN broker_credentials k ON k.credential_id = c.credential_id
        WHERE c.team_id = $1 ORDER BY c.name`,
      [this.deps.team_id],
    );
    return r.rows.map((x: any) => ({ capability_id: String(x.capability_id).trim(), name: x.name, credential: x.credential ?? null, description: x.description, scope: x.scope }));
  }

  private async capability(name: string): Promise<{ scope: CapabilityScope; credential: { kind: CredentialKind; material: Material } | null } | null> {
    const r = await this.deps.db.query(
      `SELECT c.scope, k.kind, k.ciphertext, k.nonce FROM broker_capabilities c LEFT JOIN broker_credentials k ON k.credential_id = c.credential_id
        WHERE c.team_id = $1 AND c.name = $2`,
      [this.deps.team_id, name],
    );
    const x: any = r.rows[0];
    if (!x) return null;
    const credential = x.kind ? { kind: x.kind as CredentialKind, material: JSON.parse(this.decrypt(Buffer.from(x.ciphertext), Buffer.from(x.nonce))) as Material } : null;
    return { scope: x.scope as CapabilityScope, credential };
  }

  // -- execution ---------------------------------------------------------
  async fetch(input: {
    capability: string;
    request: { url: string; method?: string; headers?: Record<string, string>; body?: string | null };
    tool: Tool;
    principal: Principal;
    execution_key?: string | null;
  }): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const method = (input.request.method ?? 'GET').toUpperCase();
    let url: URL | null = null;
    const audit = (a: { ok: boolean; status?: number | null; error?: string | null }) =>
      this.audit_({ tool: input.tool, principal: input.principal, capability: input.capability, method, url, ...a });
    const deny = async (code: 'grant-denied' | 'validation-failed' | 'not-found', reason: string): Promise<never> => {
      await audit({ ok: false, error: reason });
      this.deps.log.warn({ capability: input.capability, tool: input.tool.uid, reason, execution_key: input.execution_key }, 'broker request denied');
      throw new BreadboardError(code, `broker: ${reason}`, { capability: input.capability });
    };

    try {
      url = new URL(input.request.url);
    } catch {
      return deny('validation-failed', `invalid URL ${String(input.request.url).slice(0, 200)}`);
    }
    if (!/^[A-Z]+$/.test(method)) return deny('validation-failed', `invalid method ${method}`);
    const declared = input.tool.capabilities.find((c) => c.name === input.capability);
    if (!declared) return deny('grant-denied', `tool ${input.tool.uid} does not declare capability '${input.capability}' in its manifest`);
    const cap = await this.capability(input.capability);
    if (!cap) return deny('not-found', `capability '${input.capability}' is not defined in the broker`);
    const check = checkScope(cap.scope, declared.scope, { method, url });
    if (!check.ok) return deny('grant-denied', check.reason!);

    // Build the outbound request: caller headers minus hop-by-hop/auth, then the credential.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.request.headers ?? {})) if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase()) && typeof v === 'string') headers[k] = v;
    const body = method === 'GET' || method === 'HEAD' ? null : (input.request.body ?? null);
    if (cap.credential) {
      const { kind, material } = cap.credential;
      switch (kind) {
        case 'bearer':
          headers.authorization = `Bearer ${material.token}`;
          break;
        case 'basic':
          headers.authorization = `Basic ${Buffer.from(`${material.username}:${material.password}`).toString('base64')}`;
          break;
        case 'header':
          for (const [k, v] of Object.entries(material)) {
            for (const existing of Object.keys(headers)) if (existing.toLowerCase() === k.toLowerCase()) delete headers[existing];
            headers[k] = v;
          }
          break;
        case 'query':
          for (const [k, v] of Object.entries(material)) url.searchParams.set(k, v);
          break;
        case 'aws-sigv4':
          Object.assign(
            headers,
            signSigV4(
              { method, url: url.toString(), headers, body },
              { access_key_id: material.access_key_id!, secret_access_key: material.secret_access_key!, session_token: material.session_token },
              { region: material.region!, service: material.service! },
            ),
          );
          break;
        case 'raw':
          break;
      }
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(BROKER_FETCH_TIMEOUT_MS) });
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? `upstream timed out after ${BROKER_FETCH_TIMEOUT_MS / 1000}s` : `upstream request failed: ${(e as Error).message}`;
      await audit({ ok: false, error: msg });
      throw new BreadboardError('internal', `broker: ${msg}`, { capability: input.capability });
    }
    let text: string;
    try {
      text = await readCapped(res, BROKER_MAX_RESPONSE_BYTES);
    } catch (e) {
      await audit({ ok: false, status: res.status, error: (e as Error).message });
      throw new BreadboardError('internal', `broker: ${(e as Error).message}`, { capability: input.capability });
    }
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k !== 'set-cookie') outHeaders[k] = v;
    });
    await audit({ ok: true, status: res.status });
    return { status: res.status, headers: outHeaders, body: text };
  }

  private async audit_(a: { tool: Tool | null; principal: Principal | null; capability: string; method: string; url: URL | null; ok: boolean; status?: number | null; error?: string | null }): Promise<void> {
    try {
      await this.deps.db.query(
        `INSERT INTO broker_audit (tool_uid, session_id, step_id, actor, capability, method, target_host, target_path, response_status, ok, error)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)`,
        [
          a.tool?.uid ?? null,
          a.principal?.session_id ?? null,
          a.principal?.actor.step_id ?? null,
          a.principal ? JSON.stringify(a.principal.actor) : null,
          a.capability,
          a.method,
          a.url ? normalizeHost(a.url.hostname) : null,
          a.url ? a.url.pathname : null,
          a.status ?? null,
          a.ok,
          a.error ?? null,
        ],
      );
    } catch (e) {
      this.deps.log.error({ err: e }, 'broker audit write failed');
    }
  }

  /**
   * Credential material for MCP server auth ([06] §9) — internal only, never exposed over the API.
   * Returns `{kind, ...material}`: bearer → `token`; basic → `username`/`password`; header/query → name/value pairs;
   * aws-sigv4 → key fields; null when the capability has no credential.
   */
  async credentialFor(capability: string): Promise<Record<string, string> | null> {
    const cap = await this.capability(capability);
    if (!cap?.credential) return null;
    return { kind: cap.credential.kind, ...cap.credential.material };
  }

  async audit(limit = 100): Promise<Array<Record<string, unknown>>> {
    const r = await this.deps.db.query(
      `SELECT audit_id, at, tool_uid, session_id, step_id, actor, capability, method, target_host, target_path, response_status, ok, error
         FROM broker_audit ORDER BY audit_id DESC LIMIT $1`,
      [Math.max(1, Math.min(1000, limit))],
    );
    return r.rows.map((x: any) => ({ ...x, at: iso(x.at), tool_uid: x.tool_uid ? String(x.tool_uid).trim() : null, session_id: x.session_id ? String(x.session_id).trim() : null }));
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`upstream response exceeds ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function createCredentialBroker(deps: BrokerDeps): Promise<CredentialBrokerImpl> {
  return CredentialBrokerImpl.create(deps);
}
