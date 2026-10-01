/** Subagents inventory ([05] §7): searchable list (slug, title, model preset, tool count, last modified). */
import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Btn, Pill, Spin, ErrorBox } from '../ui';
import { AppLink } from '../components/AppLink';
import { useTreeOfKind, useDefinitions, usePresets } from '../lib/configApi';
import { matchesQuery, withUid } from '../lib/inventory';
import { InventoryShell, Table, TableEmpty, LastModified, NewDefinitionDialog } from '../inventory/Inventory';
import { isMcpGrant, isToolGrant } from './model';

export function SubagentsInventoryPage() {
  const tree = useTreeOfKind('subagent');
  const presets = usePresets();
  const [q, setQ] = useState('');
  const [preset, setPreset] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const entries = useMemo(() => withUid(tree.data), [tree.data]);
  const defs = useDefinitions(entries.map((e) => e.uid));
  const meta = useMemo(() => {
    const m = new Map<string, { preset: string; tools: number; mcp: number; circuits: number; description: string; invalid: boolean }>();
    entries.forEach((e, i) => {
      const dto = defs[i]?.data;
      const d: any = dto?.definition;
      const tools: any[] = Array.isArray(d?.tools) ? d.tools : [];
      m.set(e.uid, {
        preset: typeof d?.model_preset === 'string' ? d.model_preset : '',
        tools: tools.filter(isToolGrant).length,
        mcp: tools.filter(isMcpGrant).length,
        circuits: Array.isArray(d?.circuits) ? d.circuits.length : 0,
        description: typeof d?.description === 'string' ? d.description : '',
        invalid: dto?.validation ? !dto.validation.ok : false,
      });
    });
    return m;
  }, [entries, defs]);
  const knownPresets = Object.keys(presets.data?.presets ?? {});
  const usedPresets = [...new Set([...meta.values()].map((m) => m.preset).filter(Boolean))].sort();
  const rows = entries.filter((e) => {
    const m = meta.get(e.uid);
    return (!preset || m?.preset === preset) && matchesQuery(q, e.slug, e.title, e.uid, m?.description, m?.preset);
  });

  return (
    <InventoryShell
      title="Subagents"
      subtitle="Narrowly-scoped AI experts: system prompt, tool, circuit and knowledge access, and a model preset."
      query={q}
      onQuery={setQ}
      actions={
        <Btn variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New subagent
        </Btn>
      }
    >
      {usedPresets.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-1 text-xs">
          <span className="mr-1 text-fg-subtle">Preset</span>
          <button type="button" onClick={() => setPreset('')} className={`rounded px-2 py-0.5 ${!preset ? 'bg-hover font-medium' : 'hover:bg-hover'}`}>
            all
          </button>
          {usedPresets.map((p) => (
            <button key={p} type="button" onClick={() => setPreset(preset === p ? '' : p)} className={`rounded px-2 py-0.5 font-mono ${preset === p ? 'bg-hover font-medium' : 'hover:bg-hover'}`}>
              {p}
            </button>
          ))}
        </div>
      )}
      {tree.isLoading ? (
        <Spin />
      ) : tree.error ? (
        <ErrorBox error={tree.error} onRetry={() => tree.refetch()} />
      ) : (
        <Table head={['Slug', 'Title', 'Model preset', 'Tools', 'Last modified']} empty={rows.length === 0 && <TableEmpty>{entries.length ? 'No subagents match.' : 'No subagents yet. Create one to get started.'}</TableEmpty>}>
          {rows.map((e) => {
            const m = meta.get(e.uid);
            const unknownPreset = !!m?.preset && knownPresets.length > 0 && !knownPresets.includes(m.preset);
            return (
              <tr key={e.uid} className="border-t border-line align-top hover:bg-hover">
                <td className="px-3 py-2 font-mono text-xs">
                  <AppLink href={`/subagents/${e.uid}`} className="font-medium">
                    {e.slug}
                  </AppLink>
                  {m?.invalid && (
                    <Pill tone="danger" className="ml-1">
                      invalid
                    </Pill>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div>{e.title}</div>
                  {m?.description && <div className="line-clamp-1 text-xs text-fg-muted">{m.description}</div>}
                </td>
                <td className="px-3 py-2">
                  {m?.preset ? (
                    <Pill tone={unknownPreset ? 'danger' : 'neutral'} title={unknownPreset ? 'Not defined in presets/models.yaml' : undefined}>
                      {m.preset}
                      {unknownPreset && ' (unknown)'}
                    </Pill>
                  ) : (
                    <span className="text-xs text-fg-subtle">...</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs tabular-nums">
                  {m ? (
                    <span title={`${m.tools} tool extension(s), ${m.mcp} MCP server(s), ${m.circuits} circuit grant(s)`}>
                      {m.tools + m.mcp}
                      {m.mcp > 0 && <span className="text-fg-subtle"> ({m.mcp} MCP)</span>}
                    </span>
                  ) : (
                    ''
                  )}
                </td>
                <td className="px-3 py-2 text-xs">
                  <LastModified path={e.path} />
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <NewDefinitionDialog kind="subagent" open={creating} onClose={() => setCreating(false)} />
    </InventoryShell>
  );
}
