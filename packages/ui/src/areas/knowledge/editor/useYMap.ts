import { useCallback, useRef, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';

/** Plain-JSON snapshot of a Y.Map, re-rendering on any (deep) change. */
export function useYMapSnapshot(map: Y.Map<unknown> | null): Record<string, unknown> {
  const cache = useRef<{ map: Y.Map<unknown> | null; value: Record<string, unknown> } | null>(null);
  const subscribe = useCallback(
    (fn: () => void) => {
      if (!map) return () => undefined;
      const h = () => {
        cache.current = null;
        fn();
      };
      map.observeDeep(h);
      return () => map.unobserveDeep(h);
    },
    [map],
  );
  const get = useCallback(() => {
    if (!cache.current || cache.current.map !== map) cache.current = { map, value: map ? (map.toJSON() as Record<string, unknown>) : {} };
    return cache.current.value;
  }, [map]);
  return useSyncExternalStore(subscribe, get, get);
}

export function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}
