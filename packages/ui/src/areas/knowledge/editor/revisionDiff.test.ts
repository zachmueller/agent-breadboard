import { describe, expect, it } from 'vitest';
import { CURRENT, afterRevision, aiEditRevisions, diffRevisions, orderCompare, orderPair, parsePatch, revLabel, revisionText, togglePick } from './revisionDiff';

describe('diffRevisions', () => {
  it('produces numbered add/del/ctx rows', () => {
    const d = diffRevisions('# Title\n\nalpha\n\nbeta', '# Title\n\nalpha\n\ngamma', 'r1', 'r2');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    const del = d.rows.find((r) => r.kind === 'del')!;
    const add = d.rows.find((r) => r.kind === 'add')!;
    expect(del).toMatchObject({ text: 'beta', oldNo: 5, newNo: null });
    expect(add).toMatchObject({ text: 'gamma', oldNo: null, newNo: 5 });
    expect(d.rows[0]!.kind).toBe('hunk');
    expect(d.patch).toContain('--- r1');
  });

  it('reports no rows for identical text, ignoring a trailing newline', () => {
    const d = diffRevisions('same\n', 'same');
    expect(d.rows).toEqual([]);
    expect(d.added + d.removed).toBe(0);
  });

  it('handles empty sides', () => {
    const d = diffRevisions('', 'new line');
    expect(d.added).toBe(1);
    expect(d.rows.filter((r) => r.kind === 'add').map((r) => r.text)).toEqual(['new line']);
  });
});

describe('parsePatch', () => {
  it('skips headers and no-newline markers', () => {
    const rows = parsePatch(['===', '--- a', '+++ b', '@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+c'].join('\n'));
    expect(rows.map((r) => r.kind)).toEqual(['hunk', 'ctx', 'del', 'add']);
    expect(rows[1]).toMatchObject({ oldNo: 1, newNo: 1 });
  });
});

describe('helpers', () => {
  it('revisionText prefers body_text', () => {
    expect(revisionText({ body_text: 'md', body: { x: 1 } })).toBe('md');
    expect(revisionText({ body_text: null, body: 'plain' })).toBe('plain');
    expect(revisionText(null)).toBe('');
  });
  it('orderPair sorts', () => {
    expect(orderPair(7, 3)).toEqual([3, 7]);
  });
  it('togglePick keeps the two latest picks', () => {
    expect(togglePick([], 1)).toEqual([1]);
    expect(togglePick([1], 2)).toEqual([1, 2]);
    expect(togglePick([1, 2], 3)).toEqual([2, 3]);
    expect(togglePick([2, 3], 2)).toEqual([3]);
  });
  it('aiEditRevisions filters and sorts newest first', () => {
    const revs = [
      { revision_id: 1, labels: ['created'] },
      { revision_id: 4, labels: ['pre-ai-edit'] },
      { revision_id: 9, labels: ['pre-ai-edit', 'step-complete'] },
    ];
    expect(aiEditRevisions(revs).map((r) => r.revision_id)).toEqual([9, 4]);
  });
});

describe('compare pairs', () => {
  it('keeps the live document newest', () => {
    expect(orderCompare(CURRENT, 3)).toEqual([3, CURRENT]);
    expect(orderCompare(5, CURRENT)).toEqual([5, CURRENT]);
    expect(orderCompare(5, 2)).toEqual([2, 5]);
    expect(revLabel(CURRENT)).toBe('current');
    expect(revLabel(4)).toBe('r4');
  });
  it('afterRevision finds the next newer revision or current', () => {
    const revs = [{ revision_id: 9 }, { revision_id: 6 }, { revision_id: 4 }];
    expect(afterRevision(revs, 4)).toBe(6);
    expect(afterRevision(revs, 6)).toBe(9);
    expect(afterRevision(revs, 9)).toBe(CURRENT);
  });
});
