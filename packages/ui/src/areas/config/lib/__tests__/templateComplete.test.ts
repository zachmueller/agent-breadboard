import { describe, it, expect } from 'vitest';
import { openMustache, templateOptions, knowledgeRefs } from '../templateComplete';

describe('openMustache', () => {
  it('finds an open path', () => {
    expect(openMustache('Hello {{input.to')).toEqual({ start: 8, prefix: 'input.to', knowledge: false });
    expect(openMustache('{{#if steps.a')).toMatchObject({ prefix: 'steps.a', knowledge: false });
    expect(openMustache('{{json ')).toMatchObject({ prefix: '' });
  });
  it('ignores closed mustaches and comments', () => {
    expect(openMustache('{{input.x}} and')).toBeNull();
    expect(openMustache('{{! note')).toBeNull();
    expect(openMustache('no braces')).toBeNull();
  });
  it('detects knowledge tokens', () => {
    expect(openMustache('See {{knowledge:01AB')).toEqual({ start: 16, prefix: '01AB', knowledge: true });
  });
});

describe('templateOptions', () => {
  it('strips $ and filters by prefix', () => {
    const o = templateOptions([{ path: '$input.topic', detail: 'string' }, { path: '$steps.a.output', detail: 'x' }], 'input');
    expect(o.map((x) => x.label)).toEqual(['input.topic']);
  });
  it('offers keywords on empty prefix', () => {
    expect(templateOptions([], '').map((x) => x.label)).toContain('#if');
  });
});

describe('knowledgeRefs', () => {
  it('extracts unique uids', () => {
    const u = '0123456789ABCDEFGHJK';
    expect(knowledgeRefs(`a {{knowledge:${u}}} b {{ knowledge:${u} }}`)).toEqual([u]);
  });
});
