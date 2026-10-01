import { AlertTriangle, Check, CircleDashed, Clock, Hand, Loader2, Pause, Play, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { sessionStateMeta, stepStatusMeta, taskStatusMeta, type StateMeta } from '../lib/states';
import { Badge } from './Badge';
import { cn } from './cn';

const ICONS: Record<StateMeta['icon'], (size: number) => ReactNode> = {
  clock: (s) => <Clock size={s} aria-hidden />,
  play: (s) => <Play size={s} aria-hidden />,
  pause: (s) => <Pause size={s} aria-hidden />,
  alert: (s) => <AlertTriangle size={s} aria-hidden />,
  check: (s) => <Check size={s} aria-hidden />,
  x: (s) => <X size={s} aria-hidden />,
  circle: (s) => <CircleDashed size={s} aria-hidden />,
  loader: (s) => <Loader2 size={s} className="animate-spin [animation-duration:1.6s]" aria-hidden />,
  gate: (s) => <Hand size={s} aria-hidden />,
};

function MetaBadge({ meta, size = 'sm', className }: { meta: StateMeta; size?: 'xs' | 'sm'; className?: string }) {
  const iconSize = size === 'xs' ? 10 : 11;
  return (
    <Badge
      tone={meta.tone}
      size={size}
      variant={meta.prominent ? 'solid' : 'soft'}
      icon={ICONS[meta.icon](iconSize)}
      className={cn(meta.prominent && 'font-semibold', className)}
    >
      {meta.label}
    </Badge>
  );
}

/** Session state badge; gated/suspended states render solid for prominence. */
export function StateBadge({ state, detail, size, className }: { state: string | null | undefined; detail?: Record<string, unknown> | null; size?: 'xs' | 'sm'; className?: string }) {
  return <MetaBadge meta={sessionStateMeta(state, detail)} size={size} className={className} />;
}

export function StepStatusBadge({ status, size, className }: { status: string | null | undefined; size?: 'xs' | 'sm'; className?: string }) {
  return <MetaBadge meta={stepStatusMeta(status)} size={size} className={className} />;
}

export function TaskStatusBadge({ status, size, className }: { status: string | null | undefined; size?: 'xs' | 'sm'; className?: string }) {
  return <MetaBadge meta={taskStatusMeta(status)} size={size} className={className} />;
}
