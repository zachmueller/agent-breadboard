import type { HTMLAttributes, ReactNode } from 'react';
import { TONE_CLASSES, type Tone } from '../lib/states';
import { cn } from './cn';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  variant?: 'soft' | 'solid' | 'outline' | 'dot';
  size?: 'xs' | 'sm';
  icon?: ReactNode;
  mono?: boolean;
}

export function Badge({ tone = 'neutral', variant = 'soft', size = 'sm', icon, mono, className, children, ...rest }: BadgeProps) {
  const t = TONE_CLASSES[tone];
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded font-medium whitespace-nowrap align-middle',
        size === 'xs' ? 'h-[18px] px-1.5 text-[11px]' : 'h-5 px-1.5 text-xs',
        variant === 'soft' && t.soft,
        variant === 'solid' && t.solid,
        variant === 'outline' && cn('border bg-transparent', t.border, t.text),
        variant === 'dot' && 'bg-transparent px-0 text-fg-muted',
        mono && 'font-mono',
        className,
      )}
      {...rest}
    >
      {variant === 'dot' && <span className={cn('size-1.5 shrink-0 rounded-full', t.dot)} aria-hidden />}
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A tag rendered as a quiet chip (`need-input:*` tags are emphasized). */
export function TagChip({ tag, onRemove }: { tag: string; onRemove?: () => void }) {
  const needInput = tag === 'need-input' || tag.startsWith('need-input:');
  const deliverable = tag === 'deliverable';
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded border px-1.5 font-mono text-[11px]',
        needInput ? 'border-warn/50 bg-warn-soft text-warn-fg' : deliverable ? 'border-accent/40 bg-accent-soft text-accent-text' : 'border-line bg-sunken text-fg-muted',
      )}
    >
      {tag}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove tag ${tag}`} className="-mr-0.5 rounded px-0.5 hover:bg-hover">
          ×
        </button>
      )}
    </span>
  );
}
