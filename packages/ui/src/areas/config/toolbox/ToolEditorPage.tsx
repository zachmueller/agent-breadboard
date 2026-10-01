/**
 * Tool editor ([06] §10): CodeMirror over the tool directory (manifest + TS/Python source), manifest
 * lint with the security-relevant diff against base, commit/discard/history, tool-designer chat.
 * Onboarded MCP servers share the `/toolbox/:uid` route and get the MCP editor instead.
 */
import { useMemo, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { ShieldAlert } from 'lucide-react';
import { WorkingTreeProvider, useWorkingTree } from '../model/workingTree';
import { EditorFrame } from '../components/EditorFrame';
import { HistorySidebar } from '../components/HistorySidebar';
import { DesignerChatPanel } from '../chat/DesignerChatPanel';
import { FilesEditor } from '../components/FilesEditor';
import { ReferencesPanel } from '../components/ReferencedBy';
import { CodeEditor } from '../components/CodeEditor';
import { Empty, Pill, Spin } from '../ui';
import { useConfigTree } from '../lib/configApi';
import { parseYamlValue } from '../lib/yamlDoc';
import { lintManifest, securityDiff, limitsOf, egressOf, capabilitiesOf, LIMIT_DEFAULTS } from './manifestLint';
import { FindingsList, SecurityDiffBlock, toolDiffRenderer, plainDiffRenderer } from './SecurityFindings';
import { McpFields } from './McpFields';

export function ToolEditorPage(props: { uid?: string }) {
  const params = useParams({ strict: false }) as { uid?: string };
  const uid = props.uid ?? params.uid;
  const tree = useConfigTree();
  if (!uid) return <Empty title="No tool selected" />;
  const entry = (tree.data ?? []).find((e) => e.uid === uid && (e.kind === 'tool' || e.kind === 'mcp'));
  if (tree.isLoading)
    return (
      <div className="flex h-full items-center justify-center">
        <Spin />
      </div>
    );
  if (entry?.kind === 'mcp')
    return (
      <WorkingTreeProvider key={uid} uid={uid} kind="mcp">
        <McpEditor />
      </WorkingTreeProvider>
    );
  return (
    <WorkingTreeProvider key={uid} uid={uid} kind="tool">
      <ToolEditor />
    </WorkingTreeProvider>
  );
}

type Tab = 'files' | 'manifest' | 'backlinks';

function useToolFindings() {
  const wt = useWorkingTree();
  const baseText = wt.state.base[wt.state.rootPath];
  const base = useMemo(() => {
    if (baseText == null) return null;
    const p = parseYamlValue(baseText);
    return p.ok ? p.value : null;
  }, [baseText]);
  const next = wt.parsed;
  const ep: string | undefined = next?.entrypoint;
  const epPath = ep && wt.state.dir ? `${wt.state.dir}/${ep}` : null;
  const epExists = epPath ? wt.getFile(epPath) != null : undefined;
  const diff = useMemo(() => (next ? securityDiff(base, next) : []), [base, next]);
  const lint = useMemo(() => (next ? lintManifest(next, { entrypointExists: epExists }) : []), [next, epExists]);
  return { base, next, diff, lint, epPath, risks: diff.filter((f) => f.severity === 'risk').length };
}

function ToolEditor() {
  const wt = useWorkingTree();
  const [tab, setTab] = useState<Tab>('files');
  const t = wt.parsed;
  const f = useToolFindings();
  const title = t?.title || wt.state.definition?.title || wt.uid;
  return (
    <EditorFrame<Tab>
      kindLabel={`Tool extension${t?.language ? ` · ${t.language}` : ''}`}
      title={title}
      subtitle={t?.slug}
      tabs={[
        { id: 'files', label: 'Files' },
        {
          id: 'manifest',
          label: (
            <span className="flex items-center gap-1">
              Manifest &amp; security
              {f.risks > 0 && <Pill tone="danger">{f.risks}</Pill>}
            </span>
          ),
        },
        { id: 'backlinks', label: <span className="flex items-center gap-1">Backlinks<Pill>{wt.state.definition?.referenced_by?.length ?? 0}</Pill></span> },
      ]}
      tab={tab}
      onTab={setTab}
      toolbar={
        f.risks > 0 && (
          <button type="button" onClick={() => setTab('manifest')} className="flex items-center gap-1 rounded-md border border-danger/40 bg-danger-soft px-2 py-1 text-xs font-medium text-danger-fg">
            <ShieldAlert className="size-3.5" aria-hidden />
            {f.risks} security-widening change{f.risks === 1 ? '' : 's'}
          </button>
        )
      }
      commitNotice={wt.state.dirty.has(wt.state.rootPath) && <SecurityDiffBlock base={f.base} next={f.next} />}
      defaultCommitMessage={`Update tool ${t?.slug ?? wt.uid}`}
      history={(close) => <HistorySidebar onClose={close} renderDiff={toolDiffRenderer} />}
      chat={<DesignerChatPanel kind="tool" renderDiff={toolDiffRenderer} placeholder="Describe a change to this tool…" />}
    >
      {tab === 'files' && (
        <div className="flex h-full min-h-0 flex-col">
          {t?.builtin && <div className="border-b border-line bg-info-soft px-4 py-1 text-xs text-info-fg">Built-in tool shipped with Breadboard. Edits here fork it in your config repo.</div>}
          <div className="min-h-0 flex-1">
            <FilesEditor newFilePlaceholder={t?.language === 'python' ? 'src/helpers.py' : 'src/helpers.ts'} protectedPaths={f.epPath ? [f.epPath] : []} aside={() => <LintStrip onOpen={() => setTab('manifest')} />} />
          </div>
        </div>
      )}
      {tab === 'manifest' && <ManifestPanel />}
      {tab === 'backlinks' && <ReferencesPanel noun="tool" />}
    </EditorFrame>
  );
}

function LintStrip({ onOpen }: { onOpen: () => void }) {
  const f = useToolFindings();
  const all = [...f.diff.filter((x) => x.severity !== 'info'), ...f.lint];
  if (!all.length) return null;
  return (
    <div className="max-h-40 overflow-y-auto border-t border-line bg-surface px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold">
        Manifest lint
        <button type="button" className="font-normal text-accent-text underline" onClick={onOpen}>
          details
        </button>
      </div>
      <FindingsList findings={all} />
    </div>
  );
}

function ManifestPanel() {
  const wt = useWorkingTree();
  const f = useToolFindings();
  const t = f.next;
  if (!t) return <Empty title="tool.yaml does not parse" hint={wt.parseError ?? undefined} />;
  const bl = limitsOf(f.base);
  const nl = limitsOf(t);
  const settings: Record<string, any> = t.settings ?? {};
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 p-4">
        <SecurityDiffBlock base={f.base} next={t} title={`Security-relevant changes vs base @${(wt.state.base_commit ?? '').slice(0, 8)}`} />
        <section className="rounded-md border border-line p-3">
          <h3 className="mb-2 text-sm font-semibold">Lint</h3>
          <FindingsList findings={f.lint} empty="No lint findings." />
        </section>
        <div className="grid gap-4 md:grid-cols-2">
          <section className="rounded-md border border-line p-3">
            <h3 className="mb-2 text-sm font-semibold">Limits</h3>
            <table className="w-full text-xs">
              <tbody>
                {(Object.keys(LIMIT_DEFAULTS) as Array<keyof typeof LIMIT_DEFAULTS>).map((k) => (
                  <tr key={k} className="border-t border-line first:border-0">
                    <td className="py-1 font-mono">{k}</td>
                    <td className="py-1 text-right tabular-nums">
                      {nl[k] !== bl[k] && f.base && <span className="mr-1 text-fg-subtle line-through">{bl[k]}</span>}
                      <span className={nl[k] > bl[k] && f.base ? 'font-semibold text-danger-fg' : ''}>{nl[k]}</span>
                      {t.limits?.[k] === undefined && <span className="ml-1 text-fg-subtle">(default)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="rounded-md border border-line p-3">
            <h3 className="mb-2 text-sm font-semibold">Egress allowlist</h3>
            <p className="mb-2 text-xs text-fg-muted">Default-deny; only these destinations are reachable from the sandbox.</p>
            {egressOf(t).length === 0 ? (
              <div className="text-xs text-fg-subtle">No egress.</div>
            ) : (
              <ul className="space-y-0.5 font-mono text-xs">
                {egressOf(t).map((r) => (
                  <li key={r.host}>
                    {r.host}:{r.ports.join(',')}
                  </li>
                ))}
              </ul>
            )}
            <h3 className="mt-3 mb-2 text-sm font-semibold">Broker capabilities</h3>
            {capabilitiesOf(t).length === 0 ? (
              <div className="text-xs text-fg-subtle">None.</div>
            ) : (
              <ul className="space-y-0.5 font-mono text-xs">
                {capabilitiesOf(t).map((c) => (
                  <li key={c.name}>
                    {c.name} <span className="text-fg-muted">({c.scope})</span>
                  </li>
                ))}
              </ul>
            )}
            <h3 className="mt-3 mb-1 text-sm font-semibold">Exposure</h3>
            <div className="text-xs">{t.exposure?.external_mcp ? <Pill tone="warn">exposed to external MCP clients</Pill> : 'Internal only'}</div>
          </section>
        </div>
        <section className="rounded-md border border-line p-3">
          <h3 className="mb-2 text-sm font-semibold">Settings</h3>
          <p className="mb-2 text-xs text-fg-muted">Per-grant settings Subagents can be configured with. Hidden settings are enforced server-side and invisible to the model.</p>
          {Object.keys(settings).length === 0 ? (
            <div className="text-xs text-fg-subtle">No settings.</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-left text-fg-muted">
                <tr>
                  <th className="py-1 font-medium">Key</th>
                  <th className="py-1 font-medium">Type</th>
                  <th className="py-1 font-medium">Default</th>
                  <th className="py-1 font-medium">Visibility</th>
                  <th className="py-1 font-medium">Description</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(settings).map(([k, s]) => (
                  <tr key={k} className="border-t border-line">
                    <td className="py-1 font-mono">{k}</td>
                    <td className="py-1">{s?.type}</td>
                    <td className="py-1 font-mono">{s?.default === undefined ? '' : JSON.stringify(s.default)}</td>
                    <td className="py-1">{s?.hidden ? <Pill tone="info">hidden</Pill> : 'visible'}</td>
                    <td className="py-1 text-fg-muted">{s?.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ MCP */

type McpTab = 'form' | 'yaml' | 'backlinks';

function McpEditor() {
  const wt = useWorkingTree();
  const [tab, setTab] = useState<McpTab>('form');
  const m = wt.parsed;
  return (
    <EditorFrame<McpTab>
      kindLabel={`MCP server${m?.transport ? ` · ${m.transport}` : ''}`}
      title={m?.title || wt.state.definition?.title || wt.uid}
      subtitle={m?.slug}
      tabs={[
        { id: 'form', label: 'Configuration' },
        { id: 'yaml', label: 'YAML' },
        { id: 'backlinks', label: <span className="flex items-center gap-1">Backlinks<Pill>{wt.state.definition?.referenced_by?.length ?? 0}</Pill></span> },
      ]}
      tab={tab}
      onTab={setTab}
      defaultCommitMessage={`Update MCP server ${m?.slug ?? wt.uid}`}
      history={(close) => <HistorySidebar onClose={close} renderDiff={plainDiffRenderer} />}
      chat={<DesignerChatPanel kind="tool" renderDiff={plainDiffRenderer} placeholder="Describe a change to this MCP onboarding…" />}
    >
      {tab === 'form' &&
        (m ? (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-3xl p-4">
              <McpFields value={m} patch={(fn) => wt.editYamlFile((d) => void fn(d))} />
            </div>
          </div>
        ) : (
          <Empty title="The MCP YAML does not parse" hint={wt.parseError ?? undefined} />
        ))}
      {tab === 'yaml' && (
        <div className="flex h-full min-h-0 flex-col">
          {wt.parseError && <div className="border-b border-line px-3 py-1 text-xs text-danger-fg">YAML error: {wt.parseError}</div>}
          <div className="min-h-0 flex-1 overflow-auto">
            <CodeEditor language="yaml" value={wt.rootText} onChange={(t) => wt.setFile(wt.state.rootPath, t)} minHeight={400} className="h-full" ariaLabel="MCP YAML" />
          </div>
        </div>
      )}
      {tab === 'backlinks' && <ReferencesPanel noun="MCP server" />}
    </EditorFrame>
  );
}

