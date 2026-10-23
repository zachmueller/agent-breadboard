import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { BreadboardError, type Tool } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import { checkRepoScope, checkScope, createCredentialBroker, deriveBrokerKey, type CredentialBrokerImpl } from './broker.js';
import { codecommitGitCredentials, signSigV4 } from './sigv4.js';
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

describe('codecommitGitCredentials', () => {
  // Pinned from the AWS CLI's `aws codecommit credential-helper get` with AWS's documented example keys.
  it('matches the AWS CLI credential helper', () => {
    const c = codecommitGitCredentials({
      host: 'git-codecommit.us-east-1.amazonaws.com',
      path: '/v1/repos/my-repo',
      region: 'us-east-1',
      creds: { access_key_id: 'AKIDEXAMPLE', secret_access_key: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', session_token: 'EXAMPLETOKEN' },
      now: new Date('2026-10-21T20:09:16Z'),
    });
    expect(c).toEqual({ username: 'AKIDEXAMPLE%EXAMPLETOKEN', password: '20261021T200916Zd922b53caa17d28519190abbec30ced32275b5cb2e6040d51e814ef81c4b67cd' });
    expect(codecommitGitCredentials({ host: 'h', path: '/v1/repos/r', region: 'us-east-1', creds: { access_key_id: 'AKID', secret_access_key: 's' } }).username).toBe('AKID');
  });
});

describe('aws-role credentials', () => {
  it('validates the material, which holds no keys', async () => {
    const by = f.adminPrincipal;
    const reg = (secret: Record<string, string>) => broker.registerCredential({ name: 'role-x', kind: 'aws-role', secret, by });
    await expectError(reg({ region: 'us-east-1' }), 'validation-failed', /expected \{region, service/);
    await expectError(reg({ region: 'us-east-1', service: 'athena', secret_access_key: 'x' }), 'validation-failed', /unknown field/);
    await expectError(reg({ region: 'us-east-1', service: 'athena', role_arn: 'arn:aws:iam::123:user/x' }), 'validation-failed', /role_arn/);
    await expectError(reg({ region: 'us-east-1', service: 'athena', external_id: 'abc' }), 'validation-failed', /needs role_arn/);
    await expectError(reg({ region: 'us-east-1', service: 'athena', role_arn: 'arn:aws:iam::123456789012:role/r', session_name: 'x' }), 'validation-failed', /session_name/);
  });

  it('signs with resolved credentials, assumes the named role, and audits resolver failures', async () => {
    const asked: Array<Record<string, unknown>> = [];
    const roleBroker = await createCredentialBroker({
      db: f.db,
      team_id: f.team_id,
      masterKey: MASTER,
      log: f.log,
      awsRoleResolver: async (m) => {
        asked.push({ ...m });
        if (m.role_arn?.endsWith('/broken')) throw new Error('AccessDenied');
        return { access_key_id: 'ASIAROLEEXAMPLE', secret_access_key: 'role-SECRET', session_token: 'tok-SECRET' };
      },
    });
    const by = f.adminPrincipal;
    await roleBroker.registerCredential({ name: 'role', kind: 'aws-role', secret: { region: 'us-west-2', service: 'athena', role_arn: 'arn:aws:iam::123456789012:role/data', external_id: 'ext-1' }, by });
    await roleBroker.registerCredential({ name: 'role-broken', kind: 'aws-role', secret: { region: 'us-west-2', service: 'glue', role_arn: 'arn:aws:iam::123456789012:role/broken' }, by });
    await roleBroker.defineCapability({ name: 'role', credential: 'role', scope: { hosts: ['127.0.0.1'], methods: ['POST'], scopes: ['query'] }, by });
    await roleBroker.defineCapability({ name: 'role-broken', credential: 'role-broken', scope: { hosts: ['127.0.0.1'] }, by });
    const roleTool = (await makeToolDir({ language: 'typescript', entrypoint: 'src/index.ts', capabilities: [{ name: 'role', scope: 'query' }, { name: 'role-broken', scope: 'query' }] }, { 'src/index.ts': '' })).tool;
    const callRole = (capability: string) =>
      roleBroker.fetch({ capability, request: { url: `${base}/athena`, method: 'POST', headers: { 'x-amz-target': 'AmazonAthena.GetQueryExecution', 'content-type': 'application/x-amz-json-1.1' }, body: '{}' }, tool: roleTool, principal: f.adminPrincipal, execution_key: 'ses_X:s:1:0' });

    seen.length = 0;
    expect((await callRole('role')).status).toBe(200);
    expect(asked[0]).toEqual({ region: 'us-west-2', role_arn: 'arn:aws:iam::123456789012:role/data', external_id: 'ext-1', session_name: undefined });
    expect(seen[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAROLEEXAMPLE\/\d{8}\/us-west-2\/athena\/aws4_request, SignedHeaders=[a-z0-9;-]*x-amz-target[a-z0-9;-]*, Signature=[0-9a-f]{64}$/);
    expect(seen[0]!.headers['x-amz-security-token']).toBe('tok-SECRET');

    await expectError(callRole('role-broken'), 'internal', /could not obtain AWS credentials for arn:aws:iam::123456789012:role\/broken: AccessDenied/);
    expect(seen.length).toBe(1);
    const audit = await roleBroker.audit(20);
    expect(audit.some((r) => r.capability === 'role-broken' && r.ok === false && String(r.error).includes('AccessDenied'))).toBe(true);
    expect(JSON.stringify(audit)).not.toMatch(/SECRET/);

    // Nothing to hand an MCP server: the kind stores no keys.
    await expectError(roleBroker.credentialFor('role'), 'validation-failed', /signs brokered requests only/);
  });
});

describe('repository mirror auth', () => {
  const CC = 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/my-repo';

  it('checks a remote against the capability scope', () => {
    const scope = { hosts: ['git-codecommit.us-east-1.amazonaws.com'], methods: ['GET', 'POST'], path_prefixes: ['/v1/repos/my-repo/'], scopes: ['read'] };
    expect(checkRepoScope(scope, new URL(CC))).toEqual({ ok: true });
    expect(checkRepoScope(scope, new URL(`${CC}/`))).toEqual({ ok: true });
    expect(checkRepoScope(scope, new URL(`${CC}2`)).reason).toMatch(/path/);
    expect(checkRepoScope(scope, new URL('https://git-codecommit.us-west-2.amazonaws.com/v1/repos/my-repo')).reason).toMatch(/host/);
    expect(checkRepoScope({ ...scope, methods: ['GET'] }, new URL(CC)).reason).toMatch(/POST/);
    expect(checkRepoScope({ ...scope, scopes: ['query'] }, new URL(CC)).reason).toMatch(/scope 'read'/);
    expect(checkRepoScope(scope, new URL('http://git-codecommit.us-east-1.amazonaws.com/v1/repos/my-repo')).reason).toMatch(/scheme/);
    expect(checkRepoScope({ hosts: ['127.0.0.1'] }, new URL('http://127.0.0.1:9/r.git'))).toEqual({ ok: true });
  });

  it('turns credentials into git auth headers, audits each use, and keeps secrets out of the audit', async () => {
    const asked: string[] = [];
    const b = await createCredentialBroker({
      db: f.db,
      team_id: f.team_id,
      masterKey: MASTER,
      log: f.log,
      awsRoleResolver: async (m) => {
        asked.push(m.region);
        return { access_key_id: 'ASIAEXAMPLE', secret_access_key: 'cc-SECRET', session_token: 'cctok-SECRET' };
      },
    });
    const by = f.adminPrincipal;
    await b.registerCredential({ name: 'cc', kind: 'aws-role', secret: { region: 'us-east-1', service: 'codecommit', role_arn: 'arn:aws:iam::123456789012:role/git' }, by });
    await b.registerCredential({ name: 'cc-athena', kind: 'aws-role', secret: { region: 'us-east-1', service: 'athena' }, by });
    await b.registerCredential({ name: 'cc-west', kind: 'aws-role', secret: { region: 'us-west-2', service: 'codecommit' }, by });
    await b.registerCredential({ name: 'gh-git', kind: 'bearer', secret: 'gh-git-SECRET', by });
    const repoScope = { hosts: ['git-codecommit.us-east-1.amazonaws.com'], methods: ['GET', 'POST'], path_prefixes: ['/v1/repos/my-repo/'] };
    await b.defineCapability({ name: 'git-cc', credential: 'cc', scope: repoScope, by });
    await b.defineCapability({ name: 'git-cc-athena', credential: 'cc-athena', scope: repoScope, by });
    await b.defineCapability({ name: 'git-cc-west', credential: 'cc-west', scope: repoScope, by });
    await b.defineCapability({ name: 'git-gh', credential: 'gh-git', scope: { hosts: ['git.example.com'] }, by });
    await b.defineCapability({ name: 'git-role-elsewhere', credential: 'cc', scope: { hosts: ['git.example.com'] }, by });
    const auth = (capability: string, url = CC) => b.withRepoAuth({ capability, url, principal: by }, async (h) => h);

    const h = await auth('git-cc');
    const [user, pass] = Buffer.from(h.Authorization!.replace(/^Basic /, ''), 'base64').toString('utf8').split(':');
    expect(user).toBe('ASIAEXAMPLE%cctok-SECRET');
    expect(pass).toMatch(/^\d{8}T\d{6}Z[0-9a-f]{64}$/);
    expect(asked).toEqual(['us-east-1']);
    expect(await auth('git-gh', 'https://git.example.com/team/app.git')).toEqual({ Authorization: 'Bearer gh-git-SECRET' });

    await expectError(auth('git-cc', `${CC}2`), 'grant-denied', /path/);
    await expectError(auth('git-cc-athena'), 'validation-failed', /service 'athena'/);
    await expectError(auth('git-cc-west'), 'validation-failed', /region us-west-2/);
    await expectError(auth('git-role-elsewhere', 'https://git.example.com/team/app.git'), 'validation-failed', /only for CodeCommit/);
    await expectError(auth('missing'), 'not-found');
    await expect(b.withRepoAuth({ capability: 'git-cc', url: CC, principal: by }, async () => Promise.reject(new Error('fetch exploded')))).rejects.toThrow('fetch exploded');

    const audit = (await b.audit(50)).filter((r) => r.method === 'GIT');
    expect(audit.some((r) => r.capability === 'git-cc' && r.ok === true && r.target_host === 'git-codecommit.us-east-1.amazonaws.com' && r.target_path === '/v1/repos/my-repo')).toBe(true);
    expect(audit.some((r) => r.capability === 'git-cc' && r.ok === false && r.error === 'fetch exploded')).toBe(true);
    expect(audit.some((r) => r.capability === 'git-cc-athena' && r.ok === false)).toBe(true);
    expect(JSON.stringify(audit)).not.toMatch(/SECRET/);
  });
});

describe('per-scope capability rules', () => {
  const S3 = 'https://my-bucket.s3.us-east-1.amazonaws.com';
  const scope = {
    hosts: ['my-bucket.s3.us-east-1.amazonaws.com'],
    methods: ['GET', 'DELETE'],
    path_prefixes: ['/reports/', '/data/'],
    scopes: ['read', 'write'],
    rules: [
      { scopes: ['read'], methods: ['GET'], path_prefixes: ['/reports/', '/data/'] },
      { scopes: ['write'], methods: ['DELETE'], path_prefixes: ['/data/tmp/'] },
    ],
  };
  const req = (method: string, path: string) => ({ method, url: new URL(`${S3}${path}`) });

  it('narrows the envelope per declared scope', () => {
    expect(checkScope(scope, 'read', req('GET', '/reports/q1.csv'))).toEqual({ ok: true });
    expect(checkScope(scope, 'write', req('DELETE', '/data/tmp/part-0.parquet'))).toEqual({ ok: true });
    // inside the envelope, outside the write rule
    expect(checkScope(scope, 'write', req('DELETE', '/reports/q1.csv')).reason).toMatch(/no capability rule for scope 'write' allows DELETE \/reports\/q1.csv/);
    expect(checkScope(scope, 'write', req('GET', '/data/tmp/x')).reason).toMatch(/allows GET/);
    // a rule never widens the envelope, nor the read-only method rule
    expect(checkScope({ ...scope, rules: [{ scopes: ['read'], methods: ['GET'], path_prefixes: ['/other/'] }] }, 'read', req('GET', '/other/x')).reason).toMatch(/path \/other\/x not in capability scope/);
    expect(checkScope({ ...scope, rules: [{ scopes: ['read'] }] }, 'read', req('DELETE', '/data/x')).reason).toMatch(/read-scoped/);
    expect(checkScope({ ...scope, scopes: undefined, rules: [{ scopes: ['read'] }] }, 'query', req('GET', '/data/x')).reason).toMatch(/no capability rule for scope 'query'/);
    // no rules: the envelope alone, as before
    expect(checkScope({ ...scope, rules: undefined }, 'write', req('DELETE', '/reports/q1.csv'))).toEqual({ ok: true });
  });

  it('applies read rules to repository mirrors', () => {
    const repo = { hosts: ['git.example.com'], path_prefixes: ['/team/'] };
    expect(checkRepoScope({ ...repo, rules: [{ scopes: ['read'], path_prefixes: ['/team/app.git/'] }] }, new URL('https://git.example.com/team/app.git'))).toEqual({ ok: true });
    expect(checkRepoScope({ ...repo, rules: [{ scopes: ['read'], path_prefixes: ['/team/app.git/'] }] }, new URL('https://git.example.com/team/other.git')).reason).toMatch(/no capability rule/);
    expect(checkRepoScope({ ...repo, rules: [{ scopes: ['read'], methods: ['GET'] }] }, new URL('https://git.example.com/team/app.git')).reason).toMatch(/GET, POST/);
  });

  it('stores rules and rejects ones outside the envelope or with unknown fields', async () => {
    const by = f.adminPrincipal;
    await broker.defineCapability({ name: 'bucket', credential: null, scope: { ...scope, rules: [{ scopes: ['read'], methods: ['get'] }, ...scope.rules.slice(1)] }, by });
    const stored = (await broker.listCapabilities()).find((c) => c.name === 'bucket')!.scope;
    expect(stored.rules).toEqual([{ scopes: ['read'], methods: ['GET'] }, scope.rules[1]]);
    await broker.defineCapability({ name: 'bucket-flat', credential: null, scope: { hosts: scope.hosts, rules: [] }, by });
    expect((await broker.listCapabilities()).find((c) => c.name === 'bucket-flat')!.scope).toEqual({ hosts: scope.hosts });

    const define = (s: Record<string, unknown>) => broker.defineCapability({ name: 'bad', credential: null, scope: { hosts: scope.hosts, ...s } as any, by });
    await expectError(define({ rule: [] }), 'validation-failed', /unknown field\(s\) rule/);
    await expectError(define({ rules: {} }), 'validation-failed', /must be an array/);
    await expectError(define({ rules: [{ methods: ['GET'] }] }), 'validation-failed', /at least one scope/);
    await expectError(define({ rules: [{ scopes: ['read'], path: ['/x/'] }] }), 'validation-failed', /unknown field\(s\) path/);
    await expectError(define({ scopes: ['read'], rules: [{ scopes: ['write'] }] }), 'validation-failed', /scope 'write' is not in scope.scopes/);
    await expectError(define({ methods: ['GET'], rules: [{ scopes: ['read'], methods: ['DELETE'] }] }), 'validation-failed', /method DELETE is not in scope.methods/);
    await expectError(define({ path_prefixes: ['/data/'], rules: [{ scopes: ['read'], path_prefixes: ['/reports/'] }] }), 'validation-failed', /'\/reports\/' is not under scope.path_prefixes/);
    expect((await broker.listCapabilities()).some((c) => c.name === 'bad')).toBe(false);
  });

  it('signs an S3 range read through a rule and refuses a delete the rule does not cover', async () => {
    const b = await createCredentialBroker({ db: f.db, team_id: f.team_id, masterKey: MASTER, log: f.log, awsRoleResolver: async () => ({ access_key_id: 'ASIAS3EXAMPLE', secret_access_key: 's3-SECRET' }) });
    const by = f.adminPrincipal;
    await b.registerCredential({ name: 's3-role', kind: 'aws-role', secret: { region: 'us-east-1', service: 's3', role_arn: 'arn:aws:iam::123456789012:role/data' }, by });
    await b.defineCapability({ name: 's3-rules', credential: 's3-role', scope: { ...scope, hosts: ['127.0.0.1'] }, by });
    const s3Tool = (await makeToolDir({ language: 'typescript', entrypoint: 'src/index.ts', capabilities: [{ name: 's3-rules', scope: 'read' }] }, { 'src/index.ts': '' })).tool;
    const s3Writer = (await makeToolDir({ language: 'typescript', entrypoint: 'src/index.ts', capabilities: [{ name: 's3-rules', scope: 'write' }] }, { 'src/index.ts': '' })).tool;
    const go = (t: Tool, method: string, path: string, headers?: Record<string, string>) =>
      b.fetch({ capability: 's3-rules', request: { url: `${base}${path}`, method, headers }, tool: t, principal: by, execution_key: 'ses_X:s:1:0' });

    seen.length = 0;
    expect((await go(s3Tool, 'GET', '/reports/q1.csv', { range: 'bytes=0-99' })).status).toBe(200);
    expect(seen[0]!.headers.range).toBe('bytes=0-99');
    expect(seen[0]!.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAS3EXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request/);
    expect((await go(s3Writer, 'DELETE', '/data/tmp/part-0')).status).toBe(200);
    await expectError(go(s3Writer, 'DELETE', '/reports/q1.csv'), 'grant-denied', /no capability rule for scope 'write'/);
    expect(seen.length).toBe(2);
    expect((await b.audit(20)).some((r) => r.capability === 's3-rules' && r.ok === false && String(r.error).includes('no capability rule'))).toBe(true);
  });
});
