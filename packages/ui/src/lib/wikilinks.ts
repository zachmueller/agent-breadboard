/**
 * `[[UID|title]]` → Markdown link transform for rendering ([01] §3.2, [10] §2).
 * Valid-UID targets become `[title](/n/UID)`; non-UID targets become a broken-link marker.
 * Fenced code blocks and inline code spans are left untouched.
 */
import { isUid, normalizeUid } from '@breadboard/shared';

export const BROKEN_LINK_HREF = '#bb-broken-link';
const LINK_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]/g;
const NODE_HREF_RE = /^\/n\/([0-9A-HJKMNP-TV-Z]{20})$/;

function escapeLinkText(s: string): string {
  return s.replace(/([\\[\]*_`])/g, '\\$1');
}

function transformSegment(text: string): string {
  return text.replace(LINK_RE, (_m, target: string, title: string | undefined) => {
    const t = target.trim();
    const uid = normalizeUid(t);
    const label = (title ?? '').trim() || (isUid(uid) ? uid : t);
    if (isUid(uid)) return `[${escapeLinkText(label)}](/n/${uid})`;
    return `[${escapeLinkText(label)}](${BROKEN_LINK_HREF})`;
  });
}

/** Transform wiki links outside code. */
export function transformWikiLinks(md: string): string {
  if (!md.includes('[[')) return md;
  const out: string[] = [];
  const lines = md.split('\n');
  let fence: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) out.push(transformInline(buf.join('\n')));
    buf = [];
  };
  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      flush();
      fence = m[1]!;
      out.push(line);
      continue;
    }
    buf.push(line);
  }
  flush();
  return out.join('\n');
}

/** Transform outside inline code spans (backtick runs). */
function transformInline(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const tick = text.indexOf('`', i);
    if (tick === -1) {
      result += transformSegment(text.slice(i));
      break;
    }
    result += transformSegment(text.slice(i, tick));
    let run = 1;
    while (text[tick + run] === '`') run++;
    const delim = '`'.repeat(run);
    const close = text.indexOf(delim, tick + run);
    if (close === -1) {
      result += text.slice(tick);
      break;
    }
    result += text.slice(tick, close + run);
    i = close + run;
  }
  return result;
}

/** If `href` is a transformed node link, return its UID. */
export function nodeUidFromHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = NODE_HREF_RE.exec(href);
  return m ? m[1]! : null;
}
