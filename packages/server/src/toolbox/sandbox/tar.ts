/**
 * Minimal in-process ustar writer (no dependencies) used to copy a tool directory into a sandbox container
 * via the Docker archive API. Entries are written root-owned (uid/gid 0) with 0644/0755 modes so the
 * unprivileged sandbox user (10001) can read but never modify tool code. Symlinks are skipped: they could
 * point outside the tool directory on the host.
 */
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

export interface TarEntry {
  /** POSIX relative path; directories may end with `/`. */
  path: string;
  type: 'file' | 'dir';
  data?: Buffer;
  mode?: number;
  mtime?: number; // seconds
}

const BLOCK = 512;

function octal(n: number, width: number): string {
  // width includes the trailing NUL
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function writeStr(buf: Buffer, offset: number, width: number, s: string): void {
  const b = Buffer.from(s, 'utf8');
  if (b.length > width) throw new Error(`tar field overflow (${width}): ${s}`);
  b.copy(buf, offset);
}

/** Split a long path into ustar prefix/name (name ≤ 100, prefix ≤ 155) or null when impossible. */
export function splitUstarPath(p: string): { prefix: string; name: string } | null {
  if (Buffer.byteLength(p) <= 100) return { prefix: '', name: p };
  for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) {
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name.length > 0) return { prefix, name };
  }
  return null;
}

function header(e: { name: string; prefix: string; size: number; mode: number; mtime: number; typeflag: string }): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  writeStr(h, 0, 100, e.name);
  writeStr(h, 100, 8, octal(e.mode & 0o7777, 8));
  writeStr(h, 108, 8, octal(0, 8)); // uid
  writeStr(h, 116, 8, octal(0, 8)); // gid
  writeStr(h, 124, 12, octal(e.size, 12));
  writeStr(h, 136, 12, octal(Math.floor(e.mtime), 12));
  h.fill(0x20, 148, 156); // checksum placeholder (spaces)
  writeStr(h, 156, 1, e.typeflag);
  writeStr(h, 257, 6, 'ustar\0');
  writeStr(h, 263, 2, '00');
  writeStr(h, 265, 32, 'root');
  writeStr(h, 297, 32, 'root');
  writeStr(h, 345, 155, e.prefix);
  let sum = 0;
  for (const byte of h) sum += byte;
  writeStr(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

function pad(size: number): Buffer {
  const r = size % BLOCK;
  return Buffer.alloc(r === 0 ? 0 : BLOCK - r, 0);
}

/** PAX extended header carrying a long `path` record. */
function paxPath(path: string, mtime: number): Buffer[] {
  const rec = (len: number) => `${len} path=${path}\n`;
  let len = Buffer.byteLength(rec(0));
  while (Buffer.byteLength(rec(len)) !== len) len = Buffer.byteLength(rec(len));
  const body = Buffer.from(rec(len), 'utf8');
  return [header({ name: 'PaxHeader', prefix: '', size: body.length, mode: 0o644, mtime, typeflag: 'x' }), body, pad(body.length)];
}

export function createTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const clean = posix.normalize(e.path.replace(/\\/g, '/')).replace(/^\/+/, '').replace(/\/+$/, '');
    if (!clean || clean === '.' || clean.startsWith('../') || clean === '..') throw new Error(`unsafe tar path: ${e.path}`);
    const path = e.type === 'dir' ? clean + '/' : clean;
    const data = e.type === 'file' ? (e.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const mtime = e.mtime ?? Math.floor(Date.now() / 1000);
    const mode = e.mode ?? (e.type === 'dir' ? 0o755 : 0o644);
    let split = splitUstarPath(path);
    if (!split) {
      parts.push(...paxPath(path, mtime));
      split = { prefix: '', name: path.slice(0, 99) };
    }
    parts.push(header({ ...split, size: data.length, mode, mtime, typeflag: e.type === 'dir' ? '5' : '0' }));
    if (data.length) parts.push(data, pad(data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/**
 * Tar a directory tree (regular files + directories only). Modes are normalized: 0755 for directories and
 * owner-executable files, 0644 otherwise. Throws when the tree exceeds `maxBytes`.
 */
export async function tarDirectory(dir: string, opts: { maxBytes?: number; skip?: (rel: string) => boolean } = {}): Promise<Buffer> {
  const entries: TarEntry[] = [];
  const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
  let total = 0;
  async function walk(rel: string): Promise<void> {
    const names = (await readdir(join(dir, rel))).sort();
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (opts.skip?.(r)) continue;
      const st = await lstat(join(dir, r));
      const mtime = Math.floor(st.mtimeMs / 1000);
      if (st.isDirectory()) {
        entries.push({ path: r, type: 'dir', mtime });
        await walk(r);
      } else if (st.isFile()) {
        total += st.size;
        if (total > maxBytes) throw new Error(`tool directory exceeds ${maxBytes} bytes`);
        entries.push({ path: r, type: 'file', data: await readFile(join(dir, r)), mode: st.mode & 0o100 ? 0o755 : 0o644, mtime });
      }
      // symlinks, sockets, devices: skipped deliberately
    }
  }
  await walk('');
  return createTar(entries);
}
