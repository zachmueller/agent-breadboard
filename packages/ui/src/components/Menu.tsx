import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Render a separator before this item. */
  separator?: boolean;
}

export type MenuAnchor = { x: number; y: number } | DOMRect;

export interface MenuPopoverProps {
  open: boolean;
  anchor: MenuAnchor | null;
  items: MenuItem[];
  onClose: () => void;
  align?: 'start' | 'end';
  label?: string;
  /** Element to restore focus to on close. */
  returnFocus?: HTMLElement | null;
}

/** A positioned menu (portal) with keyboard navigation. Use directly for context menus. */
export function MenuPopover({ open, anchor, items, onClose, align = 'start', label, returnFocus }: MenuPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const el = ref.current;
    const w = el?.offsetWidth ?? 200;
    const h = el?.offsetHeight ?? 200;
    let left: number, top: number;
    if ('width' in anchor) {
      left = align === 'end' ? anchor.right - w : anchor.left;
      top = anchor.bottom + 4;
      if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.top - h - 4);
    } else {
      left = anchor.x;
      top = anchor.y;
      if (top + h > window.innerHeight - 8) top = Math.max(8, top - h);
    }
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    setPos({ left, top });
  }, [open, anchor, align]);

  const close = useCallback(() => {
    onClose();
    returnFocus?.focus();
  }, [onClose, returnFocus]);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    setActive(itemsRef.current.findIndex((i) => !i.disabled));
    const t = setTimeout(() => ref.current?.focus(), 0);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    };
    const onScroll = () => onCloseRef.current();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onScroll);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  if (!open || !anchor) return null;

  const move = (dir: 1 | -1) => {
    if (!items.length) return;
    let i = active;
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length;
      if (!items[i]!.disabled) break;
    }
    setActive(i);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const it = items[active];
      if (it && !it.disabled) {
        close();
        it.onSelect?.();
      }
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKey}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      className="fixed z-[900] min-w-48 rounded-lg border border-line bg-surface p-1 text-sm shadow-pop outline-none"
    >
      {items.map((it, i) => (
        <div key={it.key}>
          {it.separator && <div className="my-1 h-px bg-line" role="separator" />}
          <div
            role="menuitem"
            aria-disabled={it.disabled || undefined}
            tabIndex={-1}
            onMouseEnter={() => !it.disabled && setActive(i)}
            onClick={() => {
              if (it.disabled) return;
              close();
              it.onSelect?.();
            }}
            className={cn(
              'flex h-8 items-center gap-2 rounded-md px-2 select-none',
              it.disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
              i === active && !it.disabled && 'bg-hover',
              it.danger ? 'text-danger-fg' : 'text-fg',
            )}
          >
            {it.icon && <span className="flex w-4 shrink-0 justify-center text-fg-subtle">{it.icon}</span>}
            <span className="flex-1 truncate">{it.label}</span>
            {it.hint && <span className="text-xs text-fg-subtle">{it.hint}</span>}
          </div>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export interface MenuProps {
  items: MenuItem[];
  align?: 'start' | 'end';
  label?: string;
  /** Render the trigger; spread the props onto a button. */
  trigger: (props: { onClick: (e: ReactMouseEvent<HTMLElement>) => void; 'aria-haspopup': 'menu'; 'aria-expanded': boolean; ref: (el: HTMLElement | null) => void }) => ReactNode;
}

/** Dropdown menu anchored to a trigger. */
export function Menu({ items, align = 'start', label, trigger }: MenuProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  return (
    <>
      {trigger({
        onClick: (e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect()),
        'aria-haspopup': 'menu',
        'aria-expanded': !!anchor,
        ref: (el) => {
          triggerRef.current = el;
        },
      })}
      <MenuPopover open={!!anchor} anchor={anchor} items={items} onClose={() => setAnchor(null)} align={align} label={label} returnFocus={triggerRef.current} />
    </>
  );
}
