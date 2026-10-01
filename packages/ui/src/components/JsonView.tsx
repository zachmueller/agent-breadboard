import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from './cn';
import { CopyButton } from './CopyButton';

export interface JsonViewProps {
  value: unknown;
  /** Expand nodes up to this depth initially (default 1). */
  defaultExpandDepth?: number;
  className?: string;
  /** Show a copy-as-JSON button. */
  copyable?: boolean;
  /** Max height with scroll. */
  maxHeight?: number | string;
}

/** Collapsible JSON tree. */
export function JsonView({ value, defaultExpandDepth = 1, className, copyable = true, maxHeight }: JsonViewProps) {
  return (
    <div className={cn('group relative rounded-md border border-line bg-sunken font-mono text-[12px] leading-[1.6]', className)}>
      {copyable && (
        <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyButton value={() => JSON.stringify(value, null, 2)} label="Copy JSON" />
        </div>
      )}
      <div className="overflow-auto px-3 py-2" style={{ maxHeight }}>
        <JsonNode value={value} depth={0} expandDepth={defaultExpandDepth} />
      </div>
    </div>
  );
}

function JsonNode({ value, depth, expandDepth, name, last = true }: { value: unknown; depth: number; expandDepth: number; name?: string; last?: boolean }) {
  const [open, setOpen] = useState(depth < expandDepth);
  const key = name !== undefined ? <span className="text-fg-muted">{JSON.stringify(name)}: </span> : null;
  const comma = last ? '' : ',';
  if (value === null || typeof value !== 'object') {
    return (
      <div className="whitespace-pre-wrap break-all" style={{ paddingLeft: depth ? 14 : 0 }}>
        {key}
        <Primitive value={value} />
        {comma}
      </div>
    );
  }
  const isArr = Array.isArray(value);
  const entries: Array<[string, unknown]> = isArr ? (value as unknown[]).map((v, i) => [String(i), v]) : Object.entries(value as Record<string, unknown>);
  const [o, c] = isArr ? ['[', ']'] : ['{', '}'];
  if (!entries.length)
    return (
      <div style={{ paddingLeft: depth ? 14 : 0 }}>
        {key}
        <span className="text-fg-subtle">
          {o}
          {c}
        </span>
        {comma}
      </div>
    );
  return (
    <div style={{ paddingLeft: depth ? 14 : 0 }}>
      <button type="button" onClick={() => setOpen(!open)} className="-ml-3.5 inline-flex items-center rounded text-left hover:bg-hover" aria-expanded={open}>
        <ChevronRight size={12} className={cn('shrink-0 text-fg-subtle transition-transform', open && 'rotate-90')} aria-hidden />
        <span>
          {key}
          <span className="text-fg-subtle">{o}</span>
          {!open && (
            <span className="text-fg-subtle">
              {' '}
              {isArr ? `${entries.length} items` : `${entries.length} keys`} {c}
              {comma}
            </span>
          )}
        </span>
      </button>
      {open && (
        <>
          {entries.map(([k, v], i) => (
            <JsonNode key={k} name={isArr ? undefined : k} value={v} depth={depth + 1} expandDepth={expandDepth} last={i === entries.length - 1} />
          ))}
          <div className="text-fg-subtle">
            {c}
            {comma}
          </div>
        </>
      )}
    </div>
  );
}

function Primitive({ value }: { value: unknown }): ReactNode {
  if (value === null) return <span className="text-fg-subtle">null</span>;
  if (typeof value === 'string') return <span className="text-ok-fg">{JSON.stringify(value)}</span>;
  if (typeof value === 'number') return <span className="text-accent-text">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="text-info-fg">{String(value)}</span>;
  if (value === undefined) return <span className="text-fg-subtle">undefined</span>;
  return <span>{String(value)}</span>;
}
