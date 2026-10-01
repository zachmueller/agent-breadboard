import { randomBytes } from 'node:crypto';

/** Crockford base32 alphabet (no I, L, O, U). */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const UID_LENGTH = 20;

const UID_RE = /^[0-9A-HJKMNP-TV-Z]{20}$/;

/**
 * Mint a 20-character Crockford base32 UID from 100 random bits.
 * No embedded timestamp: UIDs must not leak creation ordering ([01] §3.1).
 */
export function mintUid(): string {
  // 100 bits = 20 symbols × 5 bits. Draw 13 bytes (104 bits) and take the first 100.
  const bytes = randomBytes(13);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  bits >>= 4n; // 104 -> 100 bits
  let out = '';
  for (let i = 0; i < UID_LENGTH; i++) {
    out = CROCKFORD[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}

/** Canonicalize a user-supplied UID (uppercase; map ambiguous glyphs per Crockford). */
export function normalizeUid(input: string): string {
  return input.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function isUid(value: unknown): value is string {
  return typeof value === 'string' && UID_RE.test(value);
}

export function assertUid(value: unknown, what = 'uid'): string {
  if (!isUid(value)) throw new TypeError(`${what} is not a valid 20-char Crockford base32 UID: ${String(value)}`);
  return value;
}

/** Server-minted stable block ID for CRDT body blocks ([01] §5): 10 chars, URL-safe. */
const BLOCK_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-';
export function mintBlockId(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += BLOCK_ALPHABET[bytes[i]! & 63];
  return out;
}
