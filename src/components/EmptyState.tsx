import type { ReactNode } from 'react';

interface Props {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
  className?: string;
}

const DefaultIcon = () => (
  <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <line x1="16.5" y1="16.5" x2="21" y2="21" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </svg>
);

/** Placeholder for "nothing here" panels (no rows, no tokens, unsupported feature). */
export default function EmptyState({ title, hint, action, icon, compact, className }: Props) {
  return (
    <div className={`empty${compact ? ' empty--compact' : ''}${className ? ` ${className}` : ''}`}>
      <div className="empty__icon">{icon ?? <DefaultIcon />}</div>
      <div className="empty__title">{title}</div>
      {hint && <div className="empty__hint">{hint}</div>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}
