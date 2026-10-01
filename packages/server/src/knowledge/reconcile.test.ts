import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SERVICE_ACTOR, type Actor } from '@breadboard/shared';
import { cloneDoc, docBlocks, docToMarkdown, initDocFromMarkdown, newDoc, attributionOf } from './ydoc.js';
import { applyTextDiff, planBlockOps, reconcile, similarity } from './reconcile.js';

const AI: Actor = { kind: 'subagent', id: 'writer', session_id: 'S1' };

function seed(md: string): Y.Doc {
  const d = newDoc();
  initDocFromMarkdown(d, md, SERVICE_ACTOR('test'));
  return d;
}

describe('planBlockOps', () => {
  it('classifies retain / replace / insert / delete', () => {
    const ops = planBlockOps(['# A', 'alpha beta gamma delta', 'to be removed entirely', 'tail'], ['# A', 'alpha beta gamma delta epsilon', 'brand new thing', 'tail']);
    expect(ops.map((o) => o.kind)).toEqual(['retain', 'replace', 'delete', 'insert', 'retain']);
  });
  it('treats whitespace/case-only edits as replace (same block id)', () => {
    expect(planBlockOps(['Hello World'], ['hello  world']).map((o) => o.kind)).toEqual(['replace']);
  });
  it('similarity is symmetric and 1 for identical fingerprints', () => {
    expect(similarity('abc def', 'ABC  def')).toBe(1);
    expect(similarity('the quick brown fox', 'the quick brown cat')).toBeCloseTo(similarity('the quick brown cat', 'the quick brown fox'));
  });
});

describe('applyTextDiff', () => {
  it('produces the target text with minimal ops (including astral chars)', () => {
    const doc = newDoc();
    const t = doc.getText('t');
    for (const [a, b] of [
      ['the quick brown fox', 'the slow brown fox jumps'],
      ['emoji 😀 here', 'emoji 😁 here'],
      ['abc', ''],
      ['', 'xyz'],
    ] as const) {
      t.delete(0, t.length);
      t.insert(0, a);
      applyTextDiff(t, a, b);
      expect(t.toString()).toBe(b);
    }
  });
});

describe('reconcile', () => {
  const BASE = ['# Runbook', 'Step one: restart the service carefully.', 'Step two: check the dashboards.', 'Obsolete paragraph about the old pager.', 'Closing notes.'].join('\n\n');

  it('edits, inserts and deletes with stable ids; only the insert mints a new id', () => {
    const base = seed(BASE);
    const before = docBlocks(base);
    const revised = ['# Runbook', 'Step one: restart the service very carefully.', 'Step two: check the dashboards.', 'Step three: page the on-call if errors persist.', 'Closing notes.'].join('\n\n');
    const live = cloneDoc(base);
    const r = reconcile(base, revised, { actor: AI });
    expect(r.stats).toEqual({ retained: 3, replaced: 1, inserted: 1, deleted: 1 });
    Y.applyUpdate(live, r.update);
    expect(docToMarkdown(live)).toBe(revised);
    const after = docBlocks(live);
    const beforeIds = new Set(before.map((b) => b.id));
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[1]!.id).toBe(before[1]!.id); // edited keeps id
    expect(after[2]!.id).toBe(before[2]!.id);
    expect(beforeIds.has(after[3]!.id)).toBe(false); // the insert
    expect(after[4]!.id).toBe(before[4]!.id);
    expect(after.filter((b) => !beforeIds.has(b.id))).toHaveLength(1);
    const attr = attributionOf(live);
    expect(attr[after[1]!.id]!.actor).toEqual(AI);
    expect(attr[after[3]!.id]!.actor).toEqual(AI);
    expect(attr[after[0]!.id]!.actor.kind).toBe('service');
  });

  it('merges with concurrent human edits made after the base', () => {
    const base = seed('para A original\n\npara B\n\npara C original text');
    const live = cloneDoc(base);
    // human edits block A on the live head
    const a = live.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text;
    a.insert(a.length, ' (human)');
    const r = reconcile(base, 'para A original\n\npara B\n\npara C revised text by AI', { actor: AI });
    Y.applyUpdate(live, r.update);
    expect(docToMarkdown(live)).toBe('para A original (human)\n\npara B\n\npara C revised text by AI');
  });

  it('returns an empty delta when nothing changed', () => {
    const base = seed('one\n\ntwo');
    const r = reconcile(base, 'one\n\ntwo\n', { actor: AI });
    expect(r.stats.retained).toBe(2);
    expect(r.changed_block_ids).toEqual([]);
    const live = cloneDoc(base);
    const md = docToMarkdown(live);
    Y.applyUpdate(live, r.update);
    expect(docToMarkdown(live)).toBe(md);
  });
});
