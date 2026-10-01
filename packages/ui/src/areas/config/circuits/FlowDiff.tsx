/**
 * Native circuit diff ([10] §4 proposal review, [03] §8.2 history): side-by-side read-only flow
 * canvases with added/removed/modified marks, a summary of circuit-level changes, and the
 * YAML / prompt / rubric / fixture file diffs underneath.
 */
import { useMemo, useState } from 'react';
import { deriveGraph, diffCircuits, markGraph } from '../lib/circuitGraph';
import { FlowCanvas } from './FlowCanvas';
import { MultiFileDiff } from '../components/Diff';
import { Pill, TabBar } from '../ui';
import type { DiffRenderer, Snapshot } from '../components/snapshot';

function promptOfFactory(base: Snapshot, next: Snapshot) {
  return (stepId: string, side: 'base' | 'next') => {
    const snap = side === 'base' ? base : next;
    const step = (snap.parsed?.steps ?? []).find((s: any) => s?.id === stepId);
    if (!step) return undefined;
    if (step.prompt_inline !== undefined) return String(step.prompt_inline);
    return step.prompt && snap.dir ? snap.files[`${snap.dir}/${step.prompt}`] : undefined;
  };
}

export function FlowDiff({ base, next }: { base: Snapshot; next: Snapshot }) {
  const [view, setView] = useState<'flow' | 'files'>('flow');
  const diff = useMemo(() => diffCircuits(base.parsed, next.parsed, promptOfFactory(base, next)), [base, next]);
  const baseGraph = useMemo(() => markGraph(deriveGraph(base.parsed), diff, 'base'), [base, diff]);
  const nextGraph = useMemo(() => markGraph(deriveGraph(next.parsed), diff, 'next'), [next, diff]);
  const uid = next.parsed?.uid ?? base.parsed?.uid;
  const counts = { added: 0, removed: 0, modified: 0 };
  for (const m of Object.values(diff.steps)) counts[m]++;
  const edgeChanges = Object.keys(diff.edges).length;
  const prefix = (next.dir ?? base.dir ?? '') && `${next.dir ?? base.dir}/`;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <TabBar
          tabs={[
            { id: 'flow', label: 'Flow' },
            { id: 'files', label: 'Files' },
          ]}
          value={view}
          onChange={setView}
        />
        {counts.added > 0 && <Pill tone="ok">+{counts.added} step{counts.added > 1 ? 's' : ''}</Pill>}
        {counts.removed > 0 && <Pill tone="danger">-{counts.removed} step{counts.removed > 1 ? 's' : ''}</Pill>}
        {counts.modified > 0 && <Pill tone="warn">~{counts.modified} modified</Pill>}
        {edgeChanges > 0 && <Pill>{edgeChanges} route change{edgeChanges > 1 ? 's' : ''}</Pill>}
        {diff.entryChanged && <Pill tone="warn">entry changed</Pill>}
        {diff.circuitFields.length > 0 && <span className="text-fg-muted">circuit fields: {diff.circuitFields.join(', ')}</span>}
      </div>
      {view === 'flow' ? (
        <div className="grid min-h-[22rem] flex-1 grid-cols-2 gap-2">
          {[
            { snap: base, graph: baseGraph },
            { snap: next, graph: nextGraph },
          ].map(({ snap, graph }) => (
            <div key={snap.label} className="flex min-h-0 flex-col rounded-md border border-line">
              <div className="border-b border-line bg-sunken px-2 py-1 text-xs font-medium">{snap.label}</div>
              {snap.parsed ? (
                <FlowCanvas graph={graph} positionsFrom={uid} className="min-h-[20rem] flex-1" />
              ) : (
                <div className="flex flex-1 items-center justify-center p-4 text-xs text-fg-subtle">{Object.keys(snap.files).length ? 'Unparsable circuit YAML' : 'Circuit does not exist at this version'}</div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <MultiFileDiff base={base.files} next={next.files} oldLabel={base.label} newLabel={next.label} stripPrefix={prefix || undefined} />
        </div>
      )}
    </div>
  );
}

export const circuitDiffRenderer: DiffRenderer = (base, next) => <FlowDiff base={base} next={next} />;
