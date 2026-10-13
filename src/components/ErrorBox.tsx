import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

interface Props {
  /** Error object or message (either `error` or `message` is required). */
  error?: unknown;
  message?: string;
  title?: string;
  onRetry?: () => void;
  /** Extra guidance under the message; a Settings hint is added automatically for provider / API key errors. */
  hint?: ReactNode;
  compact?: boolean;
  className?: string;
}

/** Human message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Unknown error';
}

const SETTINGS_HINT_RE = /api key|history provider|balance provider|settings|rate limit|NOTOK|No endpoints configured/i;
const NETWORK_HINT_RE = /timeout|failed to fetch|networkerror|HTTP 5\d\d|HTTP 429|load failed/i;

/** Error panel with message, optional retry and context-aware hints. */
export default function ErrorBox({ error, message, title, onRetry, hint, compact, className }: Props) {
  const text = message ?? errorMessage(error);
  const settingsHint = SETTINGS_HINT_RE.test(text);
  const networkHint = !settingsHint && NETWORK_HINT_RE.test(text);
  return (
    <div className={`error-box${compact ? ' error-box--compact' : ''}${className ? ` ${className}` : ''}`} role="alert">
      <div className="error-box__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <div className="error-box__body">
        {title && <div className="error-box__title">{title}</div>}
        <div className="error-box__message">{text}</div>
        {hint && <div className="error-box__hint">{hint}</div>}
        {settingsHint && (
          <div className="error-box__hint">
            Add an API key or a custom RPC endpoint in <Link to="/settings">Settings</Link>.
          </div>
        )}
        {networkHint && <div className="error-box__hint">The public endpoint may be rate-limited or down; retry, or add your own RPC in <Link to="/settings">Settings</Link>.</div>}
      </div>
      {onRetry && (
        <button type="button" className="btn btn--sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
