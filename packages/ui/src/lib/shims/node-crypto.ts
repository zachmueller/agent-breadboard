/**
 * Browser shim for the subset of `node:crypto` that @breadboard/shared uses (UID minting).
 * Aliased in vite.config.ts / vitest.config.ts.
 */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export default { randomBytes, randomUUID };
