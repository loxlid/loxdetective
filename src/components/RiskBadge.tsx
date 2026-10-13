import type { RiskLevel, RiskReport } from '@/lib/types';

interface Props {
  report?: RiskReport;
  /** Used when no report is given. */
  level?: RiskLevel;
  score?: number;
  loading?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** `data-testid`; defaults to `risk-badge` — render at most one default-id badge per page. Pass `null` for none. */
  testId?: string | null;
  className?: string;
}

const TITLES: Record<RiskLevel, string> = {
  none: 'No risk indicators found',
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
  critical: 'Critical risk',
};

/** Pill showing the risk level (and score) of an address. */
export default function RiskBadge({ report, level, score, loading, size = 'md', testId = 'risk-badge', className }: Props) {
  const lvl: RiskLevel | undefined = report?.level ?? level ?? (loading ? undefined : 'none');
  const sc = report?.score ?? score;
  const cls = `badge badge--risk badge--${size} badge--risk-${lvl ?? 'pending'}${className ? ` ${className}` : ''}`;
  return (
    <span className={cls} data-testid={testId ?? undefined} title={lvl ? TITLES[lvl] : 'Assessing risk'}>
      <span className="badge__dot" aria-hidden="true" />
      <span className="badge__label">Risk:</span>{' '}
      <span className="badge__value">{lvl ?? 'assessing…'}</span>
      {sc !== undefined && lvl && <span className="badge__score">{sc}</span>}
      {loading && lvl && <span className="badge__loading" title="Still loading data; the level may change" />}
    </span>
  );
}
