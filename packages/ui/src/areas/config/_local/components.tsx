/**
 * Minimal local UI primitives for the config-plane editors. Used as fallbacks for shell
 * components (`src/components`) and for editor-specific widgets the shell doesn't provide.
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X, Loader2, AlertTriangle } from 'lucide-react';
import { useModalDialog } from '../../../components/Dialog';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Btn({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; icon?: ReactNode; loading?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-3 text-sm',
        variant === 'primary' && 'border-transparent bg-accent text-accent-fg hover:bg-accent-hover',
        variant === 'secondary' && 'border-line bg-surface text-fg hover:bg-hover',
        variant === 'ghost' && 'border-transparent bg-transparent text-fg-muted hover:bg-hover hover:text-fg',
        variant === 'danger' && 'border-transparent bg-danger text-white hover:opacity-90',
        className,
      )}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
}

const fieldCls = 'w-full rounded-md border border-line bg-surface px-2 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none disabled:opacity-60';

export function TextInput({ invalid, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...rest} className={clsx(fieldCls, 'h-8', invalid && 'border-danger', className)} />;
}

export function SelectInput({ invalid, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select {...rest} className={clsx(fieldCls, 'h-8 pr-6', invalid && 'border-danger', className)}>
      {children}
    </select>
  );
}

export function TextAreaInput({ invalid, className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea {...rest} className={clsx(fieldCls, 'py-1.5', invalid && 'border-danger', className)} />;
}

export type Tone = 'neutral' | 'ok' | 'danger' | 'warn' | 'info' | 'accent';
const toneCls: Record<Tone, string> = {
  neutral: 'bg-raised text-fg-muted',
  ok: 'bg-ok-soft text-ok-fg',
  danger: 'bg-danger-soft text-danger-fg',
  warn: 'bg-warn-soft text-warn-fg',
  info: 'bg-info-soft text-info-fg',
  accent: 'bg-accent-soft text-accent-text',
};

export function Pill({ tone = 'neutral', className, children, title }: { tone?: Tone; className?: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={clsx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap', toneCls[tone], className)}>
      {children}
    </span>
  );
}

export function Spin({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-4 animate-spin text-fg-subtle', className)} />;
}

export function TabBar<T extends string>({ tabs, value, onChange, className }: { tabs: Array<{ id: T; label: ReactNode }>; value: T; onChange: (id: T) => void; className?: string }) {
  return (
    <div role="tablist" className={clsx('flex items-end gap-1 border-b border-line', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={t.id === value}
          onClick={() => onChange(t.id)}
          className={clsx(
            '-mb-px border-b-2 px-3 py-1.5 text-sm',
            t.id === value ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-muted hover:text-fg',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  // Content mounts once the dialog is modal, so a field's `autoFocus` takes effect (see useModalDialog).
  const { ref, shown } = useModalDialog(open);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={clsx('m-auto rounded-lg border border-line bg-surface p-0 text-fg shadow-pop', wide ? 'w-[min(960px,92vw)]' : 'w-[min(520px,92vw)]')}
    >
      {shown && (
        <>
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h2 className="text-sm font-semibold">{title}</h2>
            <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-fg-subtle hover:bg-hover">
              <X className="size-4" />
            </button>
          </div>
          <div className="max-h-[70vh] overflow-auto px-4 py-3">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-2.5">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function Confirm({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Btn onClick={onCancel}>Cancel</Btn>
          <Btn variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Btn>
        </>
      }
    >
      <div className="text-sm text-fg-muted">{message}</div>
    </Modal>
  );
}

export function SideDrawer({ open, onClose, title, children, width = 560 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside style={{ width }} className="flex h-full max-w-[95vw] flex-col border-l border-line bg-surface shadow-pop">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-fg-subtle hover:bg-hover">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
      </aside>
    </div>
  );
}

export function Empty({ title, hint, action }: { title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="text-sm font-medium text-fg">{title}</div>
      {hint && <div className="max-w-md text-xs text-fg-muted">{hint}</div>}
      {action}
    </div>
  );
}

export function errorMessage(error: unknown): string {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  const e = error as any;
  return e?.message ?? e?.error?.message ?? String(error);
}

export function ErrorBox({ error, onRetry, title = 'Something went wrong' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div className="m-3 flex items-start gap-2 rounded-md border border-danger/40 bg-danger-soft p-3 text-sm text-danger-fg">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        <div className="break-words text-xs">{errorMessage(error)}</div>
      </div>
      {onRetry && (
        <Btn size="sm" onClick={onRetry}>
          Retry
        </Btn>
      )}
    </div>
  );
}

export function Header({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line bg-surface px-5 py-3">
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold">{title}</h1>
        {subtitle && <div className="text-xs text-fg-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Md({ source, className }: { source: string; className?: string }) {
  return (
    <div className={clsx('bb-prose bb-prose-sm', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  );
}

export function Json({ value, className }: { value: unknown; className?: string }) {
  return <pre className={clsx('overflow-auto rounded-md border border-line bg-sunken p-2 font-mono text-xs', className)}>{JSON.stringify(value, null, 2)}</pre>;
}

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block space-y-1', className)}>
      <span className="block text-xs font-medium text-fg-muted">{label}</span>
      {children}
      {hint && !error && <span className="block text-[11px] text-fg-subtle">{hint}</span>}
      {error && <span className="block text-[11px] text-danger-fg">{error}</span>}
    </label>
  );
}

export function Section({ title, actions, children, className }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('space-y-2 border-b border-line px-3 py-3 last:border-b-0', className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}
