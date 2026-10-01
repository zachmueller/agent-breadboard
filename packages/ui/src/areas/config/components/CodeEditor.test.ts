import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { defaultHighlightStyle } from '@codemirror/language';
import { codeHighlightStyle, hasLocalEdit, syncValueSpec } from './CodeEditor';

describe('CodeEditor value sync', () => {
  it('skips the sync when the document already matches', () => {
    expect(syncValueSpec(EditorState.create({ doc: 'a: 1' }), 'a: 1')).toBeNull();
  });

  it('does not report its own value sync as a local edit', () => {
    const state = EditorState.create({ doc: 'a: 1' });
    const tr = state.update(syncValueSpec(state, 'a: 2')!);
    expect(tr.state.doc.toString()).toBe('a: 2');
    expect(hasLocalEdit([tr])).toBe(false);
  });

  it('reports typing as a local edit', () => {
    const state = EditorState.create({ doc: 'a: 1' });
    const typed = state.update({ changes: { from: 3, to: 4, insert: '9' }, userEvent: 'input.type' });
    expect(hasLocalEdit([typed])).toBe(true);
    expect(hasLocalEdit([state.update({ selection: { anchor: 1 } })])).toBe(false);
    // A batch that mixes a sync with a keystroke still reports the keystroke.
    const sync = typed.state.update(syncValueSpec(typed.state, 'a: 1')!);
    expect(hasLocalEdit([sync, sync.state.update({ changes: { from: 0, insert: '#' } })])).toBe(true);
  });
});

describe('codeHighlightStyle', () => {
  it('keeps every default token style but colors them only with theme tokens', () => {
    expect(codeHighlightStyle.specs).toHaveLength(defaultHighlightStyle.specs.length);
    const colors = codeHighlightStyle.specs.map((s) => s.color).filter(Boolean);
    expect(colors.length).toBe(defaultHighlightStyle.specs.filter((s) => s.color).length);
    for (const c of colors) expect(c).toMatch(/^var\(--bb-[a-z-]+\)$/);
    expect(codeHighlightStyle.module?.getRules()).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
