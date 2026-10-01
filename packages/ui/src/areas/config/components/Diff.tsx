/** Text diffs rendered natively (+/- coloring) from the `diff` package, plus raw patch display. */
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { structuredPatch, createTwoFilesPatch } from 'diff';
import { ChevronDown, ChevronRight } from 'lucide-react';

export function TextDiff({ oldText, newText, oldLabel = 'base', newLabel = 'working', context = 3, className }: { oldText: string; newText: string; oldLabel?: string; newLabel?: string; context?: number; className?: string }) {
  const patch = useMemo(() => structuredPatch(oldLabel, newLabel, oldText ?? '', newText ?? '', '', '', { context }), [oldText, newText, oldLabel, newLabel, context]);
  if (!patch.hunks.length) return <div className="px-2 py-1.5 text-xs text-fg-subtle">No changes.</div>;
  return (
    <div className={clsx('overflow-auto rounded-md border border-line bg-surface font-mono text-[12px] leading-[1.5]', className)}>
      {patch.hunks.map((h, i) => {
        let o = h.oldStart;
        let n = h.newStart;
        return (
          <div key={i}>
            <div className="bg-info-soft px-2 text-info-fg">
              @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
            </div>
            {h.lines.map((line, j) => {
              const sign = line[0];
              const text = line.slice(1);
              const ol = sign === '+' ? '' : String(o++);
              const nl = sign === '-' ? '' : String(n++);
              if (sign === '\\') return null;
              return (
                <div key={j} className={clsx('flex whitespace-pre', sign === '+' && 'bg-ok-soft text-ok-fg', sign === '-' && 'bg-danger-soft text-danger-fg')}>
                  <span className="w-10 shrink-0 pr-1 text-right text-fg-subtle select-none">{ol}</span>
                  <span className="w-10 shrink-0 pr-1 text-right text-fg-subtle select-none">{nl}</span>
                  <span className="w-4 shrink-0 text-center select-none">{sign === ' ' ? '' : sign}</span>
                  <span className="pr-3">{text || ' '}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function rawPatch(path: string, oldText: string | null | undefined, newText: string | null | undefined, oldRef = 'a', newRef = 'b'): string {
  return createTwoFilesPatch(oldText == null ? '/dev/null' : `${oldRef}/${path}`, newText == null ? '/dev/null' : `${newRef}/${path}`, oldText ?? '', newText ?? '', '', '', { context: 3 });
}

export function RawPatch({ patch, className }: { patch: string; className?: string }) {
  return (
    <pre className={clsx('overflow-auto rounded-md border border-line bg-sunken p-2 font-mono text-[11.5px] leading-[1.5]', className)}>
      {patch.split('\n').map((l, i) => (
        <div key={i} className={clsx(l.startsWith('+') && !l.startsWith('+++') && 'text-ok-fg', l.startsWith('-') && !l.startsWith('---') && 'text-danger-fg', l.startsWith('@@') && 'text-info-fg')}>
          {l || ' '}
        </div>
      ))}
    </pre>
  );
}

export type FileStatus = 'added' | 'modified' | 'deleted';

export function changedFiles(base: Record<string, string | null | undefined>, next: Record<string, string | null | undefined>): Array<{ path: string; status: FileStatus }> {
  const out: Array<{ path: string; status: FileStatus }> = [];
  for (const p of [...new Set([...Object.keys(base), ...Object.keys(next)])].sort()) {
    const a = base[p] ?? null;
    const b = next[p] ?? null;
    if (a === b) continue;
    out.push({ path: p, status: a === null ? 'added' : b === null ? 'deleted' : 'modified' });
  }
  return out;
}

/** Per-file collapsible text diffs (tool code diffs, prompt files). */
export function MultiFileDiff({ base, next, oldLabel, newLabel, stripPrefix, only }: { base: Record<string, string | null | undefined>; next: Record<string, string | null | undefined>; oldLabel?: string; newLabel?: string; stripPrefix?: string; only?: (path: string) => boolean }) {
  const files = changedFiles(base, next).filter((f) => !only || only(f.path));
  if (!files.length) return <div className="text-xs text-fg-subtle">No file changes.</div>;
  return (
    <div className="space-y-2">
      {files.map((f) => (
        <FileDiffBlock key={f.path} path={stripPrefix && f.path.startsWith(stripPrefix) ? f.path.slice(stripPrefix.length) : f.path} status={f.status} oldText={base[f.path] ?? ''} newText={next[f.path] ?? ''} oldLabel={oldLabel} newLabel={newLabel} />
      ))}
    </div>
  );
}

export function FileDiffBlock({ path, status, oldText, newText, oldLabel, newLabel, defaultOpen = true }: { path: string; status: FileStatus; oldText: string; newText: string; oldLabel?: string; newLabel?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-md border border-line">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 bg-sunken px-2 py-1 text-left font-mono text-xs">
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span className={clsx('w-3 font-bold', status === 'added' && 'text-ok-fg', status === 'deleted' && 'text-danger-fg', status === 'modified' && 'text-warn-fg')}>{status === 'added' ? 'A' : status === 'deleted' ? 'D' : 'M'}</span>
        <span className="truncate">{path}</span>
      </button>
      {open && <TextDiff oldText={oldText} newText={newText} oldLabel={oldLabel} newLabel={newLabel} className="rounded-none border-0 border-t" />}
    </div>
  );
}
