import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import Docker from 'dockerode';
import { mintSessionId, mintUid, BreadboardError } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import type { AuthService, SandboxRunInput, SandboxRunner, SandboxRunResult } from '../core/services.js';
import type { Principal } from '../core/principal.js';
import { EgressProxy } from './egress-proxy.js';
import { apiEgressRule } from './index.js';
import { SANDBOX_LABEL, dockerConnection } from './sandbox/docker.js';
import { createToolbox, mergeSettings, type ToolboxImpl } from './toolbox.js';
import { executionKey, inputHash, canonicalJson } from './journal.js';
import { TEST_RUNNER, createTestSandboxRunner, defaultSettings, fakeConfig, makeToolDir, testProxyListen } from './test-helpers.js';

const PYTHON = process.env.PYTHON_BIN ?? 'python3';
const DOCKER = TEST_RUNNER === 'docker';
const hasPython = (() => {
  if (DOCKER) return true; // the Python sandbox image
  try {
    execFileSync(PYTHON, ['--version']);
    return true;
  } catch {
    return false;
  }
})();

const TS_HANDLER = `
export async function handler(input: { n: number; mode?: string; url?: string }, ctx: any): Promise<unknown> {
  ctx.log('info', 'hi', { n: input.n });
  if (input.mode === 'busy') { for (;;) {} }
  if (input.mode === 'throw') throw new Error('boom from tool');
  if (input.mode === 'artifact') {
    const ref = await ctx.createArtifact({ title: 'from tool', body: 'hello' });
    return { exit: 'done', output: { n: input.n * 2, ref } };
  }
  if (input.mode === 'egress') {
    const res = await fetch(input.url!);
    return { exit: 'done', output: { n: res.status } };
  }
  if (input.mode === 'settings') return { exit: 'done', output: { n: input.n, settings: ctx.ambient.settings } };
  if (input.mode === 'raw') {
    // Ignores the proxy variables and opens a TCP socket straight at the target.
    const net = await import('node:net');
    const u = new URL(input.url!);
    const result = await new Promise<string>((resolve) => {
      const sock = net.connect({ host: u.hostname, port: Number(u.port || 80), timeout: 3000 });
      sock.on('connect', () => { sock.destroy(); resolve('connected'); });
      sock.on('timeout', () => { sock.destroy(); resolve('timeout'); });
      sock.on('error', (e: any) => resolve(e.code ?? 'error'));
    });
    return { exit: 'done', output: { n: 0, result } };
  }
  if (input.mode === 'oom') {
    const hog: Buffer[] = [];
    for (let i = 0; i < 64; i++) hog.push(Buffer.alloc(16 * 1024 * 1024, 1));
    return { exit: 'done', output: { n: hog.length } };
  }
  return { exit: 'done', output: { n: input.n * 2 } };
}
`;

const PY_HANDLER = `
def handler(input, ctx):
    ctx.log("info", "hi from python")
    ref = ctx.create_artifact(title="from py", body="hello")
    return {"exit": "done", "output": {"n": input["n"] * 2, "ref": ref}}
`;

const INPUT_SCHEMA = { type: 'object', required: ['n'], properties: { n: { type: 'number' }, mode: { type: 'string' }, url: { type: 'string' } } };

let f: Foundation;
let api: http.Server;
let apiPort: number;
const primitiveCalls: Array<{ name: string; auth: string | undefined; execution: string | undefined; body: any }> = [];
let target: http.Server;
let targetPort: number;
let proxy: EgressProxy;
let runs = 0;
let toolbox: ToolboxImpl;
const minted: Array<{ ttlSeconds: number; execution_key?: string | null; actor: string }> = [];
let tsTool: Awaited<ReturnType<typeof makeToolDir>>;
let pyTool: Awaited<ReturnType<typeof makeToolDir>>;
let slowTool: Awaited<ReturnType<typeof makeToolDir>>;
let costlyTool: Awaited<ReturnType<typeof makeToolDir>>;
let oomTool: Awaited<ReturnType<typeof makeToolDir>>;
let runner: SandboxRunner;
/** The runner reads `sandbox.images` per run, so tests may switch images by mutating this object. */
const sandboxImages = defaultSettings().sandbox.images;

function subagentPrincipal(tools: Record<string, Record<string, unknown>>, override: string[] | null = null): Principal {
  return {
    actor: { kind: 'subagent', id: mintUid() },
    team_id: f.team_id,
    user: null,
    roles: [],
    is_admin: false,
    scopes: null,
    grants: {
      subagent_uid: mintUid(),
      tools: new Map(Object.entries(tools)),
      mcp: new Map(),
      circuits: { read: new Set(), execute: new Set() },
      knowledge: { read: new Set(), write: new Set() },
      primitives: new Set(),
      tools_override: override ? new Set(override) : null,
    },
    session_id: null,
    visible_sessions: null,
    config_commit: null,
    execution_key: null,
    token_kind: 'actor',
  };
}

async function newSession(): Promise<string> {
  const id = mintSessionId();
  await f.db.query(`INSERT INTO sessions (session_id, team_id, kind, budget) VALUES ($1, $2, 'circuit-run', '{}'::jsonb)`, [id, f.team_id]);
  return id;
}

async function expectError(p: Promise<unknown>, code: string, msg?: RegExp): Promise<BreadboardError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BreadboardError);
    expect((e as BreadboardError).code).toBe(code);
    if (msg) expect((e as Error).message).toMatch(msg);
    return e as BreadboardError;
  }
  throw new Error(`expected ${code} error`);
}

beforeAll(async () => {
  f = await createFoundation();
  api = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const m = /^\/api\/v1\/primitives\/([a-z_]+)$/.exec(req.url ?? '');
      if (!m || req.method !== 'POST') return res.writeHead(404).end();
      primitiveCalls.push({ name: m[1]!, auth: req.headers.authorization, execution: req.headers['x-breadboard-execution'] as string, body: JSON.parse(body || '{}') });
      if (m[1] === 'create_artifact') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ uid: 'ARTFCT00000000000001', revision_id: 1 }));
      } else res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'validation-failed', message: 'nope' } }));
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  apiPort = (api.address() as any).port;
  target = http.createServer((_req, res) => res.writeHead(200).end('target-ok'));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  targetPort = (target.address() as any).port;

  // Process runner: API host `localhost` bypasses the proxy (NO_PROXY). Docker runner: the API is reached through
  // the proxy as an implicit destination. Either way the egress target is addressed as 127.0.0.1 and must go
  // through the proxy.
  const publicUrl = `http://localhost:${apiPort}`;
  proxy = new EgressProxy({ ...testProxyListen(), db: f.db, log: f.log, implicitAllow: apiEgressRule(publicUrl) });
  await proxy.start();

  const inner = createTestSandboxRunner({ log: f.log, proxy, apiUrl: publicUrl, pythonBin: PYTHON, objects: f.objects, images: sandboxImages });
  runner = inner;
  await inner.start();
  const counting: SandboxRunner = {
    kind: inner.kind,
    start: () => inner.start(),
    stop: () => inner.stop(),
    health: () => inner.health(),
    run: async (i: SandboxRunInput): Promise<SandboxRunResult> => {
      runs++;
      return inner.run(i);
    },
  };

  tsTool = await makeToolDir(
    {
      language: 'typescript',
      entrypoint: 'src/index.ts',
      input: INPUT_SCHEMA,
      settings: { strict: { type: 'boolean', default: false }, secret_mode: { type: 'string', default: 'safe', hidden: true } },
      limits: { timeout_s: 20, max_cost_units: 1 },
      egress: { allow: [{ host: '127.0.0.1', ports: [targetPort] }] },
    },
    { 'src/index.ts': TS_HANDLER },
  );
  pyTool = await makeToolDir({ language: 'python', entrypoint: 'src/main.py', input: INPUT_SCHEMA }, { 'src/main.py': PY_HANDLER });
  slowTool = await makeToolDir({ language: 'typescript', entrypoint: 'src/index.ts', input: INPUT_SCHEMA, limits: { timeout_s: 1 } }, { 'src/index.ts': TS_HANDLER });
  costlyTool = await makeToolDir({ language: 'typescript', entrypoint: 'src/index.ts', input: INPUT_SCHEMA, limits: { max_cost_units: 60 } }, { 'src/index.ts': TS_HANDLER });
  oomTool = await makeToolDir({ language: 'typescript', entrypoint: 'src/index.ts', input: INPUT_SCHEMA, limits: { memory_mb: 128, timeout_s: 30 } }, { 'src/index.ts': TS_HANDLER });

  const settings = defaultSettings((s) => {
    s.sandbox.nesting_depth_cap = 3;
  });
  const auth = {
    async mintActorToken(input: { principal: Principal; ttlSeconds: number; execution_key?: string | null }) {
      minted.push({ ttlSeconds: input.ttlSeconds, execution_key: input.execution_key, actor: input.principal.actor.kind });
      return `actor-token-${minted.length}`;
    },
  } as unknown as AuthService;
  toolbox = createToolbox({
    config: fakeConfig({ tools: [tsTool, pyTool, slowTool, costlyTool, oomTool], settings }),
    sandbox: counting,
    proxy,
    auth,
    objects: f.objects,
    db: f.db,
    team_id: f.team_id,
    publicUrl,
    log: f.log,
    settings: async () => settings,
    pythonBin: PYTHON,
  });
});

afterAll(async () => {
  await runner?.stop();
  await proxy?.stop();
  await new Promise((r) => api?.close(r));
  await new Promise((r) => target?.close(r));
  await f?.close();
});

describe('journal helpers', () => {
  it('derives keys and canonical hashes', () => {
    expect(executionKey({ session_id: 'ses_X', step_id: 'gather', attempt: 2, call_index: 3 })).toBe('ses_X:gather:2:3');
    expect(executionKey({})).toMatch(/^adhoc:[0-9A-Z]{20}$/);
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(inputHash({ a: 1, b: 2 })).toBe(inputHash({ b: 2, a: 1 }));
  });
});

describe(`ToolboxImpl.invoke (${TEST_RUNNER} runner)`, () => {
  it('runs a TypeScript tool, returns output + logs, and ctx primitives round-trip with the actor token', async () => {
    const before = runs;
    const r = await toolbox.invoke({ tool_uid: tsTool.uid, input: { n: 21, mode: 'artifact' }, principal: f.adminPrincipal, ambient: { invocation: 'tool-call' } });
    expect(runs).toBe(before + 1);
    expect(r.replayed).toBe(false);
    expect(r.output).toEqual({ exit: 'done', output: { n: 42, ref: { uid: 'ARTFCT00000000000001', revision_id: 1 } } });
    expect(r.logs.map((l) => l.message)).toContain('hi');
    expect(r.execution_key).toMatch(/^adhoc:/);
    expect(r.cost_units).toBe(1);
    const call = primitiveCalls.find((c) => c.execution === r.execution_key)!;
    expect(call.name).toBe('create_artifact');
    expect(call.body).toEqual({ title: 'from tool', body: 'hello' });
    const mint = minted.find((m) => m.execution_key === r.execution_key)!;
    expect(call.auth).toBe(`Bearer actor-token-${minted.indexOf(mint) + 1}`);
    expect(mint.ttlSeconds).toBe(20 + 60);
    // ad-hoc executions are journaled too
    const row = await toolbox.journal.lookup(r.execution_key);
    expect(row?.status).toBe('completed');
    expect(row?.tool_commit).toBe(tsTool.commit);
    // ctx.log entries are journaled, so the code-step drawer can show them.
    expect(row?.logs).toEqual([expect.objectContaining({ level: 'info', message: 'hi', data: { n: 21 } })]);
  });

  it.skipIf(!hasPython)('runs a Python tool through the same contract', async () => {
    const r = await toolbox.invoke({ tool_uid: pyTool.uid, input: { n: 5 }, principal: f.adminPrincipal, ambient: { invocation: 'code-step' } });
    expect(r.output).toEqual({ exit: 'done', output: { n: 10, ref: { uid: 'ARTFCT00000000000001', revision_id: 1 } } });
    expect(r.logs.map((l) => l.message)).toContain('hi from python');
    expect(primitiveCalls.some((c) => c.execution === r.execution_key && c.body.title === 'from py')).toBe(true);
  });

  it('replays a completed execution key from the journal without re-running', async () => {
    const session_id = await newSession();
    const inv = { tool_uid: tsTool.uid, input: { n: 4 }, principal: f.adminPrincipal, ambient: { invocation: 'code-step' as const }, session_id, step_id: 'compute', attempt: 1, call_index: 0 };
    const before = runs;
    const first = await toolbox.invoke(inv);
    expect(first.replayed).toBe(false);
    expect(first.execution_key).toBe(`${session_id}:compute:1:0`);
    const second = await toolbox.invoke(inv);
    expect(runs).toBe(before + 1);
    expect(second.replayed).toBe(true);
    expect(second.output).toEqual(first.output);
    // Same key, different input → idempotency mismatch rather than a silent re-run.
    await expectError(toolbox.invoke({ ...inv, input: { n: 5 } }), 'idempotency-mismatch');
    const rows = await toolbox.executions(session_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'completed', tool_uid: tsTool.uid, step_id: 'compute', attempt: 1, call_index: 0 });
  });

  it('re-executes a failed journal row on retry of the same key', async () => {
    const session_id = await newSession();
    const inv = { tool_uid: tsTool.uid, input: { n: 1, mode: 'throw' }, principal: f.adminPrincipal, ambient: { invocation: 'code-step' as const }, session_id, step_id: 's', attempt: 1, call_index: 0 };
    const err = await expectError(toolbox.invoke(inv), 'internal', /boom from tool/);
    expect((err.detail as any).execution_key).toBe(`${session_id}:s:1:0`);
    expect((await toolbox.journal.lookup(`${session_id}:s:1:0`))?.status).toBe('failed');
    const before = runs;
    await expectError(toolbox.invoke(inv), 'internal', /boom/);
    expect(runs).toBe(before + 1);
  });

  it('kills a tool that exceeds its wall-clock timeout (SIGKILL even when the event loop is blocked)', async () => {
    const t0 = Date.now();
    const err = await expectError(toolbox.invoke({ tool_uid: slowTool.uid, input: { n: 1, mode: 'busy' }, principal: f.adminPrincipal, ambient: { invocation: 'tool-call' } }), 'internal', /timed out/);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect((err.detail as any).timed_out).toBe(true);
    expect((await toolbox.journal.lookup((err.detail as any).execution_key))?.status).toBe('failed');
  });

  it('rejects invalid input before running', async () => {
    const before = runs;
    await expectError(toolbox.invoke({ tool_uid: tsTool.uid, input: { n: 'nope' }, principal: f.adminPrincipal, ambient: { invocation: 'tool-call' } }), 'validation-failed', /input/);
    await expectError(toolbox.invoke({ tool_uid: tsTool.uid, input: {}, principal: f.adminPrincipal, ambient: { invocation: 'tool-call' } }), 'validation-failed');
    expect(runs).toBe(before);
  });

  it('merges settings defaults ← grant ← caller, and rejects caller overrides of hidden settings', async () => {
    const p = subagentPrincipal({ [tsTool.uid]: { secret_mode: 'grant-value', strict: true } });
    const r = await toolbox.invoke({ tool_uid: tsTool.uid, input: { n: 1, mode: 'settings' }, settings: { strict: false }, principal: p, ambient: { invocation: 'tool-call' } });
    expect((r.output as any).output.settings).toEqual({ strict: false, secret_mode: 'grant-value' });
    const before = runs;
    await expectError(
      toolbox.invoke({ tool_uid: tsTool.uid, input: { n: 1 }, settings: { secret_mode: 'model-chosen' }, principal: p, ambient: { invocation: 'tool-call' } }),
      'validation-failed',
      /hidden/,
    );
    await expectError(toolbox.invoke({ tool_uid: tsTool.uid, input: { n: 1 }, settings: { nope: 1 }, principal: p, ambient: { invocation: 'tool-call' } }), 'validation-failed', /unknown setting/);
    expect(runs).toBe(before);
    expect(() => mergeSettings(tsTool.tool, {}, { strict: 'yes' })).toThrow(/type boolean/);
  });

  it('enforces subagent grants and step tools_override narrowing; users may invoke anything', async () => {
    await expectError(toolbox.invoke({ tool_uid: tsTool.uid, input: { n: 1 }, principal: subagentPrincipal({}), ambient: { invocation: 'tool-call' } }), 'grant-denied');
    await expectError(
      toolbox.invoke({ tool_uid: tsTool.uid, input: { n: 1 }, principal: subagentPrincipal({ [tsTool.uid]: {} }, [pyTool.uid]), ambient: { invocation: 'tool-call' } }),
      'grant-denied',
    );
    const ok = await toolbox.invoke({ tool_uid: tsTool.uid, input: { n: 1 }, principal: subagentPrincipal({ [tsTool.uid]: {} }, [tsTool.uid]), ambient: { invocation: 'tool-call' } });
    expect((ok.output as any).output.n).toBe(2);
    const p = { ...subagentPrincipal({}), grants: null };
    await expectError(toolbox.invoke({ tool_uid: tsTool.uid, input: { n: 1 }, principal: p, ambient: { invocation: 'tool-call' } }), 'grant-denied');
  });

  it('enforces the nesting depth cap', async () => {
    const before = runs;
    await expectError(toolbox.invoke({ tool_uid: tsTool.uid, input: { n: 1 }, principal: f.adminPrincipal, ambient: { invocation: 'tool-call' }, depth: 4 }), 'invalid-state', /nesting depth/);
    expect(runs).toBe(before);
    const ok = await toolbox.invoke({ tool_uid: tsTool.uid, input: { n: 1 }, principal: f.adminPrincipal, ambient: { invocation: 'tool-call' }, depth: 3 });
    expect(ok.replayed).toBe(false);
  });

  it('enforces the per-session tool cost ceiling', async () => {
    const session_id = await newSession();
    const base = { tool_uid: costlyTool.uid, input: { n: 1 }, principal: f.adminPrincipal, ambient: { invocation: 'code-step' as const }, session_id, step_id: 'x', attempt: 1 };
    await toolbox.invoke({ ...base, call_index: 0 }); // 60 of 100
    await expectError(toolbox.invoke({ ...base, call_index: 1 }), 'budget-exceeded', /60 \+ 60 > 100/);
  });

  it('routes tool HTTP through the egress proxy: allowlisted host passes, others get 403', async () => {
    const ok = await toolbox.invoke({ tool_uid: tsTool.uid, input: { n: 0, mode: 'egress', url: `http://127.0.0.1:${targetPort}/x` }, principal: f.adminPrincipal, ambient: { invocation: 'tool-call' } });
    expect((ok.output as any).output.n).toBe(200);
    const denied = await toolbox.invoke({ tool_uid: tsTool.uid, input: { n: 0, mode: 'egress', url: `http://10.255.255.1:${targetPort}/x` }, principal: f.adminPrincipal, ambient: { invocation: 'tool-call' } });
    expect((denied.output as any).output.n).toBe(403);
    const audit = await f.db.query(`SELECT execution_key, tool_uid, host, port, allowed FROM egress_audit WHERE execution_key = ANY($1) ORDER BY audit_id`, [[ok.execution_key, denied.execution_key]]);
    expect(audit.rows.map((r: any) => [r.host, r.allowed, String(r.tool_uid).trim()])).toEqual([
      ['127.0.0.1', true, tsTool.uid],
      ['10.255.255.1', false, tsTool.uid],
    ]);
    expect(proxy.isRegistered(ok.execution_key)).toBe(false);
  });

  it('lists externally exposed tools', async () => {
    expect(await toolbox.externalTools()).toEqual([]);
  });
});

describe.runIf(DOCKER)('ToolboxImpl.invoke (docker isolation)', () => {
  const docker = new Docker(dockerConnection(process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock'));
  const sandboxContainers = async () => docker.listContainers({ all: true, filters: { label: [`${SANDBOX_LABEL}=1`] } });

  it('gives a tool that ignores the proxy no route anywhere (internal network)', async () => {
    for (const url of [`http://host.docker.internal:${apiPort}`, 'http://1.1.1.1:80']) {
      const r = await toolbox.invoke({ tool_uid: tsTool.uid, input: { n: 0, mode: 'raw', url }, principal: f.adminPrincipal, ambient: { invocation: 'tool-call' } });
      expect((r.output as any).output.result, url).not.toBe('connected');
    }
  });

  it('OOM-kills a tool that allocates beyond limits.memory_mb and journals it as failed', async () => {
    const err = await expectError(toolbox.invoke({ tool_uid: oomTool.uid, input: { n: 0, mode: 'oom' }, principal: f.adminPrincipal, ambient: { invocation: 'tool-call' } }), 'internal', /exit 137|without a result/);
    expect((await toolbox.journal.lookup((err.detail as any).execution_key))?.status).toBe('failed');
  });

  it('never runs a warm container started from a previous sandbox image', async () => {
    const warmPython = async () => (await sandboxContainers()).filter((c) => c.Labels['breadboard.language'] === 'python' && c.Labels['breadboard.state'] === 'warm').map((c) => c.Id);
    let stale = await warmPython();
    for (let i = 0; i < 100 && stale.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      stale = await warmPython();
    }
    expect(stale.length).toBeGreaterThan(0);
    const original = sandboxImages.python;
    const repo = original.split(':')[0]!;
    await docker.getImage(original).tag({ repo, tag: 'warm-pool-test' });
    const since = Math.floor(Date.now() / 1000) - 1;
    sandboxImages.python = `${repo}:warm-pool-test`;
    try {
      await toolbox.invoke({ tool_uid: pyTool.uid, input: { n: 3 }, principal: f.adminPrincipal, ambient: { invocation: 'code-step' } });
    } finally {
      sandboxImages.python = original;
    }
    const events = await new Promise<string>((resolve, reject) =>
      docker.getEvents({ since, until: Math.floor(Date.now() / 1000) + 1, filters: { container: stale } }, (err, stream) => {
        if (err || !stream) return reject(err);
        let out = '';
        stream.on('data', (b: Buffer) => (out += b.toString()));
        stream.on('end', () => resolve(out));
      }),
    );
    expect(events).not.toContain('exec_create');
    await docker.getImage(`${repo}:warm-pool-test`).remove().catch(() => undefined);
  });

  it('removes the container after one execution; only warm, unused containers remain', async () => {
    const before = new Set((await sandboxContainers()).map((c) => c.Id));
    await toolbox.invoke({ tool_uid: tsTool.uid, input: { n: 1 }, principal: f.adminPrincipal, ambient: { invocation: 'tool-call' } });
    let after = await sandboxContainers();
    for (let i = 0; i < 50 && [...before].every((id) => after.some((c) => c.Id === id)); i++) {
      await new Promise((r) => setTimeout(r, 100));
      after = await sandboxContainers();
    }
    expect([...before].some((id) => !after.some((c) => c.Id === id))).toBe(true);
    for (const c of after) expect(c.Labels['breadboard.state']).toBe('warm');
  });
});

describe('ToolboxImpl.ci', () => {
  it('passes a valid TypeScript tool and flags syntax / non-erasable TS', async () => {
    const good = await makeToolDir({ language: 'typescript', entrypoint: 'src/index.ts' }, { 'src/index.ts': TS_HANDLER });
    const bad = await makeToolDir({ language: 'typescript', entrypoint: 'src/index.ts' }, { 'src/index.ts': 'export function handler(input: {n:number} { return 1 }\n', 'src/e.ts': 'enum A { x }\nexport const a = A.x;\n' });
    const missing = await makeToolDir({ language: 'typescript', entrypoint: 'src/nope.ts' }, { 'src/index.ts': TS_HANDLER });
    const tb = createToolbox({ ...(toolbox as any).deps, config: fakeConfig({ tools: [good, bad, missing] }) });
    expect(await tb.ci(good.uid, 'main')).toMatchObject({ ok: true, errors: [] });
    const r = await tb.ci(bad.uid, 'main');
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith('src/index.ts:'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('src/e.ts: non-erasable'))).toBe(true);
    expect((await tb.ci(missing.uid, 'main')).errors).toContain('entrypoint src/nope.ts does not exist');
  });

  it.skipIf(!hasPython)('checks Python syntax', async () => {
    const good = await makeToolDir({ language: 'python', entrypoint: 'src/main.py' }, { 'src/main.py': PY_HANDLER });
    const bad = await makeToolDir({ language: 'python', entrypoint: 'src/main.py' }, { 'src/main.py': 'def handler(input, ctx)\n  return 1\n' });
    const tb = createToolbox({ ...(toolbox as any).deps, config: fakeConfig({ tools: [good, bad] }) });
    expect((await tb.ci(good.uid, 'main')).ok).toBe(true);
    const r = await tb.ci(bad.uid, 'main');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/^src\/main\.py: line 1/);
  });
});
