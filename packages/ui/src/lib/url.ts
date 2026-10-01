/** URL search-param state helpers. All search values are normalized to strings by the router. */
import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

export type SearchRecord = Record<string, string | undefined>;

/** Router `validateSearch`: keep non-empty scalar values as strings. */
export function stringSearch(raw: Record<string, unknown>): SearchRecord {
  const out: SearchRecord = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = typeof v === 'string' ? v : Array.isArray(v) ? v.join(',') : String(v);
  }
  return out;
}

/** Read + patch the current route's search params (undefined / '' removes a key). */
export function useUrlSearch<T extends SearchRecord = SearchRecord>(): [T, (patch: Partial<Record<keyof T, string | undefined | null>>, opts?: { replace?: boolean }) => void] {
  const search = useSearch({ strict: false }) as T;
  const navigate = useNavigate();
  const set = useCallback(
    (patch: Partial<Record<keyof T, string | undefined | null>>, opts?: { replace?: boolean }) => {
      navigate({
        to: '.',
        replace: opts?.replace ?? true,
        search: ((prev: SearchRecord) => {
          const next: SearchRecord = { ...prev };
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === null || v === '') delete next[k];
            else next[k] = v as string;
          }
          return next;
        }) as never,
      });
    },
    [navigate],
  );
  return [search ?? ({} as T), set];
}
