import type { ReactNode } from 'react';
import { cn } from './cn';

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  /** Small line above the title (breadcrumbs, kind label). */
  eyebrow?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, icon, eyebrow, actions, children, className }: PageHeaderProps) {
  return (
    <header className={cn('border-b border-line bg-surface px-6 pt-5 pb-4', className)}>
      {eyebrow && <div className="mb-1 flex items-center gap-1.5 text-xs text-fg-subtle">{eyebrow}</div>}
      <div className="flex items-start gap-3">
        {icon && <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-fg-muted">{icon}</div>}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold leading-tight tracking-[-0.01em] text-fg">{title}</h1>
          {subtitle && <div className="mt-1 text-[13px] text-fg-muted">{subtitle}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </header>
  );
}

/** Bordered surface section with an optional header row. */
export function Panel({ title, actions, children, className, bodyClassName, description, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; description?: ReactNode; id?: string }) {
  return (
    <section id={id} className={cn('rounded-lg border border-line bg-surface', className)}>
      {(title || actions) && (
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-[13px] font-semibold text-fg">{title}</h2>}
            {description && <p className="text-xs text-fg-subtle">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/** Scrollable page body container with consistent padding. */
export function PageBody({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={cn('mx-auto w-full px-6 py-5', wide ? 'max-w-none' : 'max-w-[1400px]', className)}>{children}</div>;
}

/** Definition-list row used in headers/detail panels. */
export function MetaList({ items, className }: { items: Array<{ label: ReactNode; value: ReactNode } | null | false | undefined>; className?: string }) {
  return (
    <dl className={cn('flex flex-wrap gap-x-6 gap-y-2 text-[13px]', className)}>
      {items.filter(Boolean).map((it, i) => (
        <div key={i} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">{(it as { label: ReactNode }).label}</dt>
          <dd className="flex min-h-5 items-center gap-1 text-fg">{(it as { value: ReactNode }).value}</dd>
        </div>
      ))}
    </dl>
  );
}
