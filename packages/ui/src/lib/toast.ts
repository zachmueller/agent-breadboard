/** Minimal toast store (no provider needed). Render <Toaster/> once in the shell. */
import { useSyncExternalStore } from 'react';
import { errorMessage } from './api';

export type ToastKind = 'info' | 'success' | 'error' | 'warning';
export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  timeout: number;
}

let items: ToastItem[] = [];
let nextId = 1;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

export function pushToast(t: Omit<ToastItem, 'id' | 'timeout'> & { timeout?: number }): number {
  const id = nextId++;
  const item: ToastItem = { timeout: t.kind === 'error' ? 8000 : 4500, ...t, id };
  items = [...items.slice(-4), item];
  emit();
  if (item.timeout > 0) setTimeout(() => dismissToast(id), item.timeout);
  return id;
}

export function dismissToast(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  info: (title: string, description?: string) => pushToast({ kind: 'info', title, description }),
  success: (title: string, description?: string) => pushToast({ kind: 'success', title, description }),
  warning: (title: string, description?: string) => pushToast({ kind: 'warning', title, description }),
  error: (title: string, err?: unknown) => pushToast({ kind: 'error', title, description: err === undefined ? undefined : errorMessage(err) }),
};

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => items,
    () => items,
  );
}
