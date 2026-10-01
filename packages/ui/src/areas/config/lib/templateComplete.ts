/**
 * CodeMirror completion sources for prompt templates ([03] §3.1 Handlebars subset over
 * `{ input, steps, ambient }`) and `{{knowledge:UID}}` injections in subagent system prompts ([05] §2.1).
 */
import { EditorState, type Extension } from '@codemirror/state';
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import type { PathSuggestion } from './inputMapPaths';

/**
 * Locate an open `{{ … ` mustache ending at the cursor. Returns the offset (within `before`) where
 * the path being typed starts, plus the typed prefix; null when the cursor isn't inside one.
 */
export function openMustache(before: string): { start: number; prefix: string; knowledge: boolean } | null {
  const open = before.lastIndexOf('{{');
  if (open < 0) return null;
  const inner = before.slice(open + 2);
  if (inner.includes('}}') || inner.includes('\n')) return null;
  const k = /^\s*knowledge:([A-Za-z0-9]*)$/.exec(inner);
  if (k) return { start: before.length - k[1]!.length, prefix: k[1]!, knowledge: true };
  if (/^\s*!/.test(inner)) return null;
  const m = /^\s*(?:(?:#if|#each|json)\s+)?([A-Za-z0-9_.@-]*)$/.exec(inner);
  if (!m) return null;
  return { start: before.length - m[1]!.length, prefix: m[1]!, knowledge: false };
}

/** `$input.x` → `input.x` (template scope has no `$`). */
export const templatePath = (p: string) => (p.startsWith('$') ? p.slice(1) : p);

export function templateOptions(paths: PathSuggestion[], prefix: string): Completion[] {
  const seen = new Set<string>();
  const out: Completion[] = [];
  const keywords: Completion[] = [
    { label: '#if', type: 'keyword', detail: 'conditional block', apply: '#if ' },
    { label: '#each', type: 'keyword', detail: 'loop block', apply: '#each ' },
    { label: 'json', type: 'keyword', detail: 'pretty JSON insert', apply: 'json ' },
    { label: 'knowledge:', type: 'keyword', detail: 'inject a Knowledge Note', apply: 'knowledge:' },
  ];
  if (!prefix) out.push(...keywords);
  for (const s of paths) {
    const label = templatePath(s.path);
    if (seen.has(label) || (prefix && !label.startsWith(prefix))) continue;
    seen.add(label);
    out.push({ label, detail: s.detail, type: 'variable' });
  }
  return out;
}

/** Interpolation-path completion for circuit prompt templates. */
export function templateCompletion(getPaths: () => PathSuggestion[]): Extension {
  const source = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const at = openMustache(line.text.slice(0, ctx.pos - line.from));
    if (!at || at.knowledge) return null;
    const options = templateOptions(getPaths(), at.prefix);
    return options.length ? { from: line.from + at.start, options, validFor: /^[A-Za-z0-9_.@-]*$/ } : null;
  };
  return EditorState.languageData.of(() => [{ autocomplete: source }]);
}

/** `{{knowledge:` → Knowledge Note search; inserts the UID and closes the mustache. */
export function knowledgeCompletion(search: (q: string) => Promise<Array<{ uid: string; title: string; domains?: string[] }>>): Extension {
  const source = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const at = openMustache(before);
    if (!at?.knowledge) return null;
    const hits = await search(at.prefix || '*').catch(() => []);
    if (ctx.aborted) return null;
    const after = line.text.slice(ctx.pos - line.from);
    const closes = after.startsWith('}}');
    return {
      from: line.from + at.start,
      filter: false,
      options: hits.map((h) => ({
        label: h.uid,
        displayLabel: h.title || h.uid,
        detail: h.uid + (h.domains?.length ? ` · ${h.domains.join(', ')}` : ''),
        type: 'text',
        apply: closes ? h.uid : `${h.uid}}}`,
      })),
    };
  };
  return EditorState.languageData.of(() => [{ autocomplete: source }]);
}

/** All `{{knowledge:UID}}` tokens in a text. */
export function knowledgeRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*knowledge:([0-9A-Za-z]{20})\s*\}\}/g)) out.add(m[1]!.toUpperCase());
  return [...out];
}
