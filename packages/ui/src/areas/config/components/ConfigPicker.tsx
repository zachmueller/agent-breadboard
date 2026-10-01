/**
 * Picker over config definitions of one kind (from `GET /config/tree`). Displays slugs, stores
 * UIDs ([03] §2 normative rules: all cross-references are by UID; slugs are display metadata).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronsUpDown, ExternalLink, X } from 'lucide-react';
import { useTreeOfKind } from '../lib/configApi';
import { hrefFor } from '../lib/format';
import { AppLink } from './AppLink';

export interface ConfigPickerProps {
  kind: 'subagent' | 'tool' | 'circuit' | 'mcp';
  value: string | null | undefined;
  onChange: (uid: string | null) => void;
  placeholder?: string;
  allowClear?: boolean;
  exclude?: string[];
  invalid?: boolean;
  /** Show a click-through link to the referenced editor. */
  showLink?: boolean;
  className?: string;
}

export function ConfigPicker({ kind, value, onChange, placeholder, allowClear, exclude, invalid, showLink = true, className }: ConfigPickerProps) {
  const tree = useTreeOfKind(kind);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const current = tree.data.find((e) => e.uid === value);
  const options = useMemo(() => {
    const t = q.trim().toLowerCase();
    return tree.data.filter((e) => e.uid && !exclude?.includes(e.uid) && (!t || `${e.slug} ${e.title} ${e.uid}`.toLowerCase().includes(t)));
  }, [tree.data, q, exclude]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const unknown = !!value && !tree.isLoading && !current;
  return (
    <div ref={ref} className={clsx('relative flex items-center gap-1', className)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={clsx(
          'flex h-8 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border bg-surface px-2 text-left text-sm',
          invalid || unknown ? 'border-danger' : 'border-line',
        )}
      >
        <span className="min-w-0 truncate">
          {current ? (
            <>
              <span className="font-medium">{current.slug}</span>
              {current.title && <span className="ml-1.5 text-fg-subtle">{current.title}</span>}
            </>
          ) : value ? (
            <span className="font-mono text-xs text-danger-fg" title="Not found in the config tree">
              {value} (unknown)
            </span>
          ) : (
            <span className="text-fg-subtle">{placeholder ?? `Select ${kind}…`}</span>
          )}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" />
      </button>
      {allowClear && value && (
        <button type="button" aria-label="Clear" onClick={() => onChange(null)} className="rounded p-1 text-fg-subtle hover:bg-hover">
          <X className="size-3.5" />
        </button>
      )}
      {showLink && current && (
        <AppLink href={hrefFor(kind, current.uid)} title={`Open ${kind} editor`} className="rounded p-1 hover:bg-hover">
          <ExternalLink className="size-3.5" />
        </AppLink>
      )}
      {open && (
        <div className="absolute top-9 left-0 z-30 w-full min-w-64 rounded-md border border-line bg-surface shadow-pop">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search slug or title…" className="w-full border-b border-line bg-transparent px-2 py-1.5 text-sm outline-none" />
          <ul className="max-h-64 overflow-auto py-1">
            {tree.isLoading && <li className="px-2 py-1 text-xs text-fg-subtle">Loading…</li>}
            {!tree.isLoading && !options.length && <li className="px-2 py-1 text-xs text-fg-subtle">No matches</li>}
            {options.map((e) => (
              <li key={e.uid}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(e.uid);
                    setOpen(false);
                    setQ('');
                  }}
                  className={clsx('flex w-full flex-col items-start px-2 py-1 text-left hover:bg-hover', e.uid === value && 'bg-accent-soft')}
                >
                  <span className="text-sm">{e.slug}</span>
                  <span className="text-[11px] text-fg-subtle">
                    {e.title} · <span className="font-mono">{e.uid}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Multi-select of UIDs as removable chips + a picker to add. */
export function ConfigMultiPicker({ kind, value, onChange, placeholder }: { kind: ConfigPickerProps['kind']; value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const tree = useTreeOfKind(kind);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {value.map((uid) => {
          const e = tree.data.find((x) => x.uid === uid);
          return (
            <span key={uid} className={clsx('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs', e ? 'border-line bg-raised' : 'border-danger bg-danger-soft text-danger-fg')}>
              <AppLink href={hrefFor(kind, uid)} className="text-fg">
                {e?.slug ?? uid}
              </AppLink>
              <button type="button" aria-label="Remove" onClick={() => onChange(value.filter((x) => x !== uid))} className="text-fg-subtle hover:text-fg">
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        {!value.length && <span className="text-xs text-fg-subtle">None</span>}
      </div>
      <ConfigPicker kind={kind} value={null} exclude={value} showLink={false} placeholder={placeholder ?? `Add ${kind}…`} onChange={(uid) => uid && onChange([...value, uid])} />
    </div>
  );
}
