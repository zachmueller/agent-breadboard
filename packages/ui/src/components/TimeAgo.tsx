import { useSyncExternalStore } from 'react';
import { formatDateTime, formatRelative } from '../lib/format';
import { cn } from './cn';
import { Tooltip } from './Tooltip';

// One shared ticker for every relative timestamp on screen.
let now = Date.now();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function subscribe(cb: () => void) {
  subs.add(cb);
  if (!timer)
    timer = setInterval(() => {
      now = Date.now();
      subs.forEach((s) => s());
    }, 30_000);
  return () => {
    subs.delete(cb);
    if (!subs.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now, () => now);
}

export function TimeAgo({ at, className, prefix }: { at: string | null | undefined; className?: string; prefix?: string }) {
  const n = useNow();
  if (!at) return <span className={cn('text-fg-subtle', className)}>—</span>;
  return (
    <Tooltip content={formatDateTime(at)}>
      <time dateTime={at} className={cn('whitespace-nowrap tabular', className)}>
        {prefix}
        {formatRelative(at, Math.max(n, Date.now() - 1000))}
      </time>
    </Tooltip>
  );
}
