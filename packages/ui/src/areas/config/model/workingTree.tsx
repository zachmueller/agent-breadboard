/**
 * Per-editor working tree ([10] §4.5): the definition's files at a base commit plus the user's
 * uncommitted manual edits. Structured editors and the designer chat panel both read it; commits
 * go through `POST /config/commit` and only clear after the server confirms ([10] §5).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CONFIG_PATHS, definitionPath, parseConfigYaml, type ConfigDefinitionDto, type ConfigKind } from '@breadboard/shared';
import { configApi, type FileChange, type Validation } from '../lib/configApi';
import { editYaml, parseYamlValue } from '../lib/yamlDoc';
import { notify, errorMessage } from '../ui';

export type DefKind = 'circuit' | 'tool' | 'subagent' | 'mcp';

export interface WorkingTreeState {
  status: 'loading' | 'ready' | 'error';
  error: unknown;
  definition: ConfigDefinitionDto | null;
  base_commit: string | null;
  rootPath: string;
  dir: string | null;
  /** Content at base_commit for every loaded path. */
  base: Record<string, string>;
  /** Current content; `null` marks a deletion. */
  files: Record<string, string | null>;
  dirty: Set<string>;
  /** Paths probed and known to not exist at base (e.g. a circuit without rubric.yaml). */
  missing: Set<string>;
  validation: Validation | null;
  validating: boolean;
  restoredDraft: boolean;
}

type Action =
  | { t: 'loading' }
  | { t: 'error'; error: unknown }
  | { t: 'loaded'; definition: ConfigDefinitionDto; rootPath: string; dir: string | null; keep?: Record<string, string | null>; restored?: boolean; extra?: Record<string, string> }
  | { t: 'set'; path: string; content: string | null }
  | { t: 'add-base'; path: string; content: string | null }
  | { t: 'discard' }
  | { t: 'validating' }
  | { t: 'validated'; validation: Validation | null };

function computeDirty(base: Record<string, string>, files: Record<string, string | null>): Set<string> {
  const out = new Set<string>();
  for (const p of new Set([...Object.keys(base), ...Object.keys(files)])) {
    if ((files[p] ?? null) !== (base[p] ?? null)) out.add(p);
  }
  return out;
}

export function filesFromDefinition(def: ConfigDefinitionDto, rootPath: string, dir: string | null): Record<string, string> {
  const out: Record<string, string> = { [rootPath]: def.raw ?? '' };
  for (const [k, v] of Object.entries(def.files ?? {})) {
    if (typeof v !== 'string') continue;
    const full = dir && !k.startsWith(`${dir}/`) ? `${dir}/${k.replace(/^\/+/, '')}` : k;
    if (full === rootPath) continue;
    out[full] = v;
  }
  return out;
}

function reducer(s: WorkingTreeState, a: Action): WorkingTreeState {
  switch (a.t) {
    case 'loading':
      return { ...s, status: s.definition ? s.status : 'loading', error: null };
    case 'error':
      return { ...s, status: 'error', error: a.error };
    case 'loaded': {
      const base = { ...filesFromDefinition(a.definition, a.rootPath, a.dir), ...(a.extra ?? {}) };
      const files: Record<string, string | null> = { ...base, ...(a.keep ?? {}) };
      return {
        ...s,
        status: 'ready',
        error: null,
        definition: a.definition,
        base_commit: a.definition.commit ?? null,
        rootPath: a.rootPath,
        dir: a.dir,
        base,
        files,
        dirty: computeDirty(base, files),
        missing: new Set([...s.missing].filter((p) => !(p in base))),
        validation: a.definition.validation ?? null,
        restoredDraft: !!a.restored,
      };
    }
    case 'set': {
      const files = { ...s.files, [a.path]: a.content };
      if (a.content === null && !(a.path in s.base)) delete files[a.path];
      return { ...s, files, dirty: computeDirty(s.base, files) };
    }
    case 'add-base': {
      if (a.content === null) return { ...s, missing: new Set([...s.missing, a.path]) };
      const base = { ...s.base, [a.path]: a.content };
      const files = a.path in s.files ? s.files : { ...s.files, [a.path]: a.content };
      return { ...s, base, files, dirty: computeDirty(base, files) };
    }
    case 'discard':
      return { ...s, files: { ...s.base }, dirty: new Set(), validation: s.definition?.validation ?? null, restoredDraft: false };
    case 'validating':
      return { ...s, validating: true };
    case 'validated':
      return { ...s, validating: false, validation: a.validation ?? s.validation };
  }
}

export interface WorkingTree {
  uid: string;
  kind: DefKind;
  state: WorkingTreeState;
  /** Path used for `GET /config/history` and `POST /config/revert`. */
  historyPath: string;
  rootText: string;
  /** Parsed root YAML as a plain value (even when schema-invalid), or null on YAML syntax error. */
  parsed: any;
  parseError: string | null;
  /** Local schema errors from `parseConfigYaml` merged with server validation. */
  errors: string[];
  warnings: string[];
  getFile: (path: string) => string | undefined;
  setFile: (path: string, content: string | null) => void;
  /** Structured, comment-preserving edit of any YAML file (defaults to the root file). */
  editYamlFile: (mutate: (draft: any) => any, path?: string) => boolean;
  /** Probe for a file that may not be in `files` (rubric.yaml, fixtures.yaml); idempotent. */
  ensureFile: (path: string) => void;
  changes: () => FileChange[];
  snapshot: () => Record<string, string>;
  commit: (message: string) => Promise<string | null>;
  discard: () => void;
  reload: (opts?: { keepEdits?: boolean }) => Promise<void>;
}

const Ctx = createContext<WorkingTree | null>(null);

export function useWorkingTree(): WorkingTree {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWorkingTree must be used inside <WorkingTreeProvider>');
  return v;
}

export function useOptionalWorkingTree(): WorkingTree | null {
  return useContext(Ctx);
}

/**
 * Fetch a file outside the definition's own payload. Files inside a circuit/tool dir always arrive in
 * `definition.files` (the server returns the whole dir), so those are never probed; for other paths
 * only an exact path match counts (the server resolves sub-paths to their owning definition).
 */
async function probeFile(path: string, dir: string | null, ref?: string): Promise<string | null> {
  if (dir && path.startsWith(`${dir}/`)) return null;
  const r = await configApi.definitionAny([path], ref).catch(() => null);
  return r && r.path === path ? (r.raw ?? null) : null;
}

export function dirOf(kind: DefKind, uid: string): string | null {
  if (kind === 'circuit') return CONFIG_PATHS.circuitDir(uid);
  if (kind === 'tool') return CONFIG_PATHS.toolDir(uid);
  return null;
}

const draftKey = (uid: string) => `bb.config.draft.${uid}`;

function readDraft(uid: string): { base_commit: string; changes: Record<string, string | null> } | null {
  try {
    const raw = sessionStorage.getItem(draftKey(uid));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function WorkingTreeProvider({ uid, kind, children }: { uid: string; kind: DefKind; children: ReactNode }) {
  const rootPath = definitionPath(kind as ConfigKind, uid);
  const dir = dirOf(kind, uid);
  const qc = useQueryClient();
  const [state, dispatch] = useReducer(reducer, undefined, (): WorkingTreeState => ({
    status: 'loading',
    error: null,
    definition: null,
    base_commit: null,
    rootPath,
    dir,
    base: {},
    files: {},
    dirty: new Set(),
    missing: new Set(),
    validation: null,
    validating: false,
    restoredDraft: false,
  }));
  const stateRef = useRef(state);
  stateRef.current = state;
  const probing = useRef(new Set<string>());

  const load = useCallback(
    async (opts?: { keepEdits?: boolean; fromDraft?: boolean }) => {
      dispatch({ t: 'loading' });
      try {
        const def = await configApi.definition(uid);
        let keep: Record<string, string | null> | undefined;
        let restored = false;
        const cur = stateRef.current;
        if (opts?.keepEdits) {
          keep = Object.fromEntries([...cur.dirty].map((p) => [p, cur.files[p] ?? null]));
        } else if (opts?.fromDraft) {
          const d = readDraft(uid);
          if (d && d.base_commit === def.commit && Object.keys(d.changes).length) {
            keep = d.changes;
            restored = true;
          }
        }
        // Re-probe extra files the editor asked for previously (so a reload keeps them).
        const extra: Record<string, string> = {};
        const known = filesFromDefinition(def, rootPath, dir);
        for (const p of Object.keys(cur.base)) {
          if (p in known || p === rootPath) continue;
          const r = await probeFile(p, dir, def.commit);
          if (r !== null) extra[p] = r;
        }
        if (keep) for (const p of Object.keys(keep)) if (!(p in known) && !(p in extra) && keep[p] !== null) {
          const r = await probeFile(p, dir, def.commit);
          if (r !== null) extra[p] = r;
        }
        dispatch({ t: 'loaded', definition: def, rootPath, dir, keep, restored, extra });
      } catch (e) {
        dispatch({ t: 'error', error: e });
      }
    },
    [uid, rootPath, dir],
  );

  useEffect(() => {
    probing.current = new Set();
    void load({ fromDraft: true });
  }, [load]);

  // Persist unsaved edits per definition so navigating to a child editor and back keeps them.
  useEffect(() => {
    if (state.status !== 'ready' || !state.base_commit) return;
    try {
      if (state.dirty.size === 0) sessionStorage.removeItem(draftKey(uid));
      else sessionStorage.setItem(draftKey(uid), JSON.stringify({ base_commit: state.base_commit, changes: Object.fromEntries([...state.dirty].map((p) => [p, state.files[p] ?? null])) }));
    } catch {
      /* storage full / disabled */
    }
  }, [state.files, state.dirty, state.status, state.base_commit, uid]);

  useEffect(() => {
    if (state.dirty.size === 0) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [state.dirty.size]);

  const changes = useCallback((): FileChange[] => {
    const s = stateRef.current;
    return [...s.dirty].sort().map((path) => ({ path, content: s.files[path] ?? null }));
  }, []);

  // Debounced server validation of the working tree.
  const changeKey = useMemo(() => JSON.stringify([...state.dirty].sort().map((p) => [p, state.files[p] ?? null])), [state.dirty, state.files]);
  const seq = useRef(0);
  useEffect(() => {
    if (state.status !== 'ready') return;
    if (state.dirty.size === 0) {
      dispatch({ t: 'validated', validation: state.definition?.validation ?? null });
      return;
    }
    const my = ++seq.current;
    dispatch({ t: 'validating' });
    const timer = setTimeout(async () => {
      try {
        const v = await configApi.validate(changes(), stateRef.current.base_commit);
        if (my === seq.current) dispatch({ t: 'validated', validation: { ok: !!v.ok, errors: v.errors ?? [], warnings: v.warnings ?? [] } });
      } catch {
        if (my === seq.current) dispatch({ t: 'validated', validation: null });
      }
    }, 650);
    return () => clearTimeout(timer);
  }, [changeKey, state.status]);

  const rootText = state.files[rootPath] ?? '';
  const { parsed, parseError } = useMemo(() => {
    if (state.status !== 'ready') return { parsed: null, parseError: null };
    const r = parseYamlValue(rootText);
    return r.ok ? { parsed: r.value ?? {}, parseError: null } : { parsed: null, parseError: r.error };
  }, [rootText, state.status]);

  const localErrors = useMemo(() => {
    if (state.status !== 'ready') return [];
    const errs: string[] = [];
    const yamlFiles = [...state.dirty].filter((p) => p.endsWith('.yaml') && state.files[p] != null);
    if (!yamlFiles.includes(rootPath)) yamlFiles.unshift(rootPath);
    for (const p of yamlFiles) {
      const text = state.files[p];
      if (text == null) continue;
      const r = parseConfigYaml(text);
      const prefix = p === rootPath ? '' : `${p.split('/').pop()}: `;
      for (const e of r.errors) errs.push(prefix + e);
    }
    return errs;
  }, [state.files, state.dirty, state.status, rootPath]);

  const errors = useMemo(() => [...new Set([...localErrors, ...(state.validation?.errors ?? [])])], [localErrors, state.validation]);
  const warnings = state.validation?.warnings ?? [];

  const setFile = useCallback((path: string, content: string | null) => dispatch({ t: 'set', path, content }), []);

  const editYamlFile = useCallback(
    (mutate: (draft: any) => any, path?: string) => {
      const p = path ?? rootPath;
      const text = stateRef.current.files[p] ?? '';
      try {
        const next = editYaml(text, mutate);
        if (next !== text) dispatch({ t: 'set', path: p, content: next });
        return true;
      } catch (e) {
        notify(errorMessage(e), 'danger');
        return false;
      }
    },
    [rootPath],
  );

  const ensureFile = useCallback(
    (path: string) => {
      const s = stateRef.current;
      if (s.status !== 'ready' || path in s.base || path in s.files || s.missing.has(path) || probing.current.has(path)) return;
      probing.current.add(path);
      probeFile(path, s.dir, s.base_commit ?? undefined)
        .then((content) => dispatch({ t: 'add-base', path, content }))
        .catch(() => dispatch({ t: 'add-base', path, content: null }));
    },
    [],
  );

  const commit = useCallback(
    async (message: string) => {
      const ch = changes();
      if (!ch.length) return null;
      const r = await configApi.commit(ch, message);
      try {
        sessionStorage.removeItem(draftKey(uid));
      } catch {
        /* ignore */
      }
      notify('Committed to main', 'ok');
      await load();
      void qc.invalidateQueries({ queryKey: ['config'] });
      return r?.commit ?? r?.head ?? null;
    },
    [changes, load, qc, uid],
  );

  const value = useMemo<WorkingTree>(
    () => ({
      uid,
      kind,
      state,
      historyPath: dir ?? rootPath,
      rootText,
      parsed,
      parseError,
      errors,
      warnings,
      getFile: (p) => {
        const v = state.files[p];
        return v === null ? undefined : v;
      },
      setFile,
      editYamlFile,
      ensureFile,
      changes,
      snapshot: () => Object.fromEntries(Object.entries(stateRef.current.files).filter((e): e is [string, string] => e[1] !== null)),
      commit,
      discard: () => {
        try {
          sessionStorage.removeItem(draftKey(uid));
        } catch {
          /* ignore */
        }
        dispatch({ t: 'discard' });
      },
      reload: async (opts) => {
        await load({ keepEdits: opts?.keepEdits });
        void qc.invalidateQueries({ queryKey: ['config'] });
      },
    }),
    [uid, kind, state, dir, rootPath, rootText, parsed, parseError, errors, warnings, setFile, editYamlFile, ensureFile, changes, commit, load, qc],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Errors whose path prefix matches (e.g. `steps.2.` or `tools.`). */
export function errorsFor(errors: string[], ...prefixes: string[]): string[] {
  return errors.filter((e) => prefixes.some((p) => e.startsWith(p) || e.includes(` ${p}`)));
}
