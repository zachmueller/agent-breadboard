/**
 * Directory editor over a working tree: file list (root first, dirty dots, deletions struck through),
 * add/delete file, and a two-way CodeMirror pane. Used by the circuit YAML tab and the tool editor.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { FilePlus2, Trash2 } from 'lucide-react';
import { useWorkingTree } from '../model/workingTree';
import { CodeEditor, languageForPath } from './CodeEditor';
import { Btn, TextInput, Confirm } from '../ui';

export function FilesEditor({
  ensure = [],
  newFilePlaceholder = 'path/to/file',
  protectedPaths = [],
  aside,
  initialPath,
}: {
  /** Paths to probe (they may not exist at base). */
  ensure?: string[];
  newFilePlaceholder?: string;
  /** Paths that cannot be deleted besides the root (e.g. a tool's entrypoint). */
  protectedPaths?: string[];
  /** Optional panel rendered under the editor for the selected file. */
  aside?: (path: string) => ReactNode;
  initialPath?: string;
}) {
  const wt = useWorkingTree();
  const { rootPath, dir } = wt.state;
  useEffect(() => {
    for (const p of ensure) wt.ensureFile(p);
  }, [ensure.join('|')]);
  const files = Object.entries(wt.state.files)
    .filter(([, v]) => v !== null)
    .map(([p]) => p)
    .sort((a, b) => (a === rootPath ? -1 : b === rootPath ? 1 : a.localeCompare(b)));
  const deleted = Object.entries(wt.state.files)
    .filter(([p, v]) => v === null && p in wt.state.base)
    .map(([p]) => p);
  const [path, setPath] = useState(initialPath ?? rootPath);
  const [newPath, setNewPath] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const current = files.includes(path) ? path : rootPath;
  const text = wt.getFile(current) ?? '';
  const rel = (p: string) => (dir && p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : p);
  const create = () => {
    const r = newPath.trim().replace(/^\/+/, '');
    if (!r || !dir || r.includes('..')) return;
    const full = `${dir}/${r}`;
    if (wt.getFile(full) == null) wt.setFile(full, '');
    setPath(full);
    setNewPath('');
  };
  const canDelete = current !== rootPath && !protectedPaths.includes(current);

  return (
    <div className="flex h-full min-h-0">
      <nav className="w-56 shrink-0 overflow-y-auto border-r border-line bg-surface p-2 text-xs" aria-label="Files">
        <ul className="space-y-0.5">
          {files.map((p) => (
            <li key={p}>
              <button type="button" onClick={() => setPath(p)} aria-current={p === current} className={`flex w-full items-center gap-1 truncate rounded px-2 py-1 text-left font-mono ${p === current ? 'bg-hover font-medium' : 'hover:bg-hover'}`}>
                <span className="truncate" style={{ paddingLeft: `${Math.max(0, rel(p).split('/').length - 1) * 0.6}rem` }}>
                  {rel(p)}
                </span>
                {wt.state.dirty.has(p) && (
                  <span className="ml-auto text-warn-fg" title={p in wt.state.base ? 'modified' : 'added'}>
                    {p in wt.state.base ? 'M' : 'A'}
                  </span>
                )}
              </button>
            </li>
          ))}
          {deleted.map((p) => (
            <li key={p} className="flex items-center px-2 py-1 font-mono text-danger-fg">
              <span className="truncate line-through">{rel(p)}</span>
              <button type="button" className="ml-auto text-[10px] underline" onClick={() => wt.setFile(p, wt.state.base[p] ?? '')}>
                restore
              </button>
            </li>
          ))}
        </ul>
        {dir && (
          <div className="mt-3 flex gap-1">
            <TextInput aria-label="New file path" className="h-7 font-mono text-xs" value={newPath} placeholder={newFilePlaceholder} onChange={(e) => setNewPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
            <Btn size="xs" variant="ghost" aria-label="Add file" icon={<FilePlus2 className="size-3.5" />} onClick={create} />
          </div>
        )}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-xs">
          <span className="font-mono">{rel(current)}</span>
          {current === rootPath && wt.parseError && <span className="text-danger-fg">YAML error: {wt.parseError}</span>}
          {canDelete && (
            <Btn size="xs" variant="ghost" className="ml-auto" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDelete(true)}>
              Delete file
            </Btn>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <CodeEditor key={current} language={languageForPath(current)} value={text} onChange={(t) => wt.setFile(current, t)} minHeight={400} className="h-full" ariaLabel={rel(current)} />
        </div>
        {aside?.(current)}
      </div>
      <Confirm
        open={confirmDelete}
        title={`Delete ${rel(current)}?`}
        message="The deletion is part of your uncommitted changes until you commit."
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          wt.setFile(current, null);
          setPath(rootPath);
          setConfirmDelete(false);
        }}
      />
    </div>
  );
}
