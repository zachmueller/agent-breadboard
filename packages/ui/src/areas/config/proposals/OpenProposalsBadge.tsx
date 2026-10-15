/** "N open proposals" on an editor or inventory row: straight to the review (one proposal) or the filtered list. */
import clsx from 'clsx';
import { GitPullRequest } from 'lucide-react';
import { proposalPath, useOpenProposalsFor } from '../lib/configApi';
import { AppLink } from '../components/AppLink';

export function OpenProposalsBadge({ uid, compact }: { uid: string; compact?: boolean }) {
  const q = useOpenProposalsFor(uid);
  const n = q.data.length;
  if (!n) return null;
  const href = n === 1 ? proposalPath(q.data[0]!.proposal_id) : `/proposals?definition=${uid}`;
  const label = `${n} open proposal${n === 1 ? '' : 's'}`;
  return (
    <AppLink
      href={href}
      title={`${label} waiting for review: ${q.data.map((p) => p.message).join('; ')}`}
      className={clsx(
        'inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent-soft font-sans font-medium whitespace-nowrap text-accent-text hover:no-underline',
        compact ? 'ml-1.5 px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs',
      )}
    >
      <GitPullRequest className={compact ? 'size-3' : 'size-3.5'} aria-hidden />
      {compact ? n : label}
    </AppLink>
  );
}
