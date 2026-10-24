/**
 * Proposals (`/proposals`, [10] §4): every configuration change a designer (or an API client) proposed, by status.
 * Open ones wait for a human to merge or discard them; drafts are staged branches their authors are still trying
 * out (evals, test runs) before submitting them for review. Each row opens the review page.
 */
import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { owningDefinition, type ProposalDto } from '@breadboard/shared';
import { configApi, proposalDefinitions, proposalPath, qk, useTreeIndex, type ProposalFilter } from '../lib/configApi';
import { Pager } from '../../../components';
import { pageState } from '../../../lib/paging';
import { ErrorBox, Spin, TabBar } from '../ui';
import { AppLink } from '../components/AppLink';
import { InventoryShell, Table, TableEmpty } from '../inventory/Inventory';
import { matchesQuery } from '../lib/inventory';
import { fmtDate, fmtRelative, hrefFor } from '../lib/format';
import { ProposalAuthor, ProposalPills, useDefinitionLabels } from './ProposalParts';

type Status = NonNullable<ProposalFilter['status']>;

export function ProposalsPage() {
  const search = useSearch({ strict: false }) as { status?: string; definition?: string; q?: string; page?: string; size?: string };
  const navigate = useNavigate();
  const set = (patch: Record<string, string | undefined>) => navigate({ to: '.', replace: true, search: ((prev: Record<string, string>) => ({ ...prev, ...patch })) as never });
  const status: Status = search.status === 'merged' || search.status === 'discarded' || search.status === 'draft' ? search.status : 'open';
  const paging = pageState(search);
  const filter = useMemo<ProposalFilter>(() => ({ status, ...(search.definition ? { definition: search.definition } : {}), limit: paging.size }), [status, search.definition, paging.size]);
  const list = useQuery({ queryKey: [...qk.proposals(filter), { offset: paging.offset }], queryFn: () => configApi.proposalPage(filter, paging.offset), staleTime: 15_000, placeholderData: keepPreviousData });
  const idx = useTreeIndex();
  const scoped = search.definition ? (['circuit', 'tool', 'mcp', 'subagent'] as const).map((k) => idx.get(k, search.definition)).find(Boolean) : undefined;

  return (
    <InventoryShell
      title="Proposals"
      subtitle="Configuration changes waiting for review. Designers propose; a human merges or discards. Drafts are still being tried out by their authors."
      query={search.q ?? ''}
      onQuery={(q) => set({ q: q || undefined })}
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <TabBar
          value={status}
          onChange={(s) => set({ status: s === 'open' ? undefined : s, page: undefined })}
          tabs={[
            { id: 'open', label: 'Open' },
            { id: 'draft', label: 'Drafts' },
            { id: 'merged', label: 'Merged' },
            { id: 'discarded', label: 'Discarded' },
          ]}
        />
        {search.definition && (
          <span className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-xs">
            Changes to <span className="font-mono">{scoped?.slug ?? search.definition}</span>
            <button type="button" aria-label="Clear definition filter" className="rounded p-0.5 hover:bg-hover" onClick={() => set({ definition: undefined, page: undefined })}>
              <X className="size-3" />
            </button>
          </span>
        )}
      </div>
      {list.isLoading ? (
        <Spin />
      ) : list.error ? (
        <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <>
          <ProposalTable rows={list.data?.items ?? []} query={search.q ?? ''} status={status} />
          <Pager
            page={paging.page}
            size={paging.size}
            total={list.data?.total ?? 0}
            shown={list.data?.items.length ?? 0}
            loading={list.isPlaceholderData}
            onPage={(p) => set({ page: p > 1 ? String(p) : undefined })}
            onSize={(n) => set({ size: String(n), page: undefined })}
          />
        </>
      )}
    </InventoryShell>
  );
}

function ProposalTable({ rows, query, status }: { rows: ProposalDto[]; query: string; status: Status }) {
  const idx = useTreeIndex();
  const shown = rows.filter((p) => matchesQuery(query, p.message, p.proposal_id, ...p.changes.map((c) => c.path), ...proposalDefinitions(p).map((d) => idx.get(d.kind, d.uid)?.slug)));
  return (
    <Table
      head={['Proposal', 'Changes', 'Status', 'Opened by', 'Opened', 'Conversation']}
      empty={shown.length === 0 && <TableEmpty>{rows.length ? 'No proposals match.' : status === 'open' ? 'Nothing waiting for review.' : status === 'draft' ? 'No drafts. A draft is a proposal staged for evals before review.' : `No ${status} proposals.`}</TableEmpty>}
    >
      {shown.map((p) => (
        <ProposalRow key={p.proposal_id} p={p} />
      ))}
    </Table>
  );
}

function ProposalRow({ p }: { p: ProposalDto }) {
  const defs = useDefinitionLabels(p);
  const others = p.changes.filter((c) => !owningDefinition(c.path)).length;
  return (
    <tr className="border-t border-line align-top hover:bg-hover">
      <td className="px-3 py-2">
        <AppLink href={proposalPath(p.proposal_id)} className="font-medium">
          {p.message || 'Proposed change'}
        </AppLink>
        <div className="font-mono text-[11px] text-fg-subtle">{p.proposal_id}</div>
      </td>
      <td className="px-3 py-2 text-xs">
        <div className="flex flex-wrap gap-1">
          {defs.map((d) => (
            <AppLink key={d.uid} href={d.exists ? hrefFor(d.kind, d.uid) : null} className="rounded bg-sunken px-1.5 py-0.5 font-mono">
              {d.kind} {d.label}
            </AppLink>
          ))}
          {others > 0 && <span className="text-fg-subtle">+{others} other file{others === 1 ? '' : 's'}</span>}
        </div>
      </td>
      <td className="px-3 py-2 text-xs whitespace-nowrap">
        <span className="flex gap-1">
          <ProposalPills p={p} />
        </span>
      </td>
      <td className="px-3 py-2 text-xs">
        <ProposalAuthor actor={p.created_by} />
      </td>
      <td className="px-3 py-2 text-xs whitespace-nowrap" title={fmtDate(p.created_at)}>
        {fmtRelative(p.created_at)}
      </td>
      <td className="px-3 py-2 font-mono text-[11px]">{p.session_id ? <AppLink href={`/s/${p.session_id}`}>{p.session_id}</AppLink> : <span className="font-sans text-fg-subtle">–</span>}</td>
    </tr>
  );
}
