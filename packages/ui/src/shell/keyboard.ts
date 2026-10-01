/** Global keyboard shortcuts ([10] §5): ⌘K search, `g`+letter area jumps, `e` open editor, `?` help. */
import { useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { currentEditAction } from '../lib/edit-target';
import { EXTRA_JUMPS, NAV_AREAS } from './nav';

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type);
  }
  return !!el.closest?.('.cm-editor');
}

export interface ShortcutHandlers {
  openPalette: () => void;
  openHelp: () => void;
  isAdmin: boolean;
}

export function useKeyboardShortcuts({ openPalette, openHelp, isAdmin }: ShortcutHandlers) {
  const navigate = useNavigate();
  const pendingG = useRef<number>(0);
  const h = useRef({ openPalette, openHelp, isAdmin });
  h.current = { openPalette, openHelp, isAdmin };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        h.current.openPalette();
        return;
      }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('dialog[open]')) return;
      const k = e.key;
      if (pendingG.current && Date.now() - pendingG.current < 1500) {
        pendingG.current = 0;
        const area = NAV_AREAS.find((a) => a.jump === k && (!a.adminOnly || h.current.isAdmin));
        const extra = EXTRA_JUMPS.find((x) => x.jump === k);
        const to = area?.to ?? extra?.to;
        if (to) {
          e.preventDefault();
          navigate({ to });
        }
        return;
      }
      if (k === 'g') {
        pendingG.current = Date.now();
        return;
      }
      if (k === '/') {
        e.preventDefault();
        h.current.openPalette();
      } else if (k === '?') {
        e.preventDefault();
        h.current.openHelp();
      } else if (k === 'e') {
        const a = currentEditAction();
        if (a) {
          e.preventDefault();
          a.run();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
}

export { useKeyboardShortcuts as default };
