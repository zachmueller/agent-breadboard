import { describe, expect, it } from 'vitest';
import { buildContext, matchAnchor, splitContext } from './anchors';

describe('matchAnchor', () => {
  const doc = 'The cat sat.\n\nThe dog sat on the mat.\n\nThe cat ran.';
  it('resolves a unique quote', () => {
    expect(matchAnchor(doc, { quote: 'dog sat' })).toEqual({ status: 'resolved', from: 18, to: 25, exact: true });
  });
  it('no quote → none', () => {
    expect(matchAnchor(doc, { quote: '' })).toEqual({ status: 'none' });
    expect(matchAnchor(doc, null)).toEqual({ status: 'none' });
  });
  it('missing quote → not_found (stale)', () => {
    expect(matchAnchor(doc, { quote: 'elephant' })).toEqual({ status: 'not_found' });
  });
  it('ambiguous quote without context → ambiguous', () => {
    expect(matchAnchor(doc, { quote: 'The cat' })).toEqual({ status: 'ambiguous', candidates: 2 });
  });
  it('context disambiguates', () => {
    const from = doc.lastIndexOf('The cat');
    const context = buildContext(doc, from, from + 7);
    const m = matchAnchor(doc, { quote: 'The cat', context });
    expect(m).toEqual({ status: 'resolved', from, to: from + 7, exact: true });
  });
  it('context that matches neither candidate better stays ambiguous', () => {
    expect(matchAnchor('ab X cd X ef', { quote: 'X', context: 'zz X zz' })).toEqual({ status: 'ambiguous', candidates: 2 });
  });
  it('whitespace-insensitive fuzzy tier', () => {
    const m = matchAnchor('alpha  beta\ngamma', { quote: 'alpha beta gamma' });
    expect(m).toEqual({ status: 'resolved', from: 0, to: 17, exact: false });
  });
  it('splitContext', () => {
    expect(splitContext('aa Q bb', 'Q')).toEqual({ before: 'aa ', after: ' bb' });
    expect(splitContext('aa', 'Q')).toBeNull();
  });
  it('buildContext clamps to doc bounds', () => {
    expect(buildContext('abcdef', 2, 3, 2)).toBe('abcde');
    expect(buildContext('abcdef', 0, 1, 2)).toBe('abc');
  });
});
