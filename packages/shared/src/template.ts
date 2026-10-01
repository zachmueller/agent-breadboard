/**
 * Minimal Handlebars-subset prompt template engine ([03] §10.2):
 *   {{path.to.value}}          — insert (strings raw; objects/arrays as JSON)
 *   {{json path}}              — insert as pretty JSON
 *   {{#if path}}…{{else}}…{{/if}}
 *   {{#each path}}…{{/each}}   — `this`, `this.x`, `@index`, `@first`, `@last`
 *   {{! comment }}
 * No arbitrary expressions — logic belongs in code steps. Unknown paths resolve to empty.
 * `{{knowledge:UID}}` tokens are left untouched for the subagent resolver ([05] §2.1).
 */

export type TemplateContext = Record<string, unknown>;

type Node =
  | { kind: 'text'; value: string }
  | { kind: 'insert'; path: string; json: boolean }
  | { kind: 'if'; path: string; then: Node[]; else: Node[] }
  | { kind: 'each'; path: string; body: Node[] };

const TOKEN_RE = /\{\{(.*?)\}\}/gs;

export class TemplateError extends Error {}

export function compileTemplate(src: string): (ctx: TemplateContext) => string {
  const ast = parse(src);
  return (ctx) => render(ast, [ctx]);
}

export function renderTemplate(src: string, ctx: TemplateContext): string {
  return compileTemplate(src)(ctx);
}

/** Resolve a dotted path (optionally `$`-prefixed) against a context stack. */
export function resolvePath(path: string, scopes: unknown[]): unknown {
  let p = path.trim();
  if (p.startsWith('$')) p = p.slice(1);
  if (p === 'this' || p === '.') return scopes[scopes.length - 1];
  const segs = p.split('.').filter(Boolean);
  if (segs[0] === 'this') segs.shift();
  // Search innermost scope first, then outward (so `this.x` inside each works, and `input.x` is still reachable).
  for (let i = scopes.length - 1; i >= 0; i--) {
    const v = walk(scopes[i], segs);
    if (v !== undefined) return v;
  }
  return undefined;
}

function walk(root: unknown, segs: string[]): unknown {
  let cur: any = root;
  for (const s of segs) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(s)) cur = cur[Number(s)];
    else if (typeof cur === 'object') cur = cur[s];
    else return undefined;
  }
  return cur;
}

function parse(src: string): Node[] {
  const tokens: Array<{ text?: string; tag?: string }> = [];
  let last = 0;
  for (const m of src.matchAll(TOKEN_RE)) {
    if (m.index! > last) tokens.push({ text: src.slice(last, m.index) });
    tokens.push({ tag: m[1]!.trim() });
    last = m.index! + m[0].length;
  }
  if (last < src.length) tokens.push({ text: src.slice(last) });

  let i = 0;
  function block(closers: string[]): { nodes: Node[]; closer: string | null } {
    const nodes: Node[] = [];
    while (i < tokens.length) {
      const t = tokens[i++]!;
      if (t.text !== undefined) {
        nodes.push({ kind: 'text', value: t.text });
        continue;
      }
      const tag = t.tag!;
      if (tag.startsWith('!')) continue; // comment
      if (tag.startsWith('knowledge:')) {
        nodes.push({ kind: 'text', value: `{{${tag}}}` });
        continue;
      }
      if (closers.includes(tag)) return { nodes, closer: tag };
      if (tag.startsWith('#if ')) {
        const path = tag.slice(4).trim();
        const thenB = block(['else', '/if']);
        let elseNodes: Node[] = [];
        if (thenB.closer === 'else') {
          const elseB = block(['/if']);
          if (elseB.closer !== '/if') throw new TemplateError('unclosed {{#if}}');
          elseNodes = elseB.nodes;
        } else if (thenB.closer !== '/if') throw new TemplateError('unclosed {{#if}}');
        nodes.push({ kind: 'if', path, then: thenB.nodes, else: elseNodes });
        continue;
      }
      if (tag.startsWith('#each ')) {
        const path = tag.slice(6).trim();
        const body = block(['/each']);
        if (body.closer !== '/each') throw new TemplateError('unclosed {{#each}}');
        nodes.push({ kind: 'each', path, body: body.nodes });
        continue;
      }
      if (tag.startsWith('#') || tag.startsWith('/')) throw new TemplateError(`unsupported block: {{${tag}}}`);
      if (tag.startsWith('json ')) {
        nodes.push({ kind: 'insert', path: tag.slice(5).trim(), json: true });
        continue;
      }
      nodes.push({ kind: 'insert', path: tag, json: false });
    }
    return { nodes, closer: null };
  }
  const top = block([]);
  return top.nodes;
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v === '' || v === 0 || v === false || v == null) return false;
  return true;
}

function stringify(v: unknown, json: boolean): string {
  if (v === undefined || v === null) return '';
  if (json) return JSON.stringify(v, null, 2);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v, null, 2);
}

function render(nodes: Node[], scopes: unknown[]): string {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.value;
        break;
      case 'insert':
        out += stringify(resolvePath(n.path, scopes), n.json);
        break;
      case 'if':
        out += render(truthy(resolvePath(n.path, scopes)) ? n.then : n.else, scopes);
        break;
      case 'each': {
        const v = resolvePath(n.path, scopes);
        const items = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [];
        items.forEach((item, idx) => {
          const meta = { '@index': idx, '@first': idx === 0, '@last': idx === items.length - 1 };
          out += render(n.body, [...scopes, meta, item]);
        });
        break;
      }
    }
  }
  return out;
}

/** Collect the referenced top-level roots (e.g. `input`, `steps.quality-check`) for static validation. */
export function templateReferences(src: string): string[] {
  const refs = new Set<string>();
  for (const m of src.matchAll(TOKEN_RE)) {
    let tag = m[1]!.trim();
    if (tag.startsWith('!') || tag.startsWith('/') || tag === 'else' || tag.startsWith('knowledge:')) continue;
    if (tag.startsWith('#if ')) tag = tag.slice(4);
    else if (tag.startsWith('#each ')) tag = tag.slice(6);
    else if (tag.startsWith('json ')) tag = tag.slice(5);
    tag = tag.trim();
    if (tag.startsWith('$')) tag = tag.slice(1);
    if (tag.startsWith('this') || tag.startsWith('@')) continue;
    refs.add(tag);
  }
  return [...refs];
}
