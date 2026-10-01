/**
 * EventBus ([11] §5): durable outbox + in-process fan-out + signed webhook delivery.
 *
 *  - `publish` writes the event to `event_outbox` (the SSE replay source), notifies in-process
 *    subscribers (SSE connections), and enqueues one `webhook_deliveries` row per configured webhook
 *    whose `topics` include the event's topic. Webhooks receive **team-visible events only**.
 *  - Delivery is at-least-once: consumers dedupe on event id. Failed deliveries back off
 *    exponentially (30 s · 2^n) and are marked `failed` after 8 attempts.
 *  - Outbox rows older than 7 days are pruned hourly (bounded SSE replay window).
 */
import { createHmac } from 'node:crypto';
import { mintUid, type BreadboardConfig, type EventTopic, type StreamEvent } from '@breadboard/shared';
import type { Db } from '../db/index.js';
import type { Logger } from '../core/logger.js';
import type { EventBus, SessionStore } from '../core/services.js';
import { canSeeSession, type Principal } from '../core/principal.js';
import { toIso } from '../content/nodes.js';

export const REPLAY_MAX = 500;
export const WEBHOOK_MAX_ATTEMPTS = 8;
export const WEBHOOK_BASE_BACKOFF_S = 30;
const DELIVERY_INTERVAL_MS = 5_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_DAYS = 7;
const DELIVERY_TIMEOUT_MS = 10_000;
const DELIVERY_BATCH = 50;

export interface EventBusDeps {
  db: Db;
  log: Logger;
  settings: () => Promise<BreadboardConfig>;
  /** Reserved for family-aware visibility; the current filter only needs the principal's `visible_sessions`. */
  sessions?: () => SessionStore | null;
  /** Secret lookup for webhook signing (defaults to `process.env`). */
  secretFor?: (envName: string) => string | undefined;
}

export interface WebhookDeliveryRow {
  delivery_id: number;
  url: string;
  event_id: string;
  topic: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
  delivered_at: string | null;
}

export function signWebhookBody(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

/** Backoff after the n-th failed attempt (n = attempts before this failure, starting at 0). */
export function webhookBackoffSeconds(n: number): number {
  return WEBHOOK_BASE_BACKOFF_S * 2 ** n;
}

export class EventBusImpl implements EventBus {
  private subscribers = new Set<(e: StreamEvent) => void>();
  private deliveryTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private inflight: Promise<unknown> | null = null;
  private stopped = false;

  constructor(private deps: EventBusDeps) {}

  async publish(topic: EventTopic, payload: Record<string, unknown>, visibility: StreamEvent['visibility'] = { scope: 'team' }): Promise<StreamEvent> {
    const id = 'evt_' + mintUid(); // 24 chars = event_outbox.event_id char(24)
    // clock_timestamp() (not now()) so events published inside one transaction still order correctly.
    const r = await this.deps.db.query<{ created_at: unknown }>(`INSERT INTO event_outbox (event_id, topic, payload, visibility, created_at) VALUES ($1,$2,$3,$4, clock_timestamp()) RETURNING created_at`, [
      id,
      topic,
      JSON.stringify(payload ?? {}),
      JSON.stringify(visibility),
    ]);
    const event: StreamEvent = { id, topic, at: toIso(r.rows[0]!.created_at), payload: payload ?? {}, visibility };

    if (visibility.scope === 'team') await this.enqueueWebhooks(event);

    for (const fn of [...this.subscribers]) {
      try {
        fn(event);
      } catch (err) {
        this.deps.log.warn({ err, topic }, 'event subscriber threw');
      }
    }
    return event;
  }

  subscribe(fn: (e: StreamEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /**
   * `afterId` given: events strictly after it in (created_at, event_id) order — an unknown/pruned id yields [].
   * `afterId` null: the most recent `limit` events, oldest first.
   */
  async replay(afterId: string | null, limit = 100): Promise<StreamEvent[]> {
    const n = Math.max(1, Math.min(REPLAY_MAX, Math.floor(limit) || 100));
    if (afterId) {
      const r = await this.deps.db.query(
        `SELECT event_id, topic, payload, visibility, created_at FROM event_outbox
          WHERE (created_at, event_id) > (SELECT created_at, event_id FROM event_outbox WHERE event_id = $1)
          ORDER BY created_at, event_id LIMIT $2`,
        [afterId, n],
      );
      return r.rows.map(rowToEvent);
    }
    const r = await this.deps.db.query(`SELECT event_id, topic, payload, visibility, created_at FROM event_outbox ORDER BY created_at DESC, event_id DESC LIMIT $1`, [n]);
    return r.rows.map(rowToEvent).reverse();
  }

  visibleTo(e: StreamEvent, p: Principal): boolean {
    if (!e.visibility || e.visibility.scope === 'team') return true;
    return canSeeSession(p, e.visibility.session_id ?? null);
  }

  start(): void {
    if (this.deliveryTimer) return;
    this.stopped = false;
    this.deliveryTimer = setInterval(() => void this.tick(() => this.deliverDue()), DELIVERY_INTERVAL_MS);
    this.pruneTimer = setInterval(() => void this.tick(() => this.prune()), PRUNE_INTERVAL_MS);
    this.deliveryTimer.unref?.();
    this.pruneTimer.unref?.();
    void this.tick(() => this.prune());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.deliveryTimer) clearInterval(this.deliveryTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.deliveryTimer = null;
    this.pruneTimer = null;
    if (this.inflight) await this.inflight.catch(() => undefined);
  }

  /** One delivery pass over due `pending` rows. Returns the number of rows attempted. */
  async deliverDue(): Promise<number> {
    const due = await this.deps.db.query(
      `SELECT d.delivery_id, d.url, d.event_id, d.topic, d.attempts, o.payload, o.created_at AS event_at
         FROM webhook_deliveries d LEFT JOIN event_outbox o ON o.event_id = d.event_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= now()
        ORDER BY d.next_attempt_at, d.delivery_id LIMIT $1`,
      [DELIVERY_BATCH],
    );
    if (due.rows.length === 0) return 0;
    let hooks: BreadboardConfig['webhooks'] = [];
    try {
      hooks = (await this.deps.settings()).webhooks;
    } catch (err) {
      this.deps.log.warn({ err }, 'webhook delivery: settings unavailable; retrying later');
      return 0;
    }
    for (const row of due.rows) {
      if (this.stopped) break;
      await this.deliverOne(row, hooks);
    }
    return due.rows.length;
  }

  /** Delete outbox rows and settled deliveries older than the retention window. */
  async prune(): Promise<number> {
    const r = await this.deps.db.query(`DELETE FROM event_outbox WHERE created_at < now() - ($1 || ' days')::interval`, [String(RETENTION_DAYS)]);
    await this.deps.db.query(`DELETE FROM webhook_deliveries WHERE status <> 'pending' AND created_at < now() - ($1 || ' days')::interval`, [String(RETENTION_DAYS)]);
    return r.rowCount;
  }

  async deliveries(limit = 100): Promise<WebhookDeliveryRow[]> {
    const n = Math.max(1, Math.min(500, Math.floor(limit) || 100));
    const r = await this.deps.db.query(`SELECT * FROM webhook_deliveries ORDER BY delivery_id DESC LIMIT $1`, [n]);
    return r.rows.map(rowToDelivery);
  }

  // -------------------------------------------------------------------------

  private async tick(fn: () => Promise<unknown>): Promise<void> {
    if (this.stopped || this.inflight) return;
    const p = fn().catch((err) => this.deps.log.warn({ err }, 'event bus background pass failed'));
    this.inflight = p;
    try {
      await p;
    } finally {
      this.inflight = null;
    }
  }

  private async enqueueWebhooks(e: StreamEvent): Promise<void> {
    let hooks: BreadboardConfig['webhooks'];
    try {
      hooks = (await this.deps.settings()).webhooks;
    } catch (err) {
      this.deps.log.warn({ err, topic: e.topic }, 'webhook enqueue skipped: settings unavailable');
      return;
    }
    for (const h of hooks) {
      if (!h.topics.includes(e.topic)) continue;
      await this.deps.db.query(`INSERT INTO webhook_deliveries (url, event_id, topic) VALUES ($1,$2,$3)`, [h.url, e.id, e.topic]);
    }
  }

  private async deliverOne(row: any, hooks: BreadboardConfig['webhooks']): Promise<void> {
    const id = Number(row.delivery_id);
    const hook = hooks.find((h) => h.url === row.url);
    if (!hook) return this.settle(id, 'failed', 'webhook no longer configured');
    if (row.payload === null || row.payload === undefined) return this.settle(id, 'failed', 'event pruned from outbox');
    const secret = (this.deps.secretFor ?? ((n: string) => process.env[n]))(hook.secret_env);
    if (!secret) return this.fail(id, Number(row.attempts), `secret env '${hook.secret_env}' is not set`);

    const body = JSON.stringify({ id: String(row.event_id).trim(), topic: row.topic, at: toIso(row.event_at), payload: row.payload });
    try {
      const res = await fetch(row.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'agent-breadboard-webhooks/1',
          'x-breadboard-event': row.topic,
          'x-breadboard-signature': signWebhookBody(body, secret),
          'x-breadboard-delivery': String(id),
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        redirect: 'manual',
      });
      await res.arrayBuffer().catch(() => undefined);
      if (res.status >= 200 && res.status < 300) {
        await this.deps.db.query(`UPDATE webhook_deliveries SET status='delivered', attempts = attempts + 1, delivered_at = now(), last_error = NULL WHERE delivery_id=$1`, [id]);
        return;
      }
      return this.fail(id, Number(row.attempts), `HTTP ${res.status}`);
    } catch (err: any) {
      return this.fail(id, Number(row.attempts), String(err?.message ?? err));
    }
  }

  private async fail(id: number, priorAttempts: number, error: string): Promise<void> {
    const attempts = priorAttempts + 1;
    if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
      await this.deps.db.query(`UPDATE webhook_deliveries SET status='failed', attempts=$2, last_error=$3 WHERE delivery_id=$1`, [id, attempts, error]);
      this.deps.log.warn({ delivery_id: id, error }, 'webhook delivery gave up');
      return;
    }
    const delayS = webhookBackoffSeconds(priorAttempts);
    await this.deps.db.query(`UPDATE webhook_deliveries SET attempts=$2, last_error=$3, next_attempt_at = now() + ($4 || ' seconds')::interval WHERE delivery_id=$1`, [id, attempts, error, String(delayS)]);
  }

  private async settle(id: number, status: 'failed', error: string): Promise<void> {
    await this.deps.db.query(`UPDATE webhook_deliveries SET status=$2, last_error=$3 WHERE delivery_id=$1`, [id, status, error]);
  }
}

export function createEventBus(deps: EventBusDeps): EventBusImpl {
  return new EventBusImpl(deps);
}

function rowToEvent(r: any): StreamEvent {
  return { id: String(r.event_id).trim(), topic: r.topic, at: toIso(r.created_at), payload: r.payload ?? {}, visibility: r.visibility ?? { scope: 'team' } };
}

function rowToDelivery(r: any): WebhookDeliveryRow {
  return {
    delivery_id: Number(r.delivery_id),
    url: r.url,
    event_id: String(r.event_id).trim(),
    topic: r.topic,
    status: r.status,
    attempts: Number(r.attempts),
    last_error: r.last_error ?? null,
    next_attempt_at: toIso(r.next_attempt_at),
    created_at: toIso(r.created_at),
    delivered_at: r.delivered_at ? toIso(r.delivered_at) : null,
  };
}
