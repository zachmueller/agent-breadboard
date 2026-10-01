import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BreadboardError } from '@breadboard/shared';
import type { Services } from '../core/services.js';
import type { Principal } from '../core/principal.js';

/** Repeated query params OR within a field ([11] §2): `?type=a&type=b` or `?type=a,b`. */
export function arrayParam(v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const arr = Array.isArray(v) ? v : [v];
  return arr.flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean);
}

export function strParam(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = Array.isArray(v) ? v[0] : v;
  return s === '' ? undefined : String(s);
}

export function intParam(v: unknown, def?: number): number | undefined {
  const s = strParam(v);
  if (s === undefined) return def;
  const n = Number(s);
  return Number.isFinite(n) ? n : def;
}

export function boolParam(v: unknown): boolean | undefined {
  const s = strParam(v);
  if (s === undefined) return undefined;
  return ['1', 'true', 'yes'].includes(s.toLowerCase());
}

export function principalOf(req: FastifyRequest): Principal {
  const p = (req as any).principal as Principal | undefined;
  if (!p) throw new BreadboardError('unauthorized', 'missing credentials');
  return p;
}

export function requireBody<T = any>(req: FastifyRequest): T {
  if (!req.body || typeof req.body !== 'object') throw new BreadboardError('validation-failed', 'JSON body required');
  return req.body as T;
}

export function requireField<T = string>(body: any, name: string, type: 'string' | 'number' | 'object' | 'boolean' | 'array' = 'string'): T {
  const v = body?.[name];
  const ok = type === 'array' ? Array.isArray(v) : type === 'object' ? v && typeof v === 'object' : typeof v === type;
  if (!ok) throw new BreadboardError('validation-failed', `field '${name}' (${type}) is required`);
  return v as T;
}

/**
 * Idempotency-Key handling ([11] §2): retried keys return the original result; a different request
 * body under the same key is an `idempotency-mismatch`.
 */
export async function withIdempotency<T>(req: FastifyRequest, reply: FastifyReply, services: Services, fn: () => Promise<T>): Promise<T> {
  const key = req.headers['idempotency-key'];
  if (!key || typeof key !== 'string') return fn();
  const p = principalOf(req);
  const actorKey = `${p.actor.kind}:${p.actor.id}`;
  const reqHash = createHash('sha256').update(`${req.method} ${req.url} ${JSON.stringify(req.body ?? null)}`).digest('hex');
  const hit = await services.db.query(`SELECT request_hash, status, response FROM idempotency_keys WHERE idem_key=$1 AND actor_key=$2`, [key, actorKey]);
  if (hit.rows[0]) {
    if (hit.rows[0].request_hash !== reqHash) throw new BreadboardError('idempotency-mismatch', 'Idempotency-Key reused with a different request');
    reply.status(hit.rows[0].status);
    reply.header('idempotent-replayed', 'true');
    return hit.rows[0].response as T;
  }
  const out = await fn();
  const status = reply.statusCode || 200;
  await services.db.query(`INSERT INTO idempotency_keys (idem_key, actor_key, request_hash, status, response) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [key, actorKey, reqHash, status, JSON.stringify(out ?? null)]);
  return out;
}

export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const q = (req.query as any)?.access_token;
  if (typeof q === 'string' && q) return q;
  const cookie = (req as any).cookies?.bb_session;
  if (typeof cookie === 'string' && cookie) return cookie;
  return null;
}
