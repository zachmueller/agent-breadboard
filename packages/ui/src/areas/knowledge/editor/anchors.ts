/**
 * Client-side comment re-anchoring ([09] §4, [07] §5.4): match an anchor's quote (+ surrounding
 * context) against the current head. Confident matches render in place; anything else is
 * "possibly stale". Never guesses on ambiguity.
 */

export const ANCHOR_CONTEXT_CHARS = 40;

export type AnchorMatch =
  | { status: 'resolved'; from: number; to: number; exact: boolean }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: number }
  | { status: 'none' };

export interface AnchorLike {
  quote?: string | null;
  context?: string | null;
}

function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

function commonSuffixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** Split a context string (±N chars around the quote, quote included) into before/after parts (first occurrence). */
export function splitContext(context: string, quote: string): { before: string; after: string } | null {
  return contextSplits(context, quote)[0] ?? null;
}

/** Every way the quote can sit inside the context (the window may contain the quote more than once). */
function contextSplits(context: string, quote: string): Array<{ before: string; after: string }> {
  const all = allIndexes(context, quote).map((i) => ({ before: context.slice(0, i), after: context.slice(i + quote.length) }));
  // Contexts are cut at ±ANCHOR_CONTEXT_CHARS, so a split with a longer side can't be the anchored one.
  const plausible = all.filter((c) => c.before.length <= ANCHOR_CONTEXT_CHARS && c.after.length <= ANCHOR_CONTEXT_CHARS);
  return plausible.length ? plausible : all;
}

/** Build the context string for a new anchor: up to ±40 chars around [from, to) of `doc`. */
export function buildContext(doc: string, from: number, to: number, chars = ANCHOR_CONTEXT_CHARS): string {
  return doc.slice(Math.max(0, from - chars), Math.min(doc.length, to + chars));
}

/**
 * Tiered matching: unique exact quote → resolved; several → disambiguate by context similarity
 * (unique best with a positive margin) → resolved, else ambiguous; whitespace-normalised quote as a
 * fuzzy fallback (unique only).
 */
export function matchAnchor(doc: string, anchor: AnchorLike | null | undefined): AnchorMatch {
  const quote = anchor?.quote ?? '';
  if (!quote.trim()) return { status: 'none' };
  const hits = allIndexes(doc, quote);
  if (hits.length === 1) return { status: 'resolved', from: hits[0], to: hits[0] + quote.length, exact: true };
  if (hits.length > 1) {
    const splits = anchor?.context ? contextSplits(anchor.context, quote) : [];
    if (!splits.length) return { status: 'ambiguous', candidates: hits.length };
    const scored = hits.map((h) => ({
      h,
      score: Math.max(
        ...splits.map(
          (ctx) =>
            commonSuffixLen(doc.slice(Math.max(0, h - ctx.before.length), h), ctx.before) +
            commonPrefixLen(doc.slice(h + quote.length, h + quote.length + ctx.after.length), ctx.after),
        ),
      ),
    }));
    scored.sort((a, b) => b.score - a.score);
    if (scored[0].score > 0 && scored[0].score > scored[1].score) return { status: 'resolved', from: scored[0].h, to: scored[0].h + quote.length, exact: true };
    return { status: 'ambiguous', candidates: hits.length };
  }
  // Fuzzy tier: collapse whitespace on both sides and map back to doc offsets.
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const nq = norm(quote);
  if (!nq) return { status: 'not_found' };
  const map: number[] = [];
  let nd = '';
  let prevSpace = false;
  for (let i = 0; i < doc.length; i++) {
    const ws = /\s/.test(doc[i]);
    if (ws) {
      if (!prevSpace) {
        nd += ' ';
        map.push(i);
      }
      prevSpace = true;
    } else {
      nd += doc[i];
      map.push(i);
      prevSpace = false;
    }
  }
  const fh = allIndexes(nd, nq);
  if (fh.length === 1) {
    const from = map[fh[0]];
    const lastIdx = fh[0] + nq.length - 1;
    const to = (map[lastIdx] ?? doc.length - 1) + 1;
    return { status: 'resolved', from, to, exact: false };
  }
  if (fh.length > 1) return { status: 'ambiguous', candidates: fh.length };
  return { status: 'not_found' };
}
