import { useQuery } from '@tanstack/react-query';
import type { ConfigDefinitionDto } from '@breadboard/shared';
import { configApi, qk } from '../lib/configApi';
import { filesFromDefinition, dirOf, type DefKind } from '../model/workingTree';
import { parseYamlValue } from '../lib/yamlDoc';
import { definitionPath, type ConfigKind } from '@breadboard/shared';

/** One side of a diff: a definition's files at some ref (or the live working tree). */
export interface Snapshot {
  label: string;
  ref: string | null;
  rootPath: string;
  dir: string | null;
  files: Record<string, string>;
  /** Parsed root YAML (loose; null if unparsable). */
  parsed: any;
}

export function snapshotFromDefinition(def: ConfigDefinitionDto, kind: DefKind, uid: string, label: string, ref: string | null): Snapshot {
  const rootPath = definitionPath(kind as ConfigKind, uid);
  const dir = dirOf(kind, uid);
  const files = filesFromDefinition(def, rootPath, dir);
  const p = parseYamlValue(files[rootPath] ?? '');
  return { label, ref, rootPath, dir, files, parsed: p.ok ? p.value : null };
}

export function snapshotFromFiles(files: Record<string, string>, kind: DefKind, uid: string, label: string, ref: string | null): Snapshot {
  const rootPath = definitionPath(kind as ConfigKind, uid);
  const p = parseYamlValue(files[rootPath] ?? '');
  return { label, ref, rootPath, dir: dirOf(kind, uid), files, parsed: p.ok ? p.value : null };
}

/** Load a definition snapshot at a ref. A 404 (definition absent at that ref) yields an empty snapshot. */
export function useSnapshot(kind: DefKind, uid: string, ref: string | null | undefined, label: string) {
  return useQuery({
    queryKey: [...qk.def(uid, ref ?? undefined), 'snapshot', label],
    enabled: !!ref,
    retry: false,
    staleTime: 60_000,
    queryFn: async (): Promise<Snapshot> => {
      try {
        const def = await configApi.definition(uid, ref!);
        return snapshotFromDefinition(def, kind, uid, label, ref!);
      } catch (e) {
        if ((e as any)?.status === 404) return snapshotFromFiles({}, kind, uid, label, ref!);
        throw e;
      }
    },
  });
}

export type DiffRenderer = (base: Snapshot, next: Snapshot) => React.ReactNode;
