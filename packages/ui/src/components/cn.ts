import clsx, { type ClassValue } from 'clsx';

/** className combinator. */
export function cn(...v: ClassValue[]): string {
  return clsx(v);
}
