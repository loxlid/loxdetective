import { Link } from 'react-router-dom';
import type { ChainId } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { shorten } from '@/lib/format';
import { canonicalAddress } from '@/hooks/dispatch';
import { useLabel } from '@/hooks/useLabel';
import CopyButton from './CopyButton';
import LabelChip from './LabelChip';

interface Props {
  address: string;
  chain: ChainId;
  /** Shorten to 0x1234…abcd (default true). */
  short?: boolean;
  /** Link to the address page (default true). */
  link?: boolean;
  /** Show the known-address label chip (default true). */
  showLabel?: boolean;
  /** When a label is shown, hide the raw address (label only). */
  labelOnly?: boolean;
  copy?: boolean;
  /** Mark as the address currently being viewed. */
  self?: boolean;
  lead?: number;
  tail?: number;
  className?: string;
}

/** Placeholder values providers use for addresses that are not addresses. */
const SPECIAL = new Map<string, string>([
  ['coinbase', 'Coinbase (block reward)'],
  ['OP_RETURN', 'OP_RETURN (data output)'],
  ['unknown', 'Unknown'],
  ['', '—'],
]);

const MAX_MULTI = 3;

/**
 * Address with checksum, label chip, copy button and link to its profile.
 * Comma-joined lists (Bitcoin inputs) render as several addresses.
 */
export default function AddressDisplay({ address, chain, short = true, link = true, showLabel = true, labelOnly, copy = false, self, lead = 6, tail = 4, className }: Props) {
  const raw = (address ?? '').trim();
  const special = SPECIAL.get(raw);
  if (special !== undefined) return <span className={`addr addr--special${className ? ` ${className}` : ''}`}>{special}</span>;
  if (raw.includes(',')) {
    const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
    return (
      <span className={`addr addr--multi${className ? ` ${className}` : ''}`}>
        {parts.slice(0, MAX_MULTI).map((p, i) => (
          <AddressDisplay key={`${i}:${p}`} address={p} chain={chain} short={short} link={link} showLabel={showLabel} lead={lead} tail={tail} />
        ))}
        {parts.length > MAX_MULTI && <span className="addr__more">+{parts.length - MAX_MULTI} more</span>}
      </span>
    );
  }
  return <SingleAddress address={raw} chain={chain} short={short} link={link} showLabel={showLabel} labelOnly={labelOnly} copy={copy} self={self} lead={lead} tail={tail} className={className} />;
}

function SingleAddress({ address, chain, short, link, showLabel, labelOnly, copy, self, lead, tail, className }: Required<Pick<Props, 'address' | 'chain' | 'short' | 'link' | 'showLabel' | 'lead' | 'tail'>> & Pick<Props, 'labelOnly' | 'copy' | 'self' | 'className'>) {
  const info = findChain(chain);
  const display = canonicalAddress(info, address);
  const label = useLabel(display, chain);
  const text = short ? shorten(display, lead, tail) : display;
  const hideText = !!labelOnly && !!label && showLabel;

  const body = <span className="addr__text mono">{text}</span>;
  return (
    <span className={`addr${self ? ' addr--self' : ''}${className ? ` ${className}` : ''}`} title={display}>
      {!hideText &&
        (link && info ? (
          <Link className="addr__link" to={`/address/${chain}/${display}`}>
            {body}
          </Link>
        ) : (
          body
        ))}
      {showLabel &&
        label &&
        (hideText && link && info && !label.url ? (
          <Link className="addr__link" to={`/address/${chain}/${display}`}>
            <LabelChip label={label} compact />
          </Link>
        ) : (
          <LabelChip label={label} compact />
        ))}
      {self && <span className="addr__self">this address</span>}
      {copy && <CopyButton value={display} label="Copy address" />}
    </span>
  );
}
