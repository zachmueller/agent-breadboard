/**
 * GitConfigRepo — the system-git implementation of the `ConfigRepo` seam ([01] §6.3, §10.4).
 *
 * The repository is a *bare* repo; nothing in the server ever works from a persistent checkout.
 *  - Reads are commit-addressed (`git cat-file`, `git ls-tree`).
 *  - Writes build a tree with a throw-away index (`GIT_INDEX_FILE`) and advance a ref with `update-ref`.
 *  - Filesystem views come from `materializeTree(commit)`: a `git archive | tar -x` export cached under
 *    `cacheDir/<commit>`, pruned by `gcTrees` (LRU/age).
 *  - Merges use `git merge-tree --write-tree` (git ≥ 2.38) and fall back to a temporary detached worktree.
 * All mutating operations are serialized by an in-process async mutex so concurrent callers never race on
 * the same ref. Every git invocation is `execFile` with an argv array — never a shell string.
 */
import { execFile, spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { BreadboardError } from '@breadboard/shared';
import type { Logger } from '../core/logger.js';
import type { ConfigRepo, CommitInfo, FileChange, GitAuthor } from '../core/services.js';

export const DEFAULT_BRANCH = 'main';
const ZERO_OID = '0'.repeat(40);
export const SYSTEM_AUTHOR: GitAuthor = { name: 'Breadboard', email: 'breadboard@localhost' };

type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface GitConfigRepoOptions {
  /** Bare repository directory. */
  dir: string;
  /** Materialized-tree cache directory. */
  cacheDir: string;
  log: Logger;
  /** Force the temp-worktree merge/revert strategy even when `merge-tree --write-tree` is available (tests). */
  forceWorktreeMerge?: boolean;
}

class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | string | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

/** Minimal FIFO async mutex. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

const MISSING_RE = /does not exist|Not a valid object name|not a valid object|exists on disk, but not in|unknown revision|bad revision|no such path|needed a single revision|not a tree object|Invalid object name|fatal: path/i;

export class GitConfigRepo implements ConfigRepo {
  readonly dir: string;
  readonly cacheDir: string;
  private readonly logger: Logger;
  private readonly mutex = new Mutex();
  private readonly treeAccess = new Map<string, number>();
  private readonly inflightTrees = new Map<string, Promise<string>>();
  private mergeTreeSupport: boolean | null = null;
  private readonly forceWorktreeMerge: boolean;

  constructor(opts: GitConfigRepoOptions) {
    this.dir = resolve(opts.dir);
    this.cacheDir = resolve(opts.cacheDir);
    this.logger = opts.log;
    this.forceWorktreeMerge = !!opts.forceWorktreeMerge;
  }

  // ---------------------------------------------------------------------------------------------
  // Process plumbing
  // ---------------------------------------------------------------------------------------------

  private env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_COMMITTER_NAME: SYSTEM_AUTHOR.name,
      GIT_COMMITTER_EMAIL: SYSTEM_AUTHOR.email,
      GIT_AUTHOR_NAME: SYSTEM_AUTHOR.name,
      GIT_AUTHOR_EMAIL: SYSTEM_AUTHOR.email,
      LC_ALL: 'C',
      ...extra,
    };
  }

  private git(args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: string | Buffer; allowExit?: number[] } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
    return this.gitRaw(args, opts).then((r) => ({ stdout: r.stdout.toString('utf8'), stderr: r.stderr, code: r.code }));
  }

  private gitRaw(args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: string | Buffer; allowExit?: number[] } = {}): Promise<{ stdout: Buffer; stderr: string; code: number }> {
    return new Promise((res, rej) => {
      const child = execFile('git', args, { cwd: opts.cwd ?? this.dir, env: this.env(opts.env), encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? ((err as any).code ?? 1) : 0;
        const stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
        if (err && !(typeof code === 'number' && opts.allowExit?.includes(code))) {
          rej(new GitError(args, code, stderrText || (err as Error).message));
          return;
        }
        res({ stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? '')), stderr: stderrText, code: typeof code === 'number' ? code : 1 });
      });
      if (opts.input !== undefined) child.stdin!.end(opts.input);
      else child.stdin!.end();
    });
  }

  private async hasMergeTree(): Promise<boolean> {
    if (this.forceWorktreeMerge) return false;
    if (this.mergeTreeSupport !== null) return this.mergeTreeSupport;
    try {
      const { stdout } = await this.git(['--version'], { cwd: process.cwd() });
      const m = /git version (\d+)\.(\d+)/.exec(stdout);
      const major = m ? Number(m[1]) : 0;
      const minor = m ? Number(m[2]) : 0;
      this.mergeTreeSupport = major > 2 || (major === 2 && minor >= 38);
    } catch {
      this.mergeTreeSupport = false;
    }
    return this.mergeTreeSupport;
  }

  private async hasRef(ref: string): Promise<boolean> {
    const r = await this.git(['show-ref', '--verify', '--quiet', ref], { allowExit: [1] });
    return r.code === 0;
  }

  private async tmpPath(prefix: string): Promise<string> {
    return fs.mkdtemp(join(tmpdir(), `bb-${prefix}-`));
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  async init(seedDir?: string | null, author: GitAuthor = SYSTEM_AUTHOR): Promise<{ created: boolean; head: string }> {
    return this.mutex.run(async () => {
      let created = false;
      if (!existsSync(join(this.dir, 'HEAD'))) {
        await fs.mkdir(this.dir, { recursive: true });
        await this.git(['init', '--bare', '--quiet', `--initial-branch=${DEFAULT_BRANCH}`, this.dir], { cwd: dirname(this.dir) });
        created = true;
        this.logger.info({ dir: this.dir }, 'config repo created');
      }
      await fs.mkdir(this.cacheDir, { recursive: true });
      if (!(await this.hasRef(`refs/heads/${DEFAULT_BRANCH}`))) {
        const changes = seedDir ? await readDirAsChanges(seedDir) : [];
        const message = seedDir ? `Seed configuration from ${seedDir}` : 'Initialize empty configuration';
        const head = await this.commitUnlocked({ branch: DEFAULT_BRANCH, changes, message, author });
        this.logger.info({ head, files: changes.length }, 'config repo seeded');
        return { created, head };
      }
      return { created, head: await this.resolve(DEFAULT_BRANCH) };
    });
  }

  async resolve(ref = DEFAULT_BRANCH): Promise<string> {
    try {
      const { stdout } = await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      const hash = stdout.trim();
      if (!hash) throw new BreadboardError('not-found', `unknown ref ${ref}`);
      return hash;
    } catch (e) {
      if (e instanceof BreadboardError) throw e;
      throw new BreadboardError('not-found', `unknown ref ${ref}`);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------

  async readFileBuffer(commit: string, path: string): Promise<Buffer | null> {
    const p = normalizePath(path);
    try {
      const { stdout } = await this.gitRaw(['cat-file', 'blob', `${commit}:${p}`]);
      return stdout;
    } catch (e) {
      if (e instanceof GitError && MISSING_RE.test(e.stderr)) return null;
      throw e;
    }
  }

  async readFile(commit: string, path: string): Promise<string | null> {
    const b = await this.readFileBuffer(commit, path);
    return b === null ? null : b.toString('utf8');
  }

  async listFiles(commit: string, prefix?: string): Promise<string[]> {
    const args = ['ls-tree', '-r', '--name-only', '-z', commit];
    const pre = prefix ? normalizePath(prefix) : '';
    if (pre) args.push('--', pre);
    const { stdout } = await this.git(args);
    const files = stdout.split('\0').filter(Boolean);
    if (!pre) return files;
    // `ls-tree -- <prefix>` matches `prefix` as a path; keep directory semantics (prefix/ or exact file).
    const dir = pre.endsWith('/') ? pre : pre + '/';
    return files.filter((f) => f === pre || f.startsWith(dir));
  }

  async materializeTree(commit: string): Promise<string> {
    if (!/^[0-9a-f]{40,64}$/.test(commit)) commit = await this.resolve(commit);
    const target = join(this.cacheDir, commit);
    this.treeAccess.set(commit, Date.now());
    if (existsSync(target)) {
      fs.utimes(target, new Date(), new Date()).catch(() => undefined);
      return target;
    }
    const inflight = this.inflightTrees.get(commit);
    if (inflight) return inflight;
    const task = (async () => {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const tmp = await fs.mkdtemp(join(this.cacheDir, `.tmp-${commit.slice(0, 12)}-`));
      try {
        await this.archiveInto(commit, tmp);
        try {
          await fs.rename(tmp, target);
        } catch (e: any) {
          if (e?.code === 'ENOTEMPTY' || e?.code === 'EEXIST') await fs.rm(tmp, { recursive: true, force: true });
          else throw e;
        }
        return target;
      } catch (e) {
        await fs.rm(tmp, { recursive: true, force: true });
        throw e;
      } finally {
        this.inflightTrees.delete(commit);
      }
    })();
    this.inflightTrees.set(commit, task);
    return task;
  }

  /** `git archive <commit> | tar -x -C <dest>` with real process piping (no shell). */
  private archiveInto(commit: string, dest: string): Promise<void> {
    return new Promise((res, rej) => {
      const git = spawn('git', ['archive', '--format=tar', commit], { cwd: this.dir, env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] });
      const tar = spawn('tar', ['-x', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
      let gitErr = '';
      let tarErr = '';
      let gitCode: number | null = null;
      let tarCode: number | null = null;
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        rej(new Error(msg));
      };
      const maybeDone = () => {
        if (settled || gitCode === null || tarCode === null) return;
        if (gitCode !== 0) return fail(`git archive ${commit} failed (${gitCode}): ${gitErr.trim()}`);
        if (tarCode !== 0) return fail(`tar extract failed (${tarCode}): ${tarErr.trim()}`);
        settled = true;
        res();
      };
      git.stderr.on('data', (d) => (gitErr += d));
      tar.stderr.on('data', (d) => (tarErr += d));
      git.on('error', (e) => fail(`git archive: ${e.message}`));
      tar.on('error', (e) => fail(`tar: ${e.message}`));
      git.on('close', (c) => {
        gitCode = c ?? 1;
        maybeDone();
      });
      tar.on('close', (c) => {
        tarCode = c ?? 1;
        maybeDone();
      });
      git.stdout.pipe(tar.stdin);
    });
  }

  async gcTrees(opts: { maxEntries?: number; maxAgeMs?: number } = {}): Promise<number> {
    const maxEntries = opts.maxEntries ?? 16;
    const maxAgeMs = opts.maxAgeMs ?? 24 * 60 * 60 * 1000;
    if (!existsSync(this.cacheDir)) return 0;
    const entries = await fs.readdir(this.cacheDir, { withFileTypes: true });
    const now = Date.now();
    const trees: Array<{ name: string; last: number }> = [];
    let removed = 0;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(this.cacheDir, e.name);
      if (e.name.startsWith('.tmp-')) {
        await fs.rm(full, { recursive: true, force: true });
        removed++;
        continue;
      }
      let last = this.treeAccess.get(e.name) ?? 0;
      if (!last) {
        try {
          last = (await fs.stat(full)).mtimeMs;
        } catch {
          continue;
        }
      }
      trees.push({ name: e.name, last });
    }
    trees.sort((a, b) => b.last - a.last);
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i]!;
      if (i >= maxEntries || now - t.last > maxAgeMs) {
        if (this.inflightTrees.has(t.name)) continue;
        await fs.rm(join(this.cacheDir, t.name), { recursive: true, force: true });
        this.treeAccess.delete(t.name);
        removed++;
      }
    }
    return removed;
  }

  // ---------------------------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------------------------

  async commit(opts: { branch: string; base?: string; changes: FileChange[]; message: string; author: GitAuthor }): Promise<string> {
    return this.mutex.run(() => this.commitUnlocked(opts));
  }

  private async commitUnlocked(opts: { branch: string; base?: string; changes: FileChange[]; message: string; author: GitAuthor }): Promise<string> {
    const branchRef = `refs/heads/${opts.branch}`;
    let parent: string | null = null;
    const existed = await this.hasRef(branchRef);
    if (existed) parent = await this.resolve(opts.branch);
    else if (opts.base) parent = await this.resolve(opts.base);
    else if (await this.hasRef(`refs/heads/${DEFAULT_BRANCH}`)) parent = await this.resolve(DEFAULT_BRANCH);

    const tree = await this.buildTree(parent, opts.changes);
    const commit = await this.commitTree(tree, parent ? [parent] : [], opts.message, opts.author);
    // Compare-and-swap on the old value when the branch existed; a new branch must not exist yet (zero OID).
    await this.git(['update-ref', branchRef, commit, existed ? parent! : ZERO_OID]);
    return commit;
  }

  /** Apply `changes` over `parent`'s tree using a throw-away index; returns the new tree OID. */
  private async buildTree(parent: string | null, changes: FileChange[]): Promise<string> {
    const tmp = await this.tmpPath('index');
    const indexFile = join(tmp, 'index');
    // An (empty) work tree is required by `update-index --force-remove`; the bare repo has none.
    const env = { GIT_INDEX_FILE: indexFile, GIT_WORK_TREE: tmp };
    try {
      if (parent) await this.git(['read-tree', parent], { env });
      else await this.git(['read-tree', '--empty'], { env });
      for (const ch of changes) {
        const p = normalizePath(ch.path);
        if (!p || p.split('/').some((s) => s === '..' || s === '.git')) throw new BreadboardError('validation-failed', `invalid repo path: ${ch.path}`);
        if (ch.content === null) {
          await this.git(['update-index', '--force-remove', '--', p], { env });
        } else {
          const { stdout } = await this.git(['hash-object', '-w', '--stdin'], { input: ch.content });
          const blob = stdout.trim();
          // Files can't live under a path that is currently a file (or vice versa); drop any shadowing entry.
          await this.removeShadowing(p, env);
          await this.git(['update-index', '--add', '--cacheinfo', `100644,${blob},${p}`], { env });
        }
      }
      const { stdout } = await this.git(['write-tree'], { env });
      return stdout.trim();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  private async removeShadowing(path: string, env: Record<string, string>): Promise<void> {
    const segs = path.split('/');
    const prefixes: string[] = [];
    for (let i = 1; i < segs.length; i++) prefixes.push(segs.slice(0, i).join('/'));
    if (prefixes.length === 0) return;
    const { stdout } = await this.git(['ls-files', '-z', '--', ...prefixes], { env });
    const hits = stdout.split('\0').filter((f) => prefixes.includes(f));
    for (const h of hits) await this.git(['update-index', '--force-remove', '--', h], { env });
  }

  private async commitTree(tree: string, parents: string[], message: string, author: GitAuthor): Promise<string> {
    const args = ['commit-tree', tree];
    for (const p of parents) args.push('-p', p);
    args.push('-F', '-');
    const env = {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: SYSTEM_AUTHOR.name,
      GIT_COMMITTER_EMAIL: SYSTEM_AUTHOR.email,
    };
    const { stdout } = await this.git(args, { env, input: message.endsWith('\n') ? message : message + '\n' });
    return stdout.trim();
  }

  async branchExists(name: string): Promise<boolean> {
    return this.hasRef(`refs/heads/${name}`);
  }

  async deleteBranch(name: string): Promise<void> {
    if (name === DEFAULT_BRANCH) throw new BreadboardError('invalid-state', `refusing to delete ${DEFAULT_BRANCH}`);
    await this.mutex.run(async () => {
      if (!(await this.hasRef(`refs/heads/${name}`))) return;
      await this.git(['update-ref', '-d', `refs/heads/${name}`]);
    });
  }

  async listBranches(): Promise<string[]> {
    const { stdout } = await this.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  async diff(base: string, head: string): Promise<{ patch: string; files: Array<{ path: string; status: FileStatus }> }> {
    const [status, patch] = await Promise.all([this.git(['diff', '--no-renames', '--name-status', '-z', base, head]), this.git(['diff', '--no-renames', base, head])]);
    return { patch: patch.stdout, files: parseNameStatusZ(status.stdout) };
  }

  async merge(opts: { branch: string; into?: string; message: string; author: GitAuthor }): Promise<{ commit: string | null; conflicts: string[] }> {
    const into = opts.into ?? DEFAULT_BRANCH;
    return this.mutex.run(async () => {
      const head = await this.resolve(opts.branch);
      const intoRef = `refs/heads/${into}`;
      if (!(await this.hasRef(intoRef))) {
        await this.git(['update-ref', intoRef, head]);
        return { commit: head, conflicts: [] };
      }
      const target = await this.resolve(into);
      if (head === target || (await this.isAncestor(head, target))) return { commit: target, conflicts: [] };
      if (await this.isAncestor(target, head)) {
        await this.git(['update-ref', intoRef, head, target]);
        return { commit: head, conflicts: [] };
      }
      const result = await this.mergeTrees(target, head);
      if (result.conflicts.length) return { commit: null, conflicts: result.conflicts };
      const commit = await this.commitTree(result.tree!, [target, head], opts.message, opts.author);
      await this.git(['update-ref', intoRef, commit, target]);
      return { commit, conflicts: [] };
    });
  }

  private async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const r = await this.git(['merge-base', '--is-ancestor', ancestor, descendant], { allowExit: [1] });
    return r.code === 0;
  }

  /** Three-way merge of two commits (optionally with an explicit merge base); returns the result tree or conflict paths. */
  private async mergeTrees(ours: string, theirs: string, mergeBase?: string): Promise<{ tree: string | null; conflicts: string[] }> {
    if (await this.hasMergeTree()) {
      const args = ['merge-tree', '--write-tree', '--name-only'];
      if (mergeBase) args.push(`--merge-base=${mergeBase}`);
      args.push(ours, theirs);
      const r = await this.git(args, { allowExit: [1] });
      const lines = r.stdout.split('\n');
      const tree = lines[0]?.trim() ?? '';
      if (r.code === 0) return { tree, conflicts: [] };
      const conflicts: string[] = [];
      for (const l of lines.slice(1)) {
        if (l === '') break;
        conflicts.push(l);
      }
      return { tree: null, conflicts: [...new Set(conflicts)] };
    }
    if (mergeBase) throw new Error('merge-base override requires git >= 2.38 (merge-tree --write-tree)');
    return this.withWorktree(ours, async (wt) => {
      const r = await this.git(['merge', '--no-commit', '--no-ff', '--no-edit', theirs], { cwd: wt, allowExit: [1] });
      if (r.code !== 0) {
        const conflicts = await this.unmergedIn(wt);
        await this.git(['merge', '--abort'], { cwd: wt, allowExit: [1, 128] });
        return { tree: null, conflicts };
      }
      const { stdout } = await this.git(['write-tree'], { cwd: wt });
      return { tree: stdout.trim(), conflicts: [] };
    });
  }

  private async unmergedIn(wt: string): Promise<string[]> {
    const { stdout } = await this.git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: wt });
    return stdout.split('\0').filter(Boolean);
  }

  private async withWorktree<T>(commit: string, fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await this.tmpPath('wt');
    const wt = join(dir, 'tree');
    await this.git(['worktree', 'add', '--detach', '--quiet', wt, commit]);
    try {
      return await fn(wt);
    } finally {
      await this.git(['worktree', 'remove', '--force', wt], { allowExit: [1, 128] }).catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
      await this.git(['worktree', 'prune'], { allowExit: [1, 128] }).catch(() => undefined);
    }
  }

  async revert(opts: { toCommit: string; path?: string; message: string; author: GitAuthor }): Promise<string> {
    return this.mutex.run(async () => {
      const main = await this.resolve(DEFAULT_BRANCH);
      const to = await this.resolve(opts.toCommit);
      if (opts.path) {
        const p = normalizePath(opts.path);
        const changes: FileChange[] = [];
        const atTo = await this.listFiles(to, p);
        const atMain = await this.listFiles(main, p);
        if (atTo.length === 0 && atMain.length === 0) throw new BreadboardError('not-found', `${p} exists at neither ${to.slice(0, 12)} nor main`);
        for (const f of atTo) changes.push({ path: f, content: (await this.readFile(to, f))! });
        for (const f of atMain) if (!atTo.includes(f)) changes.push({ path: f, content: null });
        const tree = await this.buildTree(main, changes);
        const commit = await this.commitTree(tree, [main], opts.message, opts.author);
        await this.git(['update-ref', `refs/heads/${DEFAULT_BRANCH}`, commit, main]);
        return commit;
      }
      // Whole-commit revert: merge main with the commit's parent using the commit itself as the merge base.
      const { stdout } = await this.git(['rev-list', '--parents', '-n', '1', to]);
      const parents = stdout.trim().split(/\s+/).slice(1);
      if (parents.length === 0) throw new BreadboardError('invalid-state', 'cannot revert a root commit');
      if (parents.length > 1) throw new BreadboardError('invalid-state', 'cannot revert a merge commit; revert a path instead');
      const result = (await this.hasMergeTree()) ? await this.mergeTrees(main, parents[0]!, to) : await this.revertViaWorktree(main, to);
      if (result.conflicts.length) throw new BreadboardError('conflict', `reverting ${to.slice(0, 12)} conflicts with main`, { conflicts: result.conflicts });
      const commit = await this.commitTree(result.tree!, [main], opts.message, opts.author);
      await this.git(['update-ref', `refs/heads/${DEFAULT_BRANCH}`, commit, main]);
      return commit;
    });
  }

  private revertViaWorktree(main: string, to: string): Promise<{ tree: string | null; conflicts: string[] }> {
    return this.withWorktree(main, async (wt) => {
      const r = await this.git(['revert', '--no-commit', '--no-edit', to], { cwd: wt, allowExit: [1] });
      if (r.code !== 0) {
        const conflicts = await this.unmergedIn(wt);
        await this.git(['revert', '--abort'], { cwd: wt, allowExit: [1, 128] });
        return { tree: null, conflicts };
      }
      const { stdout } = await this.git(['write-tree'], { cwd: wt });
      return { tree: stdout.trim(), conflicts: [] };
    });
  }

  async log(opts: { path?: string; ref?: string; limit?: number } = {}): Promise<CommitInfo[]> {
    const ref = opts.ref ?? DEFAULT_BRANCH;
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
    const args = ['log', `--max-count=${limit}`, '--format=%x1e%H%x1f%an <%ae>%x1f%aI%x1f%B%x1f', '--no-renames'];
    if (!opts.path) args.push('--name-status');
    args.push(ref);
    if (opts.path) args.push('--', normalizePath(opts.path));
    let stdout: string;
    try {
      stdout = (await this.git(args)).stdout;
    } catch (e) {
      if (e instanceof GitError && MISSING_RE.test(e.stderr)) throw new BreadboardError('not-found', `unknown ref ${ref}`);
      throw e;
    }
    const out: CommitInfo[] = [];
    for (const rec of stdout.split('\x1e')) {
      if (!rec.trim()) continue;
      const [commit, author, date, message, rest] = rec.split('\x1f');
      if (!commit) continue;
      const info: CommitInfo = { commit: commit.trim(), author: author ?? '', date: date ?? '', message: (message ?? '').replace(/\n+$/, '') };
      if (!opts.path) {
        const files = parseNameStatusLines(rest ?? '');
        info.files = files;
      }
      out.push(info);
    }
    return out;
  }
}

// -----------------------------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------------------------

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
}

function statusOf(code: string): FileStatus {
  switch (code[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    default:
      return 'modified';
  }
}

function parseNameStatusZ(stdout: string): Array<{ path: string; status: FileStatus }> {
  const parts = stdout.split('\0');
  const files: Array<{ path: string; status: FileStatus }> = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    if (!code) continue;
    const status = statusOf(code);
    if (status === 'renamed') {
      i++; // old path
      const to = parts[i++];
      if (to) files.push({ path: to, status });
    } else {
      const p = parts[i++];
      if (p) files.push({ path: p, status });
    }
  }
  return files;
}

function parseNameStatusLines(block: string): Array<{ path: string; status: FileStatus }> {
  const files: Array<{ path: string; status: FileStatus }> = [];
  for (const line of block.split('\n')) {
    const m = /^([AMDRTC]\d*)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    const status = statusOf(m[1]!);
    const paths = m[2]!.split('\t');
    files.push({ path: paths[paths.length - 1]!, status });
  }
  return files;
}

/** Read a directory recursively into FileChange entries (used for seeding). Skips `.git` and dotfiles at the root. */
export async function readDirAsChanges(root: string): Promise<FileChange[]> {
  const abs = resolve(root);
  if (!existsSync(abs)) throw new BreadboardError('not-found', `seed directory ${abs} does not exist`);
  const out: FileChange[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name === '.git' || e.name === '.DS_Store') continue;
      // Seed-tree tooling (not configuration): keep it out of the config repo.
      if (dir === abs && (e.name === 'README.md' || e.name === 'validate.mjs')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push({ path: relative(abs, full).split(sep).join('/'), content: await fs.readFile(full, 'utf8') });
    }
  }
  await walk(abs);
  return out;
}

export function createConfigRepo(opts: GitConfigRepoOptions): GitConfigRepo {
  return new GitConfigRepo(opts);
}
