import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { BreadboardError, mintId } from '@breadboard/shared';
import type { Services } from '../core/services.js';
import { register } from '../api/conversations.js';
import { createFoundation, type Foundation } from '../test/harness.js';

const SID = mintId('ses');
let f: Foundation;
let app: FastifyInstance;
const calls: string[] = [];

beforeAll(async () => {
  f = await createFoundation();
  const conversations = {
    post: async (i: { text: string }) => (calls.push(`post:${i.text}`), { turns: [{ role: 'assistant' }], proposals: [] }),
    submit: async (i: { text: string; session_id: string }) => (calls.push(`submit:${i.text}`), { accepted: true, session_id: i.session_id }),
    turns: async () => [{ role: 'user' }],
    draftTask: async () => null,
    proposals: async () => ['prp_1'],
    busy: () => true,
  };
  const sessions = { mustGet: async () => ({ session_id: SID, state: 'running', state_detail: { last_error: 'boom' } }) };
  const services = { db: f.db, conversations, sessions } as unknown as Services;
  app = Fastify();
  app.decorateRequest('principal', null);
  app.addHook('preHandler', async (req) => void ((req as any).principal = f.adminPrincipal));
  app.setErrorHandler((err: any, _req, reply) => (err instanceof BreadboardError ? reply.status(err.status).send(err.toJSON()) : reply.status(500).send({ error: { message: String(err?.message) } })));
  await register(app, services);
});
afterAll(async () => {
  await app.close();
  await f.close();
});

describe('conversation messages REST', () => {
  it('replies inline by default and accepts with 202 under Prefer: respond-async', async () => {
    const sync = await app.inject({ method: 'POST', url: `/api/v1/conversations/${SID}/messages`, payload: { text: 'a' } });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().turns).toHaveLength(1);

    const headers = { prefer: 'respond-async', 'idempotency-key': 'k-1' };
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/conversations/${SID}/messages`, payload: { text: 'b' }, headers });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers['preference-applied']).toBe('respond-async');
    expect(accepted.json()).toEqual({ accepted: true, session_id: SID });
    // A retried send (same key) replays the acceptance instead of starting a second reply.
    const replay = await app.inject({ method: 'POST', url: `/api/v1/conversations/${SID}/messages`, payload: { text: 'b' }, headers });
    expect(replay.statusCode).toBe(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(calls).toEqual(['post:a', 'submit:b']);
  });

  it('reports busy, the last error and the session proposals on GET', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/v1/conversations/${SID}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ busy: true, last_error: 'boom', proposals: ['prp_1'], turns: [{ role: 'user' }] });
  });
});
