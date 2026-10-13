import type { CSSProperties } from 'react';
import type { ChainId, ChainInfo } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';

/** Marker kinds a badge can carry: `key` = history needs an API key. */
export type ChainBadgeHint = 'key';

interface Props {
  chain: ChainId | ChainInfo;
  size?: 'sm' | 'md' | 'lg';
  /** Show the full chain name instead of the short ticker-like name. */
  showName?: boolean;
  className?: string;
  title?: string;
  /** Small marker after the name (e.g. a key icon when history needs an API key). */
  hint?: ChainBadgeHint;
  /** Tooltip / accessible label of the marker. */
  hintTitle?: string;
}

const HINT_TITLES: Record<ChainBadgeHint, string> = {
  key: 'History needs an Etherscan API key',
};

/** Small key glyph used by the `key` hint (exported for notices that reuse it). */
export function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="8" cy="15" r="4" />
      <path d="M10.8 12.2 20 3M15 8l3 3M18 5l3 3" />
    </svg>
  );
}

/** Coloured dot + chain name, with an optional marker. Unknown chain ids render their raw id in grey. */
export default function ChainBadge({ chain, size = 'md', showName, className, title, hint, hintTitle }: Props) {
  const info = typeof chain === 'string' ? findChain(chain) : chain;
  const text = info ? (showName ? info.name : info.shortName) : String(chain);
  const style = { '--chain-color': info?.color ?? 'var(--text-faint)' } as CSSProperties;
  const hintText = hint ? (hintTitle ?? HINT_TITLES[hint]) : undefined;
  return (
    <span
      className={`chain-badge chain-badge--${size}${info?.testnet ? ' chain-badge--testnet' : ''}${hint ? ` chain-badge--hint-${hint}` : ''}${className ? ` ${className}` : ''}`}
      style={style}
      title={title ?? info?.name}
    >
      <span className="chain-badge__dot" aria-hidden="true" />
      <span className="chain-badge__name">{text}</span>
      {hint && (
        <span className={`chain-badge__hint chain-badge__hint--${hint}`} role="img" title={hintText} aria-label={hintText}>
          {hint === 'key' && <KeyIcon />}
        </span>
      )}
    </span>
  );
}
