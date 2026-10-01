/**
 * Step inspector ([03] §8.1): every field of the selected step, edited through the working tree's
 * comment-preserving YAML edits so the canvas, the YAML tab and the designer chat stay in sync.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Plus, Trash2, FilePlus2, X } from 'lucide-react';
import { EXIT_PREFIX } from '@breadboard/shared';
import { useWorkingTree, errorsFor } from '../model/workingTree';
import { Btn, Field, Section, SelectInput, TextInput, TextAreaInput, Pill } from '../ui';
import { LazyInput, idRule, NumberInput, YamlValueEditor, ExprInput, InputMapEditor, ToolSettingsForm, ValidationList } from '../components/fields';
import { ConfigPicker, ConfigMultiPicker } from '../components/ConfigPicker';
import { CodeEditor } from '../components/CodeEditor';
import { useDefinition, useRoles } from '../lib/configApi';
import { suggestPaths } from '../lib/inputMapPaths';
import { templateCompletion } from '../lib/templateComplete';
import { renameStep, stepNodeId, type StepKind } from '../lib/circuitGraph';
import { renamePosition } from './positions';
import { convertStepKind } from './ops';

const KINDS: Array<{ id: StepKind; label: string }> = [
  { id: 'llm', label: 'LLM step' },
  { id: 'code', label: 'Code step' },
  { id: 'circuit', label: 'Sub-circuit' },
  { id: 'gate', label: 'Hard gate' },
];

/** Assign or delete (for undefined / '' / empty containers) so cleared fields leave no YAML residue. */
export function setOrDelete(obj: any, key: string, v: unknown): void {
  const empty = v === undefined || v === '' || (Array.isArray(v) && v.length === 0 && key !== 'tools_override') || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
  if (empty) delete obj[key];
  else obj[key] = v;
}

export function StepInspector({ stepId, onRenamed, onDeleted }: { stepId: string; onRenamed: (id: string) => void; onDeleted: () => void }) {
  const wt = useWorkingTree();
  const c = wt.parsed;
  const steps: any[] = Array.isArray(c?.steps) ? c.steps : [];
  const idx = steps.findIndex((s) => s?.id === stepId);
  const step = steps[idx];
  const stepErrors = useMemo(() => (idx >= 0 ? errorsFor(wt.errors, `steps.${idx}.`, `steps.${idx}:`) : []), [wt.errors, idx]);

  if (!step) return <div className="p-4 text-sm text-fg-muted">Step “{stepId}” no longer exists.</div>;

  const edit = (fn: (s: any, d: any) => void) =>
    wt.editYamlFile((d) => {
      const s = (d.steps ?? []).find((x: any) => x?.id === stepId);
      if (s) fn(s, d);
    });

  const rename = (to: string) => {
    if (to === stepId) return;
    const oldPrompt = step.kind === 'llm' && step.prompt === `prompts/${stepId}.md` && wt.state.dir ? `${wt.state.dir}/${step.prompt}` : null;
    const newPrompt = oldPrompt ? `${wt.state.dir}/prompts/${to}.md` : null;
    const content = oldPrompt ? wt.getFile(oldPrompt) : undefined;
    const moveFile = oldPrompt && newPrompt && content != null && wt.getFile(newPrompt) == null;
    wt.editYamlFile((d) => {
      renameStep(d, stepId, to);
      if (moveFile) for (const s of d.steps ?? []) if (s?.id === to) s.prompt = `prompts/${to}.md`;
    });
    if (moveFile) {
      wt.setFile(newPrompt!, content!);
      wt.setFile(oldPrompt!, null);
    }
    renamePosition(wt.uid, stepNodeId(stepId), stepNodeId(to));
    onRenamed(to);
  };

  const remove = () => {
    wt.editYamlFile((d) => {
      d.steps = (d.steps ?? []).filter((s: any) => s?.id !== stepId);
      if (d.entry === stepId) d.entry = d.steps[0]?.id ?? '';
    });
    onDeleted();
  };

  const takenIds = new Set(steps.map((s) => s?.id).filter((x) => x && x !== stepId));

  return (
    <div className="space-y-4 p-3 text-sm">
      <div className="flex items-center gap-2">
        <Pill tone={step.kind === 'gate' ? 'warn' : 'accent'}>{step.kind}</Pill>
        {c?.entry === stepId ? (
          <Pill tone="ok">entry</Pill>
        ) : (
          <Btn size="xs" variant="ghost" onClick={() => wt.editYamlFile((d) => void (d.entry = stepId))}>
            Make entry
          </Btn>
        )}
        <Btn size="xs" variant="ghost" className="ml-auto" icon={<Trash2 className="size-3.5" />} onClick={remove}>
          Delete step
        </Btn>
      </div>
      {stepErrors.length > 0 && <ValidationList errors={stepErrors} />}

      <Section title="Step">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Id">
            <LazyInput mono value={stepId} validate={(v) => idRule(v) ?? (takenIds.has(v) ? 'id already used' : null)} onCommit={rename} />
          </Field>
          <Field label="Kind">
            <SelectInput value={step.kind} onChange={(e) => wt.editYamlFile((d) => convertStepKind(d, stepId, e.target.value as StepKind))}>
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </SelectInput>
          </Field>
        </div>
        <Field label="Title">
          <LazyInput value={step.title ?? ''} onCommit={(v) => edit((s) => setOrDelete(s, 'title', v))} placeholder="Optional display title" />
        </Field>
        <Field label="Description">
          <LazyInput value={step.description ?? ''} onCommit={(v) => edit((s) => setOrDelete(s, 'description', v))} />
        </Field>
      </Section>

      {step.kind === 'llm' && <LlmFields step={step} edit={edit} />}
      {step.kind === 'code' && <CodeFields step={step} edit={edit} />}
      {step.kind === 'circuit' && <CircuitStepFields step={step} edit={edit} />}
      {step.kind === 'gate' && <GateFields step={step} edit={edit} />}

      <ExitsTable step={step} edit={edit} />
      <RuntimeFields step={step} edit={edit} />
    </div>
  );
}

type Edit = (fn: (s: any, d: any) => void) => boolean;

/* ------------------------------------------------------------------ exits */

function ExitsTable({ step, edit }: { step: any; edit: Edit }) {
  const wt = useWorkingTree();
  const c = wt.parsed;
  const exits: any[] = Array.isArray(step.exits) ? step.exits : [];
  const targets = [
    ...(c?.steps ?? []).map((s: any) => s?.id).filter(Boolean).map((id: string) => ({ value: id, label: `step: ${id}` })),
    ...(c?.exits ?? []).map((x: any) => x?.name).filter(Boolean).map((n: string) => ({ value: `${EXIT_PREFIX}${n}`, label: `exit: ${n}` })),
  ];
  const known = new Set(targets.map((t: { value: string }) => t.value));
  const add = () =>
    edit((s) => {
      s.exits ??= [];
      const taken = new Set(s.exits.map((x: any) => x?.name));
      let n = 'next';
      for (let i = 2; taken.has(n); i++) n = `next-${i}`;
      s.exits.push({ name: n, to: targets[0]?.value ?? '' });
    });
  return (
    <Section
      title="Exits"
      actions={
        <Btn size="xs" variant="ghost" icon={<Plus className="size-3.5" />} onClick={add}>
          Add exit
        </Btn>
      }
    >
      {exits.length === 0 && <div className="text-xs text-danger-fg">A step needs at least one exit.</div>}
      <div className="space-y-2">
        {exits.map((x, i) => (
          <div key={i} className="rounded-md border border-line p-2">
            <div className="flex items-center gap-1.5">
              <div className="w-28 shrink-0">
                <LazyInput
                  mono
                  value={x?.name ?? ''}
                  validate={(v) => idRule(v) ?? (exits.some((y, j) => j !== i && y?.name === v) ? 'duplicate' : null)}
                  onCommit={(v) => edit((s) => void (s.exits[i].name = v))}
                />
              </div>
              <span className="text-fg-subtle">→</span>
              <SelectInput
                className="min-w-0 flex-1 font-mono text-xs"
                invalid={!known.has(x?.to)}
                value={known.has(x?.to) ? x.to : ''}
                onChange={(e) => edit((s) => void (s.exits[i].to = e.target.value))}
              >
                <option value="" disabled>
                  {x?.to ? `${x.to} (unknown)` : 'choose target'}
                </option>
                {targets.map((t: { value: string; label: string }) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </SelectInput>
              <Btn size="xs" variant="ghost" aria-label="Remove exit" disabled={exits.length <= 1} icon={<X className="size-3.5" />} onClick={() => edit((s) => s.exits.splice(i, 1))} />
            </div>
            <div className="mt-1.5">
              <LazyInput value={x?.description ?? ''} placeholder="When to take this exit (shown to the model)" onCommit={(v) => edit((s) => setOrDelete(s.exits[i], 'description', v))} />
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ retry / visits / artifacts */

function RuntimeFields({ step, edit }: { step: any; edit: Edit }) {
  const retry = step.retry;
  return (
    <Section title="Runtime">
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={!!retry}
          onChange={(e) => edit((s) => (e.target.checked ? (s.retry = { max_attempts: 3, backoff: { base_s: 5, cap_s: 300 } }) : delete s.retry))}
        />
        Custom retry policy <span className="text-fg-subtle">(default 3 attempts, 5s→300s backoff)</span>
      </label>
      {retry && (
        <div className="grid grid-cols-3 gap-2">
          <Field label="Max attempts">
            <NumberInput value={retry.max_attempts} min={1} onChange={(v) => edit((s) => setOrDelete(s.retry, 'max_attempts', v))} />
          </Field>
          <Field label="Backoff base (s)">
            <NumberInput value={retry.backoff?.base_s} min={0} onChange={(v) => edit((s) => setOrDelete((s.retry.backoff ??= {}), 'base_s', v))} />
          </Field>
          <Field label="Backoff cap (s)">
            <NumberInput value={retry.backoff?.cap_s} min={0} onChange={(v) => edit((s) => setOrDelete((s.retry.backoff ??= {}), 'cap_s', v))} />
          </Field>
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        <Field label="Max visits" hint="loop guard; default 25">
          <NumberInput value={step.max_visits} min={1} placeholder="25" onChange={(v) => edit((s) => setOrDelete(s, 'max_visits', v))} />
        </Field>
        <Field label="Artifact tag">
          <SelectInput
            value={step.artifacts?.tag ?? ''}
            onChange={(e) =>
              edit((s) => {
                s.artifacts ??= {};
                setOrDelete(s.artifacts, 'tag', e.target.value || undefined);
                if (!Object.keys(s.artifacts).length) delete s.artifacts;
              })
            }
          >
            <option value="">default</option>
            <option value="intermediate">intermediate</option>
            <option value="deliverable">deliverable</option>
          </SelectInput>
        </Field>
        <Field label="Artifact scope">
          <SelectInput
            value={step.artifacts?.scope ?? ''}
            onChange={(e) =>
              edit((s) => {
                s.artifacts ??= {};
                setOrDelete(s.artifacts, 'scope', e.target.value || undefined);
                if (!Object.keys(s.artifacts).length) delete s.artifacts;
              })
            }
          >
            <option value="">default</option>
            <option value="session">session</option>
            <option value="team">team</option>
          </SelectInput>
        </Field>
      </div>
    </Section>
  );
}

function OutputSchema({ step, edit, required, label = 'Output schema' }: { step: any; edit: Edit; required?: boolean; label?: ReactNode }) {
  return (
    <Field label={label} hint={required ? 'JSON Schema (YAML); required' : 'JSON Schema (YAML); optional'}>
      <YamlValueEditor value={step.output} onChange={(v) => edit((s) => (v === undefined ? delete s.output : (s.output = v)))} placeholder="type: object" />
    </Field>
  );
}

/* ------------------------------------------------------------------ llm */

function LlmFields({ step, edit }: { step: any; edit: Edit }) {
  const wt = useWorkingTree();
  const dir = wt.state.dir;
  const inline = step.prompt_inline !== undefined && step.prompt === undefined;
  const promptPath = step.prompt && dir ? `${dir}/${step.prompt}` : null;
  const promptText = promptPath ? wt.getFile(promptPath) : undefined;
  const paths = useMemo(() => suggestPaths(wt.parsed, step.id), [wt.parsed, step.id]);
  const pathsRef = useMemo(() => ({ current: paths }), []);
  pathsRef.current = paths;
  const completion = useMemo(() => [templateCompletion(() => pathsRef.current)], [pathsRef]);

  const toInline = () =>
    edit((s) => {
      s.prompt_inline = promptText ?? '';
      delete s.prompt;
    });
  const toFile = () => {
    const rel = `prompts/${step.id}.md`;
    const full = dir ? `${dir}/${rel}` : null;
    if (full && wt.getFile(full) == null) wt.setFile(full, step.prompt_inline ?? '');
    edit((s) => {
      s.prompt = rel;
      delete s.prompt_inline;
    });
  };

  return (
    <>
      <Section title="Subagent & prompt">
        <Field label="Subagent">
          <ConfigPicker kind="subagent" value={step.subagent ?? ''} invalid={!step.subagent} onChange={(v) => edit((s) => void (s.subagent = v ?? ''))} />
        </Field>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-fg-muted">Prompt template</span>
          <div className="ml-auto flex rounded-md border border-line p-0.5">
            <button type="button" className={`rounded px-2 py-0.5 ${!inline ? 'bg-hover font-medium' : 'text-fg-muted'}`} onClick={() => inline && toFile()}>
              File
            </button>
            <button type="button" className={`rounded px-2 py-0.5 ${inline ? 'bg-hover font-medium' : 'text-fg-muted'}`} onClick={() => !inline && toInline()}>
              Inline
            </button>
          </div>
        </div>
        {!inline && (
          <Field label="Template path" hint="relative to the circuit directory">
            <LazyInput mono value={step.prompt ?? ''} placeholder={`prompts/${step.id}.md`} onCommit={(v) => edit((s) => setOrDelete(s, 'prompt', v))} />
          </Field>
        )}
        {!inline && promptPath && promptText == null && (
          <div className="flex items-center gap-2 rounded-md border border-dashed border-warn/60 p-2 text-xs text-warn-fg">
            {promptPath.slice((dir?.length ?? 0) + 1)} does not exist in this working tree.
            <Btn size="xs" className="ml-auto" icon={<FilePlus2 className="size-3.5" />} onClick={() => wt.setFile(promptPath, `Work on the task described below.\n\n{{json input}}\n`)}>
              Create file
            </Btn>
          </div>
        )}
        {!inline && promptPath && promptText != null && (
          <CodeEditor language="markdown" value={promptText} onChange={(t) => wt.setFile(promptPath, t)} extensions={completion} minHeight={160} maxHeight={480} ariaLabel="Prompt template" />
        )}
        {inline && <CodeEditor language="markdown" value={step.prompt_inline ?? ''} onChange={(t) => edit((s) => void (s.prompt_inline = t))} extensions={completion} minHeight={120} maxHeight={400} ariaLabel="Inline prompt template" />}
        <p className="text-[11px] text-fg-subtle">
          Interpolate with <code>{'{{input.x}}'}</code>, <code>{'{{steps.<id>.output.x}}'}</code>, <code>{'{{ambient.x}}'}</code>; blocks <code>{'{{#if}}'}</code> / <code>{'{{#each}}'}</code>. Type <code>{'{{'}</code> for suggestions.
        </p>
      </Section>

      <Section title="Tools">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={Array.isArray(step.tools_override)} onChange={(e) => edit((s) => (e.target.checked ? (s.tools_override = []) : delete s.tools_override))} />
          Narrow the subagent's tool grants for this step
        </label>
        {Array.isArray(step.tools_override) && (
          <>
            <ConfigMultiPicker kind="tool" value={step.tools_override} onChange={(v) => edit((s) => void (s.tools_override = v))} placeholder="Add tool" />
            {step.tools_override.length === 0 && <div className="text-[11px] text-fg-subtle">Empty list = no tools at this step.</div>}
          </>
        )}
      </Section>

      <Section title="Output">
        <OutputSchema step={step} edit={edit} required />
        <div className="grid grid-cols-2 gap-2">
          <Field label="Max re-asks" hint="schema-invalid finishes; default 2">
            <NumberInput value={step.max_reasks} min={0} placeholder="2" onChange={(v) => edit((s) => setOrDelete(s, 'max_reasks', v))} />
          </Field>
          <Field label="Max turns" hint="default 60">
            <NumberInput value={step.max_turns} min={1} placeholder="60" onChange={(v) => edit((s) => setOrDelete(s, 'max_turns', v))} />
          </Field>
        </div>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ code */

function CodeFields({ step, edit }: { step: any; edit: Edit }) {
  const wt = useWorkingTree();
  const tool = useDefinition(step.tool || null);
  const manifest: any = tool.data?.definition;
  const keySuggestions = Object.keys(manifest?.input?.properties ?? {});
  const required: string[] = manifest?.input?.required ?? [];
  const missing = required.filter((k) => !(k in (step.input_map ?? {})));
  const paths = useMemo(() => suggestPaths(wt.parsed, step.id), [wt.parsed, step.id]);
  return (
    <>
      <Section title="Tool">
        <Field label="Tool extension">
          <ConfigPicker kind="tool" value={step.tool ?? ''} invalid={!step.tool} onChange={(v) => edit((s) => void (s.tool = v ?? ''))} />
        </Field>
        {manifest?.description && <p className="text-xs text-fg-muted">{manifest.description}</p>}
      </Section>
      <Section title="Input map">
        <InputMapEditor value={step.input_map} onChange={(v) => edit((s) => setOrDelete(s, 'input_map', v))} suggestions={paths} keySuggestions={keySuggestions} />
        {missing.length > 0 && <div className="text-[11px] text-warn-fg">Tool input requires: {missing.join(', ')}</div>}
      </Section>
      <Section title="Settings">
        <ToolSettingsForm toolUid={step.tool} value={step.settings} onChange={(v) => edit((s) => setOrDelete(s, 'settings', v))} />
      </Section>
      <Section title="Output">
        <OutputSchema step={step} edit={edit} label="Output schema override" />
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ circuit */

function CircuitStepFields({ step, edit }: { step: any; edit: Edit }) {
  const wt = useWorkingTree();
  const child = useDefinition(step.circuit || null);
  const def: any = child.data?.definition;
  const childExits: string[] = (def?.exits ?? []).map((x: any) => x?.name).filter(Boolean);
  const ownExits: string[] = (step.exits ?? []).map((x: any) => x?.name).filter(Boolean);
  const keySuggestions = Object.keys(def?.input?.properties ?? {});
  const paths = useMemo(() => suggestPaths(wt.parsed, step.id), [wt.parsed, step.id]);
  const map: Record<string, string> = step.exit_map ?? {};
  const mapped = (ce: string) => map[ce] ?? ce;
  const unrouted = childExits.filter((ce) => !ownExits.includes(mapped(ce)));

  const setMap = (ce: string, v: string) =>
    edit((s) => {
      const m = { ...(s.exit_map ?? {}) };
      if (!v || v === ce) delete m[ce];
      else m[ce] = v;
      setOrDelete(s, 'exit_map', m);
    });
  const addMissingExits = () =>
    edit((s) => {
      s.exits ??= [];
      for (const ce of unrouted) s.exits.push({ name: mapped(ce), to: s.exits[0]?.to ?? '' });
    });

  return (
    <>
      <Section title="Child circuit">
        <Field label="Circuit">
          <ConfigPicker kind="circuit" value={step.circuit ?? ''} exclude={[wt.uid]} invalid={!step.circuit} onChange={(v) => edit((s) => void (s.circuit = v ?? ''))} />
        </Field>
        {def?.description && <p className="text-xs text-fg-muted">{def.description}</p>}
      </Section>
      <Section title="Input map">
        <InputMapEditor value={step.input_map} onChange={(v) => edit((s) => setOrDelete(s, 'input_map', v))} suggestions={paths} keySuggestions={keySuggestions} />
      </Section>
      {childExits.length > 0 && (
        <Section title="Exit map" actions={unrouted.length > 0 ? <Btn size="xs" variant="ghost" onClick={addMissingExits}>Add missing exits</Btn> : undefined}>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-fg-subtle">
                <th className="py-1 font-normal">Child exit</th>
                <th className="py-1 font-normal">This step's exit</th>
              </tr>
            </thead>
            <tbody>
              {childExits.map((ce) => (
                <tr key={ce}>
                  <td className="py-1 font-mono">{ce}</td>
                  <td className="py-1">
                    <SelectInput className="font-mono text-xs" invalid={!ownExits.includes(mapped(ce))} value={mapped(ce)} onChange={(e) => setMap(ce, e.target.value)}>
                      {!ownExits.includes(mapped(ce)) && <option value={mapped(ce)}>{mapped(ce)} (not declared)</option>}
                      {ownExits.map((n) => (
                        <option key={n} value={n}>
                          {n}
                          {n === ce ? ' (identity)' : ''}
                        </option>
                      ))}
                    </SelectInput>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {unrouted.length > 0 && <div className="text-[11px] text-warn-fg">Child exits without a matching step exit: {unrouted.join(', ')}</div>}
        </Section>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ gate */

function GateFields({ step, edit }: { step: any; edit: Edit }) {
  const wt = useWorkingTree();
  const roles = useRoles();
  const paths = useMemo(() => suggestPaths(wt.parsed, step.id).filter((p) => p.path.startsWith('$steps.') || p.path.startsWith('$input') || p.path === '$ambient.artifacts'), [wt.parsed, step.id]);
  const review = step.review ?? {};
  const artifacts: string[] = Array.isArray(review.artifacts) ? review.artifacts : [];
  const reviewers = review.reviewers ?? {};
  const anyOf: Array<{ role?: string; username?: string }> = Array.isArray(reviewers.any_of) ? reviewers.any_of : [];
  const roleList = roles.data ?? [];
  const editReview = (fn: (r: any) => void) =>
    edit((s) => {
      s.review ??= { artifacts: [], reviewers: {} };
      fn(s.review);
    });
  const editReviewers = (fn: (r: any) => void) =>
    editReview((r) => {
      r.reviewers ??= {};
      fn(r.reviewers);
    });

  return (
    <>
      <Section
        title="Artifacts under review"
        actions={
          <Btn size="xs" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => editReview((r) => (r.artifacts ??= []).push('$steps.'))}>
            Add
          </Btn>
        }
      >
        {artifacts.length === 0 && <div className="text-xs text-danger-fg">A gate must review at least one artifact expression.</div>}
        {artifacts.map((a, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <ExprInput className="flex-1" value={a} suggestions={paths} onChange={(v) => editReview((r) => void (r.artifacts[i] = v))} placeholder="$steps.<id>.output.artifact" />
            <Btn size="xs" variant="ghost" aria-label="Remove" icon={<X className="size-3.5" />} onClick={() => editReview((r) => r.artifacts.splice(i, 1))} />
          </div>
        ))}
      </Section>

      <Section title="Reviewers">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Role">
            <RoleSelect roles={roleList} value={reviewers.role ?? ''} onChange={(v) => editReviewers((r) => setOrDelete(r, 'role', v))} />
          </Field>
          <Field label="Username">
            <LazyInput value={reviewers.username ?? ''} placeholder="optional" onCommit={(v) => editReviewers((r) => setOrDelete(r, 'username', v))} />
          </Field>
        </div>
        <div className="text-xs text-fg-muted">Any of (each target becomes a review request)</div>
        {anyOf.map((t, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <RoleSelect roles={roleList} value={t?.role ?? ''} onChange={(v) => editReviewers((r) => setOrDelete(r.any_of[i], 'role', v))} />
            <LazyInput value={t?.username ?? ''} placeholder="username" onCommit={(v) => editReviewers((r) => setOrDelete(r.any_of[i], 'username', v))} />
            <Btn
              size="xs"
              variant="ghost"
              aria-label="Remove target"
              icon={<X className="size-3.5" />}
              onClick={() =>
                editReviewers((r) => {
                  r.any_of.splice(i, 1);
                  if (!r.any_of.length) delete r.any_of;
                })
              }
            />
          </div>
        ))}
        <Btn size="xs" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => editReviewers((r) => (r.any_of ??= []).push({ role: roleList[0] ?? 'reviewer' }))}>
          Add target
        </Btn>
        {!reviewers.role && !reviewers.username && anyOf.length === 0 && <div className="text-[11px] text-warn-fg">No reviewer targeting: any user can resolve this gate.</div>}
      </Section>

      <Section title="Review prompt">
        <TextAreaInput rows={3} value={review.prompt ?? ''} placeholder="Shown to reviewers; supports {{ }} interpolation" onChange={(e) => editReview((r) => setOrDelete(r, 'prompt', e.target.value))} />
      </Section>

      <Section title="Output">
        <OutputSchema step={step} edit={edit} required />
        <p className="text-[11px] text-fg-subtle">Gates resolve through the <code>approve</code> and <code>changes</code> exits.</p>
      </Section>
    </>
  );
}

function RoleSelect({ roles, value, onChange }: { roles: string[]; value: string; onChange: (v: string) => void }) {
  const [custom, setCustom] = useState(false);
  if (custom || (value && roles.length > 0 && !roles.includes(value)) || roles.length === 0)
    return <TextInput value={value} placeholder="role" onChange={(e) => onChange(e.target.value)} onBlur={() => setCustom(false)} />;
  return (
    <SelectInput value={value} onChange={(e) => (e.target.value === '__custom' ? setCustom(true) : onChange(e.target.value))}>
      <option value="">none</option>
      {roles.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
      <option value="__custom">other…</option>
    </SelectInput>
  );
}
