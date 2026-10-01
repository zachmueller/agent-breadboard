/**
 * CodeMirror extensions for the shared Knowledge editor ([10] §3): presence cursors, block
 * attribution (highlight + gutter + hover), `[[UID|title]]` wiki-links (autocomplete, hover card,
 * mod-click), the client-side wipeout guard, comment-anchor highlights, and the read-only compartment.
 *
 * Everything here is view-layer only; the CRDT mapping lives in `yBlockBinding.ts`.
 */
import { Annotation, type Compartment, EditorSelection, EditorState, RangeSet, StateEffect, StateField, Transaction, type ChangeSet, type Extension, type Range, type Text } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, MatchDecorator, ViewPlugin, WidgetType, gutter, hoverTooltip, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { actorLabel, type Actor } from '@breadboard/shared';
import { fromYjs } from './yBlockBinding';

// ======================================================================= presence ===

/** The subset of y-protocols' `Awareness` the editor uses (typed structurally). */
export interface AwarenessLike {
  readonly clientID: number;
  getStates(): Map<number, Record<string, unknown>>;
  setLocalStateField(field: string, value: unknown): void;
  on(event: 'change', cb: (...args: any[]) => void): void;
  off(event: 'change', cb: (...args: any[]) => void): void;
}

export interface PresenceUser {
  name: string;
  color: string;
}

/** Encodes editor offsets as CRDT-relative positions so remote cursors survive concurrent edits. */
export interface PositionCodec {
  relativeFromPos(pos: number, assoc?: number): unknown;
  posFromRelative(rel: unknown): number | null;
}

export const PRESENCE_COLORS = ['#2a78d6', '#d0503b', '#0c8a5a', '#8a4fd6', '#c27c0e', '#d03b8a', '#2a9bb0', '#5f7a1f'];

/** Stable colour for a user handle. */
export function presenceColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]!;
}

export interface RemotePeer {
  clientId: number;
  user: PresenceUser;
  anchor: number | null;
  head: number | null;
}

/** Remote peers (excluding the local client) with decoded cursor positions. */
export function remotePeers(awareness: AwarenessLike, codec: PositionCodec | null, docLength: number): RemotePeer[] {
  const out: RemotePeer[] = [];
  const clamp = (n: number | null) => (n === null ? null : Math.max(0, Math.min(docLength, n)));
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return;
    const user = state.user as Partial<PresenceUser> | undefined;
    if (!user || typeof user.name !== 'string') return;
    const cursor = state.cursor as { anchor?: unknown; head?: unknown } | null | undefined;
    let anchor: number | null = null;
    let head: number | null = null;
    if (cursor && codec) {
      anchor = clamp(codec.posFromRelative(cursor.anchor));
      head = clamp(codec.posFromRelative(cursor.head));
    }
    out.push({ clientId, user: { name: user.name, color: typeof user.color === 'string' ? user.color : presenceColor(user.name) }, anchor, head });
  });
  return out;
}

const presenceRefresh = StateEffect.define<null>();

class CaretWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly color: string,
  ) {
    super();
  }
  override eq(o: CaretWidget): boolean {
    return o.name === this.name && o.color === this.color;
  }
  toDOM(): HTMLElement {
    const caret = document.createElement('span');
    caret.className = 'bb-remote-caret';
    caret.style.borderLeftColor = this.color;
    caret.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'bb-remote-caret-label';
    label.style.backgroundColor = this.color;
    label.textContent = this.name;
    caret.appendChild(label);
    return caret;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Publishes the local selection into `awareness.cursor` (as relative positions) and renders remote
 * selections + labelled carets. `codec` is a getter because the binding is created after the view.
 */
export function presenceExtension(awareness: AwarenessLike, codec: () => PositionCodec | null): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private timer: ReturnType<typeof setTimeout> | null = null;
      private destroyed = false;
      private readonly onChange = (change: { added?: number[]; updated?: number[]; removed?: number[] } | undefined) => {
        const ids = [...(change?.added ?? []), ...(change?.updated ?? []), ...(change?.removed ?? [])];
        if (ids.length && ids.every((id) => id === awareness.clientID)) return;
        if (this.timer) return;
        this.timer = setTimeout(() => {
          this.timer = null;
          if (!this.destroyed) this.view.dispatch({ effects: presenceRefresh.of(null) });
        }, 0);
      };
      constructor(readonly view: EditorView) {
        awareness.on('change', this.onChange);
        this.decorations = this.build();
        this.publish();
      }
      update(u: ViewUpdate) {
        if (u.selectionSet || u.docChanged || (u.focusChanged && u.view.hasFocus)) this.publish();
        if (u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(presenceRefresh)))) this.decorations = this.build();
      }
      publish() {
        const c = codec();
        if (!c) return;
        const sel = this.view.state.selection.main;
        try {
          awareness.setLocalStateField('cursor', { anchor: c.relativeFromPos(sel.anchor), head: c.relativeFromPos(sel.head) });
        } catch {
          /* awareness torn down */
        }
      }
      build(): DecorationSet {
        const ranges: Range<Decoration>[] = [];
        for (const peer of remotePeers(awareness, codec(), this.view.state.doc.length)) {
          if (peer.head === null) continue;
          const anchor = peer.anchor ?? peer.head;
          const from = Math.min(anchor, peer.head);
          const to = Math.max(anchor, peer.head);
          if (from < to) {
            ranges.push(Decoration.mark({ class: 'bb-remote-sel', attributes: { style: `background-color: color-mix(in srgb, ${peer.user.color} 22%, transparent)` } }).range(from, to));
          }
          ranges.push(Decoration.widget({ widget: new CaretWidget(peer.user.name, peer.user.color), side: 1 }).range(peer.head));
        }
        return Decoration.set(ranges, true);
      }
      destroy() {
        this.destroyed = true;
        if (this.timer) clearTimeout(this.timer);
        awareness.off('change', this.onChange);
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [plugin, presenceTheme];
}

const presenceTheme = EditorView.baseTheme({
  '.bb-remote-caret': { position: 'relative', borderLeft: '2px solid', marginLeft: '-1px', marginRight: '-1px', pointerEvents: 'none' },
  '.bb-remote-caret-label': {
    position: 'absolute',
    top: '-1.35em',
    left: '-2px',
    fontSize: '10px',
    lineHeight: '1.3',
    fontFamily: 'var(--font-sans, system-ui)',
    color: '#fff',
    padding: '0 4px',
    borderRadius: '3px 3px 3px 0',
    whiteSpace: 'nowrap',
    opacity: '0.92',
    zIndex: '5',
  },
});

// ==================================================================== attribution ===

export interface AttributedRange {
  id: string;
  from: number;
  to: number;
  actor: Actor;
  at: string | null;
}

export function isAiActor(a: Actor | null | undefined): boolean {
  return !!a && (a.kind === 'subagent' || a.kind === 'code-step');
}

/** Toggle the attribution layer on/off. */
export const setAttributionVisible = StateEffect.define<boolean>();
/** Ask the attribution layer to re-read its source (dispatch when the attribution map changes). */
export const attributionRefresh = StateEffect.define<null>();

export const attributionVisible = StateField.define<boolean>({
  create: () => true,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setAttributionVisible)) v = e.value;
    return v;
  },
});

class AttrMarker extends GutterMarker {
  constructor(
    readonly first: boolean,
    readonly title: string,
  ) {
    super();
  }
  override eq(o: AttrMarker): boolean {
    return o.first === this.first && o.title === this.title;
  }
  override toDOM(): Node {
    const d = document.createElement('div');
    d.className = this.first ? 'bb-attr-mark bb-attr-mark-first' : 'bb-attr-mark';
    d.title = this.title;
    return d;
  }
}

class SpacerMarker extends GutterMarker {
  override toDOM(): Node {
    const d = document.createElement('div');
    d.className = 'bb-attr-mark-spacer';
    return d;
  }
}

export function formatAttribution(r: Pick<AttributedRange, 'actor' | 'at'>): string {
  const when = r.at ? new Date(r.at) : null;
  const t = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : 'unknown time';
  return `Edited by ${actorLabel(r.actor)} · ${t}`;
}

/**
 * AI-edit attribution layer ([07] §5.3): a soft background + gutter bar on blocks last written by a
 * subagent or code step, and a hover card with the actor and time. `source` returns the current
 * attributed block ranges (editor coordinates).
 */
export function attributionExtension(source: () => AttributedRange[]): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      markers: RangeSet<GutterMarker> = RangeSet.empty;
      ranges: AttributedRange[] = [];
      private timer: ReturnType<typeof setTimeout> | null = null;
      private destroyed = false;
      constructor(readonly view: EditorView) {
        this.rebuild();
      }
      update(u: ViewUpdate) {
        const refresh = u.transactions.some((tr) => tr.effects.some((e) => e.is(attributionRefresh) || e.is(setAttributionVisible)));
        if (refresh) return this.rebuild();
        if (u.docChanged) {
          // Block ranges from the binding lag one update behind local edits: map now, re-read shortly.
          this.decorations = this.decorations.map(u.changes);
          this.markers = this.markers.map(u.changes);
          this.ranges = this.ranges.map((r) => ({ ...r, from: u.changes.mapPos(r.from, 1), to: u.changes.mapPos(r.to, -1) }));
          if (!this.timer) {
            this.timer = setTimeout(() => {
              this.timer = null;
              if (!this.destroyed) this.view.dispatch({ effects: attributionRefresh.of(null) });
            }, 60);
          }
        }
      }
      rebuild() {
        const state = this.view.state;
        if (!state.field(attributionVisible, false)) {
          this.ranges = [];
          this.decorations = Decoration.none;
          this.markers = RangeSet.empty;
          return;
        }
        const len = state.doc.length;
        this.ranges = source()
          .filter((r) => isAiActor(r.actor))
          .map((r) => ({ ...r, from: Math.max(0, Math.min(len, r.from)), to: Math.max(0, Math.min(len, r.to)) }))
          .filter((r) => r.to >= r.from);
        const lines: Range<Decoration>[] = [];
        const marks: Range<GutterMarker>[] = [];
        const seen = new Set<number>();
        for (const r of this.ranges) {
          const title = formatAttribution(r);
          let line = state.doc.lineAt(r.from);
          const last = state.doc.lineAt(r.to).number;
          let first = true;
          for (;;) {
            if (!seen.has(line.from)) {
              seen.add(line.from);
              lines.push(Decoration.line({ class: 'bb-attr-ai', attributes: { 'data-attr-block': r.id } }).range(line.from));
              marks.push(new AttrMarker(first, title).range(line.from));
            }
            first = false;
            if (line.number >= last) break;
            line = state.doc.line(line.number + 1);
          }
        }
        this.decorations = Decoration.set(lines, true);
        this.markers = RangeSet.of(marks, true);
      }
      destroy() {
        this.destroyed = true;
        if (this.timer) clearTimeout(this.timer);
      }
    },
    { decorations: (v) => v.decorations },
  );

  const hover = hoverTooltip(
    (view, pos) => {
      const p = view.plugin(plugin);
      const r = p?.ranges.find((x) => pos >= x.from && pos <= x.to);
      if (!r) return null;
      return {
        pos: Math.max(r.from, view.state.doc.lineAt(pos).from),
        above: true,
        create: () => {
          const dom = document.createElement('div');
          dom.className = 'bb-attr-tooltip';
          dom.textContent = formatAttribution(r);
          return { dom };
        },
      };
    },
    { hoverTime: 450 },
  );

  return [
    attributionVisible,
    plugin,
    gutter({
      class: 'bb-attr-gutter',
      markers: (view) => view.plugin(plugin)?.markers ?? RangeSet.empty,
      initialSpacer: () => new SpacerMarker(),
    }),
    hover,
    attributionTheme,
  ];
}

const attributionTheme = EditorView.baseTheme({
  '.bb-attr-ai': { backgroundColor: 'color-mix(in srgb, var(--bb-info, #4a3aa7) 7%, transparent)' },
  '.bb-attr-gutter': { width: '6px', minWidth: '6px' },
  '.bb-attr-gutter .cm-gutterElement': { padding: '0 !important' },
  '.bb-attr-mark': { width: '3px', height: '100%', marginLeft: '1px', backgroundColor: 'var(--bb-info, #4a3aa7)', opacity: '0.65' },
  '.bb-attr-mark-spacer': { width: '4px' },
  '.bb-attr-tooltip': { padding: '4px 8px', fontSize: '12px', fontFamily: 'var(--font-sans, system-ui)' },
});

// ===================================================================== wiki-links ===

const UID_CHARS = '0-9A-HJKMNP-TV-Z';
/** `[[UID]]` or `[[UID|title]]`. */
export const WIKI_LINK_SOURCE = `\\[\\[([${UID_CHARS}]{20})(?:\\|([^\\]\\n]*))?\\]\\]`;
/** Text before the cursor that opens a link completion: `[[` + a query without `]`, `|` or newline. */
export const WIKI_TRIGGER = /\[\[[^\]\n|]*$/;

export interface WikiLinkHit {
  from: number;
  to: number;
  uid: string;
  title: string | null;
}

/** All wiki-links in `text` (offsets relative to `text`). */
export function findWikiLinks(text: string, offset = 0): WikiLinkHit[] {
  const re = new RegExp(WIKI_LINK_SOURCE, 'g');
  const out: WikiLinkHit[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ from: offset + m.index, to: offset + m.index + m[0].length, uid: m[1]!, title: m[2] ?? null });
  return out;
}

/** The wiki-link covering `pos`, if any. */
export function wikiLinkAt(doc: Text, pos: number): WikiLinkHit | null {
  const line = doc.lineAt(pos);
  return findWikiLinks(line.text, line.from).find((l) => pos >= l.from && pos <= l.to) ?? null;
}

/** `[[UID|title]]` with a title safe for the link syntax. */
export function wikiLinkText(uid: string, title: string | null | undefined): string {
  const t = (title ?? '').replace(/[\]|\n\r]+/g, ' ').trim();
  return t ? `[[${uid}|${t}]]` : `[[${uid}]]`;
}

export interface LinkTarget {
  uid: string;
  title: string | null;
  type?: string | null;
  snippet?: string | null;
}

export interface NodeLookup {
  search(q: string): Promise<LinkTarget[]>;
  get(uid: string): Promise<LinkTarget | null>;
}

/** Autocomplete source for `[[`: searches knowledge notes and inserts `[[UID|title]]`, eating a trailing `]]`. */
export function wikiCompletionSource(lookup: NodeLookup) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const m = ctx.matchBefore(WIKI_TRIGGER);
    if (!m) return null;
    const q = m.text.slice(2);
    let items: LinkTarget[];
    try {
      items = await lookup.search(q);
    } catch {
      return null;
    }
    if (ctx.aborted) return null;
    return {
      from: m.from,
      filter: false,
      options: items.map((n, i) => ({
        label: n.title || n.uid,
        detail: n.uid,
        type: 'text',
        boost: -i,
        apply: (view: EditorView, _c: unknown, from: number, to: number) => {
          const end = view.state.sliceDoc(to, to + 2) === ']]' ? to + 2 : to;
          const text = wikiLinkText(n.uid, n.title);
          view.dispatch({ changes: { from, to: end, insert: text }, selection: EditorSelection.cursor(from + text.length), userEvent: 'input.complete' });
        },
      })),
    };
  };
}

const wikiMatcher = new MatchDecorator({
  regexp: new RegExp(WIKI_LINK_SOURCE, 'g'),
  decoration: (m) => Decoration.mark({ class: 'bb-wikilink', attributes: { 'data-uid': m[1]!, title: 'Cmd/Ctrl-click to open' } }),
});

/** Link styling, hover card (`/nodes/:uid`), and mod-click (or plain click when read-only) to open. */
export function wikiLinkExtension(opts: { lookup: NodeLookup; onOpen?: (uid: string) => void }): Extension {
  const deco = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = wikiMatcher.createDeco(view);
      }
      update(u: ViewUpdate) {
        this.decorations = wikiMatcher.updateDeco(u, this.decorations);
      }
    },
    { decorations: (v) => v.decorations },
  );

  const hover = hoverTooltip(async (view, pos) => {
    const hit = wikiLinkAt(view.state.doc, pos);
    if (!hit) return null;
    let target: LinkTarget | null = null;
    let failed = false;
    try {
      target = await opts.lookup.get(hit.uid);
    } catch {
      failed = true;
    }
    return {
      pos: hit.from,
      end: hit.to,
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'bb-wikilink-card';
        const title = document.createElement('div');
        title.className = 'bb-wikilink-card-title';
        title.textContent = target?.title || hit.title || hit.uid;
        dom.appendChild(title);
        const meta = document.createElement('div');
        meta.className = 'bb-wikilink-card-meta';
        meta.textContent = failed || !target ? `${hit.uid} · not found or not visible` : `${target.type ?? 'node'} · ${hit.uid}`;
        dom.appendChild(meta);
        if (target?.snippet) {
          const snip = document.createElement('div');
          snip.className = 'bb-wikilink-card-snippet';
          snip.textContent = target.snippet;
          dom.appendChild(snip);
        }
        return { dom };
      },
    };
  });

  const clicks = EditorView.domEventHandlers({
    mousedown(e, view) {
      const mod = e.metaKey || e.ctrlKey;
      if (!opts.onOpen || e.button !== 0 || (!mod && view.state.facet(EditorView.editable))) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos === null) return false;
      const hit = wikiLinkAt(view.state.doc, pos);
      if (!hit) return false;
      e.preventDefault();
      opts.onOpen(hit.uid);
      return true;
    },
  });

  return [deco, hover, clicks, wikiTheme];
}

const wikiTheme = EditorView.baseTheme({
  '.bb-wikilink': { color: 'var(--bb-accent-text, #1c5cab)', textDecoration: 'underline', textDecorationColor: 'color-mix(in srgb, var(--bb-accent, #2a78d6) 40%, transparent)', textUnderlineOffset: '2px', cursor: 'pointer' },
  '.bb-wikilink-card': { padding: '6px 10px', maxWidth: '22rem', fontFamily: 'var(--font-sans, system-ui)' },
  '.bb-wikilink-card-title': { fontWeight: '600', fontSize: '13px' },
  '.bb-wikilink-card-meta': { fontSize: '11px', opacity: '0.7', fontFamily: 'var(--font-mono, monospace)' },
  '.bb-wikilink-card-snippet': { fontSize: '12px', marginTop: '4px', opacity: '0.85', whiteSpace: 'pre-wrap', maxHeight: '6em', overflow: 'hidden' },
});

// ================================================================== wipeout guard ===

/** Marks a re-dispatch of an edit the user explicitly confirmed past the wipeout guard. */
export const wipeoutConfirmed = Annotation.define<boolean>();

export const WIPEOUT_FRACTION = 0.9;
/** Mirrors the server's `WIPEOUT_MIN_CHARS`: tiny notes are exempt. */
export const WIPEOUT_MIN_CHARS = 64;

export interface BlockedEdit {
  changes: ChangeSet;
  selection: EditorSelection | undefined;
  startDoc: Text;
  userEvent: string | undefined;
  deleted: number;
  total: number;
}

/** Characters removed (or replaced) by a change set. */
export function deletedChars(changes: ChangeSet): number {
  let n = 0;
  changes.iterChangedRanges((fromA, toA) => {
    n += toA - fromA;
  });
  return n;
}

export function isWipeout(total: number, deleted: number, fraction = WIPEOUT_FRACTION, minChars = WIPEOUT_MIN_CHARS): boolean {
  return total >= minChars && total > 0 && deleted / total > fraction;
}

/**
 * Drops local transactions that would delete more than `fraction` of the document and reports them
 * via `onBlocked`, so the UI can ask for confirmation and replay with `replayBlockedEdit`.
 */
export function wipeoutGuard(opts: { onBlocked: (edit: BlockedEdit) => void; fraction?: number; minChars?: number }): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(fromYjs) || tr.annotation(wipeoutConfirmed)) return tr;
    const total = tr.startState.doc.length;
    const deleted = deletedChars(tr.changes);
    if (!isWipeout(total, deleted, opts.fraction, opts.minChars)) return tr;
    opts.onBlocked({ changes: tr.changes, selection: tr.selection, startDoc: tr.startState.doc, userEvent: tr.annotation(Transaction.userEvent), deleted, total });
    return [];
  });
}

/** Re-apply a confirmed edit; false if the document moved on meanwhile. */
export function replayBlockedEdit(view: EditorView, edit: BlockedEdit): boolean {
  if (!view.state.doc.eq(edit.startDoc)) return false;
  view.dispatch({
    changes: edit.changes,
    selection: edit.selection,
    annotations: [wipeoutConfirmed.of(true), ...(edit.userEvent ? [Transaction.userEvent.of(edit.userEvent)] : [])],
    scrollIntoView: true,
  });
  return true;
}

// ============================================================== comment highlights ===

export interface CommentHighlight {
  id: string;
  from: number;
  to: number;
  active?: boolean;
}

export const setCommentHighlights = StateEffect.define<CommentHighlight[]>();

export const commentHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setCommentHighlights)) continue;
      const len = tr.state.doc.length;
      const ranges = e.value
        .map((h) => ({ ...h, from: Math.max(0, Math.min(len, h.from)), to: Math.max(0, Math.min(len, h.to)) }))
        .filter((h) => h.to > h.from)
        .map((h) => Decoration.mark({ class: h.active ? 'bb-comment-hl bb-comment-hl-active' : 'bb-comment-hl', attributes: { 'data-comment-id': h.id } }).range(h.from, h.to));
      deco = Decoration.set(ranges, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Anchored-comment highlights; clicking one reports its comment id. */
export function commentHighlights(onClick?: (id: string) => void): Extension {
  return [
    commentHighlightField,
    EditorView.domEventHandlers({
      click(e) {
        const el = (e.target as HTMLElement | null)?.closest?.('[data-comment-id]');
        const id = el?.getAttribute('data-comment-id');
        if (!id || !onClick) return false;
        onClick(id);
        return false;
      },
    }),
    EditorView.baseTheme({
      '.bb-comment-hl': { backgroundColor: 'color-mix(in srgb, var(--bb-warn, #fab219) 22%, transparent)', borderBottom: '2px solid color-mix(in srgb, var(--bb-warn, #fab219) 70%, transparent)', cursor: 'pointer' },
      '.bb-comment-hl-active': { backgroundColor: 'color-mix(in srgb, var(--bb-warn, #fab219) 45%, transparent)' },
    }),
  ];
}

// ====================================================================== read-only ===

export function readOnlyExtension(compartment: Compartment, readOnly: boolean): Extension {
  return compartment.of(readOnlyConfig(readOnly));
}

export function readOnlyConfig(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

// ========================================================================== theme ===

export const sharedEditorTheme = EditorView.theme({
  '&': { fontSize: '14px', backgroundColor: 'transparent', color: 'var(--bb-fg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-sans, system-ui)', lineHeight: '1.65', overflow: 'visible' },
  '.cm-content': { padding: '12px 0 48px', caretColor: 'var(--bb-fg)' },
  '.cm-line': { padding: '0 16px 0 8px' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--bb-fg)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--bb-accent) 22%, transparent) !important' },
  '.cm-tooltip': { backgroundColor: 'var(--bb-surface)', border: '1px solid var(--bb-line)', color: 'var(--bb-fg)', borderRadius: '6px', boxShadow: 'var(--bb-shadow)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--bb-accent-soft)', color: 'var(--bb-fg)' },
  '.cm-completionDetail': { fontFamily: 'var(--font-mono, monospace)', fontSize: '11px', opacity: '0.6', marginLeft: '0.75em' },
  '.cm-placeholder': { color: 'var(--bb-fg-subtle)' },
});
