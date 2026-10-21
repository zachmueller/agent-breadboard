/**
 * Repository mirrors ([06] §7.1): bare single-branch clones the server keeps of the git repositories declared in
 * `breadboard.yaml` (`repos:`), searched and read through the `search_repo` / `read_repo_file` primitives.
 *
 * - Freshness: a call without `commit` fetches first when the last attempt is at least `refresh_minutes` old. One
 *   fetch runs per mirror at a time and concurrent callers share it; a caller waits for it up to `waitMs`, then
 *   answers from the current head (`refreshing: true`). A failed fetch leaves the previous head serving
 *   (`stale: true`, `refresh_error`) and is retried only once the window has passed again.
 * - Consistency: each call resolves one commit SHA and reads only through it, so a concurrent fetch never changes a
 *   result mid-call, and the reflog (`core.logAllRefUpdates=always`) keeps cited commits readable after force-pushes.
 * - State (`state.json`: fetch times, last error) survives restarts, so a restart does not refetch inside the window.
 * - Auth: a mirror naming a broker capability fetches with the headers `broker.withRepoAuth` supplies (CodeCommit's
 *   SigV4 password for AWS credentials), passed to git only through its environment.
 */
import { mkdir, readFile, rename, rm, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { BreadboardError, type BreadboardConfig, type RepoMirrorConfig } from '@breadboard/shared';
import type { Logger } from '../core/logger.js';
import { canReadRepo, servicePrincipal, type Principal } from '../core/principal.js';
import type { CredentialBroker, RepoMirrors, RepoMirrorStatus, RepoReadInput, RepoSearchInput } from '../core/services.js';
import { cleanGitError, gitVersion, mirrorGitEnv, runGit, type GitRunner } from './git.js';
import * as P from './pathspec.js';
import { TreeIndex, parseLsTree, type TreeEntry } from './tree-index.js';
import { locate, renderNotebook, type NotebookCell } from './notebook.js';
import { grepCounts, grepLines, isBinary, readBlobs, snippet, splitLines, type GrepFlags, type GrepHit, type GrepRun } from './search.js';

export interface RepoMirrorsDeps {
  dir: string;
  settings: () => Promise<BreadboardConfig>;
  broker: Pick<CredentialBroker, 'withRepoAuth'>;
  log: Logger;
  team_id: string;
  /** Allow `file://` and loopback `http://` remotes (tests, local development). */
  allowFileUrls?: boolean;
  git?: GitRunner;
  now?: () => number;
  /** How long a call waits for an in-flight fetch before answering from the current head (default 20 s). */
  waitMs?: number;
  /** Config reconcile interval (default 60 s). */
  tickMs?: number;
}

type Phase = RepoMirrorStatus['phase'];

interface Mirror {
  cfg: RepoMirrorConfig;
  key: string;
  dir: string;
  gitDir: string;
  nbDir: string;
  phase: Phase;
  head: string | null;
  fetched_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
  failures: number;
  inflight: Promise<void> | null;
  rendering: Promise<void> | null;
  trees: Map<string, TreeIndex>;
  committedAt: Map<string, string>;
  notebooks: Map<string, NotebookMeta>;
  emptyTree: string | null;
}

interface NotebookMeta {
  cells: NotebookCell[];
  language: string | null;
  /** Not parseable as a notebook: the cache holds the raw text. */
  raw: boolean;
  bytes: number;
}

const STATE_VERSION = 1;
const SEARCH_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 60_000;
const LITERAL_EXCLUDE_MAX = 1000;
const READ_MAX_BYTES = 64 * 1024 * 1024;
const MAX_DIR_ENTRIES = 1000;
const MAX_FILES_ONLY = 500;
const NOTEBOOK_GREP_CHUNK = 500;
const NOTEBOOK_RENDER_BATCH_BYTES = 64 * 1024 * 1024;
const GREP_CONCURRENCY = 4;
const TREE_CACHE = 4;
const HARD_MAX_CHARS = 200_000;
const FIRST_CLONE_MIN_TIMEOUT_S = 3600;

const clamp = (v: number | undefined, lo: number, hi: number, dflt: number) => Math.max(lo, Math.min(hi, Math.trunc(v ?? dflt)));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

class Semaphore {
  private queue: Array<() => void> = [];
  constructor(private free: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.queue.push(r));
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.free++;
    }
  }
}

export class RepoMirrorsImpl implements RepoMirrors {
  private readonly mirrors = new Map<string, Mirror>();
  private readonly git: GitRunner;
  private readonly now: () => number;
  private readonly waitMs: number;
  private readonly service: Principal;
  private readonly grep = new Semaphore(GREP_CONCURRENCY);
  private timer: NodeJS.Timeout | null = null;
  private reconciling: Promise<void> | null = null;
  /** Set when the installed git cannot run mirrors. */
  private unavailable: string | null = null;
  private started: Promise<void> | null = null;

  constructor(private readonly deps: RepoMirrorsDeps) {
    this.git = deps.git ?? runGit;
    this.now = deps.now ?? Date.now;
    this.waitMs = deps.waitMs ?? 20_000;
    this.service = servicePrincipal(deps.team_id, 'repo-mirror');
  }

  start(): void {
    if (this.started) return;
    this.started = (async () => {
      const v = await gitVersion(this.git).catch(() => ({ version: 'not found', ok: false }));
      if (!v.ok) {
        this.unavailable = `repository mirrors need git >= 2.38 (found ${v.version})`;
        this.deps.log.error({ git: v.version }, this.unavailable);
        return;
      }
      await this.reconcile();
    })();
    this.timer = setInterval(() => void this.reconcile(), this.deps.tickMs ?? 60_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const pending = [...this.mirrors.values()].flatMap((m) => [m.inflight, m.rendering]).filter(Boolean);
    await Promise.race([Promise.allSettled(pending), sleep(5000)]);
  }

  /** Bring the mirror set in line with `breadboard.yaml`: load new ones, re-clone changed remotes, drop removed ones. */
  async reconcile(): Promise<void> {
    if (this.unavailable) return;
    if (this.reconciling) return this.reconciling;
    this.reconciling = (async () => {
      let repos: RepoMirrorConfig[];
      try {
        repos = (await this.deps.settings()).repos ?? [];
      } catch (e) {
        this.deps.log.warn({ err: e }, 'repository mirrors: breadboard.yaml did not load; keeping the current mirrors');
        return;
      }
      const configured = new Set(repos.map((r) => r.name));
      for (const cfg of repos) {
        if (!cfg.enabled) {
          this.mirrors.delete(cfg.name);
          continue;
        }
        let m = this.mirrors.get(cfg.name);
        const key = mirrorKey(cfg);
        if (m && m.key !== key) {
          this.mirrors.delete(cfg.name);
          await this.discard(m);
          m = undefined;
        }
        if (!m) {
          m = await this.load(cfg);
          this.mirrors.set(cfg.name, m);
        } else m.cfg = cfg;
        if (m.phase !== 'ready' && !m.inflight && this.due(m)) void this.fetch(m, this.service);
      }
      for (const name of [...this.mirrors.keys()]) if (!configured.has(name)) this.mirrors.delete(name);
      await this.removeStray(configured);
    })().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  // -- public API --------------------------------------------------------------------------------------

  async status(by?: Principal): Promise<RepoMirrorStatus[]> {
    this.start();
    await this.started;
    return [...this.mirrors.values()].filter((m) => !by || canReadRepo(by, m.cfg.name)).map((m) => this.statusOf(m));
  }

  async search(input: RepoSearchInput, by: Principal): Promise<Record<string, unknown>> {
    const m = await this.resolve(input.repo, by);
    const fresh = await this.freshness(m, by, !input.commit);
    const sha = await this.commitSha(m, input.commit);
    const flags: GrepFlags = { pattern: P.pattern(input.pattern), regex: !!input.regex, ignore_case: !!input.ignore_case, word: !!input.word };
    const include = P.globs(input.paths, 'paths');
    const exclude = [...P.globs(m.cfg.exclude, 'repository exclude'), ...P.globs(input.exclude, 'exclude')];
    const max = clamp(input.max_results, 1, 200, 40);
    const perFile = clamp(input.max_per_file, 1, 50, 5);
    const context = clamp(input.context, 0, 10, 2);
    const budget = input.max_chars === 0 ? HARD_MAX_CHARS : clamp(input.max_chars, 1, HARD_MAX_CHARS, 20_000);
    const tree = await this.tree(m, sha);
    const env = mirrorGitEnv({ allowFileUrls: this.deps.allowFileUrls });

    // Regular files: the commit's tree minus notebooks and oversized files.
    const oversize = tree.entries.filter((e) => e.type === 'blob' && !isNotebookPath(e.path) && (e.size ?? 0) > m.cfg.max_file_bytes).map((e) => e.path);
    const oversizeSet = new Set(oversize);
    const literal = oversize.length <= LITERAL_EXCLUDE_MAX ? oversize : [];
    const fileRun: GrepRun = { git: this.git, env, timeoutMs: SEARCH_TIMEOUT_MS, gitDir: m.gitDir, sha, specs: P.pathspecs({ include, exclude, excludeRaw: ['*.ipynb'], excludeLiteral: literal }) };

    // Notebooks: their rendered cell sources in the cache, selected by the same pathspecs.
    const nb = await this.notebookSet(m, sha, tree, include, exclude);
    const nbRuns: GrepRun[] = [];
    for (let i = 0; i < nb.files.length; i += NOTEBOOK_GREP_CHUNK) nbRuns.push({ git: this.git, env, timeoutMs: SEARCH_TIMEOUT_MS, cwd: m.nbDir, specs: nb.files.slice(i, i + NOTEBOOK_GREP_CHUNK) });

    const base = { repo: m.cfg.name, commit: sha, branch: m.cfg.branch, committed_at: await this.committedAt(m, sha), ...fresh, regex_flavor: flags.regex ? 'pcre' : null };
    const skipped = { over_size_files: oversize.length, notebooks_over_size: nb.overSize, max_file_bytes: m.cfg.max_file_bytes };

    if (input.files_only) {
      const runs = [fileRun, ...nbRuns];
      const results = await Promise.all(runs.map((r) => this.grep.run(() => grepCounts(r, flags, MAX_FILES_ONLY + 1))));
      throwIfGrepError(results);
      const files: Array<{ path: string; match_count: number; notebook?: true }> = [];
      for (const it of results[0]!.items) if (!oversizeSet.has(it.path)) files.push({ path: it.path, match_count: it.count });
      for (const r of results.slice(1)) for (const it of r.items) for (const path of nb.pathsOf(it.path)) files.push({ path, match_count: it.count, notebook: true });
      files.sort((a, b) => cmp(a.path, b.path));
      const timedOut = results.some((r) => r.timedOut);
      const truncated = timedOut || files.length > MAX_FILES_ONLY || results.some((r) => r.capped);
      return { ...base, files: files.slice(0, MAX_FILES_ONLY), files_matched: Math.min(files.length, MAX_FILES_ONLY), truncated, truncation: timedOut ? 'timeout' : truncated ? 'max_results' : null, skipped };
    }

    const rawCap = max + perFile + 1;
    const results = await Promise.all([fileRun, ...nbRuns].map((r) => this.grep.run(() => grepLines(r, flags, perFile + 1, rawCap))));
    throwIfGrepError(results);
    const byFile = new Map<string, { notebook: boolean; blob: string | null; hits: GrepHit[] }>();
    for (const h of results[0]!.items) {
      if (oversizeSet.has(h.path)) continue;
      const f = byFile.get(h.path) ?? { notebook: false, blob: tree.lookup(h.path)?.sha ?? null, hits: [] };
      f.hits.push(h);
      byFile.set(h.path, f);
    }
    for (const r of results.slice(1)) {
      for (const h of r.items) {
        const blob = blobOfCacheFile(h.path);
        for (const path of nb.pathsOf(h.path)) {
          const f = byFile.get(path) ?? { notebook: true, blob, hits: [] };
          f.hits.push(h);
          byFile.set(path, f);
        }
      }
    }

    // Order by path, keep `perFile` hits per file and `max` overall, then attach snippets within the char budget.
    const ordered = [...byFile.entries()].sort(([a], [b]) => cmp(a, b));
    let kept = 0;
    let truncated = results.some((r) => r.capped);
    const timedOut = results.some((r) => r.timedOut);
    const chosen: Array<{ path: string; notebook: boolean; blob: string | null; hits: GrepHit[]; more: boolean }> = [];
    for (const [path, f] of ordered) {
      if (kept >= max) {
        truncated = true;
        break;
      }
      const nbMeta = f.notebook && f.blob ? this.notebookMeta(m, f.blob) : null;
      const usable = nbMeta && !nbMeta.raw ? f.hits.filter((h) => locate(nbMeta.cells, h.line)?.cell_line !== 0) : f.hits;
      if (!usable.length) continue;
      const room = max - kept;
      const take = usable.slice(0, Math.min(perFile, room));
      if (room < Math.min(perFile, usable.length)) truncated = true; // cut by the overall cap, not the per-file one
      chosen.push({ path, notebook: f.notebook, blob: f.blob, hits: take, more: usable.length > take.length });
      kept += take.length;
    }

    const texts = await this.texts(m, chosen.filter((c) => !c.notebook && c.blob).map((c) => c.blob!));
    const files: Array<Record<string, unknown>> = [];
    let used = 0;
    let charCut = false;
    for (const c of chosen) {
      const text = c.notebook ? await this.notebookText(m, c.blob!) : (texts.get(c.blob!) ?? '');
      const lines = splitLines(text);
      let snip = snippet(lines, c.hits, context);
      if (used + snip.length > budget) {
        if (files.length) {
          charCut = true;
          break;
        }
        snip = `${snip.slice(0, budget)}…`;
        charCut = true;
      }
      used += snip.length;
      const meta = c.notebook && c.blob ? this.notebookMeta(m, c.blob) : null;
      files.push({
        path: c.path,
        ...(c.notebook ? { notebook: true } : {}),
        match_count: c.hits.length,
        more_in_file: c.more,
        matches: c.hits.map((h) => ({ line: h.line, column: h.column, ...(meta && !meta.raw ? (locate(meta.cells, h.line) ?? {}) : {}) })),
        snippet: snip,
      });
      if (charCut) break;
    }
    const total = files.reduce((n, f) => n + (f.match_count as number), 0);
    truncated ||= charCut || files.length < chosen.length;
    return {
      ...base,
      files,
      total_matches: total,
      files_matched: files.length,
      truncated: truncated || timedOut,
      truncation: timedOut ? 'timeout' : charCut ? 'max_chars' : truncated ? 'max_results' : null,
      skipped,
    };
  }

  async read(input: RepoReadInput, by: Principal): Promise<Record<string, unknown>> {
    const m = await this.resolve(input.repo, by);
    const fresh = await this.freshness(m, by, !input.commit);
    const sha = await this.commitSha(m, input.commit);
    const path = P.repoPath(input.path ?? '');
    const tree = await this.tree(m, sha);
    const base = { repo: m.cfg.name, commit: sha, branch: m.cfg.branch, committed_at: await this.committedAt(m, sha), ...fresh, path };
    const entry = path ? tree.lookup(path) : null;
    if (!entry) {
      if (path !== '' && !tree.isDir(path)) {
        throw new BreadboardError('not-found', `no file or directory '${path}' in ${m.cfg.name} at ${sha.slice(0, 12)}`, { suggestions: tree.suggest(path) });
      }
      const entries = tree.listDir(path);
      return { ...base, type: 'directory', entries: entries.slice(0, MAX_DIR_ENTRIES), total_entries: entries.length, truncated: entries.length > MAX_DIR_ENTRIES };
    }
    if (entry.type === 'commit') return { ...base, type: 'submodule', submodule_commit: entry.sha };

    let text: string | null;
    let notebook: Record<string, unknown> | undefined;
    if (isNotebookPath(path) && !input.raw && (entry.size ?? 0) <= m.cfg.max_notebook_bytes) {
      await this.renderMissing(m, [entry]);
      const meta = this.notebookMeta(m, entry.sha);
      text = await this.notebookText(m, entry.sha);
      if (meta && !meta.raw) notebook = { cells: meta.cells.length, language: meta.language, view: 'cell sources (outputs omitted); pass raw: true for the .ipynb JSON' };
    } else {
      if ((entry.size ?? 0) > READ_MAX_BYTES) throw new BreadboardError('validation-failed', `${path} is ${entry.size} bytes, over the ${READ_MAX_BYTES}-byte read limit`);
      const blob = (await readBlobs(this.git, m.gitDir, mirrorGitEnv({ allowFileUrls: this.deps.allowFileUrls }), [entry.sha], READ_TIMEOUT_MS, READ_MAX_BYTES + 1024)).get(entry.sha);
      if (!blob) throw new BreadboardError('internal', `could not read ${path} at ${sha.slice(0, 12)}`);
      text = isBinary(blob) ? null : blob.toString('utf8');
    }
    const file = { ...base, type: 'file', size: entry.size, blob: entry.sha, ...(entry.mode === '120000' ? { symlink: true } : {}), ...(notebook ? { notebook } : {}) };
    if (text === null) return { ...file, binary: true, text: null };

    const lines = splitLines(text);
    const budget = input.max_chars === 0 ? HARD_MAX_CHARS : clamp(input.max_chars, 1, HARD_MAX_CHARS, 20_000);
    const start = Math.max(1, Math.trunc(input.start_line ?? 1));
    const end = Math.min(lines.length, Math.trunc(input.end_line ?? lines.length));
    const width = String(Math.max(end, 1)).length;
    const out: string[] = [];
    let used = 0;
    let last = start - 1;
    for (let n = start; n <= end; n++) {
      const row = `${String(n).padStart(width)}\t${lines[n - 1]}`;
      if (out.length && used + row.length + 1 > budget) break;
      out.push(row.length > budget ? `${row.slice(0, budget)}…` : row);
      used += row.length + 1;
      last = n;
    }
    return { ...file, binary: false, total_lines: lines.length, start_line: start, end_line: last, next_start_line: last < end ? last + 1 : null, text: out.join('\n') };
  }

  // -- mirrors -------------------------------------------------------------------------------------------

  private async resolve(name: string | undefined, by: Principal): Promise<Mirror> {
    this.start();
    await this.started;
    if (this.unavailable) throw new BreadboardError('invalid-state', this.unavailable);
    // A mirror added to breadboard.yaml since the last tick is picked up on first use.
    if (name ? !this.mirrors.has(name) : !this.mirrors.size) await this.reconcile();
    const visible = [...this.mirrors.values()].filter((m) => canReadRepo(by, m.cfg.name));
    if (!name) {
      if (visible.length === 1) return visible[0]!;
      if (!visible.length) throw new BreadboardError('not-found', 'no repository mirrors are available to you');
      throw new BreadboardError('validation-failed', `repo is required: one of ${visible.map((m) => m.cfg.name).join(', ')}`);
    }
    const m = this.mirrors.get(name);
    if (m && !canReadRepo(by, name)) throw new BreadboardError('grant-denied', `no grant for repository '${name}' (subagent repos grant)`);
    if (!m) throw new BreadboardError('not-found', `unknown repository '${name}'${visible.length ? `; available: ${visible.map((v) => v.cfg.name).join(', ')}` : ''}`);
    return m;
  }

  private due(m: Mirror): boolean {
    return m.last_attempt_at === null || this.now() - m.last_attempt_at >= m.cfg.refresh_minutes * 60_000;
  }

  /** Refresh when due (`refresh` = no pinned commit), wait briefly for an in-flight fetch, and report freshness. */
  private async freshness(m: Mirror, by: Principal, refresh: boolean): Promise<{ fetched_at: string | null; stale: boolean; refreshing: boolean; refresh_error: string | null }> {
    if ((refresh || !m.head) && this.due(m) && !m.inflight) void this.fetch(m, by);
    if (m.inflight && (refresh || !m.head)) await Promise.race([m.inflight, sleep(this.waitMs)]);
    if (!m.head) {
      throw new BreadboardError('invalid-state', `repository '${m.cfg.name}' is not cloned yet (${m.phase}); try again shortly`, {
        phase: m.inflight ? 'cloning' : m.phase,
        last_error: m.last_error,
        last_attempt_at: m.last_attempt_at ? new Date(m.last_attempt_at).toISOString() : null,
      });
    }
    return { fetched_at: m.fetched_at ? new Date(m.fetched_at).toISOString() : null, stale: !!m.last_error, refreshing: !!m.inflight, refresh_error: m.last_error };
  }

  /** The single in-flight fetch for a mirror (the first one clones). */
  private fetch(m: Mirror, by: Principal): Promise<void> {
    if (m.inflight) return m.inflight;
    m.inflight = (async () => {
      const started = this.now();
      m.last_attempt_at = started;
      if (!m.head) m.phase = 'cloning';
      const before = m.head;
      try {
        const url = this.remoteUrl(m.cfg);
        await this.ensureRepo(m);
        const timeoutMs = (m.head ? m.cfg.fetch_timeout_s : Math.max(m.cfg.fetch_timeout_s, FIRST_CLONE_MIN_TIMEOUT_S)) * 1000;
        const run = async (headers: Record<string, string>) => {
          const ref = `refs/heads/${m.cfg.branch}`;
          const r = await this.git({
            args: ['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--quiet', url, `+${ref}:${ref}`],
            gitDir: m.gitDir,
            env: mirrorGitEnv({ headers, allowFileUrls: this.deps.allowFileUrls }),
            timeoutMs,
            maxStdoutBytes: 1024 * 1024,
          });
          if (r.timedOut) throw new Error(`git fetch timed out after ${Math.round(timeoutMs / 1000)}s`);
          if (r.code !== 0) throw new Error(cleanGitError(r.stderr) || `git fetch exited with ${r.code}`);
        };
        if (m.cfg.capability) await this.deps.broker.withRepoAuth({ capability: m.cfg.capability, url, principal: by }, run);
        else await run({});
        const head = await this.revParse(m, `refs/heads/${m.cfg.branch}^{commit}`);
        if (!head) throw new Error(`branch '${m.cfg.branch}' not found on the remote`);
        m.head = head;
        m.phase = 'ready';
        m.fetched_at = this.now();
        m.last_error = null;
        m.failures = 0;
        this.deps.log.info({ repo: m.cfg.name, commit: head, moved: head !== before, ms: this.now() - started }, before ? 'repository mirror fetched' : 'repository mirror cloned');
      } catch (e) {
        m.last_error = cleanGitError(String((e as Error).message ?? e));
        m.failures++;
        m.phase = m.head ? 'ready' : 'failed';
        this.deps.log.warn({ repo: m.cfg.name, err: m.last_error, failures: m.failures }, 'repository mirror fetch failed');
      } finally {
        await this.saveState(m).catch((e) => this.deps.log.warn({ err: e, repo: m.cfg.name }, 'repository mirror state not saved'));
        m.inflight = null;
      }
      if (m.head && m.head !== before) this.prerender(m);
    })();
    return m.inflight;
  }

  private remoteUrl(cfg: RepoMirrorConfig): string {
    const u = new URL(cfg.url);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol === 'https:') return cfg.url;
    if (this.deps.allowFileUrls && (u.protocol === 'file:' || (u.protocol === 'http:' && loopback))) return cfg.url;
    throw new Error(`repository url must use https (file and loopback http need MIRROR_ALLOW_FILE_URLS)`);
  }

  private async ensureRepo(m: Mirror): Promise<void> {
    if (existsSync(join(m.gitDir, 'HEAD'))) return;
    await mkdir(m.dir, { recursive: true });
    const env = mirrorGitEnv();
    const init = await this.git({ args: ['init', '--bare', '--quiet', m.gitDir], env, timeoutMs: 30_000 });
    if (init.code !== 0) throw new Error(`git init failed: ${cleanGitError(init.stderr)}`);
    for (const [k, v] of [
      ['core.logAllRefUpdates', 'always'],
      ['gc.reflogExpire', '90.days'],
    ]) {
      await this.git({ args: ['config', k!, v!], gitDir: m.gitDir, env, timeoutMs: 10_000 });
    }
    await this.git({ args: ['symbolic-ref', 'HEAD', `refs/heads/${m.cfg.branch}`], gitDir: m.gitDir, env, timeoutMs: 10_000 });
  }

  private async load(cfg: RepoMirrorConfig): Promise<Mirror> {
    const dir = join(this.deps.dir, cfg.name);
    const m: Mirror = {
      cfg,
      key: mirrorKey(cfg),
      dir,
      gitDir: join(dir, 'repo.git'),
      nbDir: join(dir, 'nbcache'),
      phase: 'absent',
      head: null,
      fetched_at: null,
      last_attempt_at: null,
      last_error: null,
      failures: 0,
      inflight: null,
      rendering: null,
      trees: new Map(),
      committedAt: new Map(),
      notebooks: new Map(),
      emptyTree: null,
    };
    const state = await readState(dir);
    if (state && state.key !== m.key) {
      // The remote or branch changed while the server was down: the old clone is of something else.
      await rm(dir, { recursive: true, force: true });
      return m;
    }
    if (existsSync(join(m.gitDir, 'HEAD'))) {
      const head = await this.revParse(m, `refs/heads/${cfg.branch}^{commit}`);
      if (head) {
        m.head = head;
        m.phase = 'ready';
      }
    }
    if (state) {
      m.fetched_at = state.fetched_at;
      m.last_attempt_at = state.last_attempt_at;
      m.last_error = state.last_error;
      m.failures = state.failures;
      if (!m.head) m.phase = state.last_error ? 'failed' : 'absent';
    }
    return m;
  }

  private async discard(m: Mirror): Promise<void> {
    await Promise.allSettled([m.inflight, m.rendering]);
    await rm(m.dir, { recursive: true, force: true });
    this.deps.log.info({ repo: m.cfg.name }, 'repository mirror removed');
  }

  /** Delete mirror directories no longer configured; only directories this service wrote (`state.json` + `repo.git`). */
  private async removeStray(configured: Set<string>): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.deps.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (configured.has(name)) continue;
      const dir = join(this.deps.dir, name);
      if (!existsSync(join(dir, 'state.json')) || !existsSync(join(dir, 'repo.git'))) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      this.deps.log.info({ repo: name }, 'repository mirror removed (no longer configured)');
    }
  }

  private async saveState(m: Mirror): Promise<void> {
    await mkdir(m.dir, { recursive: true });
    const body: StateFile = { version: STATE_VERSION, key: m.key, fetched_at: m.fetched_at, last_attempt_at: m.last_attempt_at, last_error: m.last_error, failures: m.failures };
    await writeAtomic(join(m.dir, 'state.json'), JSON.stringify(body, null, 2));
  }

  private statusOf(m: Mirror): RepoMirrorStatus {
    return {
      name: m.cfg.name,
      description: m.cfg.description,
      url: m.cfg.url,
      branch: m.cfg.branch,
      phase: m.inflight && !m.head ? 'cloning' : m.phase,
      commit: m.head,
      fetched_at: m.fetched_at ? new Date(m.fetched_at).toISOString() : null,
      last_attempt_at: m.last_attempt_at ? new Date(m.last_attempt_at).toISOString() : null,
      fetching: !!m.inflight,
      stale: !!m.last_error && !!m.head,
      last_error: m.last_error,
    };
  }

  // -- git reads ---------------------------------------------------------------------------------------------

  private async revParse(m: Mirror, rev: string): Promise<string | null> {
    const r = await this.git({ args: ['rev-parse', '--verify', '--quiet', rev], gitDir: m.gitDir, env: mirrorGitEnv(), timeoutMs: 10_000 });
    const out = r.stdout.toString('utf8').trim();
    return r.code === 0 && /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  }

  private async commitSha(m: Mirror, commit: string | undefined): Promise<string> {
    if (!commit) return m.head!;
    const c = P.commitRef(commit);
    const sha = await this.revParse(m, `${c}^{commit}`);
    if (!sha) throw new BreadboardError('not-found', `commit ${c} is not in repository '${m.cfg.name}' (the mirror holds ${m.cfg.branch} and its history)`);
    return sha;
  }

  private async committedAt(m: Mirror, sha: string): Promise<string | null> {
    const hit = m.committedAt.get(sha);
    if (hit) return hit;
    const r = await this.git({ args: ['show', '-s', '--format=%cI', sha], gitDir: m.gitDir, env: mirrorGitEnv(), timeoutMs: 10_000 });
    const at = r.code === 0 ? r.stdout.toString('utf8').trim() : '';
    if (!at) return null;
    if (m.committedAt.size > 256) m.committedAt.clear();
    m.committedAt.set(sha, at);
    return at;
  }

  private async tree(m: Mirror, sha: string): Promise<TreeIndex> {
    const hit = m.trees.get(sha);
    if (hit) {
      m.trees.delete(sha);
      m.trees.set(sha, hit);
      return hit;
    }
    const r = await this.git({ args: ['ls-tree', '-r', '-l', '-z', '--full-tree', sha], gitDir: m.gitDir, env: mirrorGitEnv(), timeoutMs: READ_TIMEOUT_MS, maxStdoutBytes: 256 * 1024 * 1024 });
    if (r.code !== 0) throw new BreadboardError('internal', `could not list ${m.cfg.name} at ${sha.slice(0, 12)}: ${cleanGitError(r.stderr)}`);
    const t = new TreeIndex(parseLsTree(r.stdout));
    m.trees.set(sha, t);
    while (m.trees.size > TREE_CACHE) m.trees.delete(m.trees.keys().next().value!);
    return t;
  }

  private async texts(m: Mirror, shas: string[]): Promise<Map<string, string>> {
    const blobs = await readBlobs(this.git, m.gitDir, mirrorGitEnv(), shas, READ_TIMEOUT_MS);
    return new Map([...blobs].map(([k, v]) => [k, v.toString('utf8')]));
  }

  // -- notebooks ---------------------------------------------------------------------------------------------

  /** Notebooks matching the user's pathspecs at `sha`, rendered into the cache; `files` are cache paths to grep. */
  private async notebookSet(m: Mirror, sha: string, tree: TreeIndex, include: string[], exclude: string[]) {
    const all = tree.entries.filter((e) => e.type === 'blob' && isNotebookPath(e.path));
    let selected = all;
    if (all.length && (include.length || exclude.length)) {
      const empty = await this.emptyTree(m);
      const r = await this.git({ args: ['diff-tree', '-r', '--name-only', '-z', '--no-renames', empty, sha, '--', ...P.pathspecs({ include, exclude })], gitDir: m.gitDir, env: mirrorGitEnv(), timeoutMs: SEARCH_TIMEOUT_MS, maxStdoutBytes: 64 * 1024 * 1024 });
      if (r.code !== 0) throw new BreadboardError('validation-failed', `invalid paths or exclude: ${cleanGitError(r.stderr, 200)}`);
      const names = new Set(r.stdout.toString('utf8').split('\0').filter(Boolean));
      selected = all.filter((e) => names.has(e.path));
    }
    let overSize = 0;
    const renderable = selected.filter((e) => {
      const ok = (e.size ?? 0) <= m.cfg.max_notebook_bytes;
      if (!ok) overSize++;
      return ok;
    });
    await this.renderMissing(m, renderable);
    const pathsByBlob = new Map<string, string[]>();
    for (const e of renderable) {
      const meta = this.notebookMeta(m, e.sha);
      if (!meta) continue;
      if (meta.bytes > m.cfg.max_file_bytes) {
        overSize++;
        continue;
      }
      const list = pathsByBlob.get(e.sha) ?? [];
      list.push(e.path);
      pathsByBlob.set(e.sha, list);
    }
    const files = [...pathsByBlob.keys()].map(cacheFile);
    return { files, overSize, pathsOf: (cachePath: string) => pathsByBlob.get(blobOfCacheFile(cachePath) ?? '') ?? [] };
  }

  private async emptyTree(m: Mirror): Promise<string> {
    if (m.emptyTree) return m.emptyTree;
    const r = await this.git({ args: ['hash-object', '-t', 'tree', '--stdin'], gitDir: m.gitDir, env: mirrorGitEnv(), input: '', timeoutMs: 10_000 });
    const sha = r.stdout.toString('utf8').trim();
    if (r.code !== 0 || !sha) throw new BreadboardError('internal', `git hash-object failed: ${cleanGitError(r.stderr)}`);
    return (m.emptyTree = sha);
  }

  private notebookMeta(m: Mirror, blob: string): NotebookMeta | null {
    return m.notebooks.get(blob) ?? null;
  }

  private async notebookText(m: Mirror, blob: string): Promise<string> {
    try {
      return await readFile(join(m.nbDir, cacheFile(blob)), 'utf8');
    } catch {
      return '';
    }
  }

  /** Render notebooks not yet in the cache (keyed by blob SHA, so entries never go stale) and load their metadata. */
  private async renderMissing(m: Mirror, entries: TreeEntry[]): Promise<void> {
    const todo: TreeEntry[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.sha) || m.notebooks.has(e.sha)) continue;
      seen.add(e.sha);
      const side = join(m.nbDir, `${cacheFile(e.sha).slice(0, -4)}.json`);
      try {
        m.notebooks.set(e.sha, JSON.parse(await readFile(side, 'utf8')) as NotebookMeta);
      } catch {
        todo.push(e);
      }
    }
    let batch: TreeEntry[] = [];
    let bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const blobs = await readBlobs(this.git, m.gitDir, mirrorGitEnv(), batch.map((e) => e.sha), READ_TIMEOUT_MS, NOTEBOOK_RENDER_BATCH_BYTES * 2);
      for (const [sha, buf] of blobs) {
        const raw = buf.toString('utf8');
        const nb = renderNotebook(raw);
        const text = nb ? nb.text : raw;
        const meta: NotebookMeta = { cells: nb?.cells ?? [], language: nb?.language ?? null, raw: !nb, bytes: Buffer.byteLength(text) };
        const file = join(m.nbDir, cacheFile(sha));
        await mkdir(dirname(file), { recursive: true });
        await writeAtomic(file, text);
        await writeAtomic(`${file.slice(0, -4)}.json`, JSON.stringify(meta));
        m.notebooks.set(sha, meta);
      }
      batch = [];
      bytes = 0;
    };
    for (const e of todo) {
      if (batch.length && bytes + (e.size ?? 0) > NOTEBOOK_RENDER_BATCH_BYTES) await flush();
      batch.push(e);
      bytes += e.size ?? 0;
    }
    await flush();
  }

  /** After a fetch moves the head, render its notebooks in the background so the next search does not wait. */
  private prerender(m: Mirror): void {
    if (m.rendering || !m.head) return;
    const head = m.head;
    m.rendering = (async () => {
      const tree = await this.tree(m, head);
      await this.renderMissing(
        m,
        tree.entries.filter((e) => e.type === 'blob' && isNotebookPath(e.path) && (e.size ?? 0) <= m.cfg.max_notebook_bytes),
      );
    })()
      .catch((e) => this.deps.log.warn({ err: e, repo: m.cfg.name }, 'notebook pre-render failed'))
      .finally(() => {
        m.rendering = null;
      });
  }
}

interface StateFile {
  version: number;
  key: string;
  fetched_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
  failures: number;
}

async function readState(dir: string): Promise<StateFile | null> {
  try {
    const s = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as StateFile;
    return s.version === STATE_VERSION ? s : null;
  } catch {
    return null;
  }
}

/** Write via a uniquely named temp file and rename, so concurrent writers of the same content cannot collide. */
async function writeAtomic(file: string, body: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, file);
}

function mirrorKey(cfg: RepoMirrorConfig): string {
  return `${cfg.url}\n${cfg.branch}`;
}

function isNotebookPath(p: string): boolean {
  return p.toLowerCase().endsWith('.ipynb');
}

/** Notebook cache path (relative to the cache dir) for a blob SHA. */
function cacheFile(blob: string): string {
  return `${blob.slice(0, 2)}/${blob}.txt`;
}

function blobOfCacheFile(p: string): string | null {
  return /([0-9a-f]{40,64})\.txt$/.exec(p)?.[1] ?? null;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function throwIfGrepError(results: Array<{ error: string | null }>): void {
  const err = results.find((r) => r.error)?.error;
  if (err) throw new BreadboardError('validation-failed', `search failed: ${err}`);
}

