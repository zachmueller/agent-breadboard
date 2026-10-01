import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './cn';

export interface TabItem<K extends string = string> {
  key: K;
  label: ReactNode;
  count?: number | null;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<K extends string> {
  items: TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  className?: string;
  size?: 'sm' | 'md';
  /** id prefix used to link tabs to panels (`<TabPanel>` with the same `idBase`). */
  idBase?: string;
}

/** WAI-ARIA tablist with arrow-key roving focus. */
export function Tabs<K extends string>({ items, value, onChange, className, size = 'md', idBase }: TabsProps<K>) {
  const gen = useId();
  const base = idBase ?? gen;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const enabled = items.map((t, j) => (t.disabled ? -1 : j)).filter((j) => j >= 0);
    const pos = enabled.indexOf(i);
    let next: number | undefined;
    if (e.key === 'ArrowRight') next = enabled[(pos + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') next = enabled[(pos - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (next === undefined) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(items[next]!.key);
  };
  return (
    <div role="tablist" className={cn('flex items-end gap-1 border-b border-line', className)}>
      {items.map((t, i) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            type="button"
            id={`${base}-tab-${t.key}`}
            aria-selected={active}
            aria-controls={`${base}-panel-${t.key}`}
            tabIndex={active ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              '-mb-px inline-flex items-center gap-1.5 border-b-2 font-medium transition-colors disabled:opacity-40',
              size === 'sm' ? 'h-8 px-2 text-[13px]' : 'h-9 px-2.5 text-sm',
              active ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg hover:border-line-strong',
            )}
          >
            {t.icon}
            {t.label}
            {t.count !== undefined && t.count !== null && (
              <span className={cn('rounded px-1.5 text-[11px] tabular', active ? 'bg-accent-soft text-accent-text' : 'bg-raised text-fg-subtle')}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idBase, tabKey, children, className }: { idBase: string; tabKey: string; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`${idBase}-panel-${tabKey}`} aria-labelledby={`${idBase}-tab-${tabKey}`} className={className}>
      {children}
    </div>
  );
}
