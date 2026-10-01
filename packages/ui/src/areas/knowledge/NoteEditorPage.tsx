/** Note editor ([07] §10): header metadata + the shared live editor with Properties | Backlinks | Comments | Revisions. */
import { Link } from '@tanstack/react-router';
import { BookOpen, ExternalLink, Plug } from 'lucide-react';
import { useNode } from '../../lib/queries';
import { useUrlSearch } from '../../lib/url';
import { isApiError } from '../../lib/api';
import { asStringArray } from './editor/useYMap';
import { Badge, buttonClasses, ConfigLink, EmptyState, ErrorState, Loading, PageHeader, TagChip } from '../../components';
import { SharedEditor, type SideTab } from './editor/SharedEditor';
import { connectorInfo } from './lib';

const TABS: readonly SideTab[] = ['properties', 'backlinks', 'comments', 'revisions'];
const asTab = (v: string | undefined): SideTab => (TABS as readonly string[]).includes(v ?? '') ? (v as SideTab) : 'properties';

export function NoteEditorPage({ uid }: { uid: string }) {
  const node = useNode(uid);
  const [search, setSearch] = useUrlSearch<{ tab?: string }>();

  if (node.isPending) return <Loading label="Loading note…" className="py-24" />;
  if (node.error) {
    const e = node.error;
    return (
      <ErrorState
        error={e}
        title={isApiError(e) && e.isNotFound ? 'Note not found' : isApiError(e) && e.isForbidden ? 'You don’t have access to this note' : 'Couldn’t load the note'}
        onRetry={() => node.refetch()}
        className="m-6"
      />
    );
  }
  const n = node.data;
  if (n.type !== 'knowledge') {
    return (
      <EmptyState
        icon={<BookOpen size={20} />}
        title="Not a knowledge note"
        description={`This is a ${n.type} node; open it in the content viewer instead.`}
        action={
          <Link to="/n/$uid" params={{ uid }} className={buttonClasses('secondary', 'sm')}>
            Open in content viewer
          </Link>
        }
        className="py-24"
      />
    );
  }
  const conn = connectorInfo(n.tags);
  const domains = asStringArray(n.properties?.domains);
  const tags = n.tags.filter((t) => !t.startsWith('connector:') && t !== 'read-only');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        className="pt-4 pb-3"
        icon={<BookOpen size={16} />}
        eyebrow={
          <>
            <Link to="/knowledge" className="hover:text-fg hover:underline">
              Knowledge
            </Link>
            <span aria-hidden>/</span>
          </>
        }
        title={n.title || 'Untitled note'}
        subtitle={
          <span className="flex flex-wrap items-center gap-1">
            {conn.isConnector && (
              <Badge size="xs" tone="info" icon={<Plug size={11} />}>
                {conn.connectorUid ? (
                  <span className="inline-flex items-center gap-1">
                    connector <ConfigLink uid={conn.connectorUid} kind="connector" icon={false} className="text-[11px]" />
                  </span>
                ) : (
                  'connector · read-only'
                )}
              </Badge>
            )}
            {domains.map((d) => (
              <Link key={d} to="/knowledge" search={{ domain: d } as never} className="rounded focus-visible:outline-2 focus-visible:outline-focus">
                <Badge size="xs" tone="accent">
                  {d}
                </Badge>
              </Link>
            ))}
            {domains.length === 0 && <span className="text-[12px] text-fg-subtle">No domain</span>}
            {tags.map((t) => (
              <TagChip key={t} tag={t} />
            ))}
          </span>
        }
        actions={
          <Link to="/n/$uid" params={{ uid }} className={buttonClasses('ghost', 'sm')}>
            <ExternalLink size={14} aria-hidden /> Content viewer
          </Link>
        }
      />
      <SharedEditor uid={uid} tab={asTab(search.tab)} onTabChange={(t) => setSearch({ tab: t === 'properties' ? undefined : t })} className="min-h-0 flex-1" />
    </div>
  );
}
