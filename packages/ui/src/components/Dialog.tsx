import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button, IconButton, type ButtonVariant } from './Button';
import { cn } from './cn';

interface BaseProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * Shows a native `<dialog>` modally while `open`; render its content only when `shown`. Content mounts
 * after showModal(): React applies `autoFocus` by calling focus() as the element mounts, which is a
 * no-op inside a still-closed dialog, and showModal() would then focus the first focusable element
 * (the header Close button). Without an autoFocus target, focus goes there anyway, as showModal() would.
 */
export function useModalDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  const [modal, setModal] = useState(false);
  useLayoutEffect(() => {
    const d = ref.current;
    if (d && open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    } else if (d && !open && d.open) d.close();
    setModal(open);
  }, [open]);
  useLayoutEffect(() => {
    const d = ref.current;
    if (!modal || !d) return;
    const active = document.activeElement;
    if (active && active !== d && d.contains(active)) return;
    d.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [modal]);
  return { ref, shown: open && modal };
}

/** Native `<dialog>` modal: focus trap, Esc, top layer for free. Backdrop click closes. */
function useNativeDialog(open: boolean, onClose: () => void) {
  const { ref, shown } = useModalDialog(open);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      closeRef.current();
    };
    d.addEventListener('cancel', onCancel);
    return () => d.removeEventListener('cancel', onCancel);
  }, []);
  const onBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) closeRef.current();
  };
  return { ref, shown, onBackdrop };
}

export interface DialogProps extends BaseProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

export function Dialog({ open, onClose, title, description, children, footer, className, size = 'md' }: DialogProps) {
  const { ref, shown, onBackdrop } = useNativeDialog(open, onClose);
  const w = { sm: 'w-[min(420px,calc(100vw-2rem))]', md: 'w-[min(540px,calc(100vw-2rem))]', lg: 'w-[min(760px,calc(100vw-2rem))]', xl: 'w-[min(1040px,calc(100vw-2rem))]' }[size];
  return (
    <dialog ref={ref} onMouseDown={onBackdrop} className={cn('m-auto max-h-[calc(100dvh-4rem)] overflow-hidden rounded-xl border border-line bg-surface p-0 text-fg shadow-pop backdrop:backdrop-blur-[1px]', w, className)}>
      {shown && (
        <div className="flex max-h-[calc(100dvh-4rem)] flex-col">
          {(title || description) && (
            <header className="flex items-start gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0 flex-1">
                {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
                {description && <p className="mt-1 text-[13px] text-fg-muted">{description}</p>}
              </div>
              <IconButton label="Close" onClick={onClose} className="-mr-1.5 -mt-1">
                <X size={16} />
              </IconButton>
            </header>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex items-center justify-end gap-2 border-t border-line bg-sunken px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export interface DrawerProps extends BaseProps {
  width?: 'md' | 'lg' | 'xl';
  /** Extra controls placed in the header next to the close button. */
  actions?: ReactNode;
}

/** Right-side panel (modal). */
export function Drawer({ open, onClose, title, description, children, footer, className, width = 'lg', actions }: DrawerProps) {
  const { ref, shown, onBackdrop } = useNativeDialog(open, onClose);
  const w = { md: 'w-[min(480px,100vw)]', lg: 'w-[min(720px,100vw)]', xl: 'w-[min(1000px,100vw)]' }[width];
  return (
    <dialog
      ref={ref}
      onMouseDown={onBackdrop}
      className={cn('fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh max-w-none border-l border-line bg-surface p-0 text-fg shadow-pop', w, className)}
    >
      {shown && (
        <div className="flex h-full flex-col">
          <header className="flex items-start gap-3 border-b border-line px-5 py-3.5">
            <div className="min-w-0 flex-1">
              {title && <h2 className="truncate text-[15px] font-semibold">{title}</h2>}
              {description && <div className="mt-0.5 text-[13px] text-fg-muted">{description}</div>}
            </div>
            {actions}
            <IconButton label="Close panel" onClick={onClose} className="-mr-1.5">
              <X size={16} />
            </IconButton>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer && <footer className="flex items-center justify-end gap-2 border-t border-line bg-sunken px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<unknown>;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ButtonVariant;
  loading?: boolean;
  /** Disable confirm (e.g. invalid form inside). */
  confirmDisabled?: boolean;
}

export function ConfirmDialog({ open, onClose, onConfirm, title, description, children, confirmLabel = 'Confirm', cancelLabel = 'Cancel', variant = 'primary', loading, confirmDisabled }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {children}
        <div className="-mx-5 -mb-4 flex justify-end gap-2 border-t border-line bg-sunken px-5 py-3">
          <Button onClick={onClose} variant="ghost">
            {cancelLabel}
          </Button>
          <Button type="submit" variant={variant} loading={loading || busy} disabled={confirmDisabled} autoFocus={!children}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
