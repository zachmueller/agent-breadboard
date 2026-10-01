import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { BreadboardError, type Tool } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import { checkScope, createCredentialBroker, deriveBrokerKey, type CredentialBrokerImpl } from './broker.js';
import { signSigV4 } from './sigv4.js';
import { makeToolDir } from './test-helpers.js';

let f: Foundation;
let broker: CredentialBrokerImpl;
let upstream: http.Server;
let base: string;
const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
let tool: Tool;
let readOnlyTool: Tool;
let bareTool: Tool;
const MASTER = Buffer.alloc(32, 7).toString('base64');

async function expectError(p: Promise<unknown>, code: string, msg?: RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BreadboardError);
    expect((e as BreadboardError).code).toBe(code);
    if (msg) expect((e as Error).message).toMatch(msg);
    return;
  }
  throw new Error(`expected ${code}`);
}

beforeAll(async () => {
  f = await createFoundation();
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (req.url?.startsWith('/big')) return res.writeHead(200).end(Buffer.alloc(4 * 1024 * 1024 + 10, 97));
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=1' }).end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(upstream.address() as any).port}`;
  broker = await createCredentialBroker({ db: f.db, team_id: f.team_id, masterKey: MASTER, log: f.log });
  tool = (
    await makeToolDir(
      {
        language: 'typescript',
        entrypoint: 'src/index.ts',
        capabilities: ['gh', 'hdr', 'basic', 'query', 'aws', 'open', 'scoped-write'].map((name) => ({ name, scope: name === 'scoped-write' ? 'write' : 'read' })),
      },
      { 'src/index.ts': 'export function handler() {}' },
    )
  ).tool;
  readOnlyTool = (await makeToolDir({ language: 'typescript', entrypoint: 'src/index.ts', capabilities: [{ name: 'gh', scope: 'read' }, { name: 'rw', scope: 'write' }] }, { 'src/index.ts': '' })).tool;
  bareTool = (await makeToolDir({ language: 'typescript', entrypoint: 'src/index.ts' }, { 'src/index.ts': '' })).tool;

  const by = f.adminPrincipal;
  await broker.registerCredential({ name: 'gh-token', kind: 'bearer', secret: 'ghp_SECRET', by });
  await broker.registerCredential({ name: 'hdr', kind: 'header', secret: { 'X-Api-Key': 'k-SECRET' }, by });
  await broker.registerCredential({ name: 'basic', kind: 'basic', secret: 'alice:pw-SECRET', by });
  await broker.registerCredential({ name: 'query', kind: 'query', secret: { api_key: 'q-SECRET' }, by });
  await broker.registerCredential({ name: 'aws', kind: 'aws-sigv4', secret: { access_key_id: 'AKIDEXAMPLE', secret_access_key: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'execute-api' }, by });
  const loop = ['127.0.0.1'];
  await broker.defineCapability({ name: 'gh', credential: 'gh-token', scope: { hosts: loop, methods: ['GET', 'POST'], path_prefixes: ['/repos/'] }, by });
  await broker.defineCapability({ name: 'hdr', credential: 'hdr', scope: { hosts: loop }, by });
  await broker.defineCapability({ name: 'basic', credential: 'basic', scope: { hosts: loop }, by });
  await broker.defineCapability({ name: 'query', credential: 'query', scope: { hosts: loop }, by });
  await broker.defineCapability({ name: 'aws', credential: 'aws', scope: { hosts: loop }, by });
  await broker.defineCapability({ name: 'open', credential: null, scope: { hosts: loop }, by });
  await broker.defineCapability({ name: 'rw', credential: 'gh-token', scope: { hosts: loop, scopes: ['read'] }, by });
});

afterAll(async () => {
  await new Promise((r) => upstream?.close(r));
  await f?.close();
});

const call = (capability: string, request: { url: string; method?: string; headers?: Record<string, string>; body?: string }, t: Tool = tool) =>
  broker.fetch({ capability, request, tool: t, principal: f.adminPrincipal, execution_key: 'ses_X:s:1:0' });

describe('broker crypto', () => {
  it('round-trips secretbox encryption with fresh nonces and rejects a different key', async () => {
    const a = broker.encrypt('hello');
    const b = broker.encrypt('hello');
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.includes(Buffer.from('hello'))).toBe(false);
    expect(broker.decrypt(a.ciphertext, a.nonce)).toBe('hello');
    const other = await createCredentialBroker({ db: f.db, team_id: f.team_id, masterKey: Buffer.alloc(32, 8).toString('base64'), log: f.log });
    expect(() => other.decrypt(a.ciphertext, a.nonce)).toThrow(/could not be decrypted/);
  });

  it('derives keys: 32-byte master used directly, fallback with warning, none → throws', () => {
    expect(Buffer.from(deriveBrokerKey(MASTER, undefined)).equals(Buffer.alloc(32, 7))).toBe(true);
    const warnings: unknown[] = [];
    const k = deriveBrokerKey(undefined, 'dev-signing-key', { ...f.log, warn: (...a: unknown[]) => warnings.push(a) } as any);
    expect(k.length).toBe(32);
    expect(warnings.length).toBe(1);
    expect(() => deriveBrokerKey(undefined, undefined)).toThrow(/BROKER_MASTER_KEY/);
  });

  it('never stores or lists secrets in the clear', async () => {
    const rows = await f.db.query(`SELECT name, ciphertext FROM broker_credentials`);
    for (const r of rows.rows as any[]) expect(Buffer.from(r.ciphertext).toString('latin1')).not.toMatch(/SECRET/);
    const listed = JSON.stringify(await broker.listCredentials()) + JSON.stringify(await broker.listCapabilities());
    expect(listed).not.toMatch(/SECRET/);
    expect((await broker.listCredentials()).map((c) => c.name)).toContain('gh-token');
  });

  it('admin-gates credential management and validates input', async () => {
    await expectError(broker.registerCredential({ name: 'x', kind: 'bearer', secret: 't', by: f.memberPrincipal }), 'forbidden');
    await expectError(broker.registerCredential({ name: 'x', kind: 'nope', secret: 't', by: f.adminPrincipal }), 'validation-failed');
    await expectError(broker.registerCredential({ name: 'x', kind: 'basic', secret: 'no-colon', by: f.adminPrincipal }), 'validation-failed');
    await expectError(broker.defineCapability({ name: 'x', credential: null, scope: { hosts: ['*'] }, by: f.adminPrincipal }), 'validation-failed');
    await expectError(broker.defineCapability({ name: 'x', credential: 'missing', scope: { hosts: ['a.com'] }, by: f.adminPrincipal }), 'not-found');
    await expectError(broker.deleteCredential('gh-token', f.adminPrincipal), 'conflict', /used by capabilities/);
  });
});

describe('broker.fetch', () => {
  it('attaches each credential kind and strips caller-supplied auth', async () => {
    seen.length = 0;
    const r = await call('gh', { url: `${base}/repos/a/b`, headers: { Authorization: 'Bearer forged', Cookie: 'x=1', Accept: 'application/json' } });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    expect(r.headers['set-cookie']).toBeUndefined();
    await call('hdr', { url: `${base}/h`, headers: { 'x-api-key': 'forged' } });
    await call('basic', { url: `${base}/b` });
    await call('query', { url: `${base}/q?x=1` });
    await call('aws', { url: `${base}/aws`, method: 'GET' });
    await call('open', { url: `${base}/o`, headers: { authorization: 'Bearer forged' } });
    expect(seen[0]!.headers.authorization).toBe('Bearer ghp_SECRET');
    expect(seen[0]!.headers.cookie).toBeUndefined();
    expect(seen[0]!.headers.accept).toBe('application/json');
    expect(seen[1]!.headers['x-api-key']).toBe('k-SECRET');
    expect(seen[2]!.headers.authorization).toBe(`Basic ${Buffer.from('alice:pw-SECRET').toString('base64')}`);
    expect(seen[3]!.url).toBe('/q?x=1&api_key=q-SECRET');
    expect(seen[4]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/execute-api\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
    expect(seen[4]!.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(seen[5]!.headers.authorization).toBeUndefined();
  });

  it('denies when the tool manifest does not declare the capability', async () => {
    await expectError(call('gh', { url: `${base}/repos/a` }, bareTool), 'grant-denied', /does not declare capability 'gh'/);
    await expectError(call('undefined-cap', { url: `${base}/repos/a` }, { ...tool, capabilities: [{ name: 'undefined-cap', scope: 'read' }] }), 'not-found');
  });

  it('enforces host, method, path, scheme, and declared-scope constraints', async () => {
    const before = seen.length;
    await expectError(call('gh', { url: `http://localhost:1/repos/a` }), 'grant-denied', /host localhost not in capability scope/);
    await expectError(call('gh', { url: `${base}/orgs/a` }), 'grant-denied', /path \/orgs\/a/);
    await expectError(call('gh', { url: `${base}/repos/a`, method: 'DELETE' }), 'grant-denied', /method DELETE/);
    // read-scoped declaration: safe methods only even though the capability allows POST
    await expectError(call('gh', { url: `${base}/repos/a`, method: 'POST', body: '{}' }), 'grant-denied', /read-scoped/);
    // capability restricts declared scopes to 'read'; the tool declares 'write'
    await expectError(call('rw', { url: `${base}/x`, method: 'GET' }, readOnlyTool), 'grant-denied', /scope 'write'/);
    await expectError(call('gh', { url: `http://user:pw@127.0.0.1/repos/a` }), 'grant-denied', /credentials in URL/);
    await expectError(call('gh', { url: 'not a url' }), 'validation-failed');
    expect(seen.length).toBe(before);
    expect(checkScope({ hosts: ['api.example.com'] }, 'read', { method: 'GET', url: new URL('http://api.example.com/') })).toMatchObject({ ok: false, reason: expect.stringMatching(/https only/) });
    expect(checkScope({ hosts: ['*.example.com'] }, 'read', { method: 'GET', url: new URL('https://api.example.com/') })).toEqual({ ok: true });
  });

  it('caps the response body', async () => {
    await expectError(call('open', { url: `${base}/big` }), 'internal', /exceeds/);
  });

  it('audits every call, allowed or denied, without secrets', async () => {
    const rows = await broker.audit(500);
    expect(rows.some((r) => r.capability === 'gh' && r.ok === true && r.response_status === 200 && r.target_path === '/repos/a/b' && r.tool_uid === tool.uid)).toBe(true);
    expect(rows.some((r) => r.capability === 'gh' && r.ok === false && String(r.error).includes('method DELETE'))).toBe(true);
    expect(rows.some((r) => r.capability === 'gh' && r.ok === false && r.tool_uid === bareTool.uid)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/SECRET/);
  });

  it('exposes credential material internally via credentialFor', async () => {
    expect(await broker.credentialFor('gh')).toEqual({ kind: 'bearer', token: 'ghp_SECRET' });
    expect(await broker.credentialFor('open')).toBeNull();
    expect(await broker.credentialFor('missing')).toBeNull();
  });
});

describe('signSigV4', () => {
  // AWS SigV4 test suite "get-vanilla".
  it('matches the AWS get-vanilla test vector', () => {
    const h = signSigV4(
      { method: 'GET', url: 'https://example.amazonaws.com/', headers: {}, body: null },
      { access_key_id: 'AKIDEXAMPLE', secret_access_key: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      { region: 'us-east-1', service: 'service', now: new Date('2015-08-30T12:36:00Z') },
    );
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(h['x-amz-date']).toBe('20150830T123600Z');
  });
});
