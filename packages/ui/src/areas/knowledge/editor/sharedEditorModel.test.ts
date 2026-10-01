import { describe, expect, it } from 'vitest';
import { attributedRanges, blockIdAt, connectionMeta, newCommentAnchor, sameTops } from './sharedEditorModel';

const ranges = [
  { id: 'b1', from: 0, to: 7 },
  { id: 'b2', from: 9, to: 20 },
];

describe('attributedRanges', () => {
  it('joins block ranges with attribution entries, skipping unattributed blocks', () => {
    const attr: Record<string, unknown> = { b2: { actor: { kind: 'subagent', id: 'S1' }, at: '2026-01-01T00:00:00Z' }, b1: { at: 'x' } };
    const out = attributedRanges(ranges, (id) => attr[id] as never);
    expect(out).toEqual([{ id: 'b2', from: 9, to: 20, actor: { kind: 'subagent', id: 'S1' }, at: '2026-01-01T00:00:00Z' }]);
  });
});

describe('blockIdAt', () => {
  it('finds the containing block, inclusive of its end', () => {
    expect(blockIdAt(ranges, 7)).toBe('b1');
    expect(blockIdAt(ranges, 9)).toBe('b2');
    expect(blockIdAt(ranges, 8)).toBeNull();
  });
});

describe('newCommentAnchor', () => {
  const doc = '# Title\n\nThe quick brown fox.';
  it('trims the selection and records context, head revision and block', () => {
    const from = doc.indexOf('quick') - 1; // leading space
    const to = doc.indexOf('brown') + 'brown'.length + 1; // trailing space
    const a = newCommentAnchor(doc, from, to, 4, ranges)!;
    expect(a.quote).toBe('quick brown');
    expect(a.context).toContain('The quick brown fox.');
    expect(a.revision).toBe(4);
    expect(a.block_id).toBe('b2');
  });
  it('omits revision when there is no head and rejects tiny selections', () => {
    expect(newCommentAnchor(doc, 0, 7, null)!.revision).toBeUndefined();
    expect(newCommentAnchor(doc, 9, 10, 1)).toBeNull();
    expect(newCommentAnchor(doc, 7, 9, 1)).toBeNull(); // whitespace only
  });
  it('accepts reversed bounds', () => {
    expect(newCommentAnchor(doc, 7, 0, 1)!.quote).toBe('# Title');
  });
});

describe('connectionMeta', () => {
  const base = { status: 'connected' as const, synced: true, unsynced: 0, authError: null };
  it('maps snapshot to a label', () => {
    expect(connectionMeta(base).label).toBe('Live');
    expect(connectionMeta({ ...base, unsynced: 2 }).label).toBe('Saving…');
    expect(connectionMeta({ ...base, synced: false }).label).toBe('Syncing…');
    expect(connectionMeta({ ...base, status: 'connecting' }).label).toBe('Connecting…');
    expect(connectionMeta({ ...base, status: 'disconnected' })).toMatchObject({ label: 'Offline', tone: 'warn' });
    expect(connectionMeta({ ...base, authError: 'denied' })).toMatchObject({ label: 'Refused', tone: 'danger' });
  });
});

describe('sameTops', () => {
  it('compares with sub-pixel tolerance', () => {
    expect(sameTops({ a: 1, b: 2 }, { a: 1.2, b: 2 })).toBe(true);
    expect(sameTops({ a: 1 }, { a: 3 })).toBe(false);
    expect(sameTops({ a: 1 }, { b: 1 })).toBe(false);
    expect(sameTops({}, {})).toBe(true);
  });
});
