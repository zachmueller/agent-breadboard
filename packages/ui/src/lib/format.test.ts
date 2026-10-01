import { describe, expect, it } from 'vitest';
import { durationMs, formatCost, formatDuration, formatRelative, formatTokens, humanize, shortCommit, shortId } from './format';

describe('format helpers', () => {
  it('formatCost', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.00001)).toBe('<$0.0001');
    expect(formatCost(0.1234)).toBe('$0.1234');
    expect(formatCost('12.5')).toBe('$12.50');
    expect(formatCost(1234.6)).toBe('$1,235');
    expect(formatCost(null)).toBe('—');
  });

  it('formatTokens', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1500)).toBe('1.5K');
    expect(formatTokens(25_000)).toBe('25K');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });

  it('durations', () => {
    expect(durationMs('2026-01-01T00:00:00Z', '2026-01-01T00:00:05Z')).toBe(5000);
    expect(durationMs('2026-01-01T00:00:00Z', null, Date.parse('2026-01-01T00:01:00Z'))).toBe(60_000);
    expect(durationMs(null, null)).toBeNull();
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(4200)).toBe('4.2s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(50 * 3_600_000)).toBe('2d 2h');
  });

  it('formatRelative', () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    expect(formatRelative('2026-09-30T11:59:50Z', now)).toBe('just now');
    expect(formatRelative('2026-09-30T11:55:00Z', now)).toBe('5m ago');
    expect(formatRelative('2026-09-30T14:00:00Z', now)).toBe('in 2h');
    expect(formatRelative('2026-09-27T12:00:00Z', now)).toBe('3d ago');
  });

  it('ids and labels', () => {
    expect(shortId('ses_01J8FQ2ZK7XW9MBT4PVN')).toBe('ses_01J8…4PVN');
    expect(shortId('short')).toBe('short');
    expect(shortCommit('0123456789abcdef')).toBe('01234567');
    expect(humanize('suspended-gate')).toBe('Suspended gate');
  });
});
