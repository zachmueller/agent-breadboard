/**
 * Subagent editor ([05] §2, §7): form over the configuration components (identity, model preset,
 * system prompt with live Knowledge Note injection, tool / MCP / circuit grants, knowledge domains,
 * primitive allowlist), a YAML tab, backlinks, history, and the subagent-designer chat.
 * Every referenced item clicks through to its own editor.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Trash2, BookOpen, AlertTriangle } from 'lucide-react';
import { WorkingTreeProvider, useWorkingTree, errorsFor } from '../model/workingTree';
import { EditorFrame } from '../components/EditorFrame';
import { HistorySidebar } from '../components/HistorySidebar';
import { DesignerChatPanel } from '../chat/DesignerChatPanel';
import { ReferencesPanel, type UseRef } from '../components/ReferencedBy';
import { CodeEditor } from '../components/CodeEditor';
import { ConfigPicker } from '../components/ConfigPicker';
import { AppLink } from '../components/AppLink';
import { LazyInput, TagsInput, ToolSettingsForm, ValidationList } from '../components/fields';
import { Btn, Empty, Field, Pill, SelectInput, TextAreaInput } from '../ui';
import { miscApi, useDefinition, useKnowledgeDomains, usePresets } from '../lib/configApi';
import { hrefFor } from '../lib/format';
import { SLUG_RE } from '../lib/inventory';
import { knowledgeCompletion, knowledgeRefs } from '../lib/templateComplete';
import { setOrDelete } from '../circuits/StepInspector';
import { PRIMITIVES, DEFAULT_PRIMITIVES, effectivePrimitives, grantHints, isMcpGrant, isToolGrant } from './model';
import { subagentDiffRenderer } from './SubagentDiff';

export function SubagentEditorPage(props: { uid?: string }) {
  const params = useParams({ strict: false }) as { uid?: string };
  const uid = props.uid ?? params.uid;
  if (!uid) return <Empty title="No subagent selected" />;
  return (
    <WorkingTreeProvider key={uid} uid={uid} kind="subagent">
      <SubagentEditor />
    </WorkingTreeProvider>
  );
}

type Tab = 'config' | 'yaml' | 'backlinks';

function usesOf(s: any): UseRef[] {
  const out: UseRef[] = [];
  (Array.isArray(s?.tools) ? s.tools : []).forEach((g: any, i: number) => {
    if (isToolGrant(g)) out.push({ kind: 'tool', uid: g.tool, where: `tools[${i}]` });
    else if (isMcpGrant(g)) out.push({ kind: 'mcp', uid: g.mcp, where: `tools[${i}]` });
  });
  (Array.isArray(s?.circuits) ? s.circuits : []).forEach((c: any, i: number) => c?.circuit && out.push({ kind: 'circuit', uid: c.circuit, where: `circuits[${i}] · ${c.access ?? 'read'}` }));
  return out;
}

function SubagentEditor() {
  const wt = useWorkingTree();
  const [tab, setTab] = useState<Tab>('config');
  const s = wt.parsed;
  const uses = useMemo(() => usesOf(s), [s]);
  return (
    <EditorFrame<Tab>
      kindLabel={`Subagent${s?.model_preset ? ` · ${s.model_preset}` : ''}`}
      title={s?.title || wt.state.definition?.title || wt.uid}
      subtitle={s?.slug}
      tabs={[
        { id: 'config', label: 'Configuration' },
        { id: 'yaml', label: 'YAML' },
        { id: 'backlinks', label: <span className="flex items-center gap-1">Backlinks<Pill>{wt.state.definition?.referenced_by?.length ?? 0}</Pill></span> },
      ]}
      tab={tab}
      onTab={setTab}
      defaultCommitMessage={`Update subagent ${s?.slug ?? wt.uid}`}
      history={(close) => <HistorySidebar onClose={close} renderDiff={subagentDiffRenderer} />}
      chat={<DesignerChatPanel kind="subagent" placeholder="Describe a change to this subagent…" />}
    >
      {tab === 'config' && (s ? <ConfigForm /> : <Empty title="The subagent YAML does not parse" hint={wt.parseError ?? 'Fix it in the YAML tab.'} />)}
      {tab === 'yaml' && (
        <div className="flex h-full min-h-0 flex-col">
          {wt.parseError && <div className="border-b border-line px-3 py-1 text-xs text-danger-fg">YAML error: {wt.parseError}</div>}
          <div className="min-h-0 flex-1 overflow-auto">
            <CodeEditor language="yaml" value={wt.rootText} onChange={(t) => wt.setFile(wt.state.rootPath, t)} minHeight={400} className="h-full" ariaLabel="Subagent YAML" />
          </div>
        </div>
      )}
      {tab === 'backlinks' && <ReferencesPanel noun="subagent" uses={uses} />}
    </EditorFrame>
  );
}

/* ------------------------------------------------------------------ form */

function Card({ title, hint, actions, errors, children }: { title: ReactNode; hint?: ReactNode; actions?: ReactNode; errors?: string[]; children: ReactNode }) {
  return (
    <section className="rounded-md border border-line bg-surface p-3">
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          {hint && <p className="text-xs text-fg-muted">{hint}</p>}
        </div>
        {actions}
      </div>
      {errors && errors.length > 0 && <ValidationList errors={errors} className="mb-2" max={10} />}
      {children}
    </section>
  );
}

function ConfigForm() {
  const wt = useWorkingTree();
  const s = wt.parsed;
  const edit = (fn: (d: any) => void) => wt.editYamlFile((d) => void fn(d));
  const hints = grantHints(s);
  const claimed = ['title', 'slug', 'description', 'model_preset', 'system_prompt', 'tools', 'circuits', 'knowledge', 'primitives'];
  const otherErrors = wt.errors.filter((e) => !errorsFor([e], ...claimed).length);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 p-4">
        {otherErrors.length > 0 && <ValidationList errors={otherErrors} warnings={wt.warnings} max={10} />}
        {hints.length > 0 && (
          <ul className="space-y-1 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn-fg">
            {hints.map((h) => (
              <li key={h} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span className="font-medium">Warning</span>
                <span>{h}</span>
              </li>
            ))}
          </ul>
        )}
        <IdentityCard edit={edit} />
        <PresetCard edit={edit} />
        <PromptCard edit={edit} />
        <ToolsCard edit={edit} />
        <McpCard edit={edit} />
        <CircuitsCard edit={edit} />
        <KnowledgeCard edit={edit} />
        <PrimitivesCard edit={edit} />
      </div>
    </div>
  );
}

type Edit = (fn: (d: any) => void) => void;

function IdentityCard({ edit }: { edit: Edit }) {
  const wt = useWorkingTree();
  const s = wt.parsed;
  return (
    <Card title="Identity" hint={<>UID <span className="font-mono">{wt.uid}</span> is permanent; the slug is display metadata, so renames never move files.</>} errors={errorsFor(wt.errors, 'title', 'slug', 'description')}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Title">
          <LazyInput value={s.title ?? ''} onCommit={(v) => edit((d) => void (d.title = v))} />
        </Field>
        <Field label="Slug">
          <LazyInput mono value={s.slug ?? ''} validate={(v) => (SLUG_RE.test(v) ? null : 'lowercase letters, digits and dashes')} onCommit={(v) => edit((d) => void (d.slug = v))} />
        </Field>
      </div>
      <Field label="Description" className="mt-3" hint="What this expert is for. Shown to triage and circuit designers.">
        <TextAreaInput rows={2} value={s.description ?? ''} onChange={(e) => edit((d) => setOrDelete(d, 'description', e.target.value))} />
      </Field>
    </Card>
  );
}

function PresetCard({ edit }: { edit: Edit }) {
  const wt = useWorkingTree();
  const presets = usePresets();
  const all = presets.data?.presets ?? {};
  const names = Object.keys(all);
  const cur: string = wt.parsed.model_preset ?? '';
  const unknown = !!cur && names.length > 0 && !names.includes(cur);
  const list = all[cur] ?? [];
  return (
    <Card title="Model preset" hint="A Breadboard-level tier resolved through an ordered fallback list (presets/models.yaml)." errors={errorsFor(wt.errors, 'model_preset')}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="w-48">
          <SelectInput aria-label="Model preset" invalid={unknown || !cur} value={cur} onChange={(e) => edit((d) => void (d.model_preset = e.target.value))}>
            {!cur && <option value="">Select a preset…</option>}
            {unknown && <option value={cur}>{cur} (unknown)</option>}
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </SelectInput>
          {unknown && <div className="mt-1 text-[11px] text-danger-fg">"{cur}" is not defined in presets/models.yaml; commit will be rejected.</div>}
          {presets.isError && <div className="mt-1 text-[11px] text-fg-subtle">Presets could not be loaded.</div>}
        </div>
        {list.length > 0 && (
          <ol className="min-w-0 flex-1 space-y-0.5 text-xs">
            {list.map((m: any, i: number) => (
              <li key={i} className="flex items-center gap-2">
                <span className="w-14 text-fg-subtle">{i === 0 ? 'primary' : `fallback ${i}`}</span>
                <span className="font-mono">{m.model_id}</span>
                {m.provider && <span className="text-fg-subtle">{m.provider}</span>}
                {Array.isArray(m.requires) && m.requires.map((r: string) => <Pill key={r}>{r}</Pill>)}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}

function PromptCard({ edit }: { edit: Edit }) {
  const wt = useWorkingTree();
  const prompt: string = wt.parsed.system_prompt ?? '';
  const refs = useMemo(() => knowledgeRefs(prompt), [prompt]);
  const extensions = useMemo(() => [knowledgeCompletion(miscApi.knowledgeSearch)], []);
  const readable: string[] = wt.parsed.knowledge?.read ?? [];
  return (
    <Card
      title="System prompt"
      hint={
        <>
          Markdown. Type <span className="font-mono">{'{{knowledge:'}</span> to inject a live Knowledge Note, resolved at each step start from a domain this subagent can read. System tenets are prepended automatically.
        </>
      }
      errors={errorsFor(wt.errors, 'system_prompt')}
    >
      <div className="overflow-hidden rounded-md border border-line">
        <CodeEditor language="markdown" value={prompt} extensions={extensions} onChange={(t) => edit((d) => void (d.system_prompt = t))} minHeight={220} maxHeight={560} ariaLabel="System prompt" />
      </div>
      {refs.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-xs font-medium text-fg-muted">Injected Knowledge Notes</div>
          <ul className="divide-y divide-line rounded-md border border-line">
            {refs.map((uid) => (
              <NoteRef key={uid} uid={uid} readable={readable} />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function NoteRef({ uid, readable }: { uid: string; readable: string[] }) {
  const n = useQuery({ queryKey: ['nodes', uid, 'title'], queryFn: () => miscApi.node(uid), staleTime: 60_000, retry: false });
  const d: any = n.data;
  const domains: string[] | undefined = d?.properties?.domains ?? d?.domains;
  const unreadable = Array.isArray(domains) && !domains.some((x) => readable.includes(x));
  return (
    <li className="flex items-center gap-2 px-3 py-1.5 text-xs">
      <BookOpen className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
      <AppLink href={hrefFor('knowledge', uid)} className="font-medium hover:underline">
        {d?.title ?? (n.isLoading ? 'Loading…' : uid)}
      </AppLink>
      <span className="font-mono text-fg-subtle">{uid}</span>
      {n.isError && <Pill tone="danger">not found</Pill>}
      {d?.type && d.type !== 'knowledge' && <Pill tone="danger">not a Knowledge Note</Pill>}
      {Array.isArray(domains) && (
        <span className="ml-auto flex items-center gap-1">
          {domains.map((x) => (
            <Pill key={x} tone={readable.includes(x) ? 'neutral' : 'warn'}>
              {x}
            </Pill>
          ))}
          {unreadable && <Pill tone="danger">not readable</Pill>}
        </span>
      )}
    </li>
  );
}

function RemoveBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="rounded p-1 text-fg-subtle hover:bg-hover hover:text-danger-fg">
      <Trash2 className="size-3.5" />
    </button>
  );
}

function ToolsCard({ edit }: { edit: Edit }) {
  const wt = useWorkingTree();
  const tools: any[] = Array.isArray(wt.parsed.tools) ? wt.parsed.tools : [];
  const grants = tools.map((g, i) => ({ g, i })).filter((x) => isToolGrant(x.g));
  const setGrant = (i: number, fn: (g: any) => void) => edit((d) => fn(d.tools[i]));
  return (
    <Card title="Tool extensions" hint="Explicit allowlist (default: none). Per-grant settings narrow the tool; hidden settings are enforced server-side and invisible to the model." errors={errorsFor(wt.errors, 'tools')}>
      {grants.length === 0 && <div className="mb-2 text-xs text-fg-subtle">No tools granted.</div>}
      <div className="space-y-2">
        {grants.map(({ g, i }) => (
          <div key={`${g.tool}-${i}`} className="rounded-md border border-line p-2">
            <div className="mb-2 flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <ConfigPicker kind="tool" value={g.tool} exclude={grants.filter((x) => x.i !== i).map((x) => x.g.tool)} onChange={(uid) => uid && setGrant(i, (x) => void (x.tool = uid))} />
              </div>
              <RemoveBtn label="Revoke tool" onClick={() => edit((d) => void d.tools.splice(i, 1))} />
            </div>
            <ToolSettingsForm toolUid={g.tool} value={g.settings} onChange={(v) => setGrant(i, (x) => setOrDelete(x, 'settings', v))} />
          </div>
        ))}
      </div>
      <div className="mt-2 max-w-sm">
        <ConfigPicker
          kind="tool"
          value={null}
          showLink={false}
          exclude={grants.map((x) => x.g.tool)}
          placeholder="Grant a tool…"
          onChange={(uid) => uid && edit((d) => void (d.tools = [...(Array.isArray(d.tools) ? d.tools : []), { tool: uid }]))}
        />
      </div>
    </Card>
  );
}

function McpCard({ edit }: { edit: Edit }) {
  const wt = useWorkingTree();
  const tools: any[] = Array.isArray(wt.parsed.tools) ? wt.parsed.tools : [];
  const grants = tools.map((g, i) => ({ g, i })).filter((x) => isMcpGrant(x.g));
  return (
    <Card title="MCP servers" hint="Onboarded MCP servers. The effective tool set is the server's allowlist intersected with this grant's allowlist." errors={errorsFor(wt.errors, 'tools')}>
      {grants.length === 0 && <div className="mb-2 text-xs text-fg-subtle">No MCP servers granted.</div>}
      <div className="space-y-2">
        {grants.map(({ g, i }) => (
          <McpGrantRow key={`${g.mcp}-${i}`} grant={g} exclude={grants.filter((x) => x.i !== i).map((x) => x.g.mcp)} onPatch={(fn) => edit((d) => fn(d.tools[i]))} onRemove={() => edit((d) => void d.tools.splice(i, 1))} />
        ))}
      </div>
      <div className="mt-2 max-w-sm">
        <ConfigPicker
          kind="mcp"
          value={null}
          showLink={false}
          exclude={grants.map((x) => x.g.mcp)}
          placeholder="Grant an MCP server…"
          onChange={(uid) => uid && edit((d) => void (d.tools = [...(Array.isArray(d.tools) ? d.tools : []), { mcp: uid, allow: [] }]))}
        />
      </div>
    </Card>
  );
}

function McpGrantRow({ grant, exclude, onPatch, onRemove }: { grant: { mcp: string; allow?: string[] }; exclude: string[]; onPatch: (fn: (g: any) => void) => void; onRemove: () => void }) {
  const server = useDefinition(grant.mcp);
  const serverAllow: string[] | undefined = (server.data?.definition as any)?.tools?.allow;
  const inherit = grant.allow === undefined;
  const outside = !inherit && serverAllow ? grant.allow!.filter((t) => !serverAllow.includes(t)) : [];
  const effective = inherit ? serverAllow : serverAllow ? grant.allow!.filter((t) => serverAllow.includes(t)) : grant.allow;
  return (
    <div className="rounded-md border border-line p-2">
      <div className="mb-2 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <ConfigPicker kind="mcp" value={grant.mcp} exclude={exclude} onChange={(uid) => uid && onPatch((g) => void (g.mcp = uid))} />
        </div>
        <RemoveBtn label="Revoke MCP server" onClick={onRemove} />
      </div>
      <div className="grid gap-2 text-xs md:grid-cols-[10rem_1fr]">
        <div className="text-fg-muted">Server allowlist</div>
        <div className="font-mono">{server.isLoading ? '…' : serverAllow === undefined ? <span className="font-sans text-fg-muted">all tools the server exposes</span> : serverAllow.length ? serverAllow.join(', ') : <span className="font-sans text-fg-muted">none</span>}</div>
        <div className="pt-1 text-fg-muted">This grant</div>
        <div className="space-y-1">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={inherit} onChange={(e) => onPatch((g) => (e.target.checked ? void delete g.allow : void (g.allow = serverAllow ? [...serverAllow] : [])))} />
            Inherit the server allowlist
          </label>
          {!inherit && <TagsInput value={grant.allow ?? []} placeholder="search, read_document" onChange={(v) => onPatch((g) => void (g.allow = v))} />}
          {!inherit && grant.allow!.length === 0 && <div className="text-warn-fg">Empty allowlist: no tools from this server are available.</div>}
          {outside.length > 0 && <div className="text-warn-fg">Not allowed by the server, so unavailable: {outside.join(', ')}</div>}
        </div>
        <div className="text-fg-muted">Effective</div>
        <div className="font-mono">{effective === undefined ? <span className="font-sans text-fg-muted">all tools the server exposes</span> : effective.length ? effective.join(', ') : <span className="font-sans text-fg-muted">none</span>}</div>
      </div>
    </div>
  );
}

function CircuitsCard({ edit }: { edit: Edit }) {
  const wt = useWorkingTree();
  const circuits: any[] = Array.isArray(wt.parsed.circuits) ? wt.parsed.circuits : [];
  return (
    <Card
      title="Circuit access"
      hint="Discretionary access only: read inspects the definition, execute invokes it as a sub-session via run_circuit. A circuit's own flow needs no grant."
      errors={errorsFor(wt.errors, 'circuits')}
    >
      {circuits.length === 0 && <div className="mb-2 text-xs text-fg-subtle">No circuit grants.</div>}
      <div className="space-y-1">
        {circuits.map((c, i) => (
          <div key={`${c.circuit}-${i}`} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <ConfigPicker kind="circuit" value={c.circuit} exclude={circuits.filter((_, j) => j !== i).map((x) => x.circuit)} onChange={(uid) => uid && edit((d) => void (d.circuits[i].circuit = uid))} />
            </div>
            <SelectInput aria-label="Access" className="w-28" value={c.access ?? 'read'} onChange={(e) => edit((d) => void (d.circuits[i].access = e.target.value))}>
              <option value="read">read</option>
              <option value="execute">execute</option>
            </SelectInput>
            <RemoveBtn label="Revoke circuit grant" onClick={() => edit((d) => void d.circuits.splice(i, 1))} />
          </div>
        ))}
      </div>
      <div className="mt-2 max-w-sm">
        <ConfigPicker
          kind="circuit"
          value={null}
          showLink={false}
          exclude={circuits.map((x) => x.circuit)}
          placeholder="Grant a circuit…"
          onChange={(uid) => uid && edit((d) => void (d.circuits = [...(Array.isArray(d.circuits) ? d.circuits : []), { circuit: uid, access: 'read' }]))}
        />
      </div>
    </Card>
  );
}

function KnowledgeCard({ edit }: { edit: Edit }) {
  const wt = useWorkingTree();
  const domains = useKnowledgeDomains();
  const read: string[] = wt.parsed.knowledge?.read ?? [];
  const write: string[] = wt.parsed.knowledge?.write ?? [];
  const known = (domains.data ?? []).map((d) => d.slug);
  const all = [...new Set([...known, ...read, ...write])];
  const toggle = (side: 'read' | 'write', slug: string, on: boolean) =>
    edit((d) => {
      d.knowledge = { read: [], write: [], ...(d.knowledge ?? {}) };
      const cur: string[] = d.knowledge[side] ?? [];
      d.knowledge[side] = on ? [...cur.filter((x) => x !== slug), slug] : cur.filter((x) => x !== slug);
    });
  return (
    <Card title="Knowledge access" hint="Read scopes search, RAG and prompt injection; write gates the AI-edit (reconcile) path." errors={errorsFor(wt.errors, 'knowledge')}>
      {all.length === 0 ? (
        <div className="text-xs text-fg-subtle">{domains.isLoading ? 'Loading domains…' : 'No Knowledge Domains are defined.'}</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-left text-fg-muted">
            <tr>
              <th className="py-1 font-medium">Domain</th>
              <th className="w-16 py-1 text-center font-medium">Read</th>
              <th className="w-16 py-1 text-center font-medium">Write</th>
            </tr>
          </thead>
          <tbody>
            {all.map((slug) => {
              const info = domains.data?.find((d) => d.slug === slug);
              const r = read.includes(slug);
              const w = write.includes(slug);
              return (
                <tr key={slug} className="border-t border-line">
                  <td className="py-1">
                    <span className="font-mono">{slug}</span>
                    {!known.includes(slug) && !domains.isLoading && (
                      <Pill tone="danger" className="ml-1">
                        unknown domain
                      </Pill>
                    )}
                    {w && !r && (
                      <Pill tone="warn" className="ml-1">
                        write without read
                      </Pill>
                    )}
                    {info?.description && <div className="text-fg-subtle">{info.description}</div>}
                  </td>
                  <td className="py-1 text-center">
                    <input type="checkbox" aria-label={`Read ${slug}`} checked={r} onChange={(e) => toggle('read', slug, e.target.checked)} />
                  </td>
                  <td className="py-1 text-center">
                    <input type="checkbox" aria-label={`Write ${slug}`} checked={w} onChange={(e) => toggle('write', slug, e.target.checked)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function PrimitivesCard({ edit }: { edit: Edit }) {
  const wt = useWorkingTree();
  const p = effectivePrimitives(wt.parsed);
  const groups = [...new Set(PRIMITIVES.map((x) => x.group))];
  const unknown = p.list.filter((x) => !PRIMITIVES.some((y) => y.name === x));
  const set = (name: string, on: boolean) => edit((d) => void (d.primitives = on ? [...new Set([...(d.primitives ?? []), name])] : (d.primitives ?? []).filter((x: string) => x !== name)));
  return (
    <Card
      title="Breadboard primitives"
      hint={p.custom ? 'Explicit allowlist of built-in Breadboard MCP primitives.' : 'Using the default primitive set. Customize to pin an explicit allowlist.'}
      errors={errorsFor(wt.errors, 'primitives')}
      actions={
        p.custom ? (
          <Btn variant="ghost" size="sm" onClick={() => edit((d) => void delete d.primitives)}>
            Reset to default
          </Btn>
        ) : (
          <Btn variant="secondary" size="sm" onClick={() => edit((d) => void (d.primitives = [...DEFAULT_PRIMITIVES]))}>
            Customize
          </Btn>
        )
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        {groups.map((g) => (
          <fieldset key={g} disabled={!p.custom} className="min-w-0">
            <legend className="mb-1 text-xs font-medium text-fg-muted">{g}</legend>
            <ul className="space-y-0.5">
              {PRIMITIVES.filter((x) => x.group === g).map((x) => (
                <li key={x.name}>
                  <label className={`flex items-start gap-1.5 text-xs ${p.custom ? '' : 'opacity-70'}`} title={x.description}>
                    <input type="checkbox" className="mt-0.5" checked={p.list.includes(x.name)} onChange={(e) => set(x.name, e.target.checked)} />
                    <span>
                      <span className="font-mono">{x.name}</span>
                      <span className="ml-1 text-fg-subtle">{x.description}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        ))}
      </div>
      {unknown.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
          <span className="text-danger-fg">Unknown primitives:</span>
          {unknown.map((x) => (
            <span key={x} className="inline-flex items-center gap-1">
              <Pill tone="danger">{x}</Pill>
              <RemoveBtn label={`Remove ${x}`} onClick={() => set(x, false)} />
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}
