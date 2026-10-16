/** Visual mapping for session / step / task states. Pure; exported for tests and reuse. */
import type { SessionState } from '@breadboard/shared';

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info';

export interface StateMeta {
  label: string;
  tone: Tone;
  /** lucide icon name key (resolved in StateBadge). */
  icon: 'clock' | 'play' | 'pause' | 'alert' | 'check' | 'x' | 'circle' | 'loader' | 'gate';
  /** Gated/blocked states get prominent treatment everywhere ([10] §5). */
  prominent: boolean;
  /** Animated/live indicator. */
  live?: boolean;
}

const SESSION: Record<SessionState, StateMeta> = {
  queued: { label: 'Queued', tone: 'neutral', icon: 'clock', prominent: false },
  running: { label: 'Running', tone: 'accent', icon: 'loader', prominent: false, live: true },
  'suspended-gate': { label: 'Awaiting review', tone: 'warn', icon: 'gate', prominent: true },
  'suspended-error': { label: 'Suspended · error', tone: 'danger', icon: 'alert', prominent: true },
  completed: { label: 'Completed', tone: 'ok', icon: 'check', prominent: false },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: 'x', prominent: false },
};

export function sessionStateMeta(state: string | null | undefined, detail?: Record<string, unknown> | null): StateMeta {
  const m = SESSION[state as SessionState];
  if (!m) return { label: state ? state : 'Unknown', tone: 'neutral', icon: 'circle', prominent: false };
  if (state === 'suspended-error' && detail && detail.reason === 'budget-exceeded') return { ...m, label: 'Suspended · budget' };
  return m;
}

export function isSuspended(state: string | null | undefined): boolean {
  return state === 'suspended-gate' || state === 'suspended-error';
}

const STEP: Record<string, StateMeta> = {
  running: { label: 'Running', tone: 'accent', icon: 'loader', prominent: false, live: true },
  exited: { label: 'Exited', tone: 'ok', icon: 'check', prominent: false },
  failed: { label: 'Failed', tone: 'danger', icon: 'alert', prominent: false },
  suspended: { label: 'Suspended', tone: 'warn', icon: 'pause', prominent: true },
  gated: { label: 'Awaiting review', tone: 'warn', icon: 'gate', prominent: true },
};

export function stepStatusMeta(status: string | null | undefined): StateMeta {
  return STEP[status ?? ''] ?? { label: status ?? 'Unknown', tone: 'neutral', icon: 'circle', prominent: false };
}

const TASK: Record<string, StateMeta> = {
  draft: { label: 'Draft', tone: 'neutral', icon: 'circle', prominent: false },
  queued: { label: 'Queued', tone: 'neutral', icon: 'clock', prominent: false },
  triaging: { label: 'Triaging', tone: 'info', icon: 'loader', prominent: false, live: true },
  active: { label: 'Active', tone: 'accent', icon: 'play', prominent: false, live: true },
  gated: { label: 'Gated', tone: 'warn', icon: 'gate', prominent: true },
  done: { label: 'Done', tone: 'ok', icon: 'check', prominent: false },
  rejected: { label: 'Rejected', tone: 'neutral', icon: 'x', prominent: false },
};

export function taskStatusMeta(status: string | null | undefined): StateMeta {
  return TASK[status ?? ''] ?? { label: status ?? 'Unknown', tone: 'neutral', icon: 'circle', prominent: false };
}

/** Classes per tone (soft background, readable foreground, matching border). */
export const TONE_CLASSES: Record<Tone, { soft: string; solid: string; text: string; dot: string; border: string }> = {
  neutral: { soft: 'bg-raised text-fg-muted', solid: 'bg-fg-muted text-surface', text: 'text-fg-muted', dot: 'bg-fg-subtle', border: 'border-line-strong' },
  accent: { soft: 'bg-accent-soft text-accent-text', solid: 'bg-accent text-accent-fg', text: 'text-accent-text', dot: 'bg-accent', border: 'border-accent' },
  ok: { soft: 'bg-ok-soft text-ok-fg', solid: 'bg-ok text-white', text: 'text-ok-fg', dot: 'bg-ok', border: 'border-ok' },
  warn: { soft: 'bg-warn-soft text-warn-fg', solid: 'bg-warn text-black', text: 'text-warn-fg', dot: 'bg-warn', border: 'border-warn' },
  danger: { soft: 'bg-danger-soft text-danger-fg', solid: 'bg-danger text-white', text: 'text-danger-fg', dot: 'bg-danger', border: 'border-danger' },
  info: { soft: 'bg-info-soft text-info-fg', solid: 'bg-info text-white', text: 'text-info-fg', dot: 'bg-info', border: 'border-info' },
};

/** The session kinds that execute steps, as one Sessions filter value (the API ORs comma-separated kinds). */
export const RUN_KINDS = 'circuit-run,eval-run';
