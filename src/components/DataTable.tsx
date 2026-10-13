import type { ReactNode } from 'react';
import { downloadCsv, rowsToCsv, type CsvColumn } from '@/lib/export';
import EmptyState from './EmptyState';
import ErrorBox from './ErrorBox';
import Spinner from './Spinner';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  /** CSS width (e.g. '120px', '20%'). */
  width?: string;
  /** Hide on narrow screens. */
  hideOnMobile?: boolean;
}

interface Props<T> {
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Empty-state title (or a custom node via `emptyNode`). */
  emptyTitle?: ReactNode;
  emptyHint?: ReactNode;
  emptyNode?: ReactNode;
  /** Rendered under the table (Load more, provenance). */
  footer?: ReactNode;
  compact?: boolean;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  testId?: string;
  className?: string;
  /** Accessible table caption (visually hidden). */
  caption?: string;
  /**
   * File name (without extension) of the "Export CSV" button. The button is
   * shown when `exportColumns` is also given and at least one row is loaded;
   * it serialises the loaded rows only.
   */
  exportName?: string;
  exportColumns?: readonly CsvColumn<T>[];
}

/** CSV of the loaded rows (pure; what the Export button downloads). */
export function tableCsv<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  return rowsToCsv(columns, rows);
}

/** Generic table with loading / error / empty states, optional CSV export and horizontal scrolling on small screens. */
export default function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  emptyTitle = 'Nothing to show',
  emptyHint,
  emptyNode,
  footer,
  compact,
  onRowClick,
  rowClassName,
  testId,
  className,
  caption,
  exportName,
  exportColumns,
}: Props<T>) {
  const showError = !!error && rows.length === 0;
  const showLoading = !!loading && rows.length === 0 && !showError;
  const showEmpty = !loading && !error && rows.length === 0;
  const canExport = !!exportName && !!exportColumns && exportColumns.length > 0 && rows.length > 0;

  const exportButton = canExport ? (
    <button
      type="button"
      className="btn btn--sm btn--ghost table-export"
      onClick={() => downloadCsv(exportName, tableCsv(exportColumns, rows))}
      title={`Download the ${rows.length.toLocaleString('en-US')} loaded row${rows.length === 1 ? '' : 's'} as CSV`}
    >
      Export CSV
    </button>
  ) : null;

  return (
    <div className={`table-wrap${className ? ` ${className}` : ''}`} data-testid={testId}>
      {showError ? (
        <ErrorBox error={error} onRetry={onRetry} />
      ) : showLoading ? (
        <Spinner block label="Loading…" />
      ) : showEmpty ? (
        (emptyNode ?? <EmptyState title={emptyTitle} hint={emptyHint} compact />)
      ) : (
        <div className="table-scroll">
          <table className={`table${compact ? ' table--compact' : ''}${onRowClick ? ' table--clickable' : ''}`}>
            {caption && <caption className="sr-only">{caption}</caption>}
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={`${c.align ? `align-${c.align}` : ''}${c.hideOnMobile ? ' hide-mobile' : ''}${c.className ? ` ${c.className}` : ''}`.trim() || undefined}
                    style={c.width ? { width: c.width } : undefined}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={rowKey(row, i)}
                  className={rowClassName?.(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === 'Enter') onRowClick(row);
                        }
                      : undefined
                  }
                >
                  {columns.map((c) => (
                    <td key={c.key} className={`${c.align ? `align-${c.align}` : ''}${c.hideOnMobile ? ' hide-mobile' : ''}${c.className ? ` ${c.className}` : ''}`.trim() || undefined}>
                      {c.render(row, i)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!!error && rows.length > 0 && <ErrorBox error={error} onRetry={onRetry} compact />}
      {(footer || exportButton) && (
        <div className={`table-footer${exportButton ? ' table-footer--split' : ''}`}>
          {footer && <div className="table-footer__main">{footer}</div>}
          {exportButton}
        </div>
      )}
    </div>
  );
}
