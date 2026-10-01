import { memo, useMemo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from '@tanstack/react-router';
import { isApiError } from '../lib/api';
import { useNode } from '../lib/queries';
import { BROKEN_LINK_HREF, nodeUidFromHref, transformWikiLinks } from '../lib/wikilinks';
import { cn } from './cn';
import { Tooltip } from './Tooltip';

export interface MarkdownProps {
  source: string | null | undefined;
  className?: string;
  size?: 'sm' | 'md';
  /** Check each `[[UID]]` link target exists (styled broken if not). Default true. */
  resolveLinks?: boolean;
}

/** Markdown renderer (GFM). `[[UID|title]]` links route to `/n/<uid>`; unknown targets are styled broken. */
export const Markdown = memo(function Markdown({ source, className, size = 'md', resolveLinks = true }: MarkdownProps) {
  const text = useMemo(() => transformWikiLinks(source ?? ''), [source]);
  const components = useMemo<Components>(
    () => ({
      a({ href, children, node: _node, ...rest }) {
        const uid = nodeUidFromHref(href);
        if (uid) return <WikiLink uid={uid} resolve={resolveLinks}>{children}</WikiLink>;
        if (href === BROKEN_LINK_HREF)
          return (
            <Tooltip content="Not a Breadboard link: the target is not a node UID">
              <span className="bb-wikilink-broken">{children}</span>
            </Tooltip>
          );
        const external = !!href && /^[a-z]+:/i.test(href);
        return (
          <a href={href} {...rest} {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>
            {children}
          </a>
        );
      },
      input({ node: _node, ...rest }) {
        return <input {...rest} disabled />;
      },
    }),
    [resolveLinks],
  );
  if (!source) return null;
  return (
    <div className={cn('bb-prose', size === 'sm' && 'bb-prose-sm', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

function WikiLink({ uid, resolve, children }: { uid: string; resolve: boolean; children: ReactNode }) {
  const q = useNode(uid, { enabled: resolve, retry: false, staleTime: 5 * 60_000 });
  const broken = resolve && isApiError(q.error) && (q.error.isNotFound || q.error.isForbidden);
  if (broken)
    return (
      <Tooltip content={q.error && isApiError(q.error) && q.error.isForbidden ? 'You can’t see this node' : `No node with UID ${uid}`}>
        <span className="bb-wikilink-broken">{children}</span>
      </Tooltip>
    );
  return (
    <Tooltip content={q.data ? `${q.data.type} · ${q.data.title}` : uid}>
      <Link to="/n/$uid" params={{ uid }} className="bb-wikilink">
        {children}
      </Link>
    </Tooltip>
  );
}
