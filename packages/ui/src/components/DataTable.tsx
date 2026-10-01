import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from './cn';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Enables sorting on this column. */
  sortValue?: (row: T) => string | number | null | undefined;
  width?: string;
  align?: 'left' | 'right' | 'center';
  className?: string;
  /** Hide on narrow screens. */
  hideBelow?: 'md' | 'lg' | 'xl';
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  /** Rendered in place of the body when there are no rows. */
  empty?: ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  className?: string;
  /** Constrain height and scroll inside (header stays sticky). */
  maxHeight?: string;
  dense?: boolean;
  caption?: string;
}

const HIDE = { md: 'hidden md:table-cell', lg: 'hidden lg:table-cell', xl: 'hidden xl:table-cell' } as const;

/** Sortable table with a sticky header. Sorting applies to loaded rows. */
export function DataTable<T>({ columns, rows, rowKey, onRowClick, rowClassName, empty, initialSort, className, maxHeight, dense, caption }: DataTableProps<T>) {
  const [sort, setSort] = useState(initialSort ?? null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const sv = col.sortValue;
    return [...rows].sort((a, b) => {
      const x = sv(a);
      const y = sv(b);
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.dir === 'asc' ? r : -r;
    });
  }, [rows, sort, columns]);

  const toggle = (key: string) => setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));
  const onKey = (e: KeyboardEvent, row: T) => {
    if (e.key === 'Enter' && onRowClick && e.target === e.currentTarget) onRowClick(row);
  };

  return (
    <div className={cn('overflow-auto rounded-lg border border-line bg-surface', className)} style={{ maxHeight }}>
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  style={{ width: c.width }}
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cn(
                    'sticky top-0 z-[1] border-b border-line bg-sunken px-3 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle whitespace-nowrap',
                    dense ? 'h-8' : 'h-9',
                    c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                    c.hideBelow && HIDE[c.hideBelow],
                  )}
                >
                  {c.sortValue ? (
                    <button type="button" onClick={() => toggle(c.key)} className={cn('inline-flex items-center gap-1 uppercase hover:text-fg', active && 'text-fg')}>
                      {c.header}
                      {active ? sort!.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} /> : <ChevronsUpDown size={11} className="opacity-50" />}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>{empty}</td>
            </tr>
          ) : (
            sorted.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? (e) => !(e.target as HTMLElement).closest('a,button,input,select,[role=menu]') && onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (e) => onKey(e, row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                // Inset ring: the scroll container would clip an outset one.
                className={cn('group', onRowClick && 'cursor-pointer hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus', rowClassName?.(row))}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      'border-b border-line px-3 align-middle group-last:border-b-0',
                      dense ? 'py-1.5' : 'py-2',
                      c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                      c.hideBelow && HIDE[c.hideBelow],
                      c.className,
                    )}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
