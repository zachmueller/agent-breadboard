import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { zBreadboardConfig, type BreadboardConfig, type StreamEvent } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import { createEventBus, signWebhookBody, type EventBusImpl } from './bus.js';
import type { Principal } from '../core/principal.js';

const SECRET_ENV = 'BB_TEST_WEBHOOK_SECRET';
const SECRET = 'whsec-test-123';

interface Received {
  headers: IncomingMessage['headers'];
  body: string;
}

describe('EventBus', () => {
  let f: Foundation;
  let settings: BreadboardConfig;
  let bus: EventBusImpl;
  let server: Server;
  let url: string;
  let received: Received[];
  let respondWith: number;

  beforeAll(async () => {
    f = await createFoundation();
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.statusCode = respondWith;
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    process.env[SECRET_ENV] = SECRET;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await f.close();
    delete process.env[SECRET_ENV];
  });

  beforeEach(async () => {
    received = [];
    respondWith = 200;
    await f.db.query(`DELETE FROM webhook_deliveries`);
    await f.db.query(`DELETE FROM event_outbox`);
    settings = zBreadboardConfig.parse({ schema: 'breadboard/breadboard@v1', webhooks: [{ url, secret_env: SECRET_ENV, topics: ['session.state', 'task.status'] }] });
    bus = createEventBus({ db: f.db, log: f.log, settings: async () => settings });
  });

  afterEach(async () => {
    await bus.stop();
  });

  it('publish notifies subscribers and writes the outbox', async () => {
    const got: StreamEvent[] = [];
    const off = bus.subscribe((e) => got.push(e));
    const e = await bus.publish('session.state', { session_id: 'ses_X', state: 'running' });
    off();
    await bus.publish('session.state', { session_id: 'ses_X', state: 'completed' });

    expect(e.id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(e.id).toHaveLength(24);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: e.id, topic: 'session.state', payload: { state: 'running' }, visibility: { scope: 'team' } });
    const row = await f.db.query(`SELECT * FROM event_outbox WHERE event_id=$1`, [e.id]);
    expect(row.rows[0]).toMatchObject({ topic: 'session.state', payload: { session_id: 'ses_X', state: 'running' } });
  });

  it('a throwing subscriber does not break publish', async () => {
    const got: string[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((e) => got.push(e.id));
    const e = await bus.publish('task.status', { uid: 'T' });
    expect(got).toEqual([e.id]);
  });

  it('replays events after an id, in order, bounded', async () => {
    const a = await bus.publish('session.state', { n: 1 });
    const b = await bus.publish('task.status', { n: 2 });
    const c = await bus.publish('node.updated', { n: 3 });
    expect((await bus.replay(a.id)).map((e) => e.id)).toEqual([b.id, c.id]);
    expect((await bus.replay(b.id, 10)).map((e) => e.id)).toEqual([c.id]);
    expect(await bus.replay(c.id)).toEqual([]);
    expect((await bus.replay('evt_00000000000000000000')).map((e) => e.id)).toEqual([a.id, b.id, c.id]); // pruned cursor: everything retained after it
    expect(await bus.replay('garbage')).toEqual([]);
    // null → most recent N, oldest first
    expect((await bus.replay(null, 2)).map((e) => e.id)).toEqual([b.id, c.id]);
    const replayed = (await bus.replay(a.id))[0]!;
    expect(replayed).toMatchObject({ topic: 'task.status', payload: { n: 2 }, visibility: { scope: 'team' } });
    expect(new Date(replayed.at).toISOString()).toBe(replayed.at);
  });

  it('event ids are strictly increasing even within one millisecond', async () => {
    const { mintEventId } = await import('./bus.js');
    const ids = Array.from({ length: 2000 }, () => mintEventId());
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
    expect(ids.every((id) => id.length === 24)).toBe(true);
  });

  it('filters session-scoped events by the subscriber’s visible sessions', async () => {
    const team = await bus.publish('session.state', { state: 'running' });
    const scoped = await bus.publish('session.event', { kind: 'turn' }, { scope: 'session', session_id: 'ses_A' });
    const subagent: Principal = { ...f.memberPrincipal, actor: { kind: 'subagent', id: 'SUBAGENT', session_id: 'ses_A' }, user: null, session_id: 'ses_A', visible_sessions: ['ses_A', 'ses_PARENT'], token_kind: 'actor' };
    const other: Principal = { ...subagent, session_id: 'ses_B', visible_sessions: ['ses_B'] };

    expect(bus.visibleTo(team, other)).toBe(true);
    expect(bus.visibleTo(scoped, subagent)).toBe(true);
    expect(bus.visibleTo(scoped, other)).toBe(false);
    expect(bus.visibleTo(scoped, f.memberPrincipal)).toBe(true); // team members: visible_sessions === null
    expect(bus.visibleTo(scoped, f.servicePrincipal)).toBe(true);
    expect(bus.visibleTo({ ...scoped, visibility: { scope: 'session' } }, subagent)).toBe(false);
  });

  it('enqueues webhooks only for matching, team-visible topics and delivers signed requests', async () => {
    const e = await bus.publish('session.state', { session_id: 'ses_1', state: 'suspended-gate' });
    await bus.publish('config.committed', { commit: 'abc' }); // topic not subscribed
    await bus.publish('session.state', { secret: true }, { scope: 'session', session_id: 'ses_1' }); // not team-visible
    const pending = await f.db.query(`SELECT * FROM webhook_deliveries`);
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0]).toMatchObject({ url, topic: 'session.state', status: 'pending', attempts: 0 });

    expect(await bus.deliverDue()).toBe(1);
    expect(received).toHaveLength(1);
    const r = received[0]!;
    expect(r.headers['content-type']).toContain('application/json');
    expect(r.headers['x-breadboard-event']).toBe('session.state');
    expect(r.headers['x-breadboard-delivery']).toBe(String(pending.rows[0].delivery_id));
    expect(r.headers['x-breadboard-signature']).toBe(signWebhookBody(r.body, SECRET));
    expect(JSON.parse(r.body)).toEqual({ id: e.id, topic: 'session.state', at: e.at, payload: { session_id: 'ses_1', state: 'suspended-gate' } });

    const after = (await bus.deliveries())[0]!;
    expect(after).toMatchObject({ status: 'delivered', attempts: 1, last_error: null });
    expect(after.delivered_at).not.toBeNull();
    expect(await bus.deliverDue()).toBe(0); // nothing due any more
  });

  it('schedules exponential retries on failure and gives up after 8 attempts', async () => {
    respondWith = 500;
    await bus.publish('task.status', { uid: 'T1', status: 'done' });

    const t0 = Date.now();
    await bus.deliverDue();
    let d = (await bus.deliveries())[0]!;
    expect(d).toMatchObject({ status: 'pending', attempts: 1, last_error: 'HTTP 500' });
    const delay1 = Date.parse(d.next_attempt_at) - t0;
    expect(delay1).toBeGreaterThan(25_000);
    expect(delay1).toBeLessThan(40_000);
    expect(await bus.deliverDue()).toBe(0); // not due yet

    await f.db.query(`UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second'`);
    const t1 = Date.now();
    await bus.deliverDue();
    d = (await bus.deliveries())[0]!;
    expect(d.attempts).toBe(2);
    const delay2 = Date.parse(d.next_attempt_at) - t1;
    expect(delay2).toBeGreaterThan(55_000);
    expect(delay2).toBeLessThan(70_000);

    await f.db.query(`UPDATE webhook_deliveries SET attempts = 7, next_attempt_at = now() - interval '1 second'`);
    await bus.deliverDue();
    d = (await bus.deliveries())[0]!;
    expect(d).toMatchObject({ status: 'failed', attempts: 8 });
    expect(received).toHaveLength(3);
  });

  it('recovers when the endpoint comes back', async () => {
    respondWith = 503;
    await bus.publish('session.state', { state: 'completed' });
    await bus.deliverDue();
    respondWith = 204;
    await f.db.query(`UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second'`);
    await bus.deliverDue();
    expect((await bus.deliveries())[0]).toMatchObject({ status: 'delivered', attempts: 2 });
    // at-least-once: both attempts carry the same event id for consumer dedupe
    expect(new Set(received.map((r) => JSON.parse(r.body).id)).size).toBe(1);
  });

  it('fails deliveries whose webhook was removed from config, and prunes old outbox rows', async () => {
    await bus.publish('session.state', { state: 'queued' });
    settings = zBreadboardConfig.parse({ schema: 'breadboard/breadboard@v1' });
    await bus.deliverDue();
    expect((await bus.deliveries())[0]).toMatchObject({ status: 'failed', last_error: 'webhook no longer configured' });

    const old = await bus.publish('task.status', { old: true });
    await f.db.query(`UPDATE event_outbox SET created_at = now() - interval '8 days' WHERE event_id=$1`, [old.id]);
    await f.db.query(`UPDATE webhook_deliveries SET created_at = now() - interval '8 days'`);
    expect(await bus.prune()).toBe(1);
    expect((await bus.replay(null, 10)).map((e) => e.id)).not.toContain(old.id);
    expect(await bus.deliveries()).toHaveLength(0);
  });

  it('start/stop manage timers without hanging', async () => {
    bus.start();
    bus.start(); // idempotent
    await bus.stop();
    await bus.stop();
  });
});
