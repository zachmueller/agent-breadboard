/** "Referenced by" + "Uses" backlink panes ([01] §10 reference index; [03] §8.2, [05] §7). */
import { Pill } from '../ui';
import { AppLink } from './AppLink';
import { hrefFor } from '../lib/format';
import { useTreeIndex } from '../lib/configApi';
import { useWorkingTree } from '../model/workingTree';

export interface UseRef {
  kind: string;
  uid: string;
  where: string;
}

export function ReferencesPanel({ noun, uses }: { noun: string; uses?: UseRef[] }) {
  const wt = useWorkingTree();
  const idx = useTreeIndex();
  const refs = wt.state.definition?.referenced_by ?? [];
  return (
    <div className={`grid h-full gap-4 overflow-y-auto p-4 ${uses ? 'md:grid-cols-2' : ''}`}>
      <section>
        <h2 className="mb-2 text-sm font-semibold">Referenced by</h2>
        <p className="mb-2 text-xs text-fg-muted">Definitions on main that use this {noun} (from the server's reference index, updated on commit).</p>
        {refs.length === 0 ? (
          <div className="text-xs text-fg-subtle">Nothing references this {noun}.</div>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {refs.map((r) => (
              <li key={r.path} className="flex items-center gap-2 px-3 py-2 text-sm">
                <Pill>{r.kind}</Pill>
                <AppLink href={hrefFor(r.kind, r.uid)} className="font-medium hover:underline">
                  {r.title || r.slug || r.uid}
                </AppLink>
                <span className="ml-auto font-mono text-xs text-fg-subtle">{r.slug}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {uses && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Uses</h2>
          <p className="mb-2 text-xs text-fg-muted">Definitions referenced by this working tree.</p>
          {uses.length === 0 ? (
            <div className="text-xs text-fg-subtle">No references.</div>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {uses.map((u, i) => {
                const e = idx.get(u.kind, u.uid);
                return (
                  <li key={i} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <Pill>{u.kind}</Pill>
                    <AppLink href={hrefFor(u.kind, u.uid)} className="font-medium hover:underline">
                      {e?.title || e?.slug || u.uid}
                    </AppLink>
                    {!e && !idx.loading && <Pill tone="danger">missing</Pill>}
                    <span className="ml-auto font-mono text-xs text-fg-subtle">{u.where}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
