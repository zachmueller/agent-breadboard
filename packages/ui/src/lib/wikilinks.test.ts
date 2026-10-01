import { describe, expect, it } from 'vitest';
import { BROKEN_LINK_HREF, nodeUidFromHref, transformWikiLinks } from './wikilinks';

const UID = '01J8FQ2ZK7XW9MBT4PVN';

describe('transformWikiLinks', () => {
  it('turns [[UID|title]] into a node link', () => {
    expect(transformWikiLinks(`See [[${UID}|Design notes]].`)).toBe(`See [Design notes](/n/${UID}).`);
  });

  it('uses the UID as label when there is no title', () => {
    expect(transformWikiLinks(`[[${UID}]]`)).toBe(`[${UID}](/n/${UID})`);
  });

  it('normalizes lowercase and ambiguous Crockford characters', () => {
    expect(transformWikiLinks('[[01j8fq2zk7xw9mbt4pvn|x]]')).toBe(`[x](/n/${UID})`);
    expect(transformWikiLinks('[[O1J8FQ2ZK7XW9MBT4PVN|x]]')).toBe(`[x](/n/${UID})`);
  });

  it('marks non-UID targets as broken', () => {
    expect(transformWikiLinks('[[Some Page]]')).toBe(`[Some Page](${BROKEN_LINK_HREF})`);
    expect(transformWikiLinks('[[nope|Label]]')).toBe(`[Label](${BROKEN_LINK_HREF})`);
  });

  it('escapes Markdown in labels', () => {
    expect(transformWikiLinks(`[[${UID}|a_b *c* [d]]]`)).toContain('a\\_b \\*c\\*');
  });

  it('leaves inline code and fenced code untouched', () => {
    const md = [`inline \`[[${UID}|x]]\` and [[${UID}|y]]`, '```md', `[[${UID}|z]]`, '```', `after [[${UID}|w]]`].join('\n');
    const out = transformWikiLinks(md).split('\n');
    expect(out[0]).toBe(`inline \`[[${UID}|x]]\` and [y](/n/${UID})`);
    expect(out[2]).toBe(`[[${UID}|z]]`);
    expect(out[4]).toBe(`after [w](/n/${UID})`);
  });

  it('respects tilde fences and longer closing fences', () => {
    const md = ['~~~', `[[${UID}]]`, '~~~~', `[[${UID}|t]]`].join('\n');
    expect(transformWikiLinks(md).split('\n')).toEqual(['~~~', `[[${UID}]]`, '~~~~', `[t](/n/${UID})`]);
  });

  it('is a no-op without links', () => {
    const md = 'plain [link](https://x) text';
    expect(transformWikiLinks(md)).toBe(md);
  });
});

describe('nodeUidFromHref', () => {
  it('extracts node UIDs from transformed links only', () => {
    expect(nodeUidFromHref(`/n/${UID}`)).toBe(UID);
    expect(nodeUidFromHref(`/n/${UID}/x`)).toBeNull();
    expect(nodeUidFromHref('/s/ses_abc')).toBeNull();
    expect(nodeUidFromHref(BROKEN_LINK_HREF)).toBeNull();
    expect(nodeUidFromHref(null)).toBeNull();
  });
});
