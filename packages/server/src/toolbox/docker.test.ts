import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DockerStreamDemuxer,
  SANDBOX_NETWORK,
  SANDBOX_USER,
  buildCreateOptions,
  buildHostConfig,
  dockerConnection,
  idleCommand,
  resourceLimits,
  runnerCommand,
} from './sandbox/docker.js';
import { createTar, splitUstarPath, tarDirectory } from './sandbox/tar.js';

const limits = { timeout_s: 30, memory_mb: 256, cpus: 0.5, pids: 64, max_cost_units: 1 };

describe('docker runner pure helpers', () => {
  it('builds the hardened HostConfig', () => {
    const hc = buildHostConfig({ limits, runtime: 'runsc' });
    expect(hc).toMatchObject({
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
      NanoCpus: 500_000_000,
      PidsLimit: 64,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      NetworkMode: SANDBOX_NETWORK,
      ExtraHosts: ['host.docker.internal:host-gateway'],
      Privileged: false,
      Runtime: 'runsc',
    });
    expect(hc.Tmpfs?.['/work']).toMatch(/noexec/);
    expect(hc.Binds).toBeUndefined();
    expect(buildHostConfig({ limits }).Runtime).toBeUndefined();
    expect(JSON.stringify(hc)).not.toMatch(/docker\.sock/);
    expect(resourceLimits(limits)).toEqual({ Memory: 268435456, MemorySwap: 268435456, NanoCpus: 500000000, PidsLimit: 64 });
  });

  it('builds create options: non-root user, /tool volume (or :ro bind), no shell commands', () => {
    const warm = buildCreateOptions({ image: 'breadboard/sandbox-ts:1', language: 'typescript', limits, state: 'warm' });
    expect(warm.User).toBe(SANDBOX_USER);
    expect(warm.User).toBe('10001:10001');
    expect(warm.Volumes).toEqual({ '/tool': {} });
    expect(warm.Labels).toMatchObject({ 'breadboard.sandbox': '1', 'breadboard.state': 'warm' });
    expect(warm.Cmd).toEqual(idleCommand('typescript'));
    const bound = buildCreateOptions({ image: 'img', language: 'python', limits, state: 'cold', bindToolDir: '/srv/tools/X' });
    expect(bound.Volumes).toBeUndefined();
    expect(bound.HostConfig?.Binds).toEqual(['/srv/tools/X:/tool:ro']);
    for (const cmd of [idleCommand('typescript'), idleCommand('python'), runnerCommand('typescript'), runnerCommand('python')]) {
      expect(['sh', '/bin/sh', 'bash']).not.toContain(cmd[0]);
    }
    expect(runnerCommand('typescript')).toEqual(['node', '--disable-warning=ExperimentalWarning', '/runtime/runner-cli.js', '/tool']);
    expect(runnerCommand('python')).toEqual(['python3', '-u', '/runtime/breadboard_runtime.py', '/tool']);
  });

  it('parses docker socket settings', () => {
    expect(dockerConnection('/var/run/docker.sock')).toEqual({ socketPath: '/var/run/docker.sock' });
    expect(dockerConnection('unix:///var/run/docker.sock')).toEqual({ socketPath: '/var/run/docker.sock' });
    expect(dockerConnection('tcp://docker:2375')).toEqual({ protocol: 'http', host: 'docker', port: 2375 });
    expect(dockerConnection('https://docker')).toEqual({ protocol: 'https', host: 'docker', port: 2376 });
  });

  it('demultiplexes the attach stream across chunk boundaries', () => {
    const out: string[] = [];
    const err: string[] = [];
    const d = new DockerStreamDemuxer(
      (b) => out.push(b.toString()),
      (b) => err.push(b.toString()),
    );
    const frame = (type: number, s: string) => {
      const p = Buffer.from(s);
      const h = Buffer.alloc(8);
      h[0] = type;
      h.writeUInt32BE(p.length, 4);
      return Buffer.concat([h, p]);
    };
    const all = Buffer.concat([frame(1, '{"kind":"log"}\n'), frame(2, 'warn!'), frame(1, '{"kind":"result"}\n')]);
    for (let i = 0; i < all.length; i += 5) d.push(all.subarray(i, i + 5));
    expect(out.join('')).toBe('{"kind":"log"}\n{"kind":"result"}\n');
    expect(err.join('')).toBe('warn!');
  });
});

describe('tar writer', () => {
  it('splits long paths into ustar prefix/name', () => {
    expect(splitUstarPath('a/b.txt')).toEqual({ prefix: '', name: 'a/b.txt' });
    const long = `${'d'.repeat(120)}/file.ts`;
    expect(splitUstarPath(long)).toEqual({ prefix: 'd'.repeat(120), name: 'file.ts' });
    expect(splitUstarPath('x'.repeat(200))).toBeNull();
  });

  it('rejects unsafe paths', () => {
    expect(() => createTar([{ path: '../escape', type: 'file' }])).toThrow(/unsafe/);
    expect(() => createTar([{ path: 'a/../../escape', type: 'file' }])).toThrow(/unsafe/);
  });

  it('produces an archive system tar extracts faithfully (long paths, modes, skipped symlinks)', async () => {
    const src = await mkdtemp(join(tmpdir(), 'bb-tar-src-'));
    const deep = join('src', 'n'.repeat(80), 'm'.repeat(80));
    await mkdir(join(src, deep), { recursive: true });
    await writeFile(join(src, 'tool.yaml'), 'schema: breadboard/tool@v1\n');
    await writeFile(join(src, deep, 'index.ts'), 'export const x = 1;\n');
    const longName = `${'z'.repeat(150)}.py`;
    await writeFile(join(src, longName), 'print(1)\n');
    await writeFile(join(src, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    await mkdir(join(src, '.git'));
    await writeFile(join(src, '.git', 'HEAD'), 'ref\n');
    await symlink('/etc/passwd', join(src, 'link'));
    const tar = await tarDirectory(src, { skip: (rel) => rel === '.git' });
    expect(tar.length % 512).toBe(0);

    const out = await mkdtemp(join(tmpdir(), 'bb-tar-out-'));
    const tarFile = join(out, 'x.tar');
    await writeFile(tarFile, tar);
    const listing = execFileSync('tar', ['-tvf', tarFile]).toString();
    expect(listing).not.toMatch(/\.git|link/);
    execFileSync('tar', ['-xf', tarFile, '-C', out]);
    expect(await readFile(join(out, 'tool.yaml'), 'utf8')).toBe('schema: breadboard/tool@v1\n');
    expect(await readFile(join(out, deep, 'index.ts'), 'utf8')).toBe('export const x = 1;\n');
    expect(await readFile(join(out, longName), 'utf8')).toBe('print(1)\n');
    expect(listing).toMatch(/^-rwxr-xr-x.*run\.sh$/m);
    expect(listing).toMatch(/^-rw-r--r--.*tool\.yaml$/m);
    await expect(tarDirectory(src, { maxBytes: 10 })).rejects.toThrow(/exceeds/);
  });
});
