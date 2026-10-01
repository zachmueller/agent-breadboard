import { useState, type MouseEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, Box, ChevronDown, Copy, ExternalLink, FileText, GitFork, History, ListTodo, MessageSquare, PencilLine } from 'lucide-react';
import type { LineageDto } from '@breadboard/shared';
import { get, isApiError } from '../lib/api';
import { qk, useNode } from '../lib/queries';
import { toast } from '../lib/toast';
import { cn } from './cn';
import { MenuPopover, type MenuAnchor, type MenuItem } from './Menu';

export function NodeTypeIcon({ type, size = 13, className }: { type: string | null | undefined; size?: number; className?: string }) {
  const p = { size, className: cn('shrink-0', className), 'aria-hidden': true } as const;
  switch (type) {
    case 'task':
      return <ListTodo {...p} />;
    case 'artifact':
      return <FileText {...p} />;
    case 'comment':
      return <MessageSquare {...p} />;
    case 'knowledge':
      return <BookOpen {...p} />;
    default:
      return <Box {...p} />;
  }
}

export interface NodeChipProps {
  uid: string;
  title?: string | null;
  type?: string | null;
  /** Pinned revision (shown as `@r3`). */
  revision?: number | null;
  size?: 'sm' | 'md';
  /** Show the context-menu chevron (right-click always works). Default true. */
  menu?: boolean;
  className?: string;
  /** Max width class for the title (default `max-w-[22rem]`). */
  maxWidth?: string;
}

/** Find the session (and step) that produced/updated a node, via one level of upward lineage. */
export function producingSession(lineage: LineageDto, uid: string): { session_id: string; step_id: string | null } | null {
  const e = lineage.edges.find((x) => (x.type === 'produces' || x.type === 'updates') && x.dst_uid === uid && x.src_session_id);
  if (e) return { session_id: e.src_session_id!, step_id: e.src_step_id };
  const s = lineage.sessions[0];
  return s ? { session_id: s.session_id, step_id: null } : null;
}

/**
 * Type icon + title chip for any content node ([10] §5). Context menu (right-click or chevron):
 * open, view lineage, view producing session (lazy `lineage?direction=up&depth=1`), copy.
 */
export function NodeChip({ uid, title, type, revision, size = 'sm', menu = true, className, maxWidth = 'max-w-[22rem]' }: NodeChipProps) {
  const needsFetch = !title || !type;
  const q = useNode(uid, { enabled: needsFetch, retry: false, staleTime: 5 * 60_000 });
  const broken = needsFetch && isApiError(q.error) && (q.error.isNotFound || q.error.isForbidden);
  const t = type ?? q.data?.type ?? null;
  const label = title || q.data?.title || (q.isPending && needsFetch ? '…' : uid);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const goProducing = async () => {
    try {
      const lin = await qc.fetchQuery({ queryKey: qk.lineage(uid, 'up', 1), queryFn: () => get<LineageDto>(`/nodes/${uid}/lineage`, { direction: 'up', depth: 1 }), staleTime: 30_000 });
      const s = producingSession(lin, uid);
      if (!s) return toast.info('No producing session', 'This node wasn’t produced by a circuit step (e.g. user-authored).');
      navigate({ to: '/s/$id', params: { id: s.session_id }, search: (s.step_id ? { step: s.step_id } : {}) as never });
    } catch (e) {
      toast.error('Couldn’t load lineage', e);
    }
  };

  const items: MenuItem[] = [
    { key: 'open', label: 'Open', icon: <ExternalLink size={14} />, onSelect: () => navigate({ to: '/n/$uid', params: { uid } }) },
    ...(t === 'knowledge' ? [{ key: 'edit', label: 'Open in editor', icon: <PencilLine size={14} />, onSelect: () => navigate({ to: `/knowledge/${uid}` }) }] : []),
    { key: 'lineage', label: 'View lineage', icon: <GitFork size={14} />, onSelect: () => navigate({ to: '/n/$uid', params: { uid }, search: { panel: 'lineage' } as never }) },
    { key: 'session', label: 'View producing session', icon: <History size={14} />, onSelect: () => void goProducing() },
    { key: 'copy', label: 'Copy UID', icon: <Copy size={14} />, separator: true, onSelect: () => void navigator.clipboard?.writeText(uid) },
    { key: 'copy-link', label: 'Copy link', icon: <Copy size={14} />, onSelect: () => void navigator.clipboard?.writeText(`${location.origin}/n/${uid}`) },
  ];

  const onContext = (e: MouseEvent) => {
    e.preventDefault();
    setAnchor({ x: e.clientX, y: e.clientY });
  };

  return (
    <span
      onContextMenu={onContext}
      className={cn(
        'group/chip inline-flex max-w-full items-center rounded-md border align-middle',
        broken ? 'border-danger/40 bg-danger-soft text-danger-fg' : 'border-line bg-surface text-fg hover:border-line-strong',
        size === 'sm' ? 'h-6 text-[12.5px]' : 'h-7 text-[13px]',
        className,
      )}
    >
      <Link
        to="/n/$uid"
        params={{ uid }}
        className={cn('flex min-w-0 items-center gap-1.5 rounded-l-md pl-1.5 hover:bg-hover', menu ? 'pr-1' : 'pr-1.5 rounded-r-md', broken && 'line-through decoration-dotted')}
        title={broken ? `Unavailable node ${uid}` : `${t ?? 'node'} · ${label}`}
      >
        <NodeTypeIcon type={t} className={broken ? '' : 'text-fg-subtle'} />
        <span className={cn('truncate', maxWidth)}>{label}</span>
        {revision !== null && revision !== undefined && <span className="font-mono text-[11px] text-fg-subtle">@r{revision}</span>}
      </Link>
      {menu && (
        <button
          type="button"
          aria-label={`Actions for ${label}`}
          aria-haspopup="menu"
          onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
          className="flex h-full items-center rounded-r-md border-l border-transparent px-0.5 text-fg-subtle opacity-60 hover:bg-hover hover:text-fg group-hover/chip:border-line group-hover/chip:opacity-100 focus-visible:opacity-100"
        >
          <ChevronDown size={12} aria-hidden />
        </button>
      )}
      <MenuPopover open={!!anchor} anchor={anchor} items={items} onClose={() => setAnchor(null)} label={`Actions for ${label}`} />
    </span>
  );
}
