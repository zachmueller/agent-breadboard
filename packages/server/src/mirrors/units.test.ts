import { describe, expect, it } from 'vitest';
import { cleanGitError, mirrorGitEnv, runGit } from './git.js';
import * as P from './pathspec.js';
import { locate, renderNotebook } from './notebook.js';
import { GrepZParser, clipLine, parseGrepCounts, snippet, splitLines } from './search.js';
import { TreeIndex, parseLsTree } from './tree-index.js';

describe('pathspec validation', () => {
  it('normalizes repo paths and rejects traversal, absolute paths and control characters', () => {
    expect(P.repoPath('')).toBe('');
    expect(P.repoPath('.')).toBe('');
    expect(P.repoPath('docs/')).toBe('docs');
    expect(P.repoPath('a b/c:d.md')).toBe('a b/c:d.md');
    for (const bad of ['../x', '/etc/passwd', 'a/../../b', 'a/./b', 'a//b', 'x\ny', 'x\0y', 'a'.repeat(1025)]) expect(() => P.repoPath(bad)).toThrow();
  });

  it('accepts git globs but not pathspec magic or traversal', () => {
    expect(P.glob('src/**/*.py')).toBe('src/**/*.py');
    expect(P.glob('docs/')).toBe('docs');
    for (const bad of [':(top)x', ':!x', '../x', '/abs', 'a/../b', 'x\ny', '']) expect(() => P.glob(bad)).toThrow();
    expect(() => P.globs(Array.from({ length: 21 }, () => 'x'), 'paths')).toThrow(/at most 20/);
  });

  it('builds pathspecs with explicit magic', () => {
    expect(P.pathspecs({ include: ['src'], exclude: ['docs/**'], excludeRaw: ['*.ipynb'], excludeLiteral: ['big[1].txt'] })).toEqual([':(glob)src', ':(exclude,glob)docs/**', ':(exclude)*.ipynb', ':(exclude,literal)big[1].txt']);
  });

  it('checks patterns and commits', () => {
    expect(P.pattern('--output=x')).toBe('--output=x');
    expect(() => P.pattern('a\nb')).toThrow();
    expect(() => P.pattern('x'.repeat(1001))).toThrow();
    expect(P.commitRef('ABCDEF1')).toBe('abcdef1');
    for (const bad of ['abc', 'HEAD', 'main', 'abcdefg', '-abcdef1']) expect(() => P.commitRef(bad)).toThrow();
  });
});

describe('notebook rendering', () => {
  it('keeps cell sources, drops outputs and maps lines to cells', () => {
    const nb = renderNotebook(
      JSON.stringify({
        nbformat: 4,
        metadata: { kernelspec: { language: 'python' } },
        cells: [
          { cell_type: 'markdown', source: ['# Title\n', 'text'] },
          { cell_type: 'code', source: 'x = 1\r\ny = 2\n', outputs: [{ output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgoSECRET' } }] },
          { cell_type: 'code', source: [] },
        ],
      }),
    )!;
    expect(nb.text).toBe('# %% [markdown] cell 1\n# Title\ntext\n# %% [code] cell 2\nx = 1\ny = 2\n# %% [code] cell 3\n');
    expect(nb.text).not.toContain('SECRET');
    expect(nb.language).toBe('python');
    expect(locate(nb.cells, 1)).toEqual({ cell: 1, cell_type: 'markdown', cell_line: 0 });
    expect(locate(nb.cells, 3)).toEqual({ cell: 1, cell_type: 'markdown', cell_line: 2 });
    expect(locate(nb.cells, 6)).toEqual({ cell: 2, cell_type: 'code', cell_line: 2 });
    expect(locate(nb.cells, 7)).toEqual({ cell: 3, cell_type: 'code', cell_line: 0 });
    expect(locate(nb.cells, 8)).toBeNull();
  });

  it('reads nbformat 3 and rejects non-notebooks', () => {
    const v3 = renderNotebook(JSON.stringify({ nbformat: 3, worksheets: [{ cells: [{ cell_type: 'code', input: ['a = 1'] }, { cell_type: 'markdown', source: 'hi' }] }] }))!;
    expect(v3.text).toBe('# %% [code] cell 1\na = 1\n# %% [markdown] cell 2\nhi\n');
    expect(renderNotebook('{not json')).toBeNull();
    expect(renderNotebook('[1,2]')).toBeNull();
    expect(renderNotebook('{"cells": "nope"}')).toBeNull();
  });
});

describe('git grep output', () => {
  it('parses -z --column records across chunk boundaries, with odd paths and multibyte columns', () => {
    const p = new GrepZParser('abc123:');
    const rec = (path: string, line: number, col: number, text: string) => Buffer.from(`abc123:${path}\0${line}\0${col}\0${text}\n`);
    const all = Buffer.concat([rec('a b/c:d.md', 3, 5, 'xx: needle'), rec('é.md', 1, 4, 'éa needle')]);
    const hits = [...p.push(all.subarray(0, 10)), ...p.push(all.subarray(10, 31)), ...p.push(all.subarray(31))];
    expect(hits).toEqual([
      { path: 'a b/c:d.md', line: 3, column: 5 },
      { path: 'é.md', line: 1, column: 3 },
    ]);
  });

  it('parses -c -z counts', () => {
    expect(parseGrepCounts(Buffer.from('s:a.md\x005\ns:b/c.md\x0017\n'), 's:')).toEqual([
      { path: 'a.md', count: 5 },
      { path: 'b/c.md', count: 17 },
    ]);
  });

  it('builds grep-style hunks and clips long lines around the match', () => {
    const lines = splitLines('l1\r\nl2\nl3\nl4\nl5\nl6\nl7\n');
    expect(lines).toHaveLength(7);
    expect(snippet(lines, [{ line: 2, column: 1 }, { line: 6, column: 1 }], 1)).toBe('1-l1\n2:l2\n3-l3\n--\n5-l5\n6:l6\n7-l7');
    expect(snippet(lines, [{ line: 3, column: 1 }, { line: 4, column: 1 }], 0)).toBe('3:l3\n4:l4');
    const long = `${'a'.repeat(500)}NEEDLE${'b'.repeat(500)}`;
    const clipped = clipLine(long, 501);
    expect(clipped).toContain('NEEDLE');
    expect(clipped.length).toBeLessThanOrEqual(242);
    expect(clipped.startsWith('…') && clipped.endsWith('…')).toBe(true);
  });
});

describe('tree index', () => {
  const idx = new TreeIndex(
    parseLsTree(
      Buffer.from(
        ['100644 blob aaaa111     12\tREADME.md', '100644 blob bbbb222   2048\tsrc/app.py', '120000 blob cccc333      6\tsrc/link', '160000 commit dddd444       -\tvendor/sub', '100644 blob eeee555      3\tdocs/guide.md'].join('\0') + '\0',
      ),
    ),
  );

  it('looks up entries and lists directories', () => {
    expect(idx.lookup('src/app.py')).toEqual({ path: 'src/app.py', mode: '100644', type: 'blob', sha: 'bbbb222', size: 2048 });
    expect(idx.lookup('vendor/sub')?.size).toBeNull();
    expect(idx.isDir('src')).toBe(true);
    expect(idx.isDir('src/app.py')).toBe(false);
    expect(idx.listDir('').map((e) => `${e.type}:${e.name}`)).toEqual(['directory:docs', 'directory:src', 'directory:vendor', 'file:README.md']);
    expect(idx.listDir('src').map((e) => `${e.type}:${e.name}`)).toEqual(['file:app.py', 'symlink:link']);
    expect(idx.listDir('vendor')).toEqual([{ name: 'sub', type: 'submodule' }]);
  });

  it('suggests near matches', () => {
    expect(idx.suggest('guide.md')).toEqual(['docs/guide.md']);
    expect(idx.suggest('nothing-like-it')).toEqual([]);
  });
});

describe('mirror git environment', () => {
  it('inherits no GIT_* settings and passes auth headers only as env config', () => {
    process.env.GIT_TRACE = '1';
    process.env.GIT_CONFIG_PARAMETERS = "'credential.helper=store'";
    try {
      const env = mirrorGitEnv({ headers: { Authorization: 'Basic c2VjcmV0' } });
      expect(env.GIT_TRACE).toBeUndefined();
      expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(env.GIT_ALLOW_PROTOCOL).toBe('https');
      const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
      expect(pairs).toContainEqual(['credential.helper', '']);
      expect(pairs).toContainEqual(['http.followRedirects', 'false']);
      const headers = pairs.filter(([k]) => k === 'http.extraHeader').map(([, v]) => v);
      expect(headers).toEqual(['', 'Authorization: Basic c2VjcmV0']);
    } finally {
      delete process.env.GIT_TRACE;
      delete process.env.GIT_CONFIG_PARAMETERS;
    }
    expect(() => mirrorGitEnv({ headers: { Authorization: 'x\r\nInjected: y' } })).toThrow();
    expect(mirrorGitEnv({ allowFileUrls: true }).GIT_ALLOW_PROTOCOL).toBe('https:http:file');
  });

  it('times out and stops processes', async () => {
    const slow = await runGit({ args: ['cat-file', '--batch'], env: mirrorGitEnv(), timeoutMs: 300, input: undefined });
    expect(slow.timedOut || slow.code !== null).toBe(true);
    const stopped = await runGit({ args: ['--version'], env: mirrorGitEnv(), timeoutMs: 10_000, onStdout: () => false });
    expect(stopped.stopped).toBe(true);
  });

  it('redacts credentials from git errors', () => {
    expect(cleanGitError('fatal: unable to access https://user:pw@example.com/r.git\nAuthorization: Basic abc')).toBe('fatal: unable to access https://<redacted>@example.com/r.git Authorization: <redacted>');
  });
});
