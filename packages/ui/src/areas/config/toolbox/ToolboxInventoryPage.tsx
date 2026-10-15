/**
 * Toolbox inventory ([06] §10): tool extensions and onboarded MCP servers, searchable; create a tool
 * (TypeScript or Python skeleton) or onboard an MCP server.
 */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, PlugZap } from 'lucide-react';
import { Btn, Pill, Spin, ErrorBox, Modal, Field, TextInput, errorMessage, notify } from '../ui';
import { AppLink, useGo } from '../components/AppLink';
import { configApi, qk, useConfigTree, useDefinitions } from '../lib/configApi';
import { editYaml } from '../lib/yamlDoc';
import { slugify } from '../lib/format';
import { matchesQuery, uidFromChanges, withUid, SLUG_RE } from '../lib/inventory';
import { InventoryShell, Table, TableEmpty, LastModified, NewDefinitionDialog } from '../inventory/Inventory';
import { McpFields } from './McpFields';
import { OpenProposalsBadge } from '../proposals/OpenProposalsBadge';
import { egressOf, capabilitiesOf } from './manifestLint';

export function ToolboxInventoryPage() {
  const tree = useConfigTree();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const tools = useMemo(() => withUid((tree.data ?? []).filter((e) => e.kind === 'tool')), [tree.data]);
  const mcps = useMemo(() => withUid((tree.data ?? []).filter((e) => e.kind === 'mcp')), [tree.data]);
  const toolDefs = useDefinitions(tools.map((t) => t.uid));
  const mcpDefs = useDefinitions(mcps.map((m) => m.uid));
  const toolRows = tools.map((e, i) => ({ e, d: toolDefs[i]?.data?.definition as any })).filter(({ e, d }) => matchesQuery(q, e.slug, e.title, e.uid, d?.description, d?.language));
  const mcpRows = mcps.map((e, i) => ({ e, d: mcpDefs[i]?.data?.definition as any })).filter(({ e, d }) => matchesQuery(q, e.slug, e.title, e.uid, d?.description, d?.endpoint, d?.command));

  return (
    <InventoryShell
      title="Toolbox"
      subtitle="Versioned tool extensions (sandboxed TypeScript/Python) and centrally onboarded MCP servers."
      query={q}
      onQuery={setQ}
      actions={
        <>
          <Btn size="sm" icon={<PlugZap className="size-4" />} onClick={() => setOnboarding(true)}>
            Onboard MCP server
          </Btn>
          <Btn size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            New tool
          </Btn>
        </>
      }
    >
      {tree.isLoading ? (
        <Spin />
      ) : tree.error ? (
        <ErrorBox error={tree.error} onRetry={() => tree.refetch()} />
      ) : (
        <div className="space-y-6">
          <section>
            <h2 className="mb-2 text-sm font-semibold">
              Tool extensions <span className="font-normal text-fg-subtle">({tools.length})</span>
            </h2>
            <Table head={['Slug', 'Title', 'Language', 'Egress', 'Capabilities', 'Exposure', 'Last modified']} empty={toolRows.length === 0 && <TableEmpty>{tools.length ? 'No tools match.' : 'No tool extensions yet.'}</TableEmpty>}>
              {toolRows.map(({ e, d }) => {
                const eg = egressOf(d);
                const caps = capabilitiesOf(d);
                return (
                  <tr key={e.uid} className="border-t border-line align-top hover:bg-hover">
                    <td className="px-3 py-2 font-mono text-xs">
                      <AppLink href={`/toolbox/${e.uid}`} className="font-medium">
                        {e.slug}
                      </AppLink>
                      <OpenProposalsBadge uid={e.uid} compact />
                      {d?.builtin && (
                        <Pill className="ml-1.5" title="Shipped with Breadboard; fork to customize">
                          builtin
                        </Pill>
                      )}
                      {d?.connector && <Pill className="ml-1.5">connector</Pill>}
                    </td>
                    <td className="px-3 py-2">
                      <div>{e.title}</div>
                      {d?.description && <div className="line-clamp-1 text-xs text-fg-muted">{d.description}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs">{d?.language ?? <Spin className="size-3" />}</td>
                    <td className="px-3 py-2 font-mono text-xs" title={eg.map((r) => `${r.host}:${r.ports.join(',')}`).join('\n')}>
                      {eg.length ? eg.map((r) => r.host).join(', ') : <span className="font-sans text-fg-subtle">none</span>}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{caps.length ? caps.map((c) => `${c.name}:${c.scope}`).join(', ') : <span className="font-sans text-fg-subtle">none</span>}</td>
                    <td className="px-3 py-2 text-xs">{d?.exposure?.external_mcp ? <Pill tone="warn">external MCP</Pill> : <span className="text-fg-subtle">internal</span>}</td>
                    <td className="px-3 py-2 text-xs">
                      <LastModified path={e.path} />
                    </td>
                  </tr>
                );
              })}
            </Table>
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold">
              MCP servers <span className="font-normal text-fg-subtle">({mcps.length})</span>
            </h2>
            <Table head={['Slug', 'Title', 'Transport', 'Endpoint / command', 'Auth', 'Allowlist', 'Last modified']} empty={mcpRows.length === 0 && <TableEmpty>{mcps.length ? 'No MCP servers match.' : 'No MCP servers onboarded.'}</TableEmpty>}>
              {mcpRows.map(({ e, d }) => (
                <tr key={e.uid} className="border-t border-line align-top hover:bg-hover">
                  <td className="px-3 py-2 font-mono text-xs">
                    <AppLink href={`/toolbox/${e.uid}`} className="font-medium">
                      {e.slug}
                    </AppLink>
                    <OpenProposalsBadge uid={e.uid} compact />
                  </td>
                  <td className="px-3 py-2">{e.title}</td>
                  <td className="px-3 py-2 text-xs">{d?.transport ?? <Spin className="size-3" />}</td>
                  <td className="max-w-72 truncate px-3 py-2 font-mono text-xs">{d?.transport === 'stdio' ? [d?.command, ...(d?.args ?? [])].join(' ') : d?.endpoint}</td>
                  <td className="px-3 py-2 font-mono text-xs">{d?.auth?.capability ?? <span className="font-sans text-fg-subtle">none</span>}</td>
                  <td className="px-3 py-2 text-xs">{Array.isArray(d?.tools?.allow) ? d.tools.allow.length ? <span className="font-mono">{d.tools.allow.join(', ')}</span> : <Pill tone="warn">none allowed</Pill> : <span className="text-fg-subtle">all tools</span>}</td>
                  <td className="px-3 py-2 text-xs">
                    <LastModified path={e.path} />
                  </td>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}
      <NewDefinitionDialog kind="tool" open={creating} onClose={() => setCreating(false)} />
      {onboarding && <OnboardMcpDialog onClose={() => setOnboarding(false)} />}
    </InventoryShell>
  );
}

/** Mint an MCP skeleton, overlay the form values onto it, commit, open the editor. */
function OnboardMcpDialog({ onClose }: { onClose: () => void }) {
  const go = useGo();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [value, setValue] = useState<any>({ transport: 'http', endpoint: '', tools: { allow: [] } });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const effSlug = slug ?? slugify(title);
  const slugErr = effSlug && !SLUG_RE.test(effSlug) ? 'lowercase letters, digits and dashes' : null;
  const target = value.transport === 'stdio' ? !!value.command : !!value.endpoint;
  const patch = (fn: (d: any) => void) =>
    setValue((v: any) => {
      const d = structuredClone(v);
      fn(d);
      return d;
    });
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { changes } = await configApi.newDefinition({ kind: 'mcp', slug: effSlug, title: title.trim() || effSlug, ...(value.endpoint ? { endpoint: value.endpoint } : {}) } as any);
      const uid = uidFromChanges(changes, 'mcp');
      const merged = changes.map((c) =>
        c.content != null && uid && c.path.endsWith(`${uid}.yaml`)
          ? {
              ...c,
              content: editYaml(c.content, (d) => {
                for (const k of ['transport', 'endpoint', 'command', 'args', 'env', 'auth', 'tools', 'description']) {
                  if (value[k] === undefined || value[k] === '') delete d[k];
                  else d[k] = value[k];
                }
                if (!value.tools) d.tools = {};
              }),
            }
          : c,
      );
      await configApi.commit(merged, `Onboard MCP server ${effSlug}`);
      await qc.invalidateQueries({ queryKey: qk.tree() });
      notify(`Onboarded ${effSlug}`, 'ok');
      onClose();
      if (uid) go(`/toolbox/${uid}`);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Onboard an MCP server"
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" loading={busy} disabled={!effSlug || !!slugErr || !target} onClick={submit}>
            Onboard and commit
          </Btn>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Title">
            <TextInput autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Internal search" />
          </Field>
          <Field label="Slug" error={slugErr}>
            <TextInput className="font-mono" value={effSlug} onChange={(e) => setSlug(e.target.value)} />
          </Field>
        </div>
        <McpFields value={value} patch={patch} />
        <p className="text-xs text-fg-muted">Onboarding is centralized: the server connects with broker-held credentials; Subagents receive access only through explicit grants.</p>
        {err != null && <div className="text-xs text-danger-fg">{errorMessage(err)}</div>}
      </div>
    </Modal>
  );
}
