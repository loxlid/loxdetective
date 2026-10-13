import { Link } from 'react-router-dom';
import type { ChainId } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { shorten } from '@/lib/format';
import CopyButton from './CopyButton';

interface Props {
  hash: string;
  chain: ChainId;
  short?: boolean;
  /** Link to the transaction page (default true). */
  link?: boolean;
  copy?: boolean;
  lead?: number;
  tail?: number;
  className?: string;
}

/** Transaction hash / signature with link to the tx page and optional copy button. */
export default function HashDisplay({ hash, chain, short = true, link = true, copy = false, lead = 8, tail = 6, className }: Props) {
  const h = (hash ?? '').trim();
  const info = findChain(chain);
  const text = short ? shorten(h, lead, tail) : h;
  const body = <span className="hash__text mono">{text}</span>;
  return (
    <span className={`hash${className ? ` ${className}` : ''}`} title={h}>
      {link && info ? (
        <Link className="hash__link" to={`/tx/${chain}/${h}`}>
          {body}
        </Link>
      ) : (
        body
      )}
      {copy && <CopyButton value={h} label="Copy hash" />}
    </span>
  );
}
