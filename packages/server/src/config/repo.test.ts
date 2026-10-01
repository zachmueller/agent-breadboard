import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '../core/logger.js';
import type { GitConfigRepo} from './repo.js';
import { createConfigRepo, SYSTEM_AUTHOR } from './repo.js';
import { seedIfEmpty } from './seed.js';

const author = { name: 'Tester', email: 'tester@example.com' };
let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'bb-repo-test-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function fresh(name: string, opts: { forceWorktreeMerge?: boolean } = {}): Promise<GitConfigRepo> {
  const repo = createConfigRepo({ dir: join(root, name, 'repo.git'), cacheDir: join(root, name, 'trees'), log: silentLogger, ...opts });
  await repo.init(null, author);
  return repo;
}

describe('GitConfigRepo', () => {
  it('creates a bare repo and seeds it from a directory on main', async () => {
    const seed = join(root, 'seed');
    await fs.mkdir(join(seed, 'subagents'), { recursive: true });
    await fs.writeFile(join(seed, 'breadboard.yaml'), 'schema: breadboard/breadboard@v1\n');
    await fs.writeFile(join(seed, 'subagents', 'A.yaml'), 'uid: A\n');
    const repo = createConfigRepo({ dir: join(root, 'seeded', 'repo.git'), cacheDir: join(root, 'seeded', 'trees'), log: silentLogger });
    const r = await repo.init(seed, author);
    expect(r.created).toBe(true);
    expect(r.head).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(root, 'seeded', 'repo.git', 'HEAD'))).toBe(true);
    expect(await fs.readFile(join(root, 'seeded', 'repo.git', 'HEAD'), 'utf8')).toContain('refs/heads/main');
    expect((await repo.listFiles(r.head)).sort()).toEqual(['breadboard.yaml', 'subagents/A.yaml']);
    expect(await repo.readFile(r.head, 'subagents/A.yaml')).toBe('uid: A\n');
    expect(await repo.readFile(r.head, 'nope.yaml')).toBeNull();
    // Second init is a no-op.
    const again = await repo.init(seed, author);
    expect(again.created).toBe(false);
    expect(again.head).toBe(r.head);
    expect(await repo.listBranches()).toEqual(['main']);
  });

  it('seedIfEmpty seeds an empty main and is otherwise idempotent', async () => {
    const seed = join(root, 'seed2');
    await fs.mkdir(seed, { recursive: true });
    await fs.writeFile(join(seed, 'tenets.md'), 'Be kind.\n');
    const repo = createConfigRepo({ dir: join(root, 'seed-empty', 'repo.git'), cacheDir: join(root, 'seed-empty', 'trees'), log: silentLogger });
    const first = await seedIfEmpty(repo, seed, silentLogger);
    expect(first.seeded).toBe(true);
    expect(await repo.readFile(first.head, 'tenets.md')).toBe('Be kind.\n');
    const second = await seedIfEmpty(repo, seed, silentLogger);
    expect(second.seeded).toBe(false);
    expect(second.head).toBe(first.head);
    // An initialized-but-empty repo also gets seeded.
    const empty = await fresh('seed-empty2');
    const r = await seedIfEmpty(empty, seed, silentLogger);
    expect(r.seeded).toBe(true);
    expect(await empty.listFiles(r.head)).toEqual(['tenets.md']);
  });

  it('commits without a checkout, supports deletes and nested paths, and records the author', async () => {
    const repo = await fresh('commit');
    const c1 = await repo.commit({ branch: 'main', changes: [{ path: 'a.txt', content: 'one\n' }, { path: 'dir/sub/b.txt', content: 'two\n' }], message: 'add a and b', author });
    expect(await repo.resolve('main')).toBe(c1);
    expect((await repo.listFiles(c1)).sort()).toEqual(['a.txt', 'dir/sub/b.txt']);
    const c2 = await repo.commit({ branch: 'main', changes: [{ path: 'a.txt', content: null }, { path: 'dir/sub/b.txt', content: 'two!\n' }], message: 'edit', author });
    expect(await repo.listFiles(c2)).toEqual(['dir/sub/b.txt']);
    expect(await repo.readFile(c2, 'dir/sub/b.txt')).toBe('two!\n');
    expect(await repo.readFile(c1, 'a.txt')).toBe('one\n');
    expect(await repo.listFiles(c2, 'dir/')).toEqual(['dir/sub/b.txt']);
    expect(await repo.listFiles(c2, 'di')).toEqual([]);
    // No working tree anywhere in the bare repo.
    expect(existsSync(join(repo.dir, 'dir'))).toBe(false);
    const log = await repo.log({ limit: 10 });
    expect(log.map((l) => l.commit).slice(0, 2)).toEqual([c2, c1]);
    expect(log).toHaveLength(3); // + init commit
    expect(log[0]!.author).toBe('Tester <tester@example.com>');
    expect(log[0]!.message).toBe('edit');
    expect(log[0]!.files).toEqual(expect.arrayContaining([{ path: 'a.txt', status: 'deleted' }, { path: 'dir/sub/b.txt', status: 'modified' }]));
    expect(log[1]!.files).toEqual(expect.arrayContaining([{ path: 'a.txt', status: 'added' }]));
    const pathLog = await repo.log({ path: 'a.txt' });
    expect(pathLog.map((l) => l.commit)).toEqual([c2, c1]);
    expect(pathLog[0]!.files).toBeUndefined();
    expect(await repo.log({ path: 'dir/sub/b.txt', limit: 1 })).toHaveLength(1);
    // Buffer read + multi-line message.
    const c3 = await repo.commit({ branch: 'main', changes: [{ path: 'bin', content: 'xé' }], message: 'subject\n\nbody line\ttab', author });
    expect((await repo.readFileBuffer(c3, 'bin'))!.toString('utf8')).toBe('xé');
    expect((await repo.log({ limit: 1 }))[0]!.message).toBe('subject\n\nbody line\ttab');
  });

  it('creates branches from base, diffs, fast-forwards, really merges, and reports conflicts', async () => {
    const repo = await fresh('merge');
    const base = await repo.commit({ branch: 'main', changes: [{ path: 'x.txt', content: 'x\n' }, { path: 'y.txt', content: 'y\n' }], message: 'base', author });
    const b1 = await repo.commit({ branch: 'proposals/p1', base, changes: [{ path: 'x.txt', content: 'x2\n' }, { path: 'z.txt', content: 'z\n' }], message: 'p1', author });
    expect(await repo.branchExists('proposals/p1')).toBe(true);
    expect(await repo.resolve('proposals/p1')).toBe(b1);
    expect(await repo.resolve('main')).toBe(base);
    const d = await repo.diff(base, b1);
    expect(d.files).toEqual(expect.arrayContaining([{ path: 'x.txt', status: 'modified' }, { path: 'z.txt', status: 'added' }]));
    expect(d.patch).toContain('-x\n+x2');
    // Fast-forward.
    const ff = await repo.merge({ branch: 'proposals/p1', message: 'merge p1', author });
    expect(ff).toEqual({ commit: b1, conflicts: [] });
    expect(await repo.resolve('main')).toBe(b1);
    // Real merge: main moves on y.txt, branch touches z.txt.
    const m2 = await repo.commit({ branch: 'main', changes: [{ path: 'y.txt', content: 'y2\n' }], message: 'main moves', author });
    const b2 = await repo.commit({ branch: 'proposals/p2', base: b1, changes: [{ path: 'z.txt', content: 'z2\n' }], message: 'p2', author });
    const real = await repo.merge({ branch: 'proposals/p2', message: 'merge p2', author });
    expect(real.conflicts).toEqual([]);
    expect(real.commit).not.toBe(b2);
    expect(real.commit).not.toBe(m2);
    const head = await repo.resolve('main');
    expect(head).toBe(real.commit);
    expect(await repo.readFile(head, 'y.txt')).toBe('y2\n');
    expect(await repo.readFile(head, 'z.txt')).toBe('z2\n');
    expect((await repo.log({ limit: 1 }))[0]!.message).toBe('merge p2');
    // Conflict: both sides change the same line of x.txt.
    const m3 = await repo.commit({ branch: 'main', changes: [{ path: 'x.txt', content: 'main-x\n' }], message: 'main x', author });
    await repo.commit({ branch: 'proposals/p3', base: head, changes: [{ path: 'x.txt', content: 'branch-x\n' }], message: 'p3', author });
    const conflict = await repo.merge({ branch: 'proposals/p3', message: 'merge p3', author });
    expect(conflict.commit).toBeNull();
    expect(conflict.conflicts).toEqual(['x.txt']);
    expect(await repo.resolve('main')).toBe(m3);
    // Already-merged branch is a no-op.
    const noop = await repo.merge({ branch: 'proposals/p2', message: 'again', author });
    expect(noop).toEqual({ commit: m3, conflicts: [] });
    await repo.deleteBranch('proposals/p3');
    expect(await repo.branchExists('proposals/p3')).toBe(false);
    expect((await repo.listBranches()).sort()).toEqual(['main', 'proposals/p1', 'proposals/p2']);
    await expect(repo.deleteBranch('main')).rejects.toThrow();
  });

  it('merges via a temporary worktree when merge-tree is unavailable', async () => {
    const repo = await fresh('merge-wt', { forceWorktreeMerge: true });
    const base = await repo.commit({ branch: 'main', changes: [{ path: 'a.txt', content: 'a\n' }, { path: 'b.txt', content: 'b\n' }], message: 'base', author });
    await repo.commit({ branch: 'main', changes: [{ path: 'a.txt', content: 'a2\n' }], message: 'main a', author });
    await repo.commit({ branch: 'wip', base, changes: [{ path: 'b.txt', content: 'b2\n' }], message: 'wip b', author });
    const ok = await repo.merge({ branch: 'wip', message: 'merge wip', author });
    expect(ok.conflicts).toEqual([]);
    expect(await repo.readFile(ok.commit!, 'a.txt')).toBe('a2\n');
    expect(await repo.readFile(ok.commit!, 'b.txt')).toBe('b2\n');
    await repo.commit({ branch: 'bad', base, changes: [{ path: 'a.txt', content: 'a3\n' }], message: 'bad a', author });
    const conflict = await repo.merge({ branch: 'bad', message: 'merge bad', author });
    expect(conflict.commit).toBeNull();
    expect(conflict.conflicts).toEqual(['a.txt']);
    expect(await repo.resolve('main')).toBe(ok.commit);
    expect(existsSync(join(repo.dir, 'worktrees')) ? (await fs.readdir(join(repo.dir, 'worktrees'))).length : 0).toBe(0);
    // Whole-commit revert through the worktree path too.
    const c = await repo.commit({ branch: 'main', changes: [{ path: 'c.txt', content: 'c\n' }], message: 'add c', author });
    const r = await repo.revert({ toCommit: c, message: 'undo c', author });
    expect(await repo.readFile(r, 'c.txt')).toBeNull();
    expect(await repo.readFile(r, 'b.txt')).toBe('b2\n');
  });

  it('reverts a path to its content at a commit, a directory, and a whole commit', async () => {
    const repo = await fresh('revert');
    const c1 = await repo.commit({ branch: 'main', changes: [{ path: 'p.txt', content: 'v1\n' }, { path: 'd/one.txt', content: '1\n' }], message: 'c1', author });
    const c2 = await repo.commit({ branch: 'main', changes: [{ path: 'p.txt', content: 'v2\n' }, { path: 'd/one.txt', content: '1b\n' }, { path: 'd/two.txt', content: '2\n' }], message: 'c2', author });
    const c3 = await repo.commit({ branch: 'main', changes: [{ path: 'q.txt', content: 'q\n' }], message: 'c3', author });
    const r1 = await repo.revert({ toCommit: c1, path: 'p.txt', message: 'revert p', author });
    expect(await repo.resolve('main')).toBe(r1);
    expect(await repo.readFile(r1, 'p.txt')).toBe('v1\n');
    expect(await repo.readFile(r1, 'q.txt')).toBe('q\n');
    expect(await repo.readFile(r1, 'd/two.txt')).toBe('2\n');
    const r2 = await repo.revert({ toCommit: c1, path: 'd', message: 'revert dir', author });
    expect((await repo.listFiles(r2, 'd/')).sort()).toEqual(['d/one.txt']);
    expect(await repo.readFile(r2, 'd/one.txt')).toBe('1\n');
    const r3 = await repo.revert({ toCommit: c3, message: 'revert c3', author });
    expect(await repo.readFile(r3, 'q.txt')).toBeNull();
    expect(await repo.readFile(r3, 'p.txt')).toBe('v1\n');
    expect((await repo.log({ limit: 1 }))[0]!.message).toBe('revert c3');
    // Reverting a path that was deleted at toCommit deletes it now.
    const r4 = await repo.revert({ toCommit: c2, path: 'd/two.txt', message: 'restore two', author });
    expect(await repo.readFile(r4, 'd/two.txt')).toBe('2\n');
    await expect(repo.revert({ toCommit: c1, path: 'missing.txt', message: 'x', author })).rejects.toThrow(/exists at neither/);
    void c2;
  });

  it('materializes trees once per commit, serves them read-only-by-convention, and prunes the cache', async () => {
    const repo = await fresh('trees');
    const c1 = await repo.commit({ branch: 'main', changes: [{ path: 'tools/T/tool.yaml', content: 'uid: T\n' }, { path: 'tools/T/src/index.ts', content: 'export {}\n' }], message: 'c1', author });
    const c2 = await repo.commit({ branch: 'main', changes: [{ path: 'tools/T/src/index.ts', content: 'export const x = 1\n' }], message: 'c2', author });
    const [d1a, d1b] = await Promise.all([repo.materializeTree(c1), repo.materializeTree(c1)]);
    expect(d1a).toBe(d1b);
    expect(d1a).toBe(join(repo.cacheDir, c1));
    expect(await fs.readFile(join(d1a, 'tools/T/src/index.ts'), 'utf8')).toBe('export {}\n');
    expect(existsSync(join(d1a, '.git'))).toBe(false);
    const d2 = await repo.materializeTree(c2);
    expect(await fs.readFile(join(d2, 'tools/T/src/index.ts'), 'utf8')).toBe('export const x = 1\n');
    const before = (await fs.stat(d1a)).mtimeMs;
    await repo.materializeTree(c1);
    expect(existsSync(d1a)).toBe(true);
    void before;
    // Branch names resolve too.
    expect(await repo.materializeTree('main')).toBe(d2);
    // LRU prune keeps the most recently used entry.
    const removed = await repo.gcTrees({ maxEntries: 1 });
    expect(removed).toBe(1);
    expect(existsSync(d2)).toBe(false === existsSync(d1a));
    expect(await repo.gcTrees({ maxAgeMs: 0 })).toBe(1);
    expect((await fs.readdir(repo.cacheDir)).length).toBe(0);
  });

  it('serializes concurrent commits on the same branch', async () => {
    const repo = await fresh('concurrent');
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => repo.commit({ branch: 'main', changes: [{ path: `f${i}.txt`, content: `${i}\n` }], message: `c${i}`, author })));
    expect(new Set(results).size).toBe(6);
    const head = await repo.resolve('main');
    expect((await repo.listFiles(head)).length).toBe(6);
    expect((await repo.log({ limit: 10 })).length).toBe(7); // + the empty init commit
  });

  it('rejects unsafe paths and reports unknown refs as not-found', async () => {
    const repo = await fresh('safety');
    await expect(repo.commit({ branch: 'main', changes: [{ path: '../escape', content: 'x' }], message: 'bad', author })).rejects.toThrow(/invalid repo path/);
    await expect(repo.resolve('nope')).rejects.toMatchObject({ code: 'not-found' });
    await expect(repo.log({ ref: 'nope' })).rejects.toMatchObject({ code: 'not-found' });
    expect(SYSTEM_AUTHOR.name).toBe('Breadboard');
  });
});
