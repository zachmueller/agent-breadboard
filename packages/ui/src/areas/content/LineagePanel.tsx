/** Lineage navigation ([09] §5.2): up into producing sessions and parents; down into derived referents and backlinks. */
import { ArrowDownRight, ArrowUpLeft, GitFork } from 'lucide-react';
import type { LineageDto } from '@breadboard/shared';
import { useLineage } from '../../lib/queries';
import { Badge, ConfigLink, ErrorState, NodeChip, Panel, SessionChip, Skeleton } from '../../components';

const EDGE_LABEL: Record<string, string> = {
  produces: 'produced by',
  updates: 'updated by',
  'derived-from': 'derived from',
  references: 'referenced by',
  'attached-to': 'attached to',
  blocks: 'blocks',
  'depends-on': 'depends on',
};

interface Row {
  key: string;
  edge: string;
  depth: number;
  kind: 'session' | 'node';
  id: string;
  step?: string | null;
  revision?: number | null;
  via?: string | null;
}

/** Flatten lineage edges into rows relative to the root. Up: sessions first, then parents. Down: children. */
export function lineageRows(l: LineageDto): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  const depthOf = new Map<string, number>([[l.root, 0]]);
  // Edges arrive in edge_id order, not BFS order: relax depths until stable (depth is small).
  for (let pass = 0; pass < 6; pass++)
    for (const e of l.edges) {
      const [near, far] = l.direction === 'up' ? [e.src_uid, e.dst_uid] : [e.dst_uid, e.src_uid];
      if (!near || !far || !depthOf.has(near)) continue;
      const d = depthOf.get(near)! + 1;
      if (!depthOf.has(far) || depthOf.get(far)! > d) depthOf.set(far, d);
    }
  for (const e of l.edges) {
    if (l.direction === 'up' && e.src_session_id && !e.src_uid) {
      const k = `s:${e.src_session_id}:${e.src_step_id ?? ''}:${e.dst_uid}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ key: k, edge: e.type, depth: (depthOf.get(e.dst_uid) ?? 0) + 1, kind: 'session', id: e.src_session_id, step: e.src_step_id, via: e.dst_uid === l.root ? null : e.dst_uid });
      continue;
    }
    const other = l.direction === 'up' ? e.dst_uid : e.src_uid;
    const anchor = l.direction === 'up' ? e.src_uid : e.dst_uid;
    if (!other || other === l.root) continue;
    const k = `n:${other}:${e.type}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({ key: k, edge: e.type, depth: depthOf.get(other) ?? 1, kind: 'node', id: other, revision: l.direction === 'up' ? e.dst_revision : null, via: anchor && anchor !== l.root ? anchor : null });
  }
  return rows.sort((a, b) => a.depth - b.depth || Number(b.kind === 'session') - Number(a.kind === 'session'));
}

function LineageList({ uid, direction }: { uid: string; direction: 'up' | 'down' }) {
  const q = useLineage(uid, direction, 3);
  if (q.isPending)
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-6 w-1/2" />
      </div>
    );
  if (q.error) return <ErrorState error={q.error} compact onRetry={() => q.refetch()} />;
  const l = q.data!;
  const rows = lineageRows(l);
  const nodes = new Map(l.nodes.map((n) => [n.uid, n]));
  const sessions = new Map(l.sessions.map((s) => [s.session_id, s]));
  if (!rows.length)
    return <p className="text-[12.5px] text-fg-subtle">{direction === 'up' ? 'No recorded origin: created directly by a user or the API.' : 'Nothing derives from or links to this yet.'}</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((r) => {
        const n = r.kind === 'node' ? nodes.get(r.id) : undefined;
        const s = r.kind === 'session' ? sessions.get(r.id) : undefined;
        return (
          <li key={r.key} className="flex min-w-0 flex-wrap items-center gap-1.5" style={{ paddingLeft: `${Math.max(0, r.depth - 1) * 14}px` }}>
            <span className="w-[5.75rem] shrink-0 text-[11.5px] text-fg-subtle">{direction === 'down' && r.edge === 'derived-from' ? 'derived into' : (EDGE_LABEL[r.edge] ?? r.edge)}</span>
            {r.kind === 'session' ? (
              <>
                <SessionChip id={r.id} state={s?.state} kind={s?.kind} step={r.step} />
                {s?.circuit_uid && <ConfigLink uid={s.circuit_uid} kind="circuit" className="text-[12px]" />}
              </>
            ) : (
              <NodeChip uid={r.id} title={n?.title} type={n?.type} revision={r.revision} maxWidth="max-w-[14rem]" />
            )}
          </li>
        );
      })}
      {l.truncated && (
        <li>
          <Badge size="xs" tone="warn">
            Truncated
          </Badge>
        </li>
      )}
    </ul>
  );
}

export function LineagePanel({ uid }: { uid: string }) {
  return (
    <Panel id="lineage" title={<span className="inline-flex items-center gap-1.5"><GitFork size={14} aria-hidden /> Lineage</span>} bodyClassName="grid gap-5 md:grid-cols-2">
      <section aria-label="Upstream">
        <h3 className="mb-2 inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
          <ArrowUpLeft size={12} aria-hidden /> Upstream
        </h3>
        <LineageList uid={uid} direction="up" />
      </section>
      <section aria-label="Downstream">
        <h3 className="mb-2 inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
          <ArrowDownRight size={12} aria-hidden /> Downstream
        </h3>
        <LineageList uid={uid} direction="down" />
      </section>
    </Panel>
  );
}
