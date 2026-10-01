import { describe, expect, it } from 'vitest';
import type { EdgeRecord } from '@breadboard/shared';
import { CONNECTOR_READ_ONLY_REASON, asSearchMode, backlinkSources, connectorInfo, filterHitsByTag, formatScore, readOnlyReason } from './lib';

const edge = (p: Partial<EdgeRecord>): EdgeRecord =>
  ({ edge_id: 1, type: 'references', src_uid: 'A', src_session_id: null, src_step_id: null, dst_uid: 'SELF', dst_revision: null, properties: {}, created_at: '2026-01-01T00:00:00Z', created_by: { kind: 'user', id: 'u' }, retracted_at: null, retracted_by: null, ...p }) as EdgeRecord;

describe('connectorInfo', () => {
  it('detects connector and read-only tags', () => {
    expect(connectorInfo(['connector:01ABC', 'read-only'])).toEqual({ connectorUid: '01ABC', readOnly: true, isConnector: true });
    expect(connectorInfo(['read-only'])).toMatchObject({ connectorUid: null, isConnector: true });
    expect(connectorInfo(['ops'])).toEqual({ connectorUid: null, readOnly: false, isConnector: false });
    expect(connectorInfo(undefined).isConnector).toBe(false);
  });
});

describe('readOnlyReason', () => {
  it('prioritises connector, then explicit, then auth, then scope', () => {
    expect(readOnlyReason({ connector: true, explicit: 'x' })).toBe(CONNECTOR_READ_ONLY_REASON);
    expect(readOnlyReason({ connector: false, explicit: 'Task is active', scope: 'readonly' })).toBe('Task is active');
    expect(readOnlyReason({ connector: false, authError: 'denied' })).toMatch(/refused/);
    expect(readOnlyReason({ connector: false, scope: 'readonly' })).toMatch(/read access/);
    expect(readOnlyReason({ connector: false, scope: 'read-write' })).toBeNull();
  });
});

describe('backlinkSources', () => {
  it('dedupes, drops retracted/self/null and non-references, newest first', () => {
    const out = backlinkSources(
      [
        edge({ edge_id: 1, src_uid: 'A', created_at: '2026-01-01T00:00:00Z' }),
        edge({ edge_id: 2, src_uid: 'B', created_at: '2026-01-03T00:00:00Z' }),
        edge({ edge_id: 3, src_uid: 'A', created_at: '2026-01-02T00:00:00Z' }),
        edge({ edge_id: 4, src_uid: 'C', retracted_at: '2026-01-04T00:00:00Z' }),
        edge({ edge_id: 5, src_uid: null }),
        edge({ edge_id: 6, src_uid: 'SELF' }),
        edge({ edge_id: 7, src_uid: 'D', type: 'produces' }),
      ],
      'SELF',
    );
    expect(out).toEqual([
      { uid: 'B', at: '2026-01-03T00:00:00Z' },
      { uid: 'A', at: '2026-01-02T00:00:00Z' },
    ]);
  });
});

describe('search helpers', () => {
  const hits = [
    { uid: '1', tags: ['ops', 'connector:X'] },
    { uid: '2', tags: ['eng'] },
    { uid: '3', tags: null },
  ];
  it('filters by exact tag or prefix ending in a colon', () => {
    expect(filterHitsByTag(hits, 'eng').map((h) => h.uid)).toEqual(['2']);
    expect(filterHitsByTag(hits, 'connector:').map((h) => h.uid)).toEqual(['1']);
    expect(filterHitsByTag(hits, '  ')).toHaveLength(3);
  });
  it('formats scores', () => {
    expect(formatScore(0.8765)).toBe('0.88');
    expect(formatScore(0)).toBe('0.00');
    expect(formatScore(0.0012)).toBe('1.2e-3');
    expect(formatScore(undefined)).toBe('—');
  });
  it('normalises the search mode', () => {
    expect(asSearchMode('text')).toBe('text');
    expect(asSearchMode('bogus')).toBe('hybrid');
    expect(asSearchMode(undefined)).toBe('hybrid');
  });
});
