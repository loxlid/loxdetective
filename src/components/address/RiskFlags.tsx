import type { RiskReport } from '@/lib/types';
import EmptyState from '@/components/EmptyState';
import Spinner from '@/components/Spinner';

const MAX_EVIDENCE = 5;

/** Expandable list of the heuristics that fired for an address. */
export default function RiskFlags({ report, loading }: { report?: RiskReport; loading: boolean }) {
  if (!report) {
    return loading ? <Spinner label="Assessing risk…" /> : <p className="muted">No assessment available: the address summary and history could not be loaded.</p>;
  }
  if (report.flags.length === 0) {
    return (
      <EmptyState
        compact
        title="No risk indicators found"
        hint={loading ? 'Some inputs are still loading; the assessment may change.' : 'No sanctions, mixer, velocity, approval or pattern heuristics fired on the available data.'}
      />
    );
  }
  return (
    <ul className="flag-list">
      {report.flags.map((f) => (
        <li key={f.id} className={`flag flag--${f.level}`}>
          <span className="flag__level">{f.level}</span>
          <span className="flag__title">{f.title}</span>
          <span className="flag__detail">{f.detail}</span>
          {f.evidence && f.evidence.length > 0 && (
            <ul className="flag__evidence">
              {f.evidence.slice(0, MAX_EVIDENCE).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
              {f.evidence.length > MAX_EVIDENCE && <li>+{f.evidence.length - MAX_EVIDENCE} more</li>}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
