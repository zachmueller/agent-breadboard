/**
 * Event stream ([11] §5): SSE `GET /api/v1/events?topics=…` with Last-Event-ID replay and
 * per-subscriber scope filtering; a JSON debug view; and the admin webhook-delivery log.
 *
 * SSE frames carry `id:` (the event id, for Last-Event-ID resume) and `data:` (the full StreamEvent
 * JSON). No `event:` field is sent, so `EventSource.onmessage` receives every topic; filter on `data.topic`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BreadboardError, EVENT_TOPICS, type StreamEvent } from '@breadboard/shared';
import type { Services } from '../core/services.js';
import { requireAdmin, requireScope, type Principal } from '../core/principal.js';
import { API_PREFIX } from '../app.js';
import { arrayParam, intParam, principalOf, strParam } from './util.js';

const HEARTBEAT_MS = 15_000;

function topicFilter(req: FastifyRequest): Set<string> | null {
  const topics = arrayParam((req.query as any)?.topics);
  if (!topics || topics.length === 0) return null;
  const unknown = topics.filter((t) => !(EVENT_TOPICS as readonly string[]).includes(t));
  if (unknown.length) throw new BreadboardError('validation-failed', `unknown topic(s): ${unknown.join(', ')}`, { allowed: EVENT_TOPICS });
  return new Set(topics);
}

function frame(e: StreamEvent): string {
  return `id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`;
}

export async function register(app: FastifyInstance, services: Services): Promise<void> {
  app.get(`${API_PREFIX}/events`, async (req, reply) => {
    const p = principalOf(req);
    requireScope(p, 'events:read');
    const topics = topicFilter(req);
    const lastId = strParam(req.headers['last-event-id']) ?? strParam((req.query as any)?.after) ?? null;
    const wants = (e: StreamEvent, who: Principal) => (!topics || topics.has(e.topic)) && services.events.visibleTo(e, who);

    reply.hijack();
    const res = reply.raw;
    const headers: Record<string, string | string[] | number> = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) headers[k] = v as any;
    res.writeHead(200, {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    const sent = new Set<string>();
    let buffered: StreamEvent[] | null = lastId ? [] : null; // live events held back while replaying
    const send = (e: StreamEvent) => {
      if (closed || sent.has(e.id)) return;
      sent.add(e.id);
      if (sent.size > 5_000) sent.clear(); // dedupe only matters around the replay boundary
      res.write(frame(e));
    };
    const unsubscribe = services.events.subscribe((e) => {
      if (!wants(e, p)) return;
      if (buffered) buffered.push(e);
      else send(e);
    });
    const heartbeat = setInterval(() => {
      if (!closed) res.write(`: ping ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    res.write(`retry: 3000\n: connected\n\n`); // after subscribing, so nothing published from here on is missed

    if (lastId) {
      try {
        const missed = await services.events.replay(lastId, 500);
        for (const e of missed) if (wants(e, p)) send(e);
      } catch (err) {
        req.log.warn({ err }, 'SSE replay failed');
      } finally {
        const pending = buffered ?? [];
        buffered = null;
        for (const e of pending) send(e);
      }
    }
  });

  app.get(`${API_PREFIX}/events/recent`, async (req) => {
    const p = principalOf(req);
    requireScope(p, 'events:read');
    const topics = topicFilter(req);
    const limit = Math.max(1, Math.min(500, intParam((req.query as any)?.limit, 50)!));
    const after = strParam((req.query as any)?.after) ?? null;
    const events = await services.events.replay(after, limit);
    return { items: events.filter((e) => (!topics || topics.has(e.topic)) && services.events.visibleTo(e, p)), next_cursor: null };
  });

  app.get(`${API_PREFIX}/webhooks/deliveries`, async (req) => {
    requireAdmin(principalOf(req));
    const limit = Math.max(1, Math.min(500, intParam((req.query as any)?.limit, 100)!));
    const status = strParam((req.query as any)?.status);
    const r = await services.db.query(
      `SELECT delivery_id, url, event_id, topic, status, attempts, last_error, next_attempt_at, created_at, delivered_at
         FROM webhook_deliveries WHERE ($2::text IS NULL OR status = $2) ORDER BY delivery_id DESC LIMIT $1`,
      [limit, status ?? null],
    );
    return {
      items: r.rows.map((d: any) => ({
        ...d,
        delivery_id: Number(d.delivery_id),
        event_id: String(d.event_id).trim(),
        next_attempt_at: iso(d.next_attempt_at),
        created_at: iso(d.created_at),
        delivered_at: d.delivered_at ? iso(d.delivered_at) : null,
      })),
      next_cursor: null,
    };
  });
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}
