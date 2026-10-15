/**
 * ⌘K global search ([10] §2): unified over content nodes (`GET /nodes?q=`, FTS) and config
 * definitions (`GET /config/search?q=`), grouped by type / kind. Arrow keys + Enter navigate.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRight, Bot, CornerDownLeft, Search, Server, Workflow, Wrench, FileCode2 } from 'lucide-react';
import { isPrefixedId, isUid, normalizeUid, type NodeDto } from '@breadboard/shared';
import { asPage, get } from '../lib/api';
import { useConfigSearch } from '../lib/queries';
import { configEditorPath } from '../lib/paths';
import { humanize } from '../lib/format';
import { cn } from '../components/cn';
import { Kbd } from '../components/Kbd';
import { NodeTypeIcon } from '../components/NodeChip';
import { Spinner } from '../components/feedback';
import { useAuth } from '../lib/auth';
import { EXTRA_JUMPS, NAV_AREAS } from './nav';

interface Result {
  id: string;
  group: string;
  label: string;
  sublabel?: string;
  icon: ReactNode;
  to: string;
  hint?: string;
}

const NODE_GROUP: Record<string, string> = { task: 'Tasks', artifact: 'Artifacts', knowledge: 'Knowledge notes', comment: 'Comments' };
const CONFIG_GROUP: Record<string, string> = { circuit: 'Circuits', subagent: 'Subagents', tool: 'Tools', mcp: 'MCP servers', rubric: 'Rubrics', fixtures: 'Fixtures' };

function configIcon(kind: string) {
  switch (kind) {
    case 'circuit':
      return <Workflow size={15} aria-hidden />;
    case 'subagent':
      return <Bot size={15} aria-hidden />;
    case 'tool':
      return <Wrench size={15} aria-hidden />;
    case 'mcp':
      return <Server size={15} aria-hidden />;
    default:
      return <FileCode2 size={15} aria-hidden />;
  }
}

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const dq = useDebounced(q.trim(), 180);
  const navigate = useNavigate();
  const { isAdmin } = useAuth();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal?.();
      setQ('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    } else if (!open && d.open) d.close();
  }, [open]);

  const nodesQ = useQuery({
    queryKey: ['palette', 'nodes', dq],
    queryFn: async ({ signal }) => asPage<NodeDto>(await get('/nodes', { q: dq, limit: 24 }, { signal })).items,
    enabled: open && dq.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const configQ = useConfigSearch(dq, open);

  const results = useMemo<Result[]>(() => {
    const out: Result[] = [];
    const ql = dq.toLowerCase();
    if (dq) {
      const maybeUid = normalizeUid(dq);
      if (isUid(maybeUid)) out.push({ id: `uid:${maybeUid}`, group: 'Go to', label: `Open node ${maybeUid}`, icon: <ArrowRight size={15} />, to: `/n/${maybeUid}` });
      if (isPrefixedId(dq, 'ses')) out.push({ id: `ses:${dq}`, group: 'Go to', label: `Open session ${dq}`, icon: <ArrowRight size={15} />, to: `/s/${dq}` });
      if (isPrefixedId(dq, 'prp')) out.push({ id: `prp:${dq}`, group: 'Go to', label: `Review proposal ${dq}`, icon: <ArrowRight size={15} />, to: `/proposals/${dq}` });
    }
    const areas = [...NAV_AREAS.filter((a) => !a.adminOnly || isAdmin).map((a) => ({ label: a.label, to: a.to, jump: a.jump, sub: a.description })), ...EXTRA_JUMPS.map((x) => ({ label: x.label, to: x.to, jump: x.jump, sub: '' }))];
    for (const a of areas) {
      if (!dq || a.label.toLowerCase().includes(ql))
        out.push({ id: `area:${a.to}`, group: dq ? 'Areas' : 'Jump to', label: a.label, sublabel: a.sub, icon: <ArrowRight size={15} />, to: a.to, hint: `g ${a.jump}` });
    }
    if (dq) {
      const nodes = nodesQ.data ?? [];
      const byType = new Map<string, NodeDto[]>();
      for (const n of nodes) byType.set(n.type, [...(byType.get(n.type) ?? []), n]);
      for (const [type, list] of byType)
        for (const n of list.slice(0, 8))
          out.push({ id: `node:${n.uid}`, group: NODE_GROUP[type] ?? humanize(type), label: n.title || n.uid, sublabel: n.tags.slice(0, 3).join(' · '), icon: <NodeTypeIcon type={type} size={15} />, to: `/n/${n.uid}` });
      for (const c of configQ.data ?? []) {
        if (!c.uid) continue;
        out.push({ id: `cfg:${c.kind}:${c.uid}`, group: CONFIG_GROUP[c.kind] ?? humanize(c.kind), label: c.title || c.slug || c.uid, sublabel: c.slug ?? undefined, icon: configIcon(c.kind), to: configEditorPath(c.kind, c.uid) ?? `/config/${c.uid}` });
      }
    }
    return out;
  }, [dq, nodesQ.data, configQ.data, isAdmin]);

  useEffect(() => setActive(0), [dq]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const go = (r: Result | undefined) => {
    if (!r) return;
    onClose();
    navigate({ to: r.to });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[active]);
    }
  };

  const loading = !!dq && (nodesQ.isFetching || configQ.isFetching);
  const groups: Array<{ group: string; items: Array<Result & { index: number }> }> = [];
  results.forEach((r, index) => {
    const g = groups.find((x) => x.group === r.group);
    if (g) g.items.push({ ...r, index });
    else groups.push({ group: r.group, items: [{ ...r, index }] });
  });

  return (
    <dialog
      ref={ref}
      aria-label="Search Breadboard"
      onCancel={(e) => (e.preventDefault(), onClose())}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      className="mx-auto mt-[12vh] w-[min(640px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-surface p-0 text-fg shadow-pop"
    >
      {open && (
        <div className="flex max-h-[min(560px,72vh)] flex-col">
          <div className="flex items-center gap-2.5 border-b border-line px-4">
            <Search size={16} className="shrink-0 text-fg-subtle" aria-hidden />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
              placeholder="Search tasks, artifacts, notes, circuits, subagents, tools…"
              role="combobox"
              aria-expanded
              aria-controls="bb-palette-list"
              aria-activedescendant={results[active] ? `bb-palette-${active}` : undefined}
              className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-fg-subtle"
            />
            {loading && <Spinner size={14} />}
            <Kbd>esc</Kbd>
          </div>
          <div ref={listRef} id="bb-palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {groups.map((g) => (
              <div key={g.group} role="group" aria-label={g.group} className="mb-1">
                <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{g.group}</div>
                {g.items.map((r) => (
                  <div
                    key={r.id}
                    id={`bb-palette-${r.index}`}
                    data-index={r.index}
                    role="option"
                    aria-selected={r.index === active}
                    onMouseMove={() => setActive(r.index)}
                    onClick={() => go(r)}
                    className={cn('flex h-10 cursor-pointer items-center gap-3 rounded-md px-2.5', r.index === active ? 'bg-accent-soft' : '')}
                  >
                    <span className={cn('flex shrink-0', r.index === active ? 'text-accent-text' : 'text-fg-subtle')}>{r.icon}</span>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {r.label}
                      {r.sublabel && <span className="ml-2 text-[12px] text-fg-subtle">{r.sublabel}</span>}
                    </span>
                    {r.hint && <span className="font-mono text-[11px] text-fg-subtle">{r.hint}</span>}
                    {r.index === active && <CornerDownLeft size={13} className="text-fg-subtle" aria-hidden />}
                  </div>
                ))}
              </div>
            ))}
            {dq && !loading && results.filter((r) => r.group !== 'Areas').length === 0 && (
              <div className="px-3 py-8 text-center text-[13px] text-fg-muted">
                No results for <span className="font-medium text-fg">“{dq}”</span>
                {(nodesQ.error || configQ.error) && <div className="mt-1 text-danger-fg">Search failed: {String((nodesQ.error ?? configQ.error) as Error)}</div>}
              </div>
            )}
          </div>
          <div className="flex items-center gap-4 border-t border-line bg-sunken px-4 py-2 text-[11.5px] text-fg-subtle">
            <span className="inline-flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> navigate
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>↵</Kbd> open
            </span>
            <span className="ml-auto">Paste a UID or session id to jump directly</span>
          </div>
        </div>
      )}
    </dialog>
  );
}
