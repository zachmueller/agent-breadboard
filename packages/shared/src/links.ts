import { isUid, normalizeUid } from './uid.js';

/** Obsidian-style `[[UID|title]]` link ([01] §3.2). */
export interface WikiLink {
  uid: string;
  title: string | null;
  /** Character offset of the `[[` in the source text. */
  index: number;
  raw: string;
}

const LINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;

/** Extract all wiki links whose target is a valid UID. Non-UID targets are ignored (not links in Breadboard). */
export function extractLinks(text: string): WikiLink[] {
  const out: WikiLink[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const target = normalizeUid(m[1]!.trim());
    if (!isUid(target)) continue;
    out.push({ uid: target, title: m[2]?.trim() ?? null, index: m.index!, raw: m[0] });
  }
  return out;
}

export function uniqueLinkTargets(text: string): string[] {
  return [...new Set(extractLinks(text).map((l) => l.uid))];
}

export function formatLink(uid: string, title?: string | null): string {
  return title ? `[[${uid}|${title}]]` : `[[${uid}]]`;
}
