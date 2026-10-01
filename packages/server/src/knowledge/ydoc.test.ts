import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SERVICE_ACTOR } from '@breadboard/shared';
import { attributionOf, cloneDoc, countDeletedChars, docBlocks, docCharCount, docToMarkdown, initDocFromMarkdown, newDoc, propertiesOf, sameVector, encodeVector, splitMarkdownIntoBlocks } from './ydoc.js';

const MD = [
  '# Title',
  'Intro paragraph\nspanning two lines.',
  '## Section',
  '- item one\n- item two\n  - nested',
  '```ts\nconst x = 1;\n\n\nconst y = 2;\n```',
  '| a | b |\n| - | - |\n| 1 | 2 |',
  '> quote',
  '---',
  '1. first\n2. second',
].join('\n\n');

describe('splitMarkdownIntoBlocks', () => {
  it('splits on top-level headings, lists, fences and tables', () => {
    const blocks = splitMarkdownIntoBlocks(MD);
    expect(blocks).toEqual([
      '# Title',
      'Intro paragraph\nspanning two lines.',
      '## Section',
      '- item one\n- item two\n  - nested',
      '```ts\nconst x = 1;\n\n\nconst y = 2;\n```',
      '| a | b |\n| - | - |\n| 1 | 2 |',
      '> quote',
      '---',
      '1. first\n2. second',
    ]);
  });

  it('keeps blank lines inside fences and treats a heading directly after a paragraph as its own block', () => {
    expect(splitMarkdownIntoBlocks('para\n# H\ntext')).toEqual(['para', '# H', 'text']);
    expect(splitMarkdownIntoBlocks('```\na\n\nb\n```')).toEqual(['```\na\n\nb\n```']);
  });

  it('normalizes CRLF and returns [] for blank input', () => {
    expect(splitMarkdownIntoBlocks('a\r\n\r\nb')).toEqual(['a', 'b']);
    expect(splitMarkdownIntoBlocks('  \n\n ')).toEqual([]);
  });
});

describe('doc model', () => {
  it('round-trips markdown and attributes every block', () => {
    const doc = newDoc();
    initDocFromMarkdown(doc, MD, SERVICE_ACTOR('test'), { properties: { title: 'T', domains: ['ops'] } });
    expect(docToMarkdown(doc)).toBe(splitMarkdownIntoBlocks(MD).join('\n\n'));
    const blocks = docBlocks(doc);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
    expect(Object.keys(attributionOf(doc)).sort()).toEqual(blocks.map((b) => b.id).sort());
    expect(propertiesOf(doc)).toEqual({ title: 'T', domains: ['ops'] });
    expect(docCharCount(doc)).toBe(blocks.reduce((n, b) => n + b.text.length, 0));
  });

  it('counts deleted characters of an update exactly', () => {
    const doc = newDoc();
    initDocFromMarkdown(doc, 'aaaa\n\nbbbbbb\n\ncc', SERVICE_ACTOR('test'));
    const other = cloneDoc(doc);
    expect(sameVector(encodeVector(doc), encodeVector(other))).toBe(true);
    const sv = Y.encodeStateVector(other);
    other.transact(() => {
      const arr = other.getArray<Y.Map<unknown>>('blocks');
      arr.delete(1, 1); // whole block: 6 chars
      (arr.get(0).get('text') as Y.Text).delete(0, 2); // 2 chars
    });
    const delta = Y.encodeStateAsUpdate(other, sv);
    expect(countDeletedChars(doc, delta)).toBe(8);
  });
});
