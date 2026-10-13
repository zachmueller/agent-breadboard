/**
 * Load-balancer identity ([12] §3). An AWS Application Load Balancer whose listener authenticates users with OIDC
 * forwards each request with the user's claims in `x-amzn-oidc-data`: a JWT it signs (ES256) with a regional key named
 * by the header's `kid`, published at `https://public-keys.auth.elb.<region>.amazonaws.com/<kid>`. Every load balancer
 * in a region signs with those keys, so a token is only this deployment's if its `signer` is this load balancer's ARN.
 *
 * The header is trusted only after verification: algorithm, signer (and issuer / client when pinned) before any key is
 * fetched, then the signature, the expiry and a subject. The load balancer re-signs on every request with a short
 * expiry, so a verified token says "this request came through the load balancer for this user" and nothing longer.
 */
import { compactVerify, importSPKI, type CompactJWSHeaderParameters, type CryptoKey } from 'jose';
import type { AlbAuthConfig } from '../core/env.js';

export const ALB_IDENTITY_HEADER = 'x-amzn-oidc-data';

const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_KEY_LENGTH = 4 * 1024;
const KID = /^[A-Za-z0-9-]{1,128}$/;
const CLOCK_SKEW_S = 60;
const KEY_FETCH_TIMEOUT_MS = 5_000;
const KEY_CACHE_MAX = 32;
/** A kid the endpoint did not serve is not asked for again for this long. */
const KEY_FAILURE_TTL_MS = 60_000;

export interface AlbIdentity {
  sub: string;
  /** The user claims the load balancer forwarded (the IdP's userinfo). */
  claims: Record<string, unknown>;
  expiresAtMs: number;
}

/** Fetch the PEM public key at `url` (a test seam). */
export type FetchAlbKey = (url: string) => Promise<string>;

export interface AlbVerifier {
  /** The verified identity; throws (with a reason fit for logs, never the token) on anything else. */
  verify(token: string): Promise<AlbIdentity>;
}

export async function fetchAlbPublicKey(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(KEY_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`the key endpoint answered ${res.status}`);
  const pem = await res.text();
  if (pem.length > MAX_KEY_LENGTH) throw new Error('the key endpoint answered an oversized key');
  return pem;
}

export function createAlbVerifier(cfg: AlbAuthConfig, opts: { fetchKey?: FetchAlbKey; now?: () => number } = {}): AlbVerifier {
  const fetchKey = opts.fetchKey ?? fetchAlbPublicKey;
  const now = opts.now ?? Date.now;
  const keys = new Map<string, { key: Promise<CryptoKey>; failedUntil: number | null }>();

  function keyFor(kid: string): Promise<CryptoKey> {
    const hit = keys.get(kid);
    if (hit && (hit.failedUntil === null || hit.failedUntil > now())) return hit.key;
    keys.delete(kid);
    if (keys.size >= KEY_CACHE_MAX) {
      for (const [k, v] of keys) if (v.failedUntil !== null) keys.delete(k);
      while (keys.size >= KEY_CACHE_MAX) keys.delete(keys.keys().next().value!);
    }
    const entry = { key: fetchKey(cfg.keyUrl(kid)).then((pem) => importSPKI(pem, 'ES256')), failedUntil: null as number | null };
    entry.key.catch(() => void (entry.failedUntil = now() + KEY_FAILURE_TTL_MS));
    keys.set(kid, entry);
    return entry.key;
  }

  function checkHeader(h: CompactJWSHeaderParameters): string {
    if (h.alg !== 'ES256') throw new Error(`unexpected algorithm ${String(h.alg)}`);
    if (typeof h.kid !== 'string' || !KID.test(h.kid)) throw new Error('missing or malformed kid');
    if (h.signer !== cfg.signerArn) throw new Error('signed by another load balancer');
    if (cfg.issuer && h.iss !== cfg.issuer) throw new Error('unexpected issuer');
    if (cfg.clientId && h.client !== cfg.clientId) throw new Error('unexpected client');
    return h.kid;
  }

  return {
    async verify(token) {
      if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH || token.split('.').length !== 3) throw new Error('malformed token');
      let header: CompactJWSHeaderParameters;
      let payload: Uint8Array;
      try {
        ({ protectedHeader: header, payload } = await compactVerify(token, (h) => keyFor(checkHeader(h)), { algorithms: ['ES256'] }));
      } catch (err: any) {
        throw new Error(err?.message ? String(err.message) : 'invalid token');
      }
      checkHeader(header);
      let claims: unknown;
      try {
        claims = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        throw new Error('the payload is not JSON');
      }
      if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('the payload is not a JSON object');
      const c = claims as Record<string, unknown>;
      if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) throw new Error('missing subject');
      if (cfg.issuer && c.iss !== undefined && c.iss !== cfg.issuer) throw new Error('unexpected issuer');
      const exp = [numeric(header.exp), numeric(c.exp)].filter((x): x is number => x !== null);
      if (!exp.length) throw new Error('no expiry');
      const expiresAtMs = Math.min(...exp) * 1000;
      if (now() > expiresAtMs + CLOCK_SKEW_S * 1000) throw new Error('expired');
      return { sub: c.sub, claims: c, expiresAtMs };
    },
  };
}

/** The load balancer writes `exp` as a number; accept a numeric string too. */
function numeric(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
