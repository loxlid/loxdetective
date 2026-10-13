import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useToast } from './Toast';

interface Props {
  value: string;
  /** Accessible label (default "Copy"). */
  label?: string;
  /** Show the label text next to the icon. */
  withText?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

/** Clipboard write with a legacy `execCommand` fallback for non-secure contexts. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const CopyIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

/** Icon button that copies `value` and flashes a check mark. */
export default function CopyButton({ value, label = 'Copy', withText, size = 'sm', className }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const toast = useToast();

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onClick = useCallback(
    async (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const ok = await copyText(value);
      if (!ok) {
        toast.push('Copy failed — your browser blocked clipboard access', 'error');
        return;
      }
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    },
    [value, toast],
  );

  return (
    <button
      type="button"
      className={`copy-btn copy-btn--${size}${copied ? ' is-copied' : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      title={copied ? 'Copied' : label}
      aria-label={copied ? 'Copied' : label}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {withText && <span className="copy-btn__text">{copied ? 'Copied' : label}</span>}
    </button>
  );
}
