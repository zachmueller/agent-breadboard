/**
 * Revision snapshots of a live CRDT document ([01] §3.3, [07] §5.2/§6).
 *
 * `NodeStore.cutRevision` deduplicates by content hash (properties/body/body_text): an identical render
 * appends labels to the latest revision even when the Y.Doc state has advanced (e.g. an attribution
 * stamp, or an edit-and-undo). For CRDT nodes the revision's state must be a merge base for the
 * current head, so when dedup hands back a revision whose stored vector differs from the live vector we
 * upgrade that revision's `ydoc_state`/`ydoc_vector` in place to the (text-identical, causally later)
 * live state. The rendered content of the revision is unchanged by construction.
 */
import type * as Y from 'yjs';
import type { Actor, NodeRevision, RevisionLabel } from '@breadboard/shared';
import type { Queryable } from '../db/index.js';
import type { NodeStore } from '../content/nodes.js';
import type { LinkIndexer } from '../content/link-indexer.js';
import { docToMarkdown, encodeState, encodeVector, sameVector } from './ydoc.js';

export interface SnapshotResult {
  revision: NodeRevision;
  markdown: string;
  /** True when a new revision row was inserted (false = deduplicated into the latest). */
  created: boolean;
}

export async function cutSnapshot(
  deps: { db: Queryable; nodes: NodeStore; linkIndexer?: LinkIndexer | null },
  uid: string,
  doc: Y.Doc,
  labels: RevisionLabel[],
  by: Actor,
): Promise<SnapshotResult> {
  const markdown = docToMarkdown(doc);
  const state = encodeState(doc);
  const vector = encodeVector(doc);
  const before = await deps.nodes.headRevisionId(uid, deps.db);
  const node = await deps.nodes.mustGet(uid, deps.db);
  if (node.body_text !== markdown) {
    await deps.nodes.setBodyText(uid, markdown, deps.db);
    if (deps.linkIndexer) await deps.linkIndexer.reindex({ ...node, body_text: markdown }, deps.db);
  }
  const rev = await deps.nodes.cutRevision(uid, { labels, created_by: by, body_text: markdown, ydoc_state: state, ydoc_vector: vector }, deps.db);
  const created = rev.revision_id !== before;
  if (!created) {
    const stored = rev.ydoc_vector ? Buffer.from(rev.ydoc_vector, 'base64') : null;
    if (!sameVector(stored, vector)) {
      await deps.db.query(`UPDATE node_revisions SET ydoc_state=$3, ydoc_vector=$4 WHERE uid=$1 AND revision_id=$2`, [uid, rev.revision_id, state, vector]);
      rev.ydoc_state = state.toString('base64');
      rev.ydoc_vector = vector.toString('base64');
    }
  }
  return { revision: rev, markdown, created };
}
