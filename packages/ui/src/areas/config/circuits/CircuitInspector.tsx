/** Circuit-level inspector ([03] §2): identity, input schema, exits, entry, budget, knowledge, tool cost. */
import { Plus, X } from 'lucide-react';
import { useWorkingTree, errorsFor } from '../model/workingTree';
import { Btn, Field, Section, SelectInput } from '../ui';
import { LazyInput, idRule, NumberInput, TagsInput, YamlValueEditor, ValidationList } from '../components/fields';
import { useKnowledgeDomains } from '../lib/configApi';
import { newCircuitExit, renameCircuitExit } from './ops';
import { setOrDelete } from './StepInspector';
import { renamePosition } from './positions';
import { exitNodeId } from '../lib/circuitGraph';

export function CircuitInspector({ selectedExit }: { selectedExit?: string | null }) {
  const wt = useWorkingTree();
  const c = wt.parsed ?? {};
  const domains = useKnowledgeDomains();
  const exits: any[] = Array.isArray(c.exits) ? c.exits : [];
  const steps: any[] = Array.isArray(c.steps) ? c.steps : [];
  const edit = (fn: (d: any) => void) => wt.editYamlFile(fn);
  const topErrors = wt.errors.filter((e) => !errorsFor([e], 'steps.').length);
  const read: string[] = c.knowledge?.read ?? [];

  return (
    <div className="space-y-4 p-3 text-sm">
      {topErrors.length > 0 && <ValidationList errors={topErrors} max={10} />}
      <Section title="Circuit">
        <Field label="Title">
          <LazyInput value={c.title ?? ''} onCommit={(v) => edit((d) => void (d.title = v))} />
        </Field>
        <Field label="Slug" hint="unique, lowercase-dash">
          <LazyInput mono value={c.slug ?? ''} validate={idRule} onCommit={(v) => edit((d) => void (d.slug = v))} />
        </Field>
        <Field label="Description">
          <LazyInput value={c.description ?? ''} onCommit={(v) => edit((d) => setOrDelete(d, 'description', v))} />
        </Field>
        <Field label="Tags">
          <TagsInput value={Array.isArray(c.tags) ? c.tags : []} onChange={(v) => edit((d) => setOrDelete(d, 'tags', v))} />
        </Field>
        <Field label="Entry step">
          <SelectInput value={c.entry ?? ''} invalid={!steps.some((s) => s?.id === c.entry)} onChange={(e) => edit((d) => void (d.entry = e.target.value))}>
            {!steps.some((s) => s?.id === c.entry) && <option value={c.entry ?? ''}>{c.entry ? `${c.entry} (missing)` : 'choose'}</option>}
            {steps.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </SelectInput>
        </Field>
      </Section>

      <Section title="Input schema">
        <YamlValueEditor value={c.input} onChange={(v) => edit((d) => (v === undefined ? delete d.input : (d.input = v)))} placeholder="type: object" />
      </Section>

      <Section
        title="Exits"
        actions={
          <Btn size="xs" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => edit((d) => void newCircuitExit(d))}>
            Add exit
          </Btn>
        }
      >
        {exits.map((x, i) => (
          <div key={i} className={`space-y-1.5 rounded-md border p-2 ${selectedExit === x?.name ? 'border-accent' : 'border-line'}`}>
            <div className="flex items-center gap-1.5">
              <LazyInput
                mono
                value={x?.name ?? ''}
                validate={(v) => idRule(v) ?? (exits.some((y, j) => j !== i && y?.name === v) ? 'duplicate' : null)}
                onCommit={(v) => {
                  const from = x?.name;
                  edit((d) => renameCircuitExit(d, from, v));
                  renamePosition(wt.uid, exitNodeId(from), exitNodeId(v));
                }}
              />
              <Btn size="xs" variant="ghost" aria-label="Remove exit" disabled={exits.length <= 1} icon={<X className="size-3.5" />} onClick={() => edit((d) => d.exits.splice(i, 1))} />
            </div>
            <LazyInput value={x?.description ?? ''} placeholder="Description" onCommit={(v) => edit((d) => setOrDelete(d.exits[i], 'description', v))} />
            <Field label="Output schema">
              <YamlValueEditor value={x?.output} minHeight={60} onChange={(v) => edit((d) => (v === undefined ? delete d.exits[i].output : (d.exits[i].output = v)))} />
            </Field>
          </div>
        ))}
      </Section>

      <Section title="Budget & limits">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!c.budget} onChange={(e) => edit((d) => (e.target.checked ? (d.budget = { max_cost_usd: 5, max_tokens: 2_000_000 }) : delete d.budget))} />
          Per-run budget (otherwise the Breadboard default applies)
        </label>
        {c.budget && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Max cost (USD)">
              <NumberInput value={c.budget.max_cost_usd} min={0} step={0.5} onChange={(v) => edit((d) => setOrDelete(d.budget, 'max_cost_usd', v))} />
            </Field>
            <Field label="Max tokens">
              <NumberInput value={c.budget.max_tokens} min={1} step={10000} onChange={(v) => edit((d) => setOrDelete(d.budget, 'max_tokens', v))} />
            </Field>
          </div>
        )}
        <Field label="Max tool cost units" hint="per-run ceiling on summed tool max_cost_units">
          <NumberInput value={c.max_tool_cost_units} min={0} onChange={(v) => edit((d) => setOrDelete(d, 'max_tool_cost_units', v))} />
        </Field>
      </Section>

      <Section title="Knowledge (read)">
        <p className="text-[11px] text-fg-subtle">Domains every LLM step in this circuit may read, in addition to each subagent's own grants.</p>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {[...new Set([...domains.data.map((d) => d.slug), ...read])].map((slug) => (
            <label key={slug} className="flex items-center gap-1.5 text-xs" title={domains.data.find((d) => d.slug === slug)?.description}>
              <input
                type="checkbox"
                checked={read.includes(slug)}
                onChange={(e) =>
                  edit((d) => {
                    const cur: string[] = d.knowledge?.read ?? [];
                    const nextRead = e.target.checked ? [...cur, slug] : cur.filter((x) => x !== slug);
                    if (nextRead.length) (d.knowledge ??= {}).read = nextRead;
                    else delete d.knowledge;
                  })
                }
              />
              <span className="font-mono">{slug}</span>
            </label>
          ))}
          {domains.data.length === 0 && read.length === 0 && <span className="text-xs text-fg-subtle">No knowledge domains defined.</span>}
        </div>
      </Section>
    </div>
  );
}
