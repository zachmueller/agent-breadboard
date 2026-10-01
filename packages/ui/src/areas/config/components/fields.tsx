/** Small form widgets shared by the config editors. */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { Plus, Trash2, AlertCircle, AlertTriangle, EyeOff } from 'lucide-react';
import { parse as parseYamlText } from 'yaml';
import { TextInput, Btn, Pill, SelectInput } from '../ui';
import { CodeEditor } from './CodeEditor';
import { toYaml } from '@breadboard/shared';
import { filterSuggestions, type PathSuggestion } from '../lib/inputMapPaths';
import { useDefinition } from '../lib/configApi';

/** Text input that applies on blur / Enter (for ids and names whose change cascades). */
export function LazyInput({ value, onCommit, validate, className, placeholder, mono }: { value: string; onCommit: (v: string) => void; validate?: (v: string) => string | null; className?: string; placeholder?: string; mono?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const err = v !== value && validate ? validate(v) : null;
  const apply = () => {
    if (v === value) return;
    if (validate && validate(v)) {
      setV(value);
      return;
    }
    onCommit(v);
  };
  return (
    <div className="w-full">
      <TextInput
        value={v}
        placeholder={placeholder}
        invalid={!!err}
        className={clsx(mono && 'font-mono text-xs', className)}
        onChange={(e) => setV(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setV(value);
        }}
      />
      {err && <div className="mt-0.5 text-[11px] text-danger-fg">{err}</div>}
    </div>
  );
}

export const idRule = (v: string) => (/^[a-z0-9][a-z0-9-]*$/.test(v) ? null : 'lowercase letters, digits and dashes');

export function NumberInput({ value, onChange, min, step, placeholder, className }: { value: number | undefined | null; onChange: (v: number | undefined) => void; min?: number; step?: number; placeholder?: string; className?: string }) {
  return (
    <TextInput
      type="number"
      value={value ?? ''}
      min={min}
      step={step}
      placeholder={placeholder}
      className={clsx('tabular', className)}
      onChange={(e) => {
        const s = e.target.value;
        onChange(s === '' ? undefined : Number(s));
      }}
    />
  );
}

export function TagsInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  return (
    <LazyInput
      value={value.join(', ')}
      placeholder={placeholder ?? 'comma, separated'}
      onCommit={(s) =>
        onChange(
          s
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        )
      }
    />
  );
}

/** Edit an arbitrary JSON-compatible value (schemas, literals) as YAML text. */
export function YamlValueEditor({ value, onChange, minHeight = 80, maxHeight = 320, placeholder }: { value: unknown; onChange: (v: unknown) => void; minHeight?: number; maxHeight?: number; placeholder?: string }) {
  const serialized = useMemo(() => (value === undefined ? '' : toYaml(value)), [value]);
  const [text, setText] = useState(serialized);
  const [err, setErr] = useState<string | null>(null);
  const lastEmitted = useRef<string>(serialized);
  useEffect(() => {
    if (serialized !== lastEmitted.current) {
      setText(serialized);
      lastEmitted.current = serialized;
      setErr(null);
    }
  }, [serialized]);
  return (
    <div>
      <CodeEditor
        language="yaml"
        value={text}
        lineNumbers={false}
        minHeight={minHeight}
        maxHeight={maxHeight}
        placeholder={placeholder}
        onChange={(t) => {
          setText(t);
          try {
            const v = t.trim() === '' ? undefined : parseYamlText(t);
            setErr(null);
            lastEmitted.current = v === undefined ? '' : toYaml(v);
            onChange(v);
          } catch (e) {
            setErr((e as Error).message.split('\n')[0] ?? 'invalid YAML');
          }
        }}
      />
      {err && <div className="mt-0.5 text-[11px] text-danger-fg">{err}</div>}
    </div>
  );
}

/** Input with path autocomplete (`$input…`, `$steps…`, `$ambient…`). */
export function ExprInput({ value, onChange, suggestions, placeholder, className }: { value: string; onChange: (v: string) => void; suggestions: PathSuggestion[]; placeholder?: string; className?: string }) {
  const [focus, setFocus] = useState(false);
  const [idx, setIdx] = useState(0);
  const list = useMemo(() => (focus ? filterSuggestions(suggestions, value, 12) : []), [focus, suggestions, value]);
  const pick = (p: string) => {
    onChange(p);
    setIdx(0);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!list.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if ((e.key === 'Enter' || e.key === 'Tab') && list[idx]) {
      e.preventDefault();
      pick(list[idx]!.path);
    } else if (e.key === 'Escape') setFocus(false);
  };
  return (
    <div className={clsx('relative w-full', className)}>
      <TextInput value={value} placeholder={placeholder ?? '$input.x | $steps.<id>.output.x | $ambient.x | literal'} className="font-mono text-xs" onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 120)} onKeyDown={onKey} onChange={(e) => onChange(e.target.value)} />
      {list.length > 0 && (
        <ul role="listbox" className="absolute top-9 left-0 z-30 max-h-56 w-full min-w-72 overflow-auto rounded-md border border-line bg-surface py-1 shadow-pop">
          {list.map((s, i) => (
            <li key={s.path}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s.path)} className={clsx('flex w-full items-baseline justify-between gap-3 px-2 py-0.5 text-left', i === idx ? 'bg-accent-soft' : 'hover:bg-hover')}>
                <span className="truncate font-mono text-xs">{s.path}</span>
                <span className="shrink-0 text-[11px] text-fg-subtle">{s.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Parse what a user typed into an input_map value: `$…` expressions stay strings; JSON literals parse. */
export function parseLiteral(s: string): unknown {
  if (s.startsWith('$')) return s;
  if (/^(true|false|null|-?\d+(\.\d+)?|\{.*\}|\[.*\])$/.test(s.trim())) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  return s;
}
const showLiteral = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** Key → expression map editor (input_map). */
export function InputMapEditor({ value, onChange, suggestions, keySuggestions }: { value: Record<string, unknown> | undefined; onChange: (v: Record<string, unknown> | undefined) => void; suggestions: PathSuggestion[]; keySuggestions?: string[] }) {
  const entries = Object.entries(value ?? {});
  const missing = (keySuggestions ?? []).filter((k) => !(k in (value ?? {})));
  const set = (next: Array<[string, unknown]>) => onChange(next.length ? Object.fromEntries(next) : undefined);
  return (
    <div className="space-y-1.5">
      {entries.map(([k, v], i) => (
        <div key={i} className="flex items-start gap-1">
          <div className="w-32 shrink-0">
            <LazyInput mono value={k} onCommit={(nk) => set(entries.map((e, j) => (j === i ? [nk, e[1]] : e)))} />
          </div>
          <ExprInput value={showLiteral(v)} suggestions={suggestions} onChange={(s) => set(entries.map((e, j) => (j === i ? [e[0], parseLiteral(s)] : e)))} />
          <button type="button" aria-label="Remove" onClick={() => set(entries.filter((_, j) => j !== i))} className="mt-1.5 text-fg-subtle hover:text-danger-fg">
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1">
        <Btn size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set([...entries, [uniqueKey(entries.map((e) => e[0])), '$input']])}>
          Add mapping
        </Btn>
        {missing.map((k) => (
          <Btn key={k} size="sm" variant="ghost" onClick={() => set([...entries, [k, '']])} title="Declared in the tool's input schema">
            + {k}
          </Btn>
        ))}
      </div>
    </div>
  );
}

function uniqueKey(taken: string[]): string {
  let i = 1;
  while (taken.includes(`key${i}`)) i++;
  return `key${i}`;
}

export function ValidationList({ errors, warnings, className, max = 50 }: { errors: string[]; warnings?: string[]; className?: string; max?: number }) {
  if (!errors.length && !warnings?.length) return null;
  return (
    <ul className={clsx('space-y-0.5 text-xs', className)}>
      {errors.slice(0, max).map((e, i) => (
        <li key={`e${i}`} className="flex items-start gap-1 text-danger-fg">
          <AlertCircle className="mt-0.5 size-3 shrink-0" />
          <span className="break-words">{e}</span>
        </li>
      ))}
      {warnings?.slice(0, max).map((w, i) => (
        <li key={`w${i}`} className="flex items-start gap-1 text-warn-fg">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span className="break-words">{w}</span>
        </li>
      ))}
    </ul>
  );
}

type ManifestSetting = { type: 'string' | 'number' | 'boolean' | 'array' | 'object'; default?: unknown; description?: string; hidden?: boolean; enum?: unknown[] };

/**
 * Per-grant settings form driven by a tool manifest's `settings` block ([05] §2.2, [06] §2).
 * Hidden settings are flagged (enforced server-side, invisible to the model).
 */
export function ToolSettingsForm({ toolUid, value, onChange }: { toolUid: string | null | undefined; value: Record<string, unknown> | undefined; onChange: (v: Record<string, unknown> | undefined) => void }) {
  const def = useDefinition(toolUid ?? null);
  const manifest = (def.data?.definition as any)?.settings as Record<string, ManifestSetting> | undefined;
  const cur = value ?? {};
  const set = (k: string, v: unknown) => {
    const next = { ...cur };
    if (v === undefined || v === '') delete next[k];
    else next[k] = v;
    onChange(Object.keys(next).length ? next : undefined);
  };
  if (!toolUid) return null;
  if (def.isLoading) return <div className="text-xs text-fg-subtle">Loading tool settings…</div>;
  const keys = Object.keys(manifest ?? {});
  const extra = Object.keys(cur).filter((k) => !keys.includes(k));
  if (!keys.length && !extra.length) return <div className="text-xs text-fg-subtle">This tool declares no settings.</div>;
  return (
    <div className="space-y-2">
      {keys.map((k) => {
        const s = manifest![k]!;
        const v = cur[k];
        return (
          <div key={k} className="grid grid-cols-[8rem_1fr] items-start gap-2">
            <div className="pt-1.5">
              <div className="flex items-center gap-1 font-mono text-xs">
                {k}
                {s.hidden && (
                  <Pill tone="warn" title="Hidden: enforced server-side, invisible to the model">
                    <EyeOff className="size-3" /> hidden
                  </Pill>
                )}
              </div>
              {s.description && <div className="text-[11px] text-fg-subtle">{s.description}</div>}
            </div>
            <div>
              {s.enum ? (
                <SelectInput value={v === undefined ? '' : JSON.stringify(v)} onChange={(e) => set(k, e.target.value === '' ? undefined : JSON.parse(e.target.value))}>
                  <option value="">(default{s.default !== undefined ? `: ${JSON.stringify(s.default)}` : ''})</option>
                  {s.enum.map((o) => (
                    <option key={JSON.stringify(o)} value={JSON.stringify(o)}>
                      {String(o)}
                    </option>
                  ))}
                </SelectInput>
              ) : s.type === 'boolean' ? (
                <SelectInput value={v === undefined ? '' : String(v)} onChange={(e) => set(k, e.target.value === '' ? undefined : e.target.value === 'true')}>
                  <option value="">(default{s.default !== undefined ? `: ${String(s.default)}` : ''})</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </SelectInput>
              ) : s.type === 'number' ? (
                <NumberInput value={typeof v === 'number' ? v : undefined} placeholder={s.default !== undefined ? `default ${s.default}` : ''} onChange={(n) => set(k, n)} />
              ) : s.type === 'string' ? (
                <TextInput value={typeof v === 'string' ? v : ''} placeholder={s.default !== undefined ? `default ${String(s.default)}` : ''} onChange={(e) => set(k, e.target.value)} />
              ) : (
                <YamlValueEditor value={v} minHeight={40} placeholder={s.default !== undefined ? `default: ${JSON.stringify(s.default)}` : s.type} onChange={(x) => set(k, x)} />
              )}
            </div>
          </div>
        );
      })}
      {extra.map((k) => (
        <div key={k} className="grid grid-cols-[8rem_1fr] items-start gap-2">
          <div className="pt-1.5 font-mono text-xs text-danger-fg" title="Not declared in the tool manifest">
            {k} (undeclared)
          </div>
          <div className="flex items-start gap-1">
            <YamlValueEditor value={cur[k]} minHeight={32} onChange={(x) => set(k, x)} />
            <button type="button" aria-label="Remove" onClick={() => set(k, undefined)} className="mt-1.5 text-fg-subtle hover:text-danger-fg">
              <Trash2 className="size-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
