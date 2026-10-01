/** A config definition reference (circuit / subagent / tool …) shown by slug, linked by permanent UID ([10] §2). */
import { Link } from '@tanstack/react-router';
import { Bot, FileCode2, Server, Workflow, Wrench } from 'lucide-react';
import { useConfigIndex } from '../lib/queries';
import { configEditorPath } from '../lib/paths';
import { cn } from './cn';

export function ConfigKindIcon({ kind, size = 13, className }: { kind: string | null | undefined; size?: number; className?: string }) {
  const p = { size, className: cn('shrink-0', className), 'aria-hidden': true } as const;
  switch (kind) {
    case 'circuit':
      return <Workflow {...p} />;
    case 'subagent':
      return <Bot {...p} />;
    case 'tool':
      return <Wrench {...p} />;
    case 'mcp':
      return <Server {...p} />;
    default:
      return <FileCode2 {...p} />;
  }
}

/** Resolve a config UID to its display slug (falls back to a shortened UID). */
export function useConfigLabel(uid: string | null | undefined, fallback?: string | null): { label: string; kind: string | null } {
  const idx = useConfigIndex();
  if (!uid) return { label: fallback ?? '—', kind: null };
  const e = idx.get(uid);
  return { label: e?.slug ?? e?.title ?? fallback ?? `${uid.slice(0, 6)}…`, kind: e?.kind ?? null };
}

export function ConfigLink({ uid, slug, kind: kindHint, icon = true, className }: { uid: string | null | undefined; slug?: string | null; kind?: string; icon?: boolean; className?: string }) {
  const { label, kind } = useConfigLabel(uid, slug);
  if (!uid) return <span className="text-fg-subtle">—</span>;
  const k = kind ?? kindHint ?? 'circuit';
  const to = configEditorPath(k, uid) ?? `/config/${uid}`;
  return (
    <Link to={to} onClick={(e) => e.stopPropagation()} title={uid} className={cn('inline-flex min-w-0 items-center gap-1 font-mono text-[12.5px] text-fg hover:text-accent-text hover:underline', className)}>
      {icon && <ConfigKindIcon kind={k} className="text-fg-subtle" />}
      <span className="truncate">{label}</span>
    </Link>
  );
}
