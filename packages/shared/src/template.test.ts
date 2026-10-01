import { describe, it, expect } from 'vitest';
import { renderTemplate, templateReferences, resolvePath } from './template.js';

describe('template engine', () => {
  const ctx = {
    input: { question: 'Why?', depth: 'quick', tags: ['a', 'b'] },
    steps: { 'quality-check': { output: { findings: ['missing cite', 'bad ref'] } } },
    ambient: { session_id: 'ses_X' },
  };
  it('inserts paths', () => {
    expect(renderTemplate('Q: {{input.question}} ({{ input.depth }})', ctx)).toBe('Q: Why? (quick)');
    expect(renderTemplate('{{$input.question}}', ctx)).toBe('Why?');
  });
  it('handles if/else and missing paths', () => {
    expect(renderTemplate('{{#if steps.quality-check.output}}has{{else}}none{{/if}}', ctx)).toBe('has');
    expect(renderTemplate('{{#if steps.nope.output}}has{{else}}none{{/if}}', ctx)).toBe('none');
    expect(renderTemplate('[{{steps.nope.output.x}}]', ctx)).toBe('[]');
  });
  it('iterates with each', () => {
    expect(renderTemplate('{{#each steps.quality-check.output.findings}}- {{this}} ({{@index}})\n{{/each}}', ctx)).toBe('- missing cite (0)\n- bad ref (1)\n');
    expect(renderTemplate('{{#each input.tags}}{{this}}{{#if @last}}.{{else}},{{/if}}{{/each}}', ctx)).toBe('a,b.');
  });
  it('json helper and object insert', () => {
    expect(renderTemplate('{{json input.tags}}', ctx)).toBe('[\n  "a",\n  "b"\n]');
  });
  it('leaves knowledge tokens for the subagent resolver', () => {
    expect(renderTemplate('x {{knowledge:01J8FQ2ZK7XW9MBT4PVN}} y', ctx)).toBe('x {{knowledge:01J8FQ2ZK7XW9MBT4PVN}} y');
  });
  it('lists references', () => {
    expect(templateReferences('{{input.q}} {{#if steps.a.output}}{{json ambient.task}}{{/if}} {{knowledge:01J8FQ2ZK7XW9MBT4PVN}}')).toEqual(['input.q', 'steps.a.output', 'ambient.task']);
  });
  it('throws on unclosed blocks', () => {
    expect(() => renderTemplate('{{#if x}}y', ctx)).toThrow();
  });
  it('resolvePath', () => {
    expect(resolvePath('$steps.quality-check.output.findings.1', [ctx])).toBe('bad ref');
  });
});
