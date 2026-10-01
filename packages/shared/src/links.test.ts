import { describe, it, expect } from 'vitest';
import { extractLinks, uniqueLinkTargets, formatLink } from './links.js';

describe('wiki links', () => {
  it('extracts UID links with and without titles', () => {
    const text = 'See [[01J8FQ2ZK7XW9MBT4PVN|Q3 latency]] and [[01J8FQ2ZK7XW9MBT4PVM]] but not [[not a uid]].';
    const links = extractLinks(text);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ uid: '01J8FQ2ZK7XW9MBT4PVN', title: 'Q3 latency' });
    expect(links[1]).toMatchObject({ uid: '01J8FQ2ZK7XW9MBT4PVM', title: null });
  });
  it('dedupes targets', () => {
    expect(uniqueLinkTargets('[[01J8FQ2ZK7XW9MBT4PVN]] [[01J8FQ2ZK7XW9MBT4PVN|x]]')).toEqual(['01J8FQ2ZK7XW9MBT4PVN']);
  });
  it('formats', () => {
    expect(formatLink('01J8FQ2ZK7XW9MBT4PVN', 'T')).toBe('[[01J8FQ2ZK7XW9MBT4PVN|T]]');
  });
});
