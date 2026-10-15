/**
 * Tool CI on proposals ([06] §6): `Toolbox.ci` for every tool a proposal adds or changes, at the
 * proposal's head commit. Commits are immutable, so results are cached by (tool, commit).
 */
import { owningDefinition, type ProposalChecksDto, type ProposalDto } from '@breadboard/shared';
import type { Toolbox } from '../core/services.js';

const CACHE_SIZE = 200;
const cache = new Map<string, Promise<ProposalChecksDto['tools'][number]>>();

/** UIDs of the tools a proposal leaves in place (a tool whose manifest it deletes has nothing to check). */
export function proposalToolUids(p: Pick<ProposalDto, 'changes'>): string[] {
  const uids = new Set<string>();
  const deleted = new Set<string>();
  for (const c of p.changes ?? []) {
    const d = owningDefinition(c.path);
    if (d?.kind !== 'tool') continue;
    uids.add(d.uid);
    if (c.status === 'deleted' && c.path === `tools/${d.uid}/tool.yaml`) deleted.add(d.uid);
  }
  return [...uids].filter((u) => !deleted.has(u));
}

export async function proposalToolChecks(toolbox: Pick<Toolbox, 'ci'>, p: Pick<ProposalDto, 'proposal_id' | 'head_commit' | 'changes'>): Promise<ProposalChecksDto> {
  const tools = await Promise.all(
    proposalToolUids(p).map((uid) => {
      const key = `${uid}@${p.head_commit}`;
      let hit = cache.get(key);
      if (!hit) {
        hit = toolbox.ci(uid, p.head_commit).then(
          (r) => ({ uid, ok: r.ok, errors: r.errors, warnings: r.warnings }),
          (e: Error) => {
            cache.delete(key); // a failure to run is not a result; try again next time
            return { uid, ok: false, errors: [`checks failed to run: ${e.message}`], warnings: [] };
          },
        );
        if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
        cache.set(key, hit);
      }
      return hit;
    }),
  );
  return { proposal_id: p.proposal_id, head_commit: p.head_commit, tools };
}
