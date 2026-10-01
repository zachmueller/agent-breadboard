import { describe, it, expect } from 'vitest';
import { mintUid, isUid, normalizeUid, mintBlockId } from './uid.js';
import { mintId, isPrefixedId } from './ids.js';

describe('uid', () => {
  it('mints 20-char Crockford base32 uids', () => {
    for (let i = 0; i < 200; i++) {
      const u = mintUid();
      expect(u).toHaveLength(20);
      expect(isUid(u)).toBe(true);
      expect(u).not.toMatch(/[ILOU]/);
    }
  });
  it('does not leak ordering (first chars vary)', () => {
    const firsts = new Set(Array.from({ length: 100 }, () => mintUid()[0]));
    expect(firsts.size).toBeGreaterThan(5);
  });
  it('normalizes ambiguous glyphs', () => {
    expect(normalizeUid('01j8fq2zk7xw9mbt4pvn')).toBe('01J8FQ2ZK7XW9MBT4PVN');
    expect(normalizeUid('OIL' + '1'.repeat(17))).toBe('011' + '1'.repeat(17));
  });
  it('mints 10-char block ids', () => {
    expect(mintBlockId()).toHaveLength(10);
  });
  it('prefixed ids', () => {
    const s = mintId('ses');
    expect(s.startsWith('ses_')).toBe(true);
    expect(s).toHaveLength(24);
    expect(isPrefixedId(s, 'ses')).toBe(true);
    expect(isPrefixedId(s, 'trn')).toBe(false);
  });
});
