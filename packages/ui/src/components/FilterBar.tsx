import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { cn } from './cn';

export type FilterDef =
  | { key: string; label: string; type: 'select'; options: Array<{ value: string; label: string }>; allLabel?: string }
  | { key: string; label: string; type: 'text'; placeholder?: string; mono?: boolean }
  | { key: string; label: string; type: 'date' };

export type FilterValues = Record<string, string | undefined>;

export interface FilterBarProps {
  filters: FilterDef[];
  value: FilterValues;
  onChange: (next: FilterValues) => void;
  /** Free-text search bound to `searchKey` (default `q`). */
  search?: { placeholder?: string; key?: string } | false;
  /** Extra controls on the right. */
  trailing?: ReactNode;
  className?: string;
}

/** One-row filter controls: each filter renders as a compact chip-style control; active ones are highlighted. */
export function FilterBar({ filters, value, onChange, search = false, trailing, className }: FilterBarProps) {
  const set = (k: string, v: string | undefined) => onChange({ ...value, [k]: v || undefined });
  const searchKey = search ? (search.key ?? 'q') : null;
  const active = filters.filter((f) => value[f.key]).length + (searchKey && value[searchKey] ? 1 : 0);
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)} role="group" aria-label="Filters">
      {search && searchKey && <SearchInput value={value[searchKey] ?? ''} onChange={(v) => set(searchKey, v)} placeholder={search.placeholder ?? 'Search…'} />}
      {filters.map((f) => (
        <FilterControl key={f.key} def={f} value={value[f.key]} onChange={(v) => set(f.key, v)} />
      ))}
      {active > 0 && (
        <button
          type="button"
          onClick={() => onChange(Object.fromEntries(Object.keys(value).map((k) => [k, undefined])))}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] text-fg-muted hover:bg-hover hover:text-fg"
        >
          <X size={13} /> Clear
        </button>
      )}
      {trailing && <div className="ml-auto flex items-center gap-2">{trailing}</div>}
    </div>
  );
}

const chip = 'h-7 rounded-md border text-[13px] transition-colors focus-within:border-accent';

function FilterControl({ def, value, onChange }: { def: FilterDef; value: string | undefined; onChange: (v: string | undefined) => void }) {
  const on = !!value;
  if (def.type === 'select') {
    const current = def.options.find((o) => o.value === value);
    return (
      <label className={cn(chip, 'relative inline-flex items-center gap-1 pl-2.5 pr-6', on ? 'border-accent/50 bg-accent-soft text-accent-text' : 'border-line-strong bg-surface text-fg-muted hover:bg-hover')}>
        <span className="font-medium">{def.label}</span>
        {current && <span className="max-w-40 truncate text-fg">: {current.label}</span>}
        <select aria-label={def.label} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)} className="absolute inset-0 cursor-pointer opacity-0">
          <option value="">{def.allLabel ?? 'Any'}</option>
          {def.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown size={13} className="pointer-events-none absolute right-1.5" aria-hidden />
      </label>
    );
  }
  if (def.type === 'date') {
    return (
      <label className={cn(chip, 'inline-flex items-center gap-1.5 px-2.5', on ? 'border-accent/50 bg-accent-soft text-accent-text' : 'border-line-strong bg-surface text-fg-muted')}>
        <span className="font-medium">{def.label}</span>
        <input type="date" value={value?.slice(0, 10) ?? ''} onChange={(e) => onChange(e.target.value || undefined)} className="bg-transparent text-fg outline-none [color-scheme:inherit]" />
        {on && (
          <button type="button" onClick={() => onChange(undefined)} aria-label={`Clear ${def.label}`} className="rounded hover:bg-hover">
            <X size={12} />
          </button>
        )}
      </label>
    );
  }
  return <TextFilter def={def} value={value} onChange={onChange} />;
}

function TextFilter({ def, value, onChange }: { def: Extract<FilterDef, { type: 'text' }>; value: string | undefined; onChange: (v: string | undefined) => void }) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  const on = !!value;
  return (
    <label className={cn(chip, 'inline-flex items-center gap-1.5 px-2.5', on ? 'border-accent/50 bg-accent-soft text-accent-text' : 'border-line-strong bg-surface text-fg-muted')}>
      <span className="font-medium">{def.label}</span>
      <input
        value={draft}
        placeholder={def.placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== (value ?? '') && onChange(draft.trim() || undefined)}
        onKeyDown={(e) => e.key === 'Enter' && onChange(draft.trim() || undefined)}
        className={cn('w-36 bg-transparent text-fg outline-none placeholder:text-fg-subtle', def.mono && 'font-mono text-[12px]')}
      />
      {on && (
        <button type="button" onClick={() => onChange(undefined)} aria-label={`Clear ${def.label}`} className="rounded hover:bg-hover">
          <X size={12} />
        </button>
      )}
    </label>
  );
}

/** Debounced search input. */
export function SearchInput({ value, onChange, placeholder, delay = 250, className, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; delay?: number; className?: string; autoFocus?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onChange(draft), delay);
    return () => clearTimeout(t);
  }, [draft]);
  return (
    <label className={cn('relative inline-flex h-7 items-center', className)}>
      <Search size={14} className="pointer-events-none absolute left-2 text-fg-subtle" aria-hidden />
      <input
        type="search"
        aria-label={placeholder ?? 'Search'}
        value={draft}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        className="h-7 w-60 rounded-md border border-line-strong bg-surface pl-7 pr-2 text-[13px] text-fg outline-none placeholder:text-fg-subtle focus:border-accent focus:ring-2 focus:ring-accent/25"
      />
    </label>
  );
}
