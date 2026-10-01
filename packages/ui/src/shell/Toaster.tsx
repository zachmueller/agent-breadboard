import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { createPortal } from 'react-dom';
import { cn } from '../components/cn';
import { dismissToast, useToasts } from '../lib/toast';

const ICON = {
  info: <Info size={16} className="text-accent-text" aria-hidden />,
  success: <CheckCircle2 size={16} className="text-ok-fg" aria-hidden />,
  warning: <AlertTriangle size={16} className="text-warn-fg" aria-hidden />,
  error: <XCircle size={16} className="text-danger-fg" aria-hidden />,
};

export function Toaster() {
  const items = useToasts();
  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[1100] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite" role="region" aria-label="Notifications">
      {items.map((t) => (
        <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} className={cn('pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-surface px-3.5 py-3 shadow-pop', t.kind === 'error' ? 'border-danger/40' : 'border-line')}>
          <span className="mt-0.5">{ICON[t.kind]}</span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-fg">{t.title}</div>
            {t.description && <div className="mt-0.5 break-words text-[12.5px] text-fg-muted">{t.description}</div>}
            {t.action && (
              <button type="button" className="mt-1.5 text-[12.5px] font-medium text-accent-text hover:underline" onClick={() => (t.action!.onClick(), dismissToast(t.id))}>
                {t.action.label}
              </button>
            )}
          </div>
          <button type="button" onClick={() => dismissToast(t.id)} aria-label="Dismiss" className="-mr-1 rounded p-0.5 text-fg-subtle hover:bg-hover hover:text-fg">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
