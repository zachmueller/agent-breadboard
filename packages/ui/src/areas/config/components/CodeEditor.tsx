/** Thin CodeMirror 6 wrapper: controlled value, language by name/extension, extra extensions. */
import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { Annotation, EditorState, Compartment, type Extension, type Transaction, type TransactionSpec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput, foldGutter, foldKeymap } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { yaml } from '@codemirror/lang-yaml';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';

export type CodeLanguage = 'yaml' | 'markdown' | 'typescript' | 'javascript' | 'python' | 'json' | 'text';

export function languageForPath(path: string): CodeLanguage {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'ts' || ext === 'tsx' || ext === 'mts' || ext === 'cts') return 'typescript';
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'javascript';
  if (ext === 'py') return 'python';
  if (ext === 'json') return 'json';
  return 'text';
}

function langExt(l: CodeLanguage): Extension {
  switch (l) {
    case 'yaml':
      return yaml();
    case 'markdown':
      return [markdown(), EditorView.lineWrapping];
    case 'typescript':
      return javascript({ typescript: true, jsx: true });
    case 'javascript':
      return javascript({ jsx: true });
    case 'json':
      return javascript();
    case 'python':
      return python();
    default:
      return EditorView.lineWrapping;
  }
}

const theme = EditorView.theme({
  '&': { fontSize: '12.5px', backgroundColor: 'var(--bb-surface)', color: 'var(--bb-fg)', height: '100%' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'var(--bb-sunken)', color: 'var(--bb-fg-subtle)', borderRight: '1px solid var(--bb-line)' },
  '.cm-activeLine': { backgroundColor: 'var(--bb-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bb-hover)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--bb-fg)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--bb-accent) 25%, transparent) !important' },
  '.cm-tooltip': { backgroundColor: 'var(--bb-surface)', border: '1px solid var(--bb-line)', color: 'var(--bb-fg)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--bb-accent-soft)', color: 'var(--bb-fg)' },
  '.cm-placeholder': { color: 'var(--bb-fg-subtle)' },
});

/** Marks the transaction that syncs the document to a new `value` prop, so it is not echoed to `onChange`. */
const valueSync = Annotation.define<boolean>();

/** Replace the document with `value` (annotated as a sync), or null when it already matches. */
export function syncValueSpec(state: EditorState, value: string): TransactionSpec | null {
  const cur = state.doc.toString();
  return cur === value ? null : { changes: { from: 0, to: cur.length, insert: value }, annotations: valueSync.of(true) };
}

/**
 * Whether an update's transactions include a document edit made in the editor. The `value` sync is
 * excluded: echoing it back lets a lagging `value` overwrite newer keystrokes and ping-pong with them.
 */
export function hasLocalEdit(transactions: readonly Transaction[]): boolean {
  return transactions.some((tr) => tr.docChanged && !tr.annotation(valueSync));
}

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: CodeLanguage;
  readOnly?: boolean;
  /** Extra extensions (autocomplete sources, decorations). Reconfigured when identity changes. */
  extensions?: Extension[];
  placeholder?: string;
  className?: string;
  minHeight?: number;
  maxHeight?: number;
  lineNumbers?: boolean;
  ariaLabel?: string;
}

export function CodeEditor({ value, onChange, language = 'text', readOnly, extensions, placeholder, className, minHeight, maxHeight, lineNumbers: showLines = true, ariaLabel }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const comp = useRef({ lang: new Compartment(), ro: new Compartment(), extra: new Compartment(), gutters: new Compartment() });

  useEffect(() => {
    const c = comp.current;
    const state = EditorState.create({
      doc: value,
      extensions: [
        c.gutters.of(showLines ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : []),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        autocompletion({ activateOnTyping: true }),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
        theme,
        placeholder ? cmPlaceholder(placeholder) : [],
        ariaLabel ? EditorView.contentAttributes.of({ 'aria-label': ariaLabel }) : [],
        c.lang.of(langExt(language)),
        c.ro.of([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly)]),
        c.extra.of(extensions ?? []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && hasLocalEdit(u.transactions)) onChangeRef.current?.(u.state.doc.toString());
        }),
      ],
    });
    view.current = new EditorView({ state, parent: host.current! });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const spec = syncValueSpec(v.state, value);
    if (spec) v.dispatch(spec);
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: comp.current.lang.reconfigure(langExt(language)) });
  }, [language]);
  useEffect(() => {
    view.current?.dispatch({ effects: comp.current.ro.reconfigure([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);
  useEffect(() => {
    view.current?.dispatch({ effects: comp.current.extra.reconfigure(extensions ?? []) });
  }, [extensions]);
  useEffect(() => {
    view.current?.dispatch({ effects: comp.current.gutters.reconfigure(showLines ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : []) });
  }, [showLines]);

  return (
    <div
      ref={host}
      style={{ minHeight, maxHeight }}
      className={clsx('overflow-auto rounded-md border border-line bg-surface [&_.cm-editor]:h-full', readOnly && 'opacity-95', className)}
    />
  );
}
