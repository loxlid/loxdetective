interface Props {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  /** Number of rows loaded so far. */
  count?: number;
  /** Backend that served the data, shown as provenance. */
  source?: string;
  label?: string;
  className?: string;
}

/** Cursor-based "Load more" footer with row count and provenance. */
export default function LoadMore({ hasMore, loading, onLoadMore, count, source, label = 'Load more', className }: Props) {
  return (
    <div className={`load-more${className ? ` ${className}` : ''}`}>
      <span className="load-more__meta muted">
        {count !== undefined && `${count.toLocaleString('en-US')} row${count === 1 ? '' : 's'}`}
        {count !== undefined && source && ' · '}
        {source && (
          <>
            via <span className="mono">{source}</span>
          </>
        )}
      </span>
      {hasMore ? (
        <button type="button" className="btn btn--sm" onClick={onLoadMore} disabled={loading}>
          {loading ? 'Loading…' : label}
        </button>
      ) : (
        count !== undefined && count > 0 && <span className="muted">End of results</span>
      )}
    </div>
  );
}

/** Spec name for the cursor pager. */
export { LoadMore as Pagination };
