import { uniqueLinkTargets, SERVICE_ACTOR, type NodeRecord } from '@breadboard/shared';
import type { Queryable, Db } from '../db/index.js';
import type { EdgeStore } from './edges.js';

/** Collect `[[UID|title]]` targets from a node's title, properties, and body ([01] §3.2). */
export function linkTargetsOf(node: Pick<NodeRecord, 'title' | 'properties' | 'body' | 'body_text'>): string[] {
  const texts: string[] = [node.title ?? ''];
  if (node.body_text) texts.push(node.body_text);
  else if (typeof node.body === 'string') texts.push(node.body);
  else if (node.body && typeof node.body === 'object') texts.push(JSON.stringify(node.body));
  if (node.properties) texts.push(JSON.stringify(node.properties));
  return uniqueLinkTargets(texts.join('\n'));
}

/**
 * Materializes `references` edges from wiki links whenever a head is persisted or a revision cut ([01] §3.2).
 * Indexer-owned edges are a derived index: upserted/true-deleted on re-index ([01] §4.3).
 */
export class LinkIndexer {
  constructor(
    private db: Db,
    private edges: EdgeStore,
  ) {}

  async reindex(node: Pick<NodeRecord, 'uid' | 'title' | 'properties' | 'body' | 'body_text'>, q: Queryable = this.db): Promise<{ added: string[]; removed: string[] }> {
    const targets = linkTargetsOf(node);
    return this.edges.replaceIndexedReferences(node.uid, targets, SERVICE_ACTOR('link-indexer'), q);
  }
}
