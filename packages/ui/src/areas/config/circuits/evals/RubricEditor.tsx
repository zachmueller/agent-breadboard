/** Rubric editor ([04] §2, §8): form view over `rubric.yaml` with a YAML view; both edit the working tree. */
import { useEffect, useState } from 'react';
import { Plus, X, FilePlus2, ArrowUp, ArrowDown } from 'lucide-react';
import { useWorkingTree } from '../../model/workingTree';
import { Btn, Field, Section, SelectInput, TextInput, TextAreaInput, TabBar, Pill } from '../../ui';
import { LazyInput, idRule, NumberInput, TagsInput, ValidationList } from '../../components/fields';
import { ConfigPicker } from '../../components/ConfigPicker';
import { CodeEditor } from '../../components/CodeEditor';
import { parseYamlValue } from '../../lib/yamlDoc';
import { usePresets, useTreeOfKind } from '../../lib/configApi';
import { rubricPathOf, rubricTemplate, errorsForFile, BUILTIN_ASSERTIONS } from './shared';
import { setOrDelete } from '../StepInspector';

const DIM_TYPES = ['numeric', 'ordinal', 'boolean', 'programmatic'] as const;

export function RubricEditor() {
  const wt = useWorkingTree();
  const path = rubricPathOf(wt);
  const subagents = useTreeOfKind('subagent');
  const judge = subagents.data.find((e) => /judge|eval/.test(e.slug ?? ''))?.uid ?? '';
  const [mode, setMode] = useState<'form' | 'yaml'>('form');
  useEffect(() => {
    if (path) wt.ensureFile(path);
  }, [path]);
  if (!path) return null;
  const text = wt.getFile(path);
  const probing = text === undefined && !wt.state.missing.has(path);
  if (probing) return <div className="p-4 text-xs text-fg-subtle">Loading rubric…</div>;
  if (text == null)
    return (
      <div className="rounded-md border border-dashed border-line p-6 text-center">
        <div className="mb-1 text-sm font-medium">No rubric yet</div>
        <p className="mb-3 text-xs text-fg-muted">A rubric defines how eval runs grade this circuit's outputs: typed dimensions, a judge, an aggregate and a gate.</p>
        <Btn variant="primary" size="sm" icon={<FilePlus2 className="size-3.5" />} onClick={() => wt.setFile(path, rubricTemplate(wt.uid, judge))}>
          Create rubric.yaml
        </Btn>
      </div>
    );
  const parsed = parseYamlValue(text);
  const errors = errorsForFile(wt.errors, path);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <TabBar
          tabs={[
            { id: 'form', label: 'Form' },
            { id: 'yaml', label: 'YAML' },
          ]}
          value={mode}
          onChange={setMode}
        />
        {wt.state.dirty.has(path) && <Pill tone="warn">unsaved</Pill>}
        {!parsed.ok && <span className="text-xs text-danger-fg">YAML error: {parsed.error}</span>}
      </div>
      {errors.length > 0 && <ValidationList errors={errors} />}
      {mode === 'yaml' || !parsed.ok ? (
        <CodeEditor language="yaml" value={text} onChange={(t) => wt.setFile(path, t)} minHeight={320} ariaLabel="rubric.yaml" />
      ) : (
        <RubricForm rubric={(parsed.value as any) ?? {}} path={path} />
      )}
    </div>
  );
}

function RubricForm({ rubric, path }: { rubric: any; path: string }) {
  const wt = useWorkingTree();
  const presets = usePresets();
  const tools = useTreeOfKind('tool');
  const edit = (fn: (d: any) => void) => wt.editYamlFile(fn, path);
  const dims: any[] = Array.isArray(rubric.dimensions) ? rubric.dimensions : [];
  const weights: Record<string, number> = rubric.aggregate?.weights ?? {};
  const modelIds = [...new Set(Object.values(presets.data?.presets ?? {}).flatMap((l) => l.map((e) => e.model_id)))];
  const method = rubric.aggregate?.method ?? 'weighted-mean';

  const addDim = () =>
    edit((d) => {
      d.dimensions ??= [];
      const taken = new Set(d.dimensions.map((x: any) => x?.key));
      let k = 'dimension';
      for (let i = 2; taken.has(k); i++) k = `dimension-${i}`;
      d.dimensions.push({ key: k, type: 'numeric', scale: { min: 0, max: 10 }, prompt: 'Score …' });
    });
  const setType = (i: number, type: string) =>
    edit((d) => {
      const x = d.dimensions[i];
      const keep = { key: x.key, ...(x.description ? { description: x.description } : {}) };
      const prompt = x.prompt ?? 'Score …';
      d.dimensions[i] =
        type === 'numeric'
          ? { ...keep, type, scale: { min: 0, max: 10 }, prompt }
          : type === 'ordinal'
            ? { ...keep, type, levels: ['low', 'medium', 'high'], prompt }
            : type === 'boolean'
              ? { ...keep, type, prompt }
              : { ...keep, type, tool: 'assert-output-schema' };
    });
  const renameDim = (i: number, from: string, to: string) =>
    edit((d) => {
      d.dimensions[i].key = to;
      const w = d.aggregate?.weights;
      if (w && from in w) {
        w[to] = w[from];
        delete w[from];
      }
      const om = d.aggregate?.ordinal_map;
      if (om && from in om) {
        om[to] = om[from];
        delete om[from];
      }
    });
  const move = (i: number, by: number) =>
    edit((d) => {
      const j = i + by;
      if (j < 0 || j >= d.dimensions.length) return;
      [d.dimensions[i], d.dimensions[j]] = [d.dimensions[j], d.dimensions[i]];
    });

  return (
    <div className="space-y-4 text-sm">
      <Section title="Judge">
        <div className="grid grid-cols-3 gap-2">
          <Field label="Evaluator subagent">
            <ConfigPicker kind="subagent" value={rubric.judge?.subagent ?? ''} invalid={!rubric.judge?.subagent} onChange={(v) => edit((d) => void ((d.judge ??= {}).subagent = v ?? ''))} />
          </Field>
          <Field label="Model ID" hint="explicit ID, never a preset tier">
            <LazyInput mono value={rubric.judge?.model_id ?? ''} onCommit={(v) => edit((d) => void ((d.judge ??= {}).model_id = v))} placeholder="anthropic.claude-…" />
          </Field>
          <Field label="Provider">
            <LazyInput mono value={rubric.judge?.provider ?? ''} placeholder="bedrock" onCommit={(v) => edit((d) => setOrDelete((d.judge ??= {}), 'provider', v))} />
          </Field>
        </div>
        {modelIds.length > 0 && (
          <div className="flex flex-wrap gap-1 text-[11px] text-fg-subtle">
            Models in presets:
            {modelIds.map((m) => (
              <button key={m} type="button" className="rounded border border-line px-1 font-mono hover:bg-hover" onClick={() => edit((d) => void ((d.judge ??= {}).model_id = m))}>
                {m}
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Dimensions"
        actions={
          <Btn size="xs" variant="ghost" icon={<Plus className="size-3.5" />} onClick={addDim}>
            Add dimension
          </Btn>
        }
      >
        {dims.length === 0 && <div className="text-xs text-danger-fg">A rubric needs at least one dimension.</div>}
        {dims.map((x, i) => (
          <div key={i} className="space-y-2 rounded-md border border-line p-2">
            <div className="flex items-center gap-1.5">
              <div className="w-44">
                <LazyInput mono value={x?.key ?? ''} validate={(v) => idRule(v) ?? (dims.some((y, j) => j !== i && y?.key === v) ? 'duplicate' : null)} onCommit={(v) => renameDim(i, x.key, v)} />
              </div>
              <SelectInput className="w-36" value={x?.type ?? 'numeric'} onChange={(e) => setType(i, e.target.value)}>
                {DIM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </SelectInput>
              {method === 'weighted-mean' && (
                <label className="flex items-center gap-1 text-xs text-fg-muted">
                  weight
                  <NumberInput
                    className="w-16"
                    value={weights[x.key]}
                    min={0}
                    placeholder="1"
                    onChange={(v) =>
                      edit((d) => {
                        d.aggregate ??= {};
                        d.aggregate.weights ??= {};
                        setOrDelete(d.aggregate.weights, x.key, v);
                        if (!Object.keys(d.aggregate.weights).length) delete d.aggregate.weights;
                      })
                    }
                  />
                </label>
              )}
              <div className="ml-auto flex">
                <Btn size="xs" variant="ghost" aria-label="Move up" disabled={i === 0} icon={<ArrowUp className="size-3.5" />} onClick={() => move(i, -1)} />
                <Btn size="xs" variant="ghost" aria-label="Move down" disabled={i === dims.length - 1} icon={<ArrowDown className="size-3.5" />} onClick={() => move(i, 1)} />
                <Btn size="xs" variant="ghost" aria-label="Remove dimension" icon={<X className="size-3.5" />} onClick={() => edit((d) => d.dimensions.splice(i, 1))} />
              </div>
            </div>
            <LazyInput value={x?.description ?? ''} placeholder="Description (optional)" onCommit={(v) => edit((d) => setOrDelete(d.dimensions[i], 'description', v))} />
            {x?.type === 'numeric' && (
              <div className="flex items-center gap-2 text-xs text-fg-muted">
                scale
                <NumberInput className="w-20" value={x.scale?.min} onChange={(v) => edit((d) => void ((d.dimensions[i].scale ??= {}).min = v ?? 0))} />
                to
                <NumberInput className="w-20" value={x.scale?.max} onChange={(v) => edit((d) => void ((d.dimensions[i].scale ??= {}).max = v ?? 10))} />
              </div>
            )}
            {x?.type === 'ordinal' && (
              <Field label="Levels (low → high)">
                <TagsInput value={Array.isArray(x.levels) ? x.levels : []} onChange={(v) => edit((d) => void (d.dimensions[i].levels = v))} />
              </Field>
            )}
            {x?.type === 'programmatic' && (
              <Field label="Assertion tool" hint="builtin assertion name or tool extension UID">
                <TextInput className="font-mono" list={`bb-assert-${i}`} value={x.tool ?? ''} onChange={(e) => edit((d) => void (d.dimensions[i].tool = e.target.value))} />
                <datalist id={`bb-assert-${i}`}>
                  {BUILTIN_ASSERTIONS.map((a) => (
                    <option key={a} value={a} />
                  ))}
                  {tools.data.map((t) => (
                    <option key={t.uid!} value={t.uid!}>
                      {t.slug}
                    </option>
                  ))}
                </datalist>
              </Field>
            )}
            {x?.type !== 'programmatic' && (
              <Field label="Judge prompt">
                <TextAreaInput rows={3} value={x?.prompt ?? ''} invalid={!x?.prompt} onChange={(e) => edit((d) => void (d.dimensions[i].prompt = e.target.value))} />
              </Field>
            )}
          </div>
        ))}
      </Section>

      <Section title="Aggregate">
        <div className="grid grid-cols-3 gap-2">
          <Field label="Method">
            <SelectInput value={method} onChange={(e) => edit((d) => void ((d.aggregate ??= {}).method = e.target.value))}>
              <option value="weighted-mean">weighted-mean</option>
              <option value="mean">mean</option>
              <option value="min">min</option>
            </SelectInput>
          </Field>
          <Field label="Gate (min aggregate)" hint="0–1; enables pass/fail and cheapest-passing">
            <NumberInput
              value={rubric.aggregate?.gate?.min}
              min={0}
              step={0.05}
              onChange={(v) =>
                edit((d) => {
                  d.aggregate ??= {};
                  if (v === undefined) delete d.aggregate.gate;
                  else d.aggregate.gate = { min: Math.max(0, Math.min(1, v)) };
                })
              }
            />
          </Field>
          <Field label="Merge check">
            <label className="flex h-8 items-center gap-2 text-xs">
              <input type="checkbox" checked={!!rubric.required_for_merge} onChange={(e) => edit((d) => setOrDelete(d, 'required_for_merge', e.target.checked || undefined))} />
              Required for merging changes to this circuit
            </label>
          </Field>
        </div>
      </Section>
    </div>
  );
}
