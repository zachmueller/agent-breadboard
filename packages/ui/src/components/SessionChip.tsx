import { Link } from '@tanstack/react-router';
import { Activity, CornerDownRight } from 'lucide-react';
import { sessionStateMeta, TONE_CLASSES } from '../lib/states';
import { shortId } from '../lib/format';
import { cn } from './cn';

export interface SessionChipProps {
  id: string;
  state?: string | null;
  kind?: string | null;
  /** Override the display label (default: short id). */
  label?: string | null;
  /** Deep-link to a step within the session. */
  step?: string | null;
  size?: 'sm' | 'md';
  className?: string;
}

/** Link chip for a Session (`/s/<id>`), with a state dot when known. */
export function SessionChip({ id, state, kind, label, step, size = 'sm', className }: SessionChipProps) {
  const meta = state ? sessionStateMeta(state) : null;
  return (
    <Link
      to="/s/$id"
      params={{ id }}
      search={step ? ({ step } as never) : undefined}
      title={`Session ${id}${kind ? ` · ${kind}` : ''}${meta ? ` · ${meta.label}` : ''}${step ? ` · step ${step}` : ''}`}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md border align-middle hover:bg-hover',
        meta?.prominent ? cn('border-warn/50', meta.tone === 'danger' && 'border-danger/50') : 'border-line hover:border-line-strong',
        'bg-surface text-fg',
        size === 'sm' ? 'h-6 px-1.5 text-[12.5px]' : 'h-7 px-2 text-[13px]',
        className,
      )}
    >
      {meta ? <span className={cn('size-1.5 shrink-0 rounded-full', TONE_CLASSES[meta.tone].dot, meta.live && 'animate-pulse')} aria-hidden /> : <Activity size={12} className="shrink-0 text-fg-subtle" aria-hidden />}
      <span className="truncate font-mono text-[12px]">{label ?? shortId(id)}</span>
      {step && (
        <span className="inline-flex items-center gap-0.5 text-fg-subtle">
          <CornerDownRight size={11} aria-hidden />
          <span className="truncate font-mono text-[11.5px]">{step}</span>
        </span>
      )}
    </Link>
  );
}
