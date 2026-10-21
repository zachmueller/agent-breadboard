import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BreadboardError, SCHEMA_TAGS, zBreadboardConfig, type BreadboardConfig } from '@breadboard/shared';
import { createLogger } from '../core/logger.js';
import { servicePrincipal, type Grants, type Principal } from '../core/principal.js';
import { runGit, type GitRunner } from './git.js';
import { RepoMirrorsImpl } from './service.js';

const TEAM = 'team-1';
const MIN = 60_000;

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(root: string, rel: string, body: string | Buffer) {
  const f = join(root, rel);
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, body);
}

function notebook(cells: Array<{ type: string; source: string | string[]; output?: string }>): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { language: 'python', name: 'python3' } },
    cells: cells.map((c) => ({
      cell_type: c.type,
      source: c.source,
      metadata: {},
      ...(c.type === 'code' ? { outputs: c.output ? [{ output_type: 'stream', name: 'stdout', text: [c.output] }] : [], execution_count: 1 } : {}),
    })),
  });
}

/** A fixture origin with text, a notebook (plus one at the top level), a binary, an oversized file and odd paths. */
function makeOrigin(root: string): string {
  const o = join(root, 'origin');
  mkdirSync(o, { recursive: true });
  sh(o, 'init', '--quiet', '--initial-branch=main');
  write(o, 'README.md', '# Demo\nThe shared library is called widgetlib.\nSee docs.\n');
  write(o, 'src/app.py', 'import widgetlib\n\ndef load():\n    return "a.b"\n\ndef other():\n    return "aXb"\n');
  write(o, 'docs/guide.md', Array.from({ length: 30 }, (_, i) => `line ${i + 1} widgetlib`).join('\n') + '\n');
  write(o, 'big.txt', 'widgetlib\n' + 'x'.repeat(5000) + '\n');
  write(o, 'bin.dat', Buffer.concat([Buffer.from('widgetlib'), Buffer.from([0, 1, 2, 0]), Buffer.from('widgetlib')]));
  write(o, 'odd dir/a:b.md', 'colon widgetlib\n');
  write(
    o,
    'analysis/explore.ipynb',
    notebook([
      { type: 'markdown', source: ['# Exploring the cell data\n', 'Uses widgetlib.\n'] },
      { type: 'code', source: 'import widgetlib\ndf = widgetlib.load()\n', output: 'OUTPUT_ONLY_TOKEN widgetlib\n' },
    ]),
  );
  write(o, 'top.ipynb', notebook([{ type: 'code', source: 'print("top widgetlib")' }]));
  write(o, 'broken.ipynb', '{not json widgetlib');
  sh(o, 'add', '-A');
  sh(o, 'commit', '--quiet', '-m', 'init');
  return o;
}

function settingsFor(url: string, over: Record<string, unknown> = {}): BreadboardConfig {
  return zBreadboardConfig.parse({ schema: SCHEMA_TAGS.breadboard, repos: [{ name: 'demo', url, branch: 'main', max_file_bytes: 1000, ...over }] });
}

function subagent(repos: string[]): Principal {
  const grants: Grants = { subagent_uid: 'S', tools: new Map(), mcp: new Map(), circuits: { read: new Set(), execute: new Set() }, knowledge: { read: new Set(), write: new Set() }, primitives: new Set(), repos: new Set(repos), tools_override: null };
  return { ...servicePrincipal(TEAM, 'x'), actor: { kind: 'subagent', id: 'S' }, grants } as Principal;
}

describe('RepoMirrors', () => {
  let root: string;
  let origin: string;
  let t: number;
  let fetches: number;
  let settings: BreadboardConfig;
  let mirrors: RepoMirrorsImpl;
  const member = servicePrincipal(TEAM, 'test');
  const audit: Array<{ capability: string; url: string }> = [];
  const git: GitRunner = (o) => {
    if (o.args[0] === 'fetch') fetches++;
    return runGit(o);
  };
  const make = (over: Partial<ConstructorParameters<typeof RepoMirrorsImpl>[0]> = {}) =>
    new RepoMirrorsImpl({
      dir: join(root, 'mirrors'),
      settings: async () => settings,
      broker: {
        withRepoAuth: async (input, fn) => {
          audit.push({ capability: input.capability, url: input.url });
          return fn({ 'X-Test': 'yes' });
        },
      },
      log: createLogger('silent', false),
      team_id: TEAM,
      allowFileUrls: true,
      git,
      now: () => t,
      tickMs: 3_600_000,
      ...over,
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-mirrors-'));
    origin = makeOrigin(root);
    t = Date.parse('2026-10-01T00:00:00Z');
    fetches = 0;
    audit.length = 0;
    settings = settingsFor(`file://${origin}`);
    mirrors = make();
  });

  afterEach(async () => {
    await mirrors.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('clones on first use and cites the head commit', async () => {
    const r: any = await mirrors.search({ pattern: 'widgetlib', paths: ['README.md'] }, member);
    expect(r.commit).toBe(sh(origin, 'rev-parse', 'HEAD'));
    expect(r.repo).toBe('demo');
    expect(r.files.map((f: any) => f.path)).toEqual(['README.md']);
    expect(r.files[0].matches).toEqual([{ line: 2, column: 30 }]);
    expect(r.files[0].snippet).toBe('1-# Demo\n2:The shared library is called widgetlib.\n3-See docs.');
    expect(fetches).toBe(1);
    expect(existsSync(join(root, 'mirrors', 'demo', 'repo.git', 'HEAD'))).toBe(true);
  });

  it('matches literally by default, and supports regex, ignore_case and word', async () => {
    const lit: any = await mirrors.search({ pattern: 'a.b', paths: ['src'] }, member);
    expect(lit.files[0].matches.map((m: any) => m.line)).toEqual([4]);
    const re: any = await mirrors.search({ pattern: 'a.b', regex: true, paths: ['src'] }, member);
    expect(re.files[0].matches.map((m: any) => m.line)).toEqual([4, 7]);
    expect(re.regex_flavor).toBe('pcre');
    const pcre: any = await mirrors.search({ pattern: 'def \\w+\\(', regex: true, paths: ['src'] }, member);
    expect(pcre.files[0].matches.map((m: any) => m.line)).toEqual([3, 6]);
    const ci: any = await mirrors.search({ pattern: 'DEMO', ignore_case: true, paths: ['README.md'] }, member);
    expect(ci.files).toHaveLength(1);
    const word: any = await mirrors.search({ pattern: 'widget', word: true }, member);
    expect(word.files).toHaveLength(0);
  });

  it('searches notebooks by cell source only, with cell locations', async () => {
    const r: any = await mirrors.search({ pattern: 'widgetlib', paths: ['analysis'] }, member);
    expect(r.files).toHaveLength(1);
    const f = r.files[0];
    expect(f.path).toBe('analysis/explore.ipynb');
    expect(f.notebook).toBe(true);
    expect(f.matches).toEqual([
      { line: 3, column: 6, cell: 1, cell_type: 'markdown', cell_line: 2 },
      { line: 5, column: 8, cell: 2, cell_type: 'code', cell_line: 1 },
      { line: 6, column: 6, cell: 2, cell_type: 'code', cell_line: 2 },
    ]);
    expect((await mirrors.search({ pattern: 'OUTPUT_ONLY_TOKEN' }, member) as any).files).toHaveLength(0);
    // Marker lines (`# %% [code] cell 2`) are never hits, but real "cell" text is.
    const cell: any = await mirrors.search({ pattern: 'cell', paths: ['analysis'] }, member);
    expect(cell.files[0].matches.map((m: any) => m.line)).toEqual([2]);
    // A top-level notebook is a notebook too, and an unparseable one is searched as text.
    const top: any = await mirrors.search({ pattern: 'top widgetlib' }, member);
    expect(top.files.map((x: any) => [x.path, x.notebook])).toEqual([['top.ipynb', true]]);
    const broken: any = await mirrors.search({ pattern: 'not json' }, member);
    expect(broken.files.map((x: any) => x.path)).toEqual(['broken.ipynb']);
    expect(broken.files[0].matches[0].cell).toBeUndefined();
  });

  it('applies include and exclude globs, the mirror exclude, and skips binary and oversized files', async () => {
    const all: any = await mirrors.search({ pattern: 'widgetlib', files_only: true }, member);
    expect(all.files.map((f: any) => f.path)).toEqual(['README.md', 'analysis/explore.ipynb', 'broken.ipynb', 'docs/guide.md', 'odd dir/a:b.md', 'src/app.py', 'top.ipynb']);
    expect(all.files.find((f: any) => f.path === 'docs/guide.md').match_count).toBe(30);
    expect(all.skipped.over_size_files).toBe(1);
    const md: any = await mirrors.search({ pattern: 'widgetlib', files_only: true, paths: ['**/*.md'], exclude: ['docs'] }, member);
    expect(md.files.map((f: any) => f.path)).toEqual(['README.md', 'odd dir/a:b.md']);
    const top: any = await mirrors.search({ pattern: 'widgetlib', files_only: true, paths: ['*.md'] }, member);
    expect(top.files.map((f: any) => f.path)).toEqual(['README.md']);
    settings = settingsFor(`file://${origin}`, { exclude: ['docs/**', 'analysis'] });
    await mirrors.reconcile(); // config changes land on the next reconcile tick
    const ex: any = await mirrors.search({ pattern: 'widgetlib', files_only: true }, member);
    expect(ex.files.map((f: any) => f.path)).toEqual(['README.md', 'broken.ipynb', 'odd dir/a:b.md', 'src/app.py', 'top.ipynb']);
  });

  it('caps results per file and overall, and trims snippets to the char budget', async () => {
    const r: any = await mirrors.search({ pattern: 'widgetlib', paths: ['docs'], max_per_file: 3, context: 0 }, member);
    expect(r.files[0].match_count).toBe(3);
    expect(r.files[0].more_in_file).toBe(true);
    expect(r.truncated).toBe(false);
    const capped: any = await mirrors.search({ pattern: 'widgetlib', max_results: 4, context: 0 }, member);
    expect(capped.total_matches).toBe(4);
    expect(capped.truncated).toBe(true);
    expect(capped.truncation).toBe('max_results');
    const tight: any = await mirrors.search({ pattern: 'widgetlib', max_chars: 60 }, member);
    expect(tight.files).toHaveLength(1);
    expect(tight.truncation).toBe('max_chars');
  });

  it('treats an option-looking pattern as text', async () => {
    write(origin, 'opts.txt', 'run with --output=x please\n');
    sh(origin, 'add', '-A');
    sh(origin, 'commit', '--quiet', '-m', 'opts');
    t += 6 * MIN;
    const r: any = await mirrors.search({ pattern: '--output=x' }, member);
    expect(r.files.map((f: any) => f.path)).toEqual(['opts.txt']);
    expect(existsSync(join(root, 'mirrors', 'demo', 'repo.git', 'x'))).toBe(false);
    expect(((await mirrors.search({ pattern: '-e' }, member)) as any).truncated).toBe(false);
  });

  it('reads files with line numbers, ranges, directories and notebooks', async () => {
    const f: any = await mirrors.read({ path: 'docs/guide.md', start_line: 2, end_line: 3 }, member);
    expect(f.type).toBe('file');
    expect(f.text).toBe('2\tline 2 widgetlib\n3\tline 3 widgetlib');
    expect(f.total_lines).toBe(30);
    expect(f.next_start_line).toBeNull();
    const cut: any = await mirrors.read({ path: 'docs/guide.md', max_chars: 60 }, member);
    expect(cut.end_line).toBe(3);
    expect(cut.next_start_line).toBe(4);
    const dir: any = await mirrors.read({ path: '' }, member);
    expect(dir.type).toBe('directory');
    expect(dir.entries.slice(0, 4).map((e: any) => [e.name, e.type])).toEqual([
      ['analysis', 'directory'],
      ['docs', 'directory'],
      ['odd dir', 'directory'],
      ['src', 'directory'],
    ]);
    const nb: any = await mirrors.read({ path: 'analysis/explore.ipynb' }, member);
    expect(nb.notebook.cells).toBe(2);
    expect(nb.text.split('\n')[3]).toBe('4\t# %% [code] cell 2');
    expect(nb.text).not.toContain('OUTPUT_ONLY_TOKEN');
    const raw: any = await mirrors.read({ path: 'analysis/explore.ipynb', raw: true }, member);
    expect(raw.text).toContain('OUTPUT_ONLY_TOKEN');
    const bin: any = await mirrors.read({ path: 'bin.dat' }, member);
    expect(bin.binary).toBe(true);
    await expect(mirrors.read({ path: 'docs/gide.md' }, member)).rejects.toMatchObject({ code: 'not-found' });
    await expect(mirrors.read({ path: 'guide.md' }, member)).rejects.toMatchObject({ code: 'not-found', detail: { suggestions: ['docs/guide.md'] } });
    for (const bad of ['../x', '/etc/passwd', 'a/../../b', 'a//b'])
      await expect(mirrors.read({ path: bad }, member)).rejects.toMatchObject({ code: 'validation-failed' });
  });

  it('fetches only when the last attempt is older than refresh_minutes', async () => {
    await mirrors.search({ pattern: 'widgetlib' }, member);
    write(origin, 'new.md', 'fresh widgetlib\n');
    sh(origin, 'add', '-A');
    sh(origin, 'commit', '--quiet', '-m', 'new');
    t += 4 * MIN;
    const early: any = await mirrors.search({ pattern: 'fresh' }, member);
    expect(early.files).toHaveLength(0);
    expect(fetches).toBe(1);
    t += 1 * MIN;
    const late: any = await mirrors.search({ pattern: 'fresh' }, member);
    expect(late.files.map((f: any) => f.path)).toEqual(['new.md']);
    expect(late.commit).toBe(sh(origin, 'rev-parse', 'HEAD'));
    expect(fetches).toBe(2);
    // A pinned commit never refreshes.
    t += 10 * MIN;
    await mirrors.read({ path: 'new.md', commit: late.commit }, member);
    expect(fetches).toBe(2);
  });

  it('shares one fetch between concurrent callers', async () => {
    await mirrors.search({ pattern: 'widgetlib' }, member);
    t += 6 * MIN;
    await Promise.all(Array.from({ length: 5 }, () => mirrors.search({ pattern: 'widgetlib' }, member)));
    expect(fetches).toBe(2);
  });

  it('serves the previous commit with refresh_error when a fetch fails, and waits out the window before retrying', async () => {
    const first: any = await mirrors.search({ pattern: 'widgetlib' }, member);
    rmSync(origin, { recursive: true, force: true });
    t += 6 * MIN;
    const stale: any = await mirrors.search({ pattern: 'widgetlib' }, member);
    expect(stale.commit).toBe(first.commit);
    expect(stale.stale).toBe(true);
    expect(stale.refresh_error).toBeTruthy();
    expect(fetches).toBe(2);
    t += 2 * MIN;
    await mirrors.search({ pattern: 'widgetlib' }, member);
    expect(fetches).toBe(2);
    const [status] = await mirrors.status();
    expect(status).toMatchObject({ name: 'demo', phase: 'ready', stale: true, commit: first.commit });
  });

  it('keeps its freshness across restarts', async () => {
    await mirrors.search({ pattern: 'widgetlib' }, member);
    await mirrors.stop();
    t += 2 * MIN;
    mirrors = make();
    await mirrors.search({ pattern: 'widgetlib' }, member);
    expect(fetches).toBe(1);
  });

  it('keeps a cited commit readable after a force-push', async () => {
    const first: any = await mirrors.search({ pattern: 'widgetlib' }, member);
    write(origin, 'README.md', 'rewritten\n');
    sh(origin, 'commit', '--quiet', '-a', '--amend', '-m', 'rewrite');
    t += 6 * MIN;
    const after: any = await mirrors.search({ pattern: 'rewritten' }, member);
    expect(after.commit).not.toBe(first.commit);
    const old: any = await mirrors.read({ path: 'README.md', commit: first.commit.slice(0, 12) }, member);
    expect(old.text).toContain('widgetlib');
    await expect(mirrors.read({ path: 'README.md', commit: 'deadbeefdead' }, member)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('re-clones when the remote changes and authenticates through the named capability', async () => {
    await mirrors.search({ pattern: 'widgetlib' }, member);
    const other = join(root, 'other');
    mkdirSync(other);
    sh(other, 'init', '--quiet', '--initial-branch=main');
    write(other, 'only.md', 'other widgetlib\n');
    sh(other, 'add', '-A');
    sh(other, 'commit', '--quiet', '-m', 'o');
    settings = settingsFor(`file://${other}`, { capability: 'git-demo' });
    await mirrors.reconcile();
    const r: any = await mirrors.search({ pattern: 'widgetlib', files_only: true }, member);
    expect(r.files.map((f: any) => f.path)).toEqual(['only.md']);
    expect(audit).toEqual([{ capability: 'git-demo', url: `file://${other}` }]);
  });

  it('enforces repository grants and resolves an omitted repo', async () => {
    await expect(mirrors.search({ repo: 'demo', pattern: 'widgetlib' }, subagent([]))).rejects.toMatchObject({ code: 'grant-denied' });
    await expect(mirrors.search({ pattern: 'widgetlib' }, subagent([]))).rejects.toMatchObject({ code: 'not-found' });
    expect(((await mirrors.search({ pattern: 'widgetlib', paths: ['README.md'] }, subagent(['demo']))) as any).files).toHaveLength(1);
    await expect(mirrors.search({ repo: 'nope', pattern: 'x' }, member)).rejects.toMatchObject({ code: 'not-found' });
    expect(await mirrors.status(subagent([]))).toEqual([]);
  });

  it('reports a mirror that cannot be cloned as invalid-state', async () => {
    settings = settingsFor(`file://${join(root, 'missing')}`);
    const err = await mirrors.search({ pattern: 'x' }, member).catch((e) => e);
    expect(err).toBeInstanceOf(BreadboardError);
    expect(err.code).toBe('invalid-state');
    expect(err.detail.phase).toBe('failed');
    expect(err.detail.last_error).toBeTruthy();
  });

  it('refuses non-https remotes unless file URLs are allowed', async () => {
    mirrors = make({ allowFileUrls: false });
    const err = await mirrors.search({ pattern: 'x' }, member).catch((e) => e);
    expect(err.code).toBe('invalid-state');
    expect(err.detail.last_error).toMatch(/https/);
  });
});
