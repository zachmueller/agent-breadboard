import { describe, expect, it } from 'vitest';
import { parseSearch, stringSearch, stringifySearch } from './url';

describe('search serialization', () => {
  it('keeps scalars as plain strings in both directions', () => {
    const qs = stringifySearch({ page: '2', size: '100', created_after: '2026-01-05', q: 'true', task: '12345678901234567890' });
    expect(qs).toBe('?page=2&size=100&created_after=2026-01-05&q=true&task=12345678901234567890');
    expect(stringSearch(parseSearch(qs))).toEqual({ page: '2', size: '100', created_after: '2026-01-05', q: 'true', task: '12345678901234567890' });
  });

  it('still round-trips objects', () => {
    const qs = stringifySearch({ f: { a: 1 } as never });
    expect(parseSearch(qs)).toEqual({ f: { a: 1 } });
  });
});
