/** Circuit inventory ([03] §8.1): slug, title, tags, last-modified, eval status summary. */
import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Btn, Pill, Spin, ErrorBox } from '../ui';
import { AppLink } from '../components/AppLink';
import { useTreeOfKind, useDefinitions, useLatestRun, isRunTerminal } from '../lib/configApi';
import { fmtScore, fmtPct, fmtRelative } from '../lib/format';
import { matchesQuery, withUid } from '../lib/inventory';
import { InventoryShell, Table, TableEmpty, LastModified, NewDefinitionDialog } from '../inventory/Inventory';
import { statusTone } from './evals/RunsPanel';

export function CircuitsInventoryPage() {
  const tree = useTreeOfKind('circuit');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [tag, setTag] = useState<string | null>(null);
  const entries = useMemo(() => withUid(tree.data), [tree.data]);
  const defs = useDefinitions(entries.map((e) => e.uid));
  const meta = useMemo(() => {
    const m = new Map<string, { tags: string[]; description: string }>();
    entries.forEach((e, i) => {
      const d: any = defs[i]?.data?.definition;
      m.set(e.uid, { tags: Array.isArray(d?.tags) ? d.tags : [], description: typeof d?.description === 'string' ? d.description : '' });
    });
    return m;
  }, [entries, defs]);
  const allTags = [...new Set([...meta.values()].flatMap((m) => m.tags))].sort();
  const rows = entries.filter((e) => {
    const m = meta.get(e.uid);
    return (!tag || m?.tags.includes(tag)) && matchesQuery(q, e.slug, e.title, e.uid, m?.tags ?? [], m?.description);
  });

  return (
    <InventoryShell
      title="Circuits"
      subtitle="Designed flows of LLM and code steps. Open one to edit its graph, prompts and evals."
      query={q}
      onQuery={setQ}
      actions={
        <Btn variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New circuit
        </Btn>
      }
    >
      {allTags.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1 text-xs">
          <span className="mr-1 text-fg-subtle">Tags</span>
          <button type="button" onClick={() => setTag(null)} className={`rounded px-2 py-0.5 ${!tag ? 'bg-hover font-medium' : 'hover:bg-hover'}`}>
            all
          </button>
          {allTags.map((t) => (
            <button key={t} type="button" onClick={() => setTag(tag === t ? null : t)} className={`rounded px-2 py-0.5 font-mono ${tag === t ? 'bg-hover font-medium' : 'hover:bg-hover'}`}>
              {t}
            </button>
          ))}
        </div>
      )}
      {tree.isLoading ? (
        <Spin />
      ) : tree.error ? (
        <ErrorBox error={tree.error} onRetry={() => tree.refetch()} />
      ) : (
        <Table head={['Slug', 'Title', 'Tags', 'Last modified', 'Evals']} empty={rows.length === 0 && <TableEmpty>{entries.length ? 'No circuits match.' : 'No circuits yet. Create one to get started.'}</TableEmpty>}>
          {rows.map((e) => {
            const m = meta.get(e.uid);
            return (
              <tr key={e.uid} className="border-t border-line align-top hover:bg-hover">
                <td className="px-3 py-2 font-mono text-xs">
                  <AppLink href={`/circuits/${e.uid}`} className="font-medium">
                    {e.slug}
                  </AppLink>
                </td>
                <td className="px-3 py-2">
                  <div>{e.title}</div>
                  {m?.description && <div className="line-clamp-1 text-xs text-fg-muted">{m.description}</div>}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {(m?.tags ?? []).map((t) => (
                      <Pill key={t}>{t}</Pill>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">
                  <LastModified path={e.path} />
                </td>
                <td className="px-3 py-2 text-xs">
                  <EvalStatus uid={e.uid} />
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <NewDefinitionDialog kind="circuit" open={creating} onClose={() => setCreating(false)} />
    </InventoryShell>
  );
}

function EvalStatus({ uid }: { uid: string }) {
  const q = useLatestRun(uid);
  if (q.isLoading) return <Spin className="size-3" />;
  const r = q.data;
  if (!r) return <span className="text-fg-subtle">no runs</span>;
  const gate = (r.raw?.summary as any)?.gate_min;
  const below = typeof gate === 'number' && r.aggregate != null && r.aggregate < gate;
  return (
    <AppLink href={`/circuits/${uid}?tab=evals&evals=runs&run=${r.eval_run_id}`} className="flex flex-wrap items-center gap-1.5 text-fg no-underline hover:underline">
      {isRunTerminal(r.status) && r.status === 'completed' ? (
        <>
          <Pill tone={below ? 'danger' : 'ok'}>{below ? 'below gate' : typeof gate === 'number' ? 'passing' : 'scored'}</Pill>
          <span className="tabular-nums">mean {fmtScore(r.aggregate)}</span>
          {r.pass_rate != null && <span className="tabular-nums text-fg-muted">pass {fmtPct(r.pass_rate)}</span>}
        </>
      ) : (
        <Pill tone={statusTone(r.status)}>{r.status}</Pill>
      )}
      <span className="text-fg-subtle">{fmtRelative(r.created_at)}</span>
    </AppLink>
  );
}
