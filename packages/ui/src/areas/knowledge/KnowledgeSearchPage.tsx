/** Knowledge search ([07] §9–§10): text / semantic / hybrid search over Notes, preview drawer, new note. */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, ExternalLink, Library, Plug, Plus } from 'lucide-react';
import type { NodeDto } from '@breadboard/shared';
import { asPage, get, post } from '../../lib/api';
import { qk, useNode, useNodeMarkdown, useNodes } from '../../lib/queries';
import { useUrlSearch } from '../../lib/url';
import { toast } from '../../lib/toast';
import { humanize } from '../../lib/format';
import {
  Badge,
  Button,
  buttonClasses,
  cn,
  Dialog,
  Drawer,
  EmptyState,
  ErrorState,
  FilterBar,
  Input,
  Loading,
  Markdown,
  PageBody,
  PageHeader,
  Pagination,
  TagChip,
  TimeAgo,
  type FilterDef,
} from '../../components';
import { useKnowledgeDomains } from './editor/PropertiesPanel';
import { asSearchMode, connectorInfo, filterHitsByTag, formatScore, SEARCH_MODES, type KnowledgeHit } from './lib';

type Search = { q?: string; mode?: string; domain?: string; tag?: string; preview?: string };

const MODE_HELP: Record<string, string> = {
  hybrid: 'Keyword and meaning, fused',
  text: 'Exact keywords (full-text)',
  semantic: 'Similar meaning (embeddings)',
};

/** A row in the result list: either a search hit or a recent note (no score). */
interface Row {
  uid: string;
  title: string;
  snippet: string;
  domains: string[];
  tags: string[];
  score: number | null;
  source: string | null;
  updated_at?: string;
}

function noteRow(n: NodeDto): Row {
  const domains = Array.isArray(n.properties?.domains) ? (n.properties.domains as unknown[]).filter((d): d is string => typeof d === 'string') : [];
  const text = (n.body_text ?? '').replace(/\s+/g, ' ').trim();
  return { uid: n.uid, title: n.title, snippet: text.slice(0, 280), domains, tags: n.tags, score: null, source: null, updated_at: n.updated_at };
}

export function KnowledgeSearchPage() {
  const [search, setSearch] = useUrlSearch<Search>();
  const navigate = useNavigate();
  const domains = useKnowledgeDomains();
  const [creating, setCreating] = useState(false);

  const q = (search.q ?? '').trim();
  const mode = asSearchMode(search.mode);

  const hits = useQuery({
    queryKey: ['knowledge', 'search', { q, mode, domain: search.domain ?? null }],
    queryFn: async ({ signal }) => asPage<KnowledgeHit>(await get('/knowledge/search', { q, mode, domain: search.domain, limit: 30 }, { signal })).items,
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
  });
  // No query: browse the most recent notes instead (domain filtering applies client-side there too).
  const recent = useNodes({ type: 'knowledge' }, { enabled: q.length === 0, limit: 30 });

  const rows: Row[] = useMemo(() => {
    if (q) return filterHitsByTag((hits.data ?? []).map((h) => ({ ...h, score: h.score, source: h.source })), search.tag);
    const list = (recent.items as NodeDto[]).map(noteRow).filter((r) => !search.domain || r.domains.includes(search.domain));
    return filterHitsByTag(list, search.tag);
  }, [q, hits.data, recent.items, search.domain, search.tag]);

  const pending = q ? hits.isPending : recent.isPending;
  const error = q ? hits.error : recent.error;
  const retry = () => (q ? hits.refetch() : recent.refetch());

  const filters: FilterDef[] = [
    { key: 'mode', label: 'Mode', type: 'select', options: SEARCH_MODES.filter((m) => m !== 'hybrid').map((m) => ({ value: m, label: humanize(m) })), allLabel: 'Hybrid' },
    { key: 'domain', label: 'Domain', type: 'select', options: (domains.data ?? []).map((d) => ({ value: d.slug, label: d.note_count != null ? `${d.slug} (${d.note_count})` : d.slug })) },
    { key: 'tag', label: 'Tag', type: 'text', placeholder: 'e.g. connector:', mono: true },
  ];

  return (
    <>
      <PageHeader
        icon={<Library size={16} />}
        title="Knowledge"
        subtitle="Durable, curated context the AI draws on — organized into domains, edited live by people and agents."
        actions={
          <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
            New note
          </Button>
        }
      >
        <FilterBar
          filters={filters}
          value={{ q: search.q, mode: mode === 'hybrid' ? undefined : mode, domain: search.domain, tag: search.tag }}
          search={{ placeholder: 'Search notes…' }}
          onChange={(v) => setSearch({ q: v.q, mode: v.mode, domain: v.domain, tag: v.tag })}
          trailing={q ? <span className="text-[12px] text-fg-subtle">{MODE_HELP[mode]}</span> : undefined}
        />
      </PageHeader>
      <PageBody>
        {pending ? (
          <Loading label={q ? 'Searching…' : 'Loading notes…'} />
        ) : error ? (
          <ErrorState error={error} title={q ? 'Search failed' : 'Couldn’t load notes'} onRetry={retry} />
        ) : rows.length === 0 ? (
          q || search.domain || search.tag ? (
            <EmptyState icon={<BookOpen size={20} />} title="No matching notes" description={q && mode === 'text' ? 'Try hybrid or semantic mode to match by meaning.' : 'Try another query or clear a filter.'} />
          ) : (
            <EmptyState
              icon={<BookOpen size={20} />}
              title="No notes yet"
              description="Knowledge Notes hold the context your Subagents read: conventions, decisions, how-tos."
              action={
                <Button size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
                  New note
                </Button>
              }
            />
          )
        ) : (
          <>
            <div className="mb-2 text-[12px] text-fg-subtle" aria-live="polite">
              {q ? `${rows.length} result${rows.length === 1 ? '' : 's'}` : 'Recently updated'}
            </div>
            <ul className="flex flex-col gap-2" aria-label={q ? 'Search results' : 'Recent notes'}>
              {rows.map((r) => (
                <li key={r.uid}>
                  <ResultCard row={r} active={search.preview === r.uid} onPreview={() => setSearch({ preview: r.uid }, { replace: false })} onDomain={(d) => setSearch({ domain: d })} />
                </li>
              ))}
            </ul>
            {!q && <Pagination hasMore={!!recent.hasNextPage} loading={recent.isFetchingNextPage} onLoadMore={() => recent.fetchNextPage()} shown={rows.length} className="mt-3" />}
          </>
        )}
      </PageBody>

      <PreviewDrawer uid={search.preview ?? null} onClose={() => setSearch({ preview: undefined })} onOpen={(uid) => navigate({ to: '/knowledge/$uid', params: { uid } })} />
      <NewNoteDialog open={creating} onClose={() => setCreating(false)} defaultDomain={search.domain} />
    </>
  );
}

function ResultCard({ row, active, onPreview, onDomain }: { row: Row; active: boolean; onPreview: () => void; onDomain: (d: string) => void }) {
  const conn = connectorInfo(row.tags);
  const plainTags = row.tags.filter((t) => !t.startsWith('connector:') && t !== 'read-only');
  return (
    <article className={cn('group rounded-lg border bg-surface p-3 transition-colors hover:border-line-strong', active ? 'border-accent' : 'border-line')}>
      <div className="flex items-start gap-2">
        <button type="button" onClick={onPreview} className="min-w-0 flex-1 rounded text-left focus-visible:outline-2 focus-visible:outline-focus">
          <h2 className="truncate text-[14px] font-semibold text-fg group-hover:text-accent-text">{row.title || <span className="italic text-fg-subtle">Untitled</span>}</h2>
          {row.snippet ? <p className="mt-1 line-clamp-2 text-[13px] text-fg-muted">{row.snippet}</p> : <p className="mt-1 text-[13px] text-fg-subtle italic">Empty note</p>}
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {row.score !== null && (
            <Badge size="xs" mono title={`Relevance score (${row.source ?? 'search'})`}>
              {formatScore(row.score)}
            </Badge>
          )}
          <Link to="/knowledge/$uid" params={{ uid: row.uid }} className={buttonClasses('ghost', 'xs')} aria-label={`Open ${row.title || 'note'}`}>
            Open
          </Link>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {conn.isConnector && (
          <Badge size="xs" tone="info" icon={<Plug size={11} />} title="Synced from a connector; read-only here">
            connector
          </Badge>
        )}
        {row.domains.map((d) => (
          <button key={d} type="button" onClick={() => onDomain(d)} className="rounded focus-visible:outline-2 focus-visible:outline-focus" title={`Filter to ${d}`}>
            <Badge size="xs" tone="accent">
              {d}
            </Badge>
          </button>
        ))}
        {plainTags.slice(0, 4).map((t) => (
          <TagChip key={t} tag={t} />
        ))}
        {plainTags.length > 4 && <span className="text-[12px] text-fg-subtle">+{plainTags.length - 4}</span>}
        {row.updated_at && <TimeAgo at={row.updated_at} className="ml-auto text-[12px] text-fg-subtle" />}
      </div>
    </article>
  );
}

function PreviewDrawer({ uid, onClose, onOpen }: { uid: string | null; onClose: () => void; onOpen: (uid: string) => void }) {
  const node = useNode(uid);
  const md = useNodeMarkdown(uid ?? '', !!uid);
  const conn = connectorInfo(node.data?.tags);
  return (
    <Drawer
      open={!!uid}
      onClose={onClose}
      title={node.data?.title || 'Note'}
      description={conn.isConnector ? 'Synced from a connector' : undefined}
      width="lg"
      footer={
        uid && (
          <div className="flex justify-end gap-2">
            <Link to="/n/$uid" params={{ uid }} className={buttonClasses('ghost', 'sm')}>
              <ExternalLink size={14} aria-hidden /> Content viewer
            </Link>
            <Button size="sm" onClick={() => onOpen(uid)}>
              Open in editor
            </Button>
          </div>
        )
      }
    >
      {md.isPending ? (
        <Loading label="Loading preview…" />
      ) : md.error ? (
        <ErrorState error={md.error} onRetry={() => md.refetch()} compact />
      ) : md.data?.markdown.trim() ? (
        <Markdown source={md.data.markdown} />
      ) : (
        <p className="text-sm text-fg-subtle">This note is empty.</p>
      )}
    </Drawer>
  );
}

function NewNoteDialog({ open, onClose, defaultDomain }: { open: boolean; onClose: () => void; defaultDomain?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const domains = useKnowledgeDomains();
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setTitle('');
      setPicked(defaultDomain ? [defaultDomain] : []);
    }
  }
  const toggle = (slug: string) => setPicked((p) => (p.includes(slug) ? p.filter((x) => x !== slug) : [...p, slug]));
  const submit = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const created = await post<NodeDto>('/knowledge', { title: t, domains: picked }, { idempotencyKey: true });
      qc.setQueryData(qk.node(created.uid), created);
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      void qc.invalidateQueries({ queryKey: ['knowledge'] });
      onClose();
      navigate({ to: '/knowledge/$uid', params: { uid: created.uid } });
    } catch (e) {
      toast.error('Couldn’t create the note', e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New knowledge note"
      description="Notes are live-collaborative Markdown. Domains scope which Subagents and Circuits can read it."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" loading={busy} disabled={!title.trim()} onClick={() => void submit()}>
            Create note
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input label="Title" required autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Release checklist" />
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-fg">Domains</legend>
          {domains.isPending ? (
            <Loading label="Loading domains…" className="py-2" />
          ) : (domains.data ?? []).length === 0 ? (
            <p className="text-[12.5px] text-fg-subtle">No domains defined yet. You can add domains later in the note’s properties.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {(domains.data ?? []).map((d) => {
                const on = picked.includes(d.slug);
                return (
                  <button
                    key={d.slug}
                    type="button"
                    aria-pressed={on}
                    title={d.description}
                    onClick={() => toggle(d.slug)}
                    className={cn(
                      'h-7 rounded-md border px-2.5 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-focus',
                      on ? 'border-accent/50 bg-accent-soft text-accent-text' : 'border-line-strong bg-surface text-fg-muted hover:bg-hover',
                    )}
                  >
                    {d.slug}
                  </button>
                );
              })}
            </div>
          )}
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
