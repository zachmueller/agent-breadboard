/**
 * Circuit editor ([03] §8.2): flow canvas + inspector, two-way YAML, evals ([04] §6), backlinks,
 * version history sidebar, and the always-visible circuit-designer chat ([10] §4).
 */
import { useMemo, useState, useEffect } from 'react';
import { useParams } from '@tanstack/react-router';
import { Plus, Bot, Code2, Workflow, ShieldCheck, Flag, Settings2 } from 'lucide-react';
import { WorkingTreeProvider, useWorkingTree, errorsFor } from '../model/workingTree';
import { EditorFrame } from '../components/EditorFrame';
import { HistorySidebar } from '../components/HistorySidebar';
import { DesignerChatPanel } from '../chat/DesignerChatPanel';
import { FilesEditor } from '../components/FilesEditor';
import { ReferencesPanel, type UseRef } from '../components/ReferencedBy';
import { Btn, Empty, Pill } from '../ui';
import { deriveGraph, stepRef, type StepKind } from '../lib/circuitGraph';
import { FlowCanvas } from './FlowCanvas';
import { StepInspector } from './StepInspector';
import { CircuitInspector } from './CircuitInspector';
import { circuitDiffRenderer } from './FlowDiff';
import { EvalsTab } from './EvalsTab';
import { connect, deleteEdges, deleteNodes, newStep, newCircuitExit } from './ops';

type Tab = 'flow' | 'yaml' | 'evals' | 'backlinks';
const TABS: Tab[] = ['flow', 'yaml', 'evals', 'backlinks'];

function initialTab(): Tab {
  const t = new URLSearchParams(window.location.search).get('tab') as Tab | null;
  return t && TABS.includes(t) ? t : 'flow';
}

export function CircuitEditorPage(props: { uid?: string }) {
  const params = useParams({ strict: false }) as { uid?: string };
  const uid = props.uid ?? params.uid;
  if (!uid) return <Empty title="No circuit selected" />;
  return (
    <WorkingTreeProvider key={uid} uid={uid} kind="circuit">
      <CircuitEditor />
    </WorkingTreeProvider>
  );
}

function CircuitEditor() {
  const wt = useWorkingTree();
  const [tab, setTab] = useState<Tab>(initialTab);
  const onTab = (t: Tab) => {
    setTab(t);
    const url = new URL(window.location.href);
    if (t === 'flow') url.searchParams.delete('tab');
    else url.searchParams.set('tab', t);
    window.history.replaceState(window.history.state, '', url);
  };
  const c = wt.parsed;
  const title = c?.title || wt.state.definition?.title || wt.uid;
  const evalErrors = errorsFor(wt.errors, 'rubric', 'fixtures').length;
  return (
    <EditorFrame<Tab>
      kindLabel="Circuit"
      title={title}
      subtitle={c?.slug ?? wt.state.definition?.slug ?? undefined}
      tabs={[
        { id: 'flow', label: 'Flow' },
        { id: 'yaml', label: 'YAML' },
        { id: 'evals', label: <span className="flex items-center gap-1">Evals{evalErrors > 0 && <Pill tone="danger">{evalErrors}</Pill>}</span> },
        { id: 'backlinks', label: <span className="flex items-center gap-1">Backlinks<Pill>{wt.state.definition?.referenced_by?.length ?? 0}</Pill></span> },
      ]}
      tab={tab}
      onTab={onTab}
      defaultCommitMessage={`Update circuit ${c?.slug ?? wt.uid}`}
      history={(close) => <HistorySidebar onClose={close} renderDiff={circuitDiffRenderer} canRunEvals />}
      chat={<DesignerChatPanel kind="circuit" renderDiff={circuitDiffRenderer} canRunEvals placeholder="Describe a change to this circuit…" />}
    >
      {tab === 'flow' && <FlowTab />}
      {tab === 'yaml' && <YamlTab />}
      {tab === 'evals' && <EvalsTab />}
      {tab === 'backlinks' && <BacklinksTab />}
    </EditorFrame>
  );
}

/* ------------------------------------------------------------------ flow */

const ADD: Array<{ kind: StepKind; label: string; icon: typeof Bot }> = [
  { kind: 'llm', label: 'LLM step', icon: Bot },
  { kind: 'code', label: 'Code step', icon: Code2 },
  { kind: 'circuit', label: 'Sub-circuit', icon: Workflow },
  { kind: 'gate', label: 'Hard gate', icon: ShieldCheck },
];

function FlowTab() {
  const wt = useWorkingTree();
  const c = wt.parsed;
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const graph = useMemo(() => deriveGraph(c), [c]);
  const errorsByStep = useMemo(() => {
    const out: Record<string, number> = {};
    (c?.steps ?? []).forEach((s: any, i: number) => {
      const n = errorsFor(wt.errors, `steps.${i}.`, `steps.${i}:`).length;
      if (s?.id && n) out[s.id] = n;
    });
    return out;
  }, [c, wt.errors]);

  // Drop a selection whose node disappeared (deleted, renamed via YAML, discarded edits).
  useEffect(() => {
    if (selected && !graph.nodes.some((n) => n.id === selected)) setSelected(null);
  }, [graph, selected]);

  if (!c) {
    return (
      <div className="p-6">
        <Empty title="The circuit YAML does not parse" hint={wt.parseError ?? undefined} />
      </div>
    );
  }

  const add = (kind: StepKind) => {
    let id = '';
    wt.editYamlFile((d) => void (id = newStep(d, kind)));
    if (id) setSelected(`step:${id}`);
    setMenu(false);
  };
  const addExit = () => {
    let name = '';
    wt.editYamlFile((d) => void (name = newCircuitExit(d)));
    if (name) setSelected(`exit:${name}`);
  };
  const selectedStep = selected?.startsWith('step:') ? selected.slice(5) : null;
  const selectedExit = selected?.startsWith('exit:') ? selected.slice(5) : null;

  const toolbar = (
    <div className="flex items-center gap-1">
      <div className="relative">
        <Btn size="xs" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => setMenu(!menu)} aria-expanded={menu}>
          Step
        </Btn>
        {menu && (
          <div className="absolute top-7 left-0 z-20 w-40 rounded-md border border-line bg-surface p-1 shadow-pop">
            {ADD.map(({ kind, label, icon: Icon }) => (
              <button key={kind} type="button" className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-hover" onClick={() => add(kind)}>
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>
        )}
      </div>
      <Btn size="xs" variant="secondary" icon={<Flag className="size-3.5" />} onClick={addExit}>
        Exit
      </Btn>
      <Btn size="xs" variant={selected ? 'ghost' : 'secondary'} icon={<Settings2 className="size-3.5" />} onClick={() => setSelected(null)}>
        Circuit
      </Btn>
    </div>
  );

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        <FlowCanvas
          graph={graph}
          uid={wt.uid}
          editable
          selectedId={selected}
          onSelect={setSelected}
          errorsByStep={errorsByStep}
          toolbar={toolbar}
          className="h-full"
          onConnect={(source, handle, target) => {
            wt.editYamlFile((d) => void connect(d, source, handle, target));
          }}
          onDeleteEdges={(ids) => wt.editYamlFile((d) => deleteEdges(d, ids))}
          onDeleteNodes={(ids) => {
            wt.editYamlFile((d) => deleteNodes(d, ids));
            if (selected && ids.includes(selected)) setSelected(null);
          }}
        />
      </div>
      <aside className="w-[26rem] shrink-0 overflow-y-auto border-l border-line bg-surface">
        {selectedStep ? (
          <StepInspector key={selectedStep} stepId={selectedStep} onRenamed={(id) => setSelected(`step:${id}`)} onDeleted={() => setSelected(null)} />
        ) : (
          <CircuitInspector selectedExit={selectedExit} />
        )}
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ yaml */

function YamlTab() {
  const { dir } = useWorkingTree().state;
  const ensure = dir ? [`${dir}/rubric.yaml`, `${dir}/fixtures.yaml`] : [];
  return <FilesEditor ensure={ensure} newFilePlaceholder="prompts/new.md" />;
}

/* ------------------------------------------------------------------ backlinks */

function BacklinksTab() {
  const wt = useWorkingTree();
  const uses = useMemo(() => {
    const out: UseRef[] = [];
    for (const s of wt.parsed?.steps ?? []) {
      const r = stepRef(s);
      if (!r) continue;
      out.push({ kind: s.kind === 'llm' ? 'subagent' : s.kind === 'code' ? 'tool' : 'circuit', uid: r, where: `step ${s.id}` });
      for (const t of s.tools_override ?? []) out.push({ kind: 'tool', uid: t, where: `step ${s.id}` });
    }
    return out;
  }, [wt.parsed]);
  return <ReferencesPanel noun="circuit" uses={uses} />;
}
