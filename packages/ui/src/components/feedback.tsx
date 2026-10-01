import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, Loader2, Lock, RefreshCw, SearchX } from 'lucide-react';
import { errorMessage, isApiError } from '../lib/api';
import { Button } from './Button';
import { cn } from './cn';

export function Spinner({ size = 16, className, label = 'Loading' }: { size?: number; className?: string; label?: string }) {
  return (
    <span role="status" aria-label={label} className={cn('inline-flex text-fg-subtle', className)}>
      <Loader2 size={size} className="animate-spin" aria-hidden />
    </span>
  );
}

/** Centered loading state for a panel or page region. */
export function Loading({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 py-12 text-sm text-fg-subtle', className)}>
      <Spinner size={16} label={label} />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-raised', className)} aria-hidden />;
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, className, compact }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'gap-1.5 py-6' : 'gap-2 py-14', className)}>
      <div className="flex size-9 items-center justify-center rounded-full bg-raised text-fg-subtle" aria-hidden>
        {icon ?? <Inbox size={18} />}
      </div>
      <div className="text-sm font-medium text-fg">{title}</div>
      {description && <div className="max-w-md text-[13px] text-fg-muted">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  error: unknown;
  title?: ReactNode;
  onRetry?: () => void;
  className?: string;
  compact?: boolean;
}

export function ErrorState({ error, title, onRetry, className, compact }: ErrorStateProps) {
  const api = isApiError(error) ? error : null;
  const notFound = api?.isNotFound;
  const forbidden = api?.isForbidden;
  const icon = notFound ? <SearchX size={18} /> : forbidden ? <Lock size={18} /> : <AlertTriangle size={18} />;
  const heading = title ?? (notFound ? 'Not found' : forbidden ? 'You don’t have access' : api?.code === 'network' ? 'Server unreachable' : 'Something went wrong');
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'gap-1.5 py-6' : 'gap-2 py-14', className)} role="alert">
      <div className={cn('flex size-9 items-center justify-center rounded-full', notFound || forbidden ? 'bg-raised text-fg-subtle' : 'bg-danger-soft text-danger-fg')} aria-hidden>
        {icon}
      </div>
      <div className="text-sm font-medium text-fg">{heading}</div>
      <div className="max-w-md text-[13px] text-fg-muted">
        {errorMessage(error)}
        {api?.code && api.code !== 'network' && <span className="ml-1 font-mono text-[11px] text-fg-subtle">({api.code})</span>}
      </div>
      {onRetry && !notFound && !forbidden && (
        <Button size="sm" className="mt-2" icon={<RefreshCw size={13} />} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** Inline banner (info / warning / error / success). */
export function Callout({ tone = 'info', title, children, icon, action, className }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; title?: ReactNode; children?: ReactNode; icon?: ReactNode; action?: ReactNode; className?: string }) {
  const tones = {
    info: 'border-accent/30 bg-accent-soft text-fg',
    warn: 'border-warn/45 bg-warn-soft text-fg',
    danger: 'border-danger/40 bg-danger-soft text-fg',
    ok: 'border-ok/40 bg-ok-soft text-fg',
  } as const;
  const iconTone = { info: 'text-accent-text', warn: 'text-warn-fg', danger: 'text-danger-fg', ok: 'text-ok-fg' }[tone];
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border px-3.5 py-3 text-[13px]', tones[tone], className)} role={tone === 'danger' ? 'alert' : 'status'}>
      {icon && <span className={cn('mt-0.5 flex shrink-0', iconTone)}>{icon}</span>}
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cn(title && 'mt-0.5', 'text-fg-muted')}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
