import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { StreamEvent } from '@breadboard/shared';
import { createFoundation, type Foundation } from '../test/harness.js';
import { buildRouteHarness, type RouteHarness } from '../auth/route-harness.js';
import type { Principal } from '../core/principal.js';

/** Open an SSE stream and collect `data:` events until `count` arrive (or timeout). */
async function collect(url: string, headers: Record<string, string>, count: number, during?: () => Promise<void>): Promise<{ status: number; contentType: string | null; events: StreamEvent[]; ids: string[] }> {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  const events: StreamEvent[] = [];
  const ids: string[] = [];
  if (res.status !== 200 || !res.body) {
    return { status: res.status, contentType: res.headers.get('content-type'), events, ids };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const timer = setTimeout(() => ac.abort(), 5_000);
  const started = (async () => {
    // wait for the initial comment before triggering live publishes
    while (!buf.includes(': connected')) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
    }
    if (during) await during();
  })();
  try {
    await started;
    for (;;) {
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const id = /^id: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (id) ids.push(id);
        if (data) events.push(JSON.parse(data));
      }
      if (events.length >= count) break;
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
  } catch (err: any) {
    if (err?.name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return { status: res.status, contentType: res.headers.get('content-type'), events, ids };
}

describe('SSE /api/v1/events', () => {
  let f: Foundation;
  let h: RouteHarness;
  let base: string;
  let memberTok: string;

  beforeAll(async () => {
    f = await createFoundation();
    h = await buildRouteHarness(f, ['events', 'admin']);
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
    memberTok = await h.auth.mintUserToken(f.member);
  });
  afterAll(async () => {
    await h.app.close();
    await f.close();
  });

  it('replays after Last-Event-ID, then streams live events, filtered by topic', async () => {
    const first = await h.events.publish('session.state', { n: 1 });
    const missed = await h.events.publish('session.state', { n: 2 });
    await h.events.publish('task.status', { n: 3 }); // filtered by topic
    let live!: StreamEvent;
    const r = await collect(`${base}/api/v1/events?topics=session.state,need-input.tagged`, { authorization: `Bearer ${memberTok}`, 'last-event-id': first.id }, 3, async () => {
      await h.events.publish('task.status', { n: 4 });
      live = await h.events.publish('session.state', { n: 5 });
      await h.events.publish('need-input.tagged', { n: 6 });
    });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/event-stream');
    expect(r.events.map((e) => e.payload.n)).toEqual([2, 5, 6]);
    expect(r.ids.slice(0, 2)).toEqual([missed.id, live.id]);
  });

  it('?after= works like Last-Event-ID; no cursor means live only', async () => {
    const a = await h.events.publish('config.committed', { commit: 'a' });
    await h.events.publish('config.committed', { commit: 'b' });
    const replay = await collect(`${base}/api/v1/events?topics=config.committed&after=${a.id}`, { authorization: `Bearer ${memberTok}` }, 1);
    expect(replay.events.map((e) => e.payload.commit)).toEqual(['b']);
    const liveOnly = await collect(`${base}/api/v1/events?topics=config.committed`, { authorization: `Bearer ${memberTok}` }, 1, async () => {
      await h.events.publish('config.committed', { commit: 'c' });
    });
    expect(liveOnly.events.map((e) => e.payload.commit)).toEqual(['c']);
  });

  it('filters session-scoped events against an actor token’s visible sessions', async () => {
    const actor: Principal = { ...f.memberPrincipal, actor: { kind: 'subagent', id: 'SUB', session_id: 'ses_MINE' }, user: null, roles: [], is_admin: false, session_id: 'ses_MINE', visible_sessions: ['ses_MINE'], token_kind: 'actor' };
    const tok = await h.auth.mintActorToken({ principal: actor, ttlSeconds: 60 });
    const r = await collect(`${base}/api/v1/events?topics=session.event`, { authorization: `Bearer ${tok}` }, 2, async () => {
      await h.events.publish('session.event', { which: 'other' }, { scope: 'session', session_id: 'ses_OTHER' });
      await h.events.publish('session.event', { which: 'mine' }, { scope: 'session', session_id: 'ses_MINE' });
      await h.events.publish('session.event', { which: 'team' });
    });
    expect(r.events.map((e) => e.payload.which)).toEqual(['mine', 'team']);
  });

  it('cookie auth works (EventSource cannot set headers); scopes and topics are validated', async () => {
    const viaCookie = await collect(`${base}/api/v1/events?topics=eval.run-completed`, { cookie: `bb_session=${memberTok}` }, 1, async () => {
      await h.events.publish('eval.run-completed', { id: 'evr_1' });
    });
    expect(viaCookie.events).toHaveLength(1);

    expect((await collect(`${base}/api/v1/events`, {}, 0)).status).toBe(401);
    expect((await collect(`${base}/api/v1/events?topics=bogus`, { authorization: `Bearer ${memberTok}` }, 0)).status).toBe(400);
    const svc = await f.identity.createServiceToken({ team_id: f.team_id, name: 'no-events', scopes: ['tasks:read'], created_by: f.adminPrincipal.actor });
    expect((await collect(`${base}/api/v1/events`, { authorization: `Bearer ${svc.secret}` }, 0)).status).toBe(403);
  });

  it('closing the stream unsubscribes', async () => {
    const before = (h.events as any).subscribers.size;
    await collect(`${base}/api/v1/events`, { authorization: `Bearer ${memberTok}` }, 1, async () => {
      await h.events.publish('node.updated', { uid: 'X' });
    });
    for (let i = 0; i < 50 && (h.events as any).subscribers.size !== before; i++) await new Promise((r) => setTimeout(r, 20));
    expect((h.events as any).subscribers.size).toBe(before);
  });

  it('GET /events/recent and /webhooks/deliveries', async () => {
    const recent = await h.app.inject({ method: 'GET', url: '/api/v1/events/recent?limit=2&topics=node.updated', headers: { authorization: `Bearer ${memberTok}` } });
    expect(recent.statusCode).toBe(200);
    expect(recent.json().items.every((e: StreamEvent) => e.topic === 'node.updated')).toBe(true);

    const adminTok = await h.auth.mintUserToken(f.admin);
    const d = await h.app.inject({ method: 'GET', url: '/api/v1/webhooks/deliveries?limit=5', headers: { authorization: `Bearer ${adminTok}` } });
    expect(d.statusCode).toBe(200);
    expect(d.json()).toEqual({ items: [], next_cursor: null });
  });
});
