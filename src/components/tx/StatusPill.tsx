import type { TxStatus } from '@/lib/types';

const TEXT: Record<TxStatus, string> = { success: 'Success', failed: 'Failed', pending: 'Pending' };

interface Props {
  status: TxStatus;
  size?: 'sm' | 'md';
  /** `data-testid`, e.g. `tx-status` on the transaction page header (one per page). */
  testId?: string;
  className?: string;
}

/** Coloured transaction status: Success / Failed / Pending. */
export default function StatusPill({ status, size = 'md', testId, className }: Props) {
  const cls = `status status--${status}${size === 'sm' ? ' status--sm' : ''}${className ? ` ${className}` : ''}`;
  return (
    <span className={cls} data-testid={testId} title={`Transaction status: ${TEXT[status] ?? status}`}>
      <span className="status__dot" aria-hidden="true" />
      {TEXT[status] ?? status}
    </span>
  );
}
