/**
 * Custom CodeMirror 6 ↔ Yjs binding over a block-structured body ([07] §2, §12.4; [10] §3).
 *
 * The editor shows ONE Markdown document, `blocks.map(text).join('\n\n')`, while the CRDT keeps a
 * `Y.Array` of `{id, text: Y.Text}` blocks. Local edits are mapped back onto per-block Y.Texts
 * (splitting/merging blocks at `\n\n` boundaries, minting ids only for true inserts); remote edits
 * are mapped forward into editor changes tagged `fromYjs` so they don't echo.
 *
 * Invariant (checked after every sync, repaired if ever violated): `cmDoc === blocksToMarkdown(blocks)`.
 */
import * as Y from 'yjs';
import { Annotation, type ChangeSet, Compartment, StateEffect, Transaction, type ChangeSpec, type EditorState, type Text, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { BLOCK_SEPARATOR, blockId, blockString, blockYText, detectTextKey, makeBlock, mintBlockId, type BlockMap } from './ydocSchema';
import { docLength, locate, planChange, simpleDiff, spansFor, type ChangePlan } from './blockModel';

/** Marks editor transactions that mirror Yjs changes (never written back). */
export const fromYjs = Annotation.define<boolean>();

/** Transaction origin for local user edits. */
export interface LocalOrigin {
  kind: 'user';
  local: true;
}

export interface BlockRange {
  id: string;
  from: number;
  to: number;
}

export interface BlockBinding {
  destroy(): void;
  /** Current block ranges in editor coordinates (aligned with the editor document). */
  blockRanges(): BlockRange[];
  /** Encode an editor offset as a Yjs relative position (JSON) for awareness cursors. */
  relativeFromPos(pos: number, assoc?: number): unknown;
  /** Decode a relative position (JSON) to an editor offset, or null if its block is gone. */
  posFromRelative(rel: unknown): number | null;
  /** The origin object used for local transactions. */
  readonly origin: LocalOrigin;
}

export interface BindingOptions {
  /** Id minting for human-inserted blocks (default: random 10-char `0-9a-zA-Z_-`). */
  mintId?: () => string;
  /** Transaction origin for local edits (default `{kind:'user', local:true}`). */
  origin?: LocalOrigin;
  /** Full-string invariant check after every remote sync (default: length check only). */
  paranoid?: boolean;
  /** Called if the invariant was found broken and the editor was resynced from Yjs. */
  onResync?: (reason: string) => void;
}

/** Minimal editor surface the core needs — an EditorView, or a test double around EditorState. */
export interface BindingHost {
  readonly state: EditorState;
  dispatch(spec: TransactionSpec): void;
}

export interface BindingCore {
  /** Apply a local (non-`fromYjs`) editor change set to the CRDT. `startDoc` is the doc it applies to. */
  applyLocal(changes: ChangeSet, startDoc: Text): void;
  blockRanges(): BlockRange[];
  relativeFromPos(pos: number, assoc?: number): unknown;
  posFromRelative(rel: unknown): number | null;
  destroy(): void;
  readonly origin: LocalOrigin;
}

interface ShadowBlock {
  map: BlockMap;
  len: number;
}

/**
 * Binding core, independent of the view layer. On creation, the host document is replaced with the
 * blocks' Markdown (a `fromYjs` transaction, kept out of undo history).
 */
export function createBindingCore(blocks: Y.Array<BlockMap>, host: BindingHost, opts: BindingOptions = {}): BindingCore {
  const doc = blocks.doc;
  if (!doc) throw new Error('blocks must belong to a Y.Doc');
  const mint = opts.mintId ?? mintBlockId;
  const origin: LocalOrigin = opts.origin ?? { kind: 'user', local: true };
  let shadow: ShadowBlock[] = [];
  let destroyed = false;

  const refreshShadow = () => {
    shadow = blocks.toArray().map((map) => ({ map, len: blockYText(map)?.length ?? 0 }));
  };
  const lengths = () => shadow.map((s) => s.len);
  const markdown = () => blocks.toArray().map(blockString).join(BLOCK_SEPARATOR);

  const dispatchFromY = (changes: ChangeSpec) => {
    host.dispatch({ changes, annotations: [fromYjs.of(true), Transaction.addToHistory.of(false)] });
  };

  /** Replace the editor content with the CRDT content (minimal single-range diff). */
  const resync = (reason?: string) => {
    const want = markdown();
    const have = host.state.doc.toString();
    const d = simpleDiff(have, want);
    if (d) dispatchFromY({ from: d.offset, to: d.offset + d.deleteCount, insert: d.insert });
    refreshShadow();
    if (reason) opts.onResync?.(reason);
  };

  const verify = () => {
    const n = docLength(lengths());
    if (n !== host.state.doc.length) return resync(`length mismatch (doc ${host.state.doc.length}, blocks ${n})`);
    if (opts.paranoid && host.state.doc.toString() !== markdown()) resync('content mismatch');
  };

  // ------------------------------------------------------------------ Y → CM
  const observer = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>, txn: Y.Transaction) => {
    if (destroyed) return;
    if (txn.origin === origin) {
      refreshShadow();
      return;
    }
    let changes: ChangeSpec[];
    try {
      changes = remoteChanges(events);
    } catch (e) {
      resync(`remote mapping failed: ${(e as Error).message}`);
      return;
    }
    if (changes.length) dispatchFromY(changes);
    refreshShadow();
    verify();
  };

  const remoteChanges = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>): ChangeSpec[] => {
    const oldSpans = spansFor(lengths());
    const oldIndex = new Map<BlockMap, number>();
    shadow.forEach((s, i) => oldIndex.set(s.map, i));
    const textDeltas = new Map<BlockMap, Array<{ insert?: unknown; retain?: number; delete?: number }>>();
    const replaced = new Set<BlockMap>();
    let arrayEvent: Y.YEvent<Y.AbstractType<unknown>> | null = null;
    for (const ev of events) {
      if (ev.target === blocks) arrayEvent = ev;
      else if (ev.target instanceof Y.Text && ev.target.parent instanceof Y.Map && oldIndex.has(ev.target.parent as BlockMap)) {
        const parent = ev.target.parent as BlockMap;
        if (blockYText(parent) === ev.target) textDeltas.set(parent, ev.delta as Array<{ insert?: unknown; retain?: number; delete?: number }>);
      } else if (ev.target instanceof Y.Map && oldIndex.has(ev.target as BlockMap)) {
        const keys = (ev as Y.YMapEvent<unknown>).keysChanged;
        if (keys.has('text') || keys.has('ytext')) replaced.add(ev.target as BlockMap);
      }
    }

    // New block sequence: kept old blocks (by old index) and freshly inserted maps.
    type Item = { kept: number } | { added: BlockMap };
    const seq: Item[] = [];
    if (arrayEvent) {
      let oi = 0;
      for (const op of arrayEvent.changes.delta) {
        if (op.retain) {
          for (let k = 0; k < op.retain; k++) seq.push({ kept: oi++ });
        } else if (op.delete) {
          oi += op.delete;
        } else if (op.insert) {
          for (const m of op.insert as BlockMap[]) seq.push({ added: m });
        }
      }
      while (oi < shadow.length) seq.push({ kept: oi++ });
    } else {
      for (let i = 0; i < shadow.length; i++) seq.push({ kept: i });
    }

    const out: ChangeSpec[] = [];
    const cmDoc = host.state.doc;
    const docLen = cmDoc.length;
    const pushGap = (oldFrom: number, oldTo: number, newText: string) => {
      const oldText = cmDoc.sliceString(oldFrom, oldTo);
      const d = simpleDiff(oldText, newText);
      if (d) out.push({ from: oldFrom + d.offset, to: oldFrom + d.offset + d.deleteCount, insert: d.insert });
    };

    const keptIdx: number[] = [];
    seq.forEach((it, i) => {
      if ('kept' in it) keptIdx.push(i);
    });
    const addedText = (from: number, to: number) =>
      seq
        .slice(from, to)
        .map((it) => ('added' in it ? blockString(it.added) : ''))
        .join(BLOCK_SEPARATOR);

    if (!keptIdx.length) {
      pushGap(0, docLen, addedText(0, seq.length));
      return out;
    }
    // Leading gap.
    {
      const k = (seq[keptIdx[0]] as { kept: number }).kept;
      const lead = addedText(0, keptIdx[0]);
      pushGap(0, oldSpans[k].from, keptIdx[0] > 0 ? lead + BLOCK_SEPARATOR : '');
    }
    for (let n = 0; n < keptIdx.length; n++) {
      const si = keptIdx[n];
      const k = (seq[si] as { kept: number }).kept;
      const span = oldSpans[k];
      const map = shadow[k].map;
      // Block body.
      if (replaced.has(map)) {
        pushGap(span.from, span.to, blockString(map));
      } else {
        const delta = textDeltas.get(map);
        if (delta) {
          let p = span.from;
          for (const op of delta) {
            if (op.retain) p += op.retain;
            else if (op.delete) {
              out.push({ from: p, to: p + op.delete });
              p += op.delete;
            } else if (typeof op.insert === 'string') out.push({ from: p, insert: op.insert });
          }
        }
      }
      // Gap after this kept block.
      const nextSi = n + 1 < keptIdx.length ? keptIdx[n + 1] : seq.length;
      const between = addedText(si + 1, nextSi);
      const hasAdded = nextSi > si + 1;
      if (n + 1 < keptIdx.length) {
        const k2 = (seq[keptIdx[n + 1]] as { kept: number }).kept;
        pushGap(span.to, oldSpans[k2].from, hasAdded ? BLOCK_SEPARATOR + between + BLOCK_SEPARATOR : BLOCK_SEPARATOR);
      } else {
        pushGap(span.to, docLen, hasAdded ? BLOCK_SEPARATOR + between : '');
      }
    }
    return out;
  };

  // ------------------------------------------------------------------ CM → Y
  const applyPlanToY = (plan: ChangePlan, textKey: string) => {
    const keep = new Set(plan.blocks.filter((b) => b.reused).map((b) => b.id));
    for (let i = plan.start + plan.deleteCount - 1; i >= plan.start; i--) {
      if (!keep.has(blockId(blocks.get(i)))) blocks.delete(i, 1);
    }
    let idx = plan.start;
    for (const pb of plan.blocks) {
      if (pb.reused) {
        const map = blocks.get(idx);
        const yt = map && blockYText(map);
        if (!map || blockId(map) !== pb.id || !yt) throw new Error(`block order mismatch at ${idx}`);
        const d = pb.edit ?? simpleDiff(yt.toString(), pb.text);
        if (d) {
          if (d.deleteCount) yt.delete(d.offset, d.deleteCount);
          if (d.insert) yt.insert(d.offset, d.insert);
        }
      } else {
        blocks.insert(idx, [makeBlock(pb.id, pb.text, textKey)]);
      }
      idx++;
    }
  };

  const applyLocal = (changes: ChangeSet, startDoc: Text) => {
    if (destroyed || changes.empty) return;
    if (docLength(lengths()) !== startDoc.length) {
      // Should never happen; Yjs is the source of truth — resync rather than corrupt.
      resync('local change against a stale mirror');
      return;
    }
    const list: Array<{ from: number; to: number; insert: string }> = [];
    changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => list.push({ from: fromA, to: toA, insert: inserted.toString() }));
    const textKey = detectTextKey(blocks);
    try {
      doc.transact(() => {
        // Descending order: each change leaves offsets before it intact.
        for (let i = list.length - 1; i >= 0; i--) {
          const c = list[i];
          const current = blocks.toArray().map((m) => ({ id: blockId(m), text: blockString(m) }));
          const plan = planChange(current, c.from, c.to, c.insert, mint);
          if (!plan.deleteCount && !plan.blocks.length) continue;
          applyPlanToY(plan, textKey);
        }
      }, origin);
    } catch (e) {
      resync(`local mapping failed: ${(e as Error).message}`);
      return;
    }
    refreshShadow();
  };

  // ------------------------------------------------------------- positions
  const blockRanges = (): BlockRange[] => {
    const spans = spansFor(lengths());
    return shadow.map((s, i) => ({ id: blockId(s.map), from: spans[i].from, to: spans[i].to }));
  };

  const relativeFromPos = (pos: number, assoc = 0): unknown => {
    if (!shadow.length) return null;
    const loc = locate(lengths(), Math.max(0, Math.min(pos, host.state.doc.length)));
    const yt = blockYText(shadow[loc.block].map);
    if (!yt) return null;
    return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(yt, loc.offset, assoc));
  };

  const posFromRelative = (rel: unknown): number | null => {
    if (!rel) return null;
    try {
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel), doc);
      if (!abs) return null;
      const spans = spansFor(lengths());
      for (let i = 0; i < shadow.length; i++) {
        if (blockYText(shadow[i].map) === abs.type) return Math.min(spans[i].from + abs.index, spans[i].to);
      }
    } catch {
      /* malformed */
    }
    return null;
  };

  // ------------------------------------------------------------------ init
  refreshShadow();
  resync();
  blocks.observeDeep(observer);

  return {
    applyLocal,
    blockRanges,
    relativeFromPos,
    posFromRelative,
    origin,
    destroy() {
      destroyed = true;
      blocks.unobserveDeep(observer);
    },
  };
}

/**
 * Bind an EditorView to a block array. The view's document is replaced with the blocks' Markdown.
 * Installs an update listener (in its own compartment, removed on destroy).
 */
export function createBlockBinding(blocks: Y.Array<BlockMap>, view: EditorView, opts: BindingOptions = {}): BlockBinding {
  const core = createBindingCore(blocks, view, opts);
  const compartment = new Compartment();
  const listener = EditorView.updateListener.of((update) => {
    for (const tr of update.transactions) {
      if (!tr.docChanged || tr.annotation(fromYjs)) continue;
      core.applyLocal(tr.changes, tr.startState.doc);
    }
  });
  view.dispatch({ effects: StateEffect.appendConfig.of(compartment.of(listener)) });
  return {
    blockRanges: core.blockRanges,
    relativeFromPos: core.relativeFromPos,
    posFromRelative: core.posFromRelative,
    origin: core.origin,
    destroy() {
      core.destroy();
      try {
        view.dispatch({ effects: compartment.reconfigure([]) });
      } catch {
        /* view already destroyed */
      }
    },
  };
}
