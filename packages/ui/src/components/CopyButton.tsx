import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from './cn';
import { Tooltip } from './Tooltip';

export function CopyButton({ value, label = 'Copy', className, size = 13 }: { value: string | (() => string); label?: string; className?: string; size?: number }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof value === 'function' ? value() : value);
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void copy();
      }}
      aria-label={label}
      title={label}
      className={cn('inline-flex size-6 items-center justify-center rounded text-fg-subtle hover:bg-hover hover:text-fg', className)}
    >
      {done ? <Check size={size} className="text-ok-fg" aria-hidden /> : <Copy size={size} aria-hidden />}
    </button>
  );
}

/** Monospace identifier with optional shortened display and copy affordance. */
export function IdText({ id, display, copy = true, className }: { id: string; display?: string; copy?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5 font-mono text-[12px] text-fg-muted', className)}>
      <Tooltip content={id} disabled={!display || display === id}>
        <span>{display ?? id}</span>
      </Tooltip>
      {copy && <CopyButton value={id} label={`Copy ${id}`} size={12} className="size-5" />}
    </span>
  );
}
