import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState, type FocusEvent, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

export interface TooltipProps {
  content: ReactNode;
  /** A single element; it receives aria-describedby and hover/focus handlers. Plain text is wrapped in a span. */
  children: ReactNode;
  side?: 'top' | 'bottom';
  delay?: number;
  className?: string;
  disabled?: boolean;
}

/** Hover/focus tooltip rendered in a portal (never clipped by scroll containers). */
export function Tooltip({ content, children, side = 'top', delay = 250, className, disabled }: TooltipProps) {
  const id = useId();
  const [pos, setPos] = useState<{ x: number; y: number; side: 'top' | 'bottom' } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchor = useRef<HTMLElement | null>(null);

  const show = useCallback(
    (el: HTMLElement) => {
      anchor.current = el;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const r = el.getBoundingClientRect();
        const s = side === 'top' && r.top < 48 ? 'bottom' : side;
        setPos({ x: r.left + r.width / 2, y: s === 'top' ? r.top : r.bottom, side: s });
      }, delay);
    },
    [delay, side],
  );
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setPos(null);
  }, []);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
    };
  }, [pos, hide]);

  if (disabled || content === null || content === undefined || content === '') return <>{children}</>;

  const child = isValidElement(children) ? (children as ReactElement<Record<string, unknown>>) : <span>{children}</span>;
  const handlers = {
    'aria-describedby': pos ? id : undefined,
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      show(e.currentTarget);
      (child.props.onMouseEnter as ((e: unknown) => void) | undefined)?.(e);
    },
    onMouseLeave: (e: MouseEvent<HTMLElement>) => {
      hide();
      (child.props.onMouseLeave as ((e: unknown) => void) | undefined)?.(e);
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      show(e.currentTarget);
      (child.props.onFocus as ((e: unknown) => void) | undefined)?.(e);
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      hide();
      (child.props.onBlur as ((e: unknown) => void) | undefined)?.(e);
    },
  };

  return (
    <>
      {cloneElement(child, handlers)}
      {pos &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            style={{ left: pos.x, top: pos.side === 'top' ? pos.y - 6 : pos.y + 6 }}
            className={cn(
              'pointer-events-none fixed z-[1000] max-w-xs -translate-x-1/2 rounded-md bg-fg px-2 py-1 text-xs leading-snug text-surface shadow-pop',
              pos.side === 'top' ? '-translate-y-full' : '',
              className,
            )}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
