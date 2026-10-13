import type { ReactNode } from 'react';

export interface Stat {
  label: ReactNode;
  value: ReactNode;
  /** Secondary line under the value (USD, "as of", provenance). */
  hint?: ReactNode;
  mono?: boolean;
  /** Highlight with the accent colour. */
  accent?: boolean;
  testId?: string;
  /** Span the full row (for long values such as addresses). */
  wide?: boolean;
}

interface Props {
  stats: Stat[];
  /** Minimum column width in px (default 180). */
  minWidth?: number;
  className?: string;
}

/** Responsive grid of label/value tiles used by overview panels. */
export default function StatGrid({ stats, minWidth = 180, className }: Props) {
  return (
    <div className={`stat-grid${className ? ` ${className}` : ''}`} style={{ '--stat-min': `${minWidth}px` } as React.CSSProperties}>
      {stats.map((s, i) => (
        <div key={i} className={`stat${s.accent ? ' stat--accent' : ''}${s.wide ? ' stat--wide' : ''}`} data-testid={s.testId}>
          <div className="stat__label">{s.label}</div>
          <div className={`stat__value${s.mono ? ' mono' : ''}`}>{s.value}</div>
          {s.hint !== undefined && s.hint !== null && <div className="stat__hint">{s.hint}</div>}
        </div>
      ))}
    </div>
  );
}
