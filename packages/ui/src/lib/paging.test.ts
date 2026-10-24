import { describe, expect, it } from 'vitest';
import { dayEndIso, dayStartIso, pageCount, pageState, pageWindow, rangeLabel } from './paging';

describe('paging helpers', () => {
  it('reads page state from the URL, falling back to page 1 and the default size', () => {
    expect(pageState({})).toEqual({ page: 1, size: 50, offset: 0 });
    expect(pageState({ page: '3', size: '25' })).toEqual({ page: 3, size: 25, offset: 50 });
    expect(pageState({ page: '0', size: '33' })).toEqual({ page: 1, size: 50, offset: 0 });
    expect(pageState({ page: 'x' }).page).toBe(1);
  });

  it('counts pages and windows them with gaps', () => {
    expect([pageCount(0, 50), pageCount(50, 50), pageCount(51, 50)]).toEqual([1, 1, 2]);
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(6, 65)).toEqual([1, 'gap', 4, 5, 6, 7, 8, 'gap', 65]);
    // A one-page gap shows the page instead of an ellipsis.
    expect(pageWindow(4, 9)).toEqual([1, 2, 3, 4, 5, 6, 'gap', 9]);
    expect(pageWindow(65, 65)).toEqual([1, 'gap', 63, 64, 65]);
  });

  it('labels the visible range', () => {
    expect(rangeLabel(0, 50, 3214)).toBe('1–50 of 3,214');
    expect(rangeLabel(3200, 14, 3214)).toBe('3,201–3,214 of 3,214');
    expect(rangeLabel(0, 0, 0)).toBe('0 of 0');
  });

  it('turns local days into an inclusive instant range', () => {
    const start = new Date(dayStartIso('2026-03-07')!);
    const end = new Date(dayEndIso('2026-03-07')!);
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes()]).toEqual([2026, 2, 7, 0, 0]);
    expect([end.getDate(), end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()]).toEqual([7, 23, 59, 59, 999]);
    expect(dayStartIso(undefined)).toBeUndefined();
    expect(dayEndIso('not a day')).toBeUndefined();
  });
});
