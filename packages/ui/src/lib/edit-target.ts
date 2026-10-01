/**
 * The `e` shortcut ([10] §5): viewers register "open the editor for what I'm showing";
 * the global keyboard handler invokes the most recently registered action.
 */
import { useEffect, useRef } from 'react';

type Action = { run: () => void; label?: string };
const stack: Action[] = [];

export function currentEditAction(): Action | null {
  return stack[stack.length - 1] ?? null;
}

/** Register an edit action while mounted. Pass `null` to register nothing (e.g. read-only). */
export function useEditShortcut(run: (() => void) | null, label?: string): void {
  const ref = useRef(run);
  ref.current = run;
  const enabled = !!run;
  useEffect(() => {
    if (!enabled) return;
    const a: Action = { run: () => ref.current?.(), label };
    stack.push(a);
    return () => {
      const i = stack.lastIndexOf(a);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [enabled, label]);
}
