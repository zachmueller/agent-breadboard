/** Backlinks ([07] §10): nodes linking here, i.e. incoming `references` edges. */
import { useQuery } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import type { EdgeRecord } from '@breadboard/shared';
import { asPage, get } from '../../../lib/api';
import { qk } from '../../../lib/queries';
import { EmptyState, ErrorState, Loading, NodeChip, TimeAgo } from '../../../components';
import { backlinkSources } from '../lib';

export function useBacklinks(uid: string, enabled = true) {
  const query = { direction: 'in', type: 'references' } as const;
  return useQuery({
    queryKey: qk.edges(uid, query),
    queryFn: async () => asPage<EdgeRecord>(await get(`/nodes/${uid}/edges`, query)).items,
    enabled,
    staleTime: 30_000,
  });
}

export function BacklinksPanel({ uid }: { uid: string }) {
  const q = useBacklinks(uid);
  if (q.isPending) return <Loading label="Loading backlinks…" className="py-10" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} compact className="m-3" />;
  const sources = backlinkSources(q.data ?? [], uid);
  if (!sources.length) {
    return <EmptyState compact icon={<Link2 size={18} />} title="No backlinks" description="Notes and artifacts that link here with [[…]] show up here." className="py-10" />;
  }
  return (
    <ul className="flex flex-col gap-1 p-3" aria-label="Backlinks">
      {sources.map((s) => (
        <li key={s.uid} className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 hover:bg-hover">
          <NodeChip uid={s.uid} maxWidth="max-w-[14rem]" />
          <TimeAgo at={s.at} className="shrink-0 text-[11.5px] text-fg-subtle" />
        </li>
      ))}
    </ul>
  );
}
