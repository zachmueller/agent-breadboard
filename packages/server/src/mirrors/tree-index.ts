/**
 * A commit's file tree for a repository mirror ([06] §7.1), from `git ls-tree -r -l -z --full-tree <sha>`: every
 * path with its mode, blob SHA and size. Reads resolve user paths here (so no user path reaches argv), searches use
 * the sizes to skip oversized files, and misses suggest near matches.
 */
export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'commit';
  sha: string;
  /** Blob size in bytes; null for submodules. */
  size: number | null;
}

export type EntryKind = 'file' | 'directory' | 'symlink' | 'submodule';

/** Parse `ls-tree -r -l -z` output: `<mode> <type> <sha> <size>\t<path>\0` per entry. */
export function parseLsTree(buf: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0, start);
    if (end < 0) end = buf.length;
    const rec = buf.subarray(start, end).toString('utf8');
    start = end + 1;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, sha, size] = rec.slice(0, tab).split(/ +/);
    if (!mode || !sha || (type !== 'blob' && type !== 'commit')) continue;
    out.push({ path: rec.slice(tab + 1), mode, type, sha, size: size && size !== '-' ? Number(size) : null });
  }
  return out;
}

export function entryKind(e: TreeEntry): EntryKind {
  if (e.type === 'commit') return 'submodule';
  return e.mode === '120000' ? 'symlink' : 'file';
}

export class TreeIndex {
  readonly byPath = new Map<string, TreeEntry>();
  private children: Map<string, Map<string, { name: string; type: EntryKind; size?: number }>> | null = null;

  constructor(readonly entries: TreeEntry[]) {
    for (const e of entries) this.byPath.set(e.path, e);
  }

  lookup(path: string): TreeEntry | null {
    return this.byPath.get(path) ?? null;
  }

  isDir(path: string): boolean {
    return this.dirMap().has(path);
  }

  /** Immediate children of a directory (`''` = root), directories first, then by name. */
  listDir(path: string): Array<{ name: string; type: EntryKind; size?: number }> {
    const kids = this.dirMap().get(path);
    if (!kids) return [];
    return [...kids.values()].sort((a, b) => (a.type === 'directory') !== (b.type === 'directory') ? (a.type === 'directory' ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }

  /** Up to `n` existing paths that look like `path`: the same file name first, then names containing it. */
  suggest(path: string, n = 5): string[] {
    const base = (path.split('/').pop() ?? path).toLowerCase();
    if (!base) return [];
    const same: string[] = [];
    const contains: string[] = [];
    for (const p of this.byPath.keys()) {
      const name = (p.split('/').pop() ?? p).toLowerCase();
      if (name === base) same.push(p);
      else if (name.includes(base) || (base.length > 3 && base.includes(name))) contains.push(p);
    }
    return [...same, ...contains].slice(0, n);
  }

  private dirMap() {
    if (this.children) return this.children;
    const m = new Map<string, Map<string, { name: string; type: EntryKind; size?: number }>>([['', new Map()]]);
    const ensure = (dir: string) => {
      let kids = m.get(dir);
      if (!kids) m.set(dir, (kids = new Map()));
      return kids;
    };
    for (const e of this.entries) {
      const parts = e.path.split('/');
      for (let i = 0; i < parts.length - 1; i++) {
        const parent = parts.slice(0, i).join('/');
        const name = parts[i]!;
        ensure(parent).set(name, { name, type: 'directory' });
        ensure(parts.slice(0, i + 1).join('/'));
      }
      const parent = parts.slice(0, -1).join('/');
      const name = parts[parts.length - 1]!;
      ensure(parent).set(name, { name, type: entryKind(e), ...(e.size !== null ? { size: e.size } : {}) });
    }
    this.children = m;
    return m;
  }
}
