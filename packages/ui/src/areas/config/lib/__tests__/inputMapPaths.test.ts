import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { filterSuggestions, suggestPaths } from '../inputMapPaths';
import { LIT_REVIEW_YAML } from './fixtures';

describe('suggestPaths', () => {
  const all = suggestPaths(parse(LIT_REVIEW_YAML), 'quality-check');
  const paths = all.map((s) => s.path);

  it('includes input schema properties', () => {
    expect(paths).toContain('$input');
    expect(paths).toContain('$input.question');
    expect(all.find((s) => s.path === '$input.depth')!.detail).toBe('quick | thorough');
  });

  it('includes step outputs including artifact-ref expansion and array types', () => {
    expect(paths).toContain('$steps.summarize.output.summary_artifact');
    expect(paths).toContain('$steps.summarize.output.summary_artifact.uid');
    expect(all.find((s) => s.path === '$steps.gather.output.sources')!.detail).toBe('artifact-ref[]');
    expect(paths).toContain('$steps.report-empty.output');
  });

  it('includes the closed ambient channel', () => {
    expect(paths).toEqual(expect.arrayContaining(['$ambient.task', '$ambient.session_id', '$ambient.budget', '$ambient.artifacts']));
  });

  it('filters by prefix first, then substring', () => {
    const f = filterSuggestions(all, '$steps.summ').map((s) => s.path);
    expect(f[0]).toBe('$steps.summarize.output');
    expect(f.every((p) => p.startsWith('$steps.summarize'))).toBe(true);
    expect(filterSuggestions(all, 'revision_id').map((s) => s.path)).toContain('$steps.summarize.output.summary_artifact.revision_id');
  });
});
