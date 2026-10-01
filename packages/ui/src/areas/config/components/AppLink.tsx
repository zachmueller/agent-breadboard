/** Router-agnostic in-app link: works regardless of how the shell typed its route tree. */
import type { MouseEvent, ReactNode } from 'react';
import { useRouter } from '@tanstack/react-router';
import clsx from 'clsx';

export function useGo() {
  const router = useRouter();
  return (href: string) => router.history.push(href);
}

export function AppLink({ href, children, className, title }: { href: string | null | undefined; children: ReactNode; className?: string; title?: string }) {
  const router = useRouter();
  if (!href) return <span className={className}>{children}</span>;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    router.history.push(href);
  };
  return (
    <a href={href} onClick={onClick} title={title} className={clsx('text-accent-text hover:underline', className)}>
      {children}
    </a>
  );
}
