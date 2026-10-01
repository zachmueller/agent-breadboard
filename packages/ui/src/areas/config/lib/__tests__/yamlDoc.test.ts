import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseConfigYaml } from '@breadboard/shared';
import { editYaml, yamlOf, merge3 } from '../yamlDoc';
import { LIT_REVIEW_YAML } from './fixtures';

describe('editYaml', () => {
  it('fixture is a valid circuit', () => {
    const r = parseConfigYaml(LIT_REVIEW_YAML, 'circuit');
    expect(r.errors).toEqual([]);
  });

  it('returns byte-identical text when nothing changes', () => {
    expect(editYaml(LIT_REVIEW_YAML, () => {})).toBe(LIT_REVIEW_YAML);
    expect(editYaml(LIT_REVIEW_YAML, (d) => structuredClone(d))).toBe(LIT_REVIEW_YAML);
  });

  it('changes a scalar while keeping every comment', () => {
    const out = editYaml(LIT_REVIEW_YAML, (d) => {
      d.title = 'Lit review v2';
    });
    expect(parse(out).title).toBe('Lit review v2');
    for (const c of ['# permanent config UID', '# display metadata only', '# per-run defaults', '# typed input schema', '# step id where execution begins', '# The scout finds sources first.', '# research-writer', '# loop back', '# emit-empty-report']) {
      expect(out).toContain(c);
    }
    // key order preserved
    const keys = Object.keys(parse(out));
    expect(keys).toEqual(Object.keys(parse(LIT_REVIEW_YAML)));
  });

  it('keeps step comments attached when a step is removed or reordered', () => {
    const out = editYaml(LIT_REVIEW_YAML, (d) => {
      d.steps = d.steps.filter((s: any) => s.id !== 'summarize');
      d.steps.reverse();
    });
    const v = parse(out);
    expect(v.steps.map((s: any) => s.id)).toEqual(['report-empty', 'quality-gate', 'quality-check', 'gather']);
    // comment on quality-check's tool line still sits next to that tool
    expect(out).toMatch(/tool: 01J8T00000000000CK00 # check-citations/);
    expect(out).toMatch(/tool: 01J8T00000000000EM00 # emit-empty-report/);
    expect(out).not.toContain('# research-writer');
  });

  it('retargets an exit and appends new keys at the end of the step', () => {
    const out = editYaml(LIT_REVIEW_YAML, (d) => {
      const gate = d.steps.find((s: any) => s.id === 'quality-gate');
      gate.exits[1].to = 'gather';
      gate.max_visits = 5;
    });
    const gate = parse(out).steps.find((s: any) => s.id === 'quality-gate');
    expect(gate.exits[1]).toEqual({ name: 'changes', to: 'gather' });
    expect(Object.keys(gate).at(-1)).toBe('max_visits');
    expect(out).toContain('reviewers: { role: scientist }');
  });

  it('writes multi-line strings as block literals', () => {
    const out = editYaml(LIT_REVIEW_YAML, (d) => {
      d.description = 'line one\nline two\n';
    });
    expect(out).toContain('description: |');
    expect(parse(out).description).toBe('line one\nline two\n');
  });

  it('deleting a key drops it and keeps neighbors', () => {
    const out = editYaml(LIT_REVIEW_YAML, (d) => {
      delete d.steps[0].tools_override;
    });
    expect(parse(out).steps[0].tools_override).toBeUndefined();
    expect(out).toContain('prompt: prompts/gather.md');
  });

  it('serializes fresh values', () => {
    expect(parse(yamlOf({ a: 1, b: ['x'] }))).toEqual({ a: 1, b: ['x'] });
  });
});

describe('minimal rewrite', () => {
  it('keeps untouched lines byte-identical (alignment, flow spacing, trailing comments)', () => {
    const src = 'a: 1        # one\ntags: [x, y]\nb:    { k: v }\nc: old   # keep\n';
    const out = editYaml(src, (d) => {
      d.c = 'new';
    });
    expect(out).toBe('a: 1        # one\ntags: [x, y]\nb:    { k: v }\nc: new # keep\n');
  });
  it('appends new keys without reformatting the rest', () => {
    const src = 'x:   1   # c\nlist: [a]\n';
    const out = editYaml(src, (d) => {
      d.y = { z: true };
    });
    expect(out.startsWith('x:   1   # c\nlist: [a]\n')).toBe(true);
    expect(out).toContain('y:\n  z: true');
  });
  it('merge3 prefers the edit on conflicting chunks', () => {
    expect(merge3(['a', 'b', 'c'], ['a', 'B', 'c'], ['a', 'b2', 'c'])).toEqual(['a', 'b2', 'c']);
    expect(merge3(['a', 'b', 'c'], ['A', 'b', 'c'], ['a', 'b', 'c2'])).toEqual(['A', 'b', 'c2']);
  });
});
