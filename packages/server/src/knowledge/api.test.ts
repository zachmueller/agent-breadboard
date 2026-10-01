import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { BreadboardError } from '@breadboard/shared';
import { register } from '../api/knowledge.js';
import type { Principal } from '../core/principal.js';
import { aiPrincipal, createKnowledgeKit, type KnowledgeKit } from './testkit.js';

describe('knowledge REST routes', () => {
  let kit: KnowledgeKit;
  let app: FastifyInstance;
  const principals = new Map<string, Principal>();

  beforeEach(async () => {
    kit = await createKnowledgeKit();
    principals.set('member', kit.f.memberPrincipal);
    principals.set('admin', kit.f.adminPrincipal);
    principals.set('ai', aiPrincipal(kit.f, { read: ['ops'], write: ['ops'] }));
    principals.set('reader', { ...kit.f.memberPrincipal, scopes: ['knowledge:read'] });
    app = Fastify();
    app.addHook('preHandler', async (req) => {
      (req as any).principal = principals.get(String(req.headers['x-who'] ?? 'member'));
    });
    app.setErrorHandler((err: any, _req, reply) => {
      if (err instanceof BreadboardError) return reply.status(err.status).send(err.toJSON());
      return reply.status(500).send({ error: { code: 'internal', message: String(err?.message) } });
    });
    const services = {
      knowledge: kit.knowledge,
      nodes: kit.f.nodes,
      db: kit.f.db,
      content: { nodeDto: async (n: unknown) => n },
      connectors: { status: async () => [], syncNow: async () => ({ fetched: 0, updated: 0, errors: [] }) },
    };
    await register(app, services as any);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await kit.close();
  });

  it('create → read → edit → revert, with typed errors', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/knowledge', payload: { title: 'Runbook', markdown: 'step one\n\nstep two', domains: ['ops'] } });
    expect(created.statusCode).toBe(201);
    const uid = created.json().uid;

    const read = await app.inject({ method: 'GET', url: `/api/v1/knowledge/${uid}`, headers: { 'x-who': 'ai' } });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ uid, markdown: 'step one\n\nstep two', domains: ['ops'] });
    const base = read.json().base_revision;

    const md = await app.inject({ method: 'GET', url: `/api/v1/knowledge/${uid}/markdown` });
    expect(md.json()).toMatchObject({ markdown: 'step one\n\nstep two', base_revision: base });

    const edit = await app.inject({ method: 'POST', url: `/api/v1/knowledge/${uid}/edits`, headers: { 'x-who': 'ai' }, payload: { base_revision: base, markdown: 'step one\n\nstep two\n\nstep three' } });
    expect(edit.statusCode).toBe(200);
    expect(edit.json()).toMatchObject({ applied: true, had_concurrent_edits: false, merged_markdown: 'step one\n\nstep two\n\nstep three' });

    const old = await app.inject({ method: 'POST', url: `/api/v1/knowledge/${uid}/edits`, headers: { 'x-who': 'ai' }, payload: { base_revision: 999, markdown: 'x' } });
    expect(old.statusCode).toBe(409);
    expect(old.json().error.code).toBe('base-revision-too-old');

    const ro = await app.inject({ method: 'POST', url: `/api/v1/knowledge/${uid}/edits`, headers: { 'x-who': 'reader' }, payload: { base_revision: base, markdown: 'x' } });
    expect(ro.statusCode).toBe(403);

    const bad = await app.inject({ method: 'POST', url: `/api/v1/knowledge/${uid}/edits`, payload: { markdown: 'x' } });
    expect(bad.json().error.code).toBe('validation-failed');

    const rv = await app.inject({ method: 'POST', url: `/api/v1/knowledge/${uid}/revert-ai-edit`, payload: { pre_ai_edit_revision: edit.json().pre_ai_edit_revision } });
    expect(rv.statusCode).toBe(200);
    expect(await kit.knowledge.markdownOf(uid)).toBe('step one\n\nstep two');

    const attr = await app.inject({ method: 'GET', url: `/api/v1/knowledge/${uid}/attribution` });
    expect(Object.keys(attr.json().blocks).length).toBeGreaterThanOrEqual(2);

    const search = await app.inject({ method: 'GET', url: `/api/v1/knowledge/search?q=step&mode=text&domain=ops` });
    expect(search.json().items.map((h: any) => h.uid)).toEqual([uid]);
    expect((await app.inject({ method: 'GET', url: `/api/v1/knowledge/search?q=step&mode=bogus` })).statusCode).toBe(400);

    const domains = await app.inject({ method: 'GET', url: `/api/v1/knowledge/domains`, headers: { 'x-who': 'ai' } });
    expect(domains.json().items.map((d: any) => d.slug)).toEqual(['ops']);

    expect((await app.inject({ method: 'POST', url: `/api/v1/knowledge/${uid}/compact` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/v1/knowledge/${uid}/compact`, headers: { 'x-who': 'admin' } })).json()).toHaveProperty('pruned');

    const missing = await app.inject({ method: 'GET', url: `/api/v1/knowledge/0000000000000000000Z` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('note-not-found');
  });
});
