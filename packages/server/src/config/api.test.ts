import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BreadboardError, CONFIG_PATHS, SCHEMA_TAGS, mintUid, owningDefinition, toYaml } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import type { Principal } from '../core/principal.js';
import { createConfigRepo } from './repo.js';
import { createConfigService } from './service.js';
import { register } from '../api/config.js';

let f: Foundation;
let app: FastifyInstance;
let root: string;
let current: Principal;
const SUB = mintUid();

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'bb-config-api-'));
  const seed = join(root, 'seed');
  await fs.mkdir(join(seed, 'presets'), { recursive: true });
  await fs.mkdir(join(seed, 'subagents'), { recursive: true });
  await fs.writeFile(join(seed, 'breadboard.yaml'), toYaml({ schema: SCHEMA_TAGS.breadboard }));
  await fs.writeFile(join(seed, 'tenets.md'), 'Be precise.\n');
  await fs.writeFile(join(seed, 'presets/models.yaml'), toYaml({ schema: SCHEMA_TAGS.presets, presets: { medium: [{ provider: 'mock', model_id: 'm' }] } }));
  await fs.writeFile(join(seed, CONFIG_PATHS.subagent(SUB)), toYaml({ schema: SCHEMA_TAGS.subagent, uid: SUB, slug: 'scout', title: 'Scout', model_preset: 'medium' }));
  f = await createFoundation();
  const repo = createConfigRepo({ dir: join(root, 'repo.git'), cacheDir: join(root, 'trees'), log: f.log });
  await repo.init(seed);
  const config = createConfigService({ repo, db: f.db, team_id: f.team_id, log: f.log });
  current = f.memberPrincipal;
  app = Fastify();
  app.addHook('preHandler', async (req) => {
    (req as any).principal = current;
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof BreadboardError) return reply.status(err.status).send(err.toJSON());
    reply.status(500).send({ error: { code: 'internal', message: String(err?.message) } });
  });
  const toolbox = { ci: async (uid: string, ref: string) => ({ ok: true, errors: [], warnings: [`checked ${uid}@${ref}`] }) };
  await register(app, { config, toolbox } as any);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await f.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('config routes', () => {
  it('serves tree/search/main/definitions (uid, encoded path, wildcard path)', async () => {
    const main = await app.inject({ method: 'GET', url: '/api/v1/config/main' });
    expect(main.statusCode).toBe(200);
    expect(main.json().commit).toMatch(/^[0-9a-f]{40}$/);
    const tree = await app.inject({ method: 'GET', url: '/api/v1/config/tree' });
    expect(tree.json().map((e: any) => e.kind)).toEqual(['breadboard', 'tenets', 'presets', 'subagent']);
    expect((await app.inject({ method: 'GET', url: '/api/v1/config/search?q=sco' })).json()[0].uid).toBe(SUB);
    expect((await app.inject({ method: 'GET', url: `/api/v1/config/definitions/${SUB}` })).json().slug).toBe('scout');
    expect((await app.inject({ method: 'GET', url: `/api/v1/config/definitions/${encodeURIComponent(CONFIG_PATHS.subagent(SUB))}` })).json().uid).toBe(SUB);
    expect((await app.inject({ method: 'GET', url: `/api/v1/config/definitions/${CONFIG_PATHS.subagent(SUB)}?ref=main` })).json().uid).toBe(SUB);
    expect((await app.inject({ method: 'GET', url: '/api/v1/config/definitions/tenets' })).json().raw).toBe('Be precise.\n');
    expect((await app.inject({ method: 'GET', url: `/api/v1/config/definitions/${mintUid()}` })).statusCode).toBe(404);
    // Slugs resolve only through read_config: the UI builds file paths from the id it routes on.
    expect((await app.inject({ method: 'GET', url: '/api/v1/config/definitions/scout' })).statusCode).toBe(404);
    const hist = await app.inject({ method: 'GET', url: '/api/v1/config/history?limit=5' });
    expect(hist.json()).toHaveLength(1);
  });

  it('validates, mints skeletons, and runs a proposal through merge over HTTP', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/v1/config/validate', payload: { changes: [{ path: 'tenets.md', content: 'x'.repeat(3000) }] } });
    expect(bad.statusCode).toBe(200);
    expect(bad.json().ok).toBe(false);
    const malformed = await app.inject({ method: 'POST', url: '/api/v1/config/validate', payload: { changes: [{ content: 'x' }] } });
    expect(malformed.statusCode).toBe(400);

    const skel = await app.inject({ method: 'POST', url: '/api/v1/config/new', payload: { kind: 'subagent', slug: 'writer', title: 'Writer' } });
    expect(skel.statusCode).toBe(200);
    const changes = skel.json().changes;
    expect(changes).toHaveLength(1);

    const created = await app.inject({ method: 'POST', url: '/api/v1/config/proposals', payload: { changes, message: 'add writer' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().proposal_id;
    expect((await app.inject({ method: 'GET', url: '/api/v1/config/proposals?status=open' })).json().map((p: any) => p.proposal_id)).toEqual([id]);
    expect((await app.inject({ method: 'GET', url: `/api/v1/config/proposals/${id}` })).json().changes[0].status).toBe('added');
    const amended = await app.inject({ method: 'POST', url: `/api/v1/config/proposals/${id}/amend`, payload: { changes: [{ path: 'tenets.md', content: 'Be precise and kind.\n' }], message: 'tenets' } });
    expect(amended.statusCode).toBe(200);
    expect(amended.json().changes.map((c: any) => c.path).sort()).toEqual([changes[0].path, 'tenets.md'].sort());

    // A service token without config:merge cannot merge; with it, it can.
    current = { ...f.servicePrincipal, scopes: ['config:propose'], token_kind: 'service' };
    expect((await app.inject({ method: 'POST', url: `/api/v1/config/proposals/${id}/merge` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/config/tree' })).statusCode).toBe(200);
    current = { ...f.servicePrincipal, scopes: ['config:merge'], token_kind: 'service' };
    const merged = await app.inject({ method: 'POST', url: `/api/v1/config/proposals/${id}/merge` });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().status).toBe('merged');
    current = f.memberPrincipal;
    expect((await app.inject({ method: 'GET', url: '/api/v1/config/definitions/tenets' })).json().raw).toBe('Be precise and kind.\n');
    expect((await app.inject({ method: 'GET', url: '/api/v1/config/tree' })).json().filter((e: any) => e.kind === 'subagent')).toHaveLength(2);

    const direct = await app.inject({ method: 'POST', url: '/api/v1/config/commit', payload: { changes: [{ path: 'tenets.md', content: 'Direct.\n' }], message: 'direct' } });
    expect(direct.statusCode).toBe(201);
    const reverted = await app.inject({ method: 'POST', url: '/api/v1/config/revert', payload: { path: 'tenets.md', to_commit: merged.json().merged_commit } });
    expect(reverted.statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/api/v1/config/definitions/tenets' })).json().raw).toBe('Be precise and kind.\n');

    const discard = await app.inject({ method: 'POST', url: '/api/v1/config/proposals', payload: { changes: [{ path: 'tenets.md', content: 'tmp\n' }], message: 'tmp' } });
    const d = await app.inject({ method: 'POST', url: `/api/v1/config/proposals/${discard.json().proposal_id}/discard` });
    expect(d.json().status).toBe('discarded');
    expect((await app.inject({ method: 'POST', url: `/api/v1/config/proposals/${discard.json().proposal_id}/merge` })).statusCode).toBe(409);
  });

  it('filters proposals by conversation and definition, and runs tool checks at the head', async () => {
    const sid = `ses_${mintUid()}`;
    const skel = (await app.inject({ method: 'POST', url: '/api/v1/config/new', payload: { kind: 'tool', slug: 'probe', title: 'Probe', language: 'typescript' } })).json();
    const toolUid = skel.changes.map((c: any) => owningDefinition(c.path)?.uid).find(Boolean);
    const tool = (await app.inject({ method: 'POST', url: '/api/v1/config/proposals', payload: { changes: skel.changes, message: 'add probe', session_id: sid } })).json();
    const other = (await app.inject({ method: 'POST', url: '/api/v1/config/proposals', payload: { changes: [{ path: 'tenets.md', content: 'Other.\n' }], message: 'other' } })).json();
    expect(tool.session_id).toBe(sid);
    expect(other.session_id).toBeNull();
    const ids = async (query: string) => (await app.inject({ method: 'GET', url: `/api/v1/config/proposals${query}` })).json().map((p: any) => p.proposal_id);
    expect(await ids(`?status=open&definition=${toolUid}`)).toEqual([tool.proposal_id]);
    expect(await ids(`?status=open&definition=${SUB}`)).toEqual([]);
    expect(await ids(`?session_id=${sid}`)).toEqual([tool.proposal_id]);

    const checks = (await app.inject({ method: 'GET', url: `/api/v1/config/proposals/${tool.proposal_id}/checks` })).json();
    expect(checks).toEqual({ proposal_id: tool.proposal_id, head_commit: tool.head_commit, tools: [{ uid: toolUid, ok: true, errors: [], warnings: [`checked ${toolUid}@${tool.head_commit}`] }] });
    expect((await app.inject({ method: 'GET', url: `/api/v1/config/proposals/${other.proposal_id}/checks` })).json().tools).toEqual([]);
    for (const p of [tool, other]) await app.inject({ method: 'POST', url: `/api/v1/config/proposals/${p.proposal_id}/discard` });
  });
});
