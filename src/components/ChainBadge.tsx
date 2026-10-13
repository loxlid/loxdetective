import type { CSSProperties } from 'react';
import type { ChainId, ChainInfo } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';

interface Props {
  chain: ChainId | ChainInfo;
  size?: 'sm' | 'md' | 'lg';
  /** Show the full chain name instead of the short ticker-like name. */
  showName?: boolean;
  className?: string;
  title?: string;
}

/** Coloured dot + chain name. Unknown chain ids render their raw id in grey. */
export default function ChainBadge({ chain, size = 'md', showName, className, title }: Props) {
  const info = typeof chain === 'string' ? findChain(chain) : chain;
  const text = info ? (showName ? info.name : info.shortName) : String(chain);
  const style = { '--chain-color': info?.color ?? 'var(--text-faint)' } as CSSProperties;
  return (
    <span className={`chain-badge chain-badge--${size}${info?.testnet ? ' chain-badge--testnet' : ''}${className ? ` ${className}` : ''}`} style={style} title={title ?? info?.name}>
      <span className="chain-badge__dot" aria-hidden="true" />
      <span className="chain-badge__name">{text}</span>
    </span>
  );
}
