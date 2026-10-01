import { Button } from './Button';

export interface PaginationProps {
  hasMore: boolean;
  loading?: boolean;
  onLoadMore: () => void;
  /** Number of items currently shown. */
  shown?: number;
  className?: string;
}

/** Cursor pagination: a "Load more" affordance plus a count. */
export function Pagination({ hasMore, loading, onLoadMore, shown, className }: PaginationProps) {
  if (!hasMore && shown === undefined) return null;
  return (
    <div className={`flex items-center justify-center gap-3 py-3 text-[13px] text-fg-subtle ${className ?? ''}`}>
      {shown !== undefined && <span className="tabular">{shown.toLocaleString()} shown</span>}
      {hasMore && (
        <Button size="sm" onClick={onLoadMore} loading={loading}>
          Load more
        </Button>
      )}
    </div>
  );
}
