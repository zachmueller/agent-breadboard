/** Per-circuit Evals tab ([04] §8): Rubric | Fixtures | Runs | Analysis. */
import { useState } from 'react';
import { TabBar } from '../ui';
import { RubricEditor } from './evals/RubricEditor';
import { FixturesEditor } from './evals/FixturesEditor';
import { RunsPanel } from './evals/RunsPanel';
import { AnalysisPanel } from './evals/AnalysisPanel';

type Sub = 'rubric' | 'fixtures' | 'runs' | 'analysis';

export function EvalsTab() {
  const initial = (new URLSearchParams(window.location.search).get('evals') as Sub) || 'rubric';
  const [sub, setSub] = useState<Sub>(['rubric', 'fixtures', 'runs', 'analysis'].includes(initial) ? initial : 'rubric');
  const [selectedRun, setSelectedRun] = useState<string | null>(new URLSearchParams(window.location.search).get('run'));
  const change = (s: Sub) => {
    setSub(s);
    const u = new URL(window.location.href);
    u.searchParams.set('evals', s);
    window.history.replaceState(window.history.state, '', u);
  };
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl space-y-3 p-4">
        <TabBar
          tabs={[
            { id: 'rubric', label: 'Rubric' },
            { id: 'fixtures', label: 'Fixtures' },
            { id: 'runs', label: 'Runs' },
            { id: 'analysis', label: 'Analysis' },
          ]}
          value={sub}
          onChange={change}
        />
        {sub === 'rubric' && <RubricEditor />}
        {sub === 'fixtures' && <FixturesEditor />}
        {sub === 'runs' && <RunsPanel selected={selectedRun} onSelect={setSelectedRun} />}
        {sub === 'analysis' && <AnalysisPanel />}
      </div>
    </div>
  );
}
