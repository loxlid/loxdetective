import type { ChainFamily, ChainId, ChainInfo } from '@/lib/types';
import { allChains, chainsByFamily } from '@/lib/chains/registry';
import { useSettings } from '@/lib/settings/store';

interface Props {
  value: ChainId;
  onChange: (chain: ChainId) => void;
  /** Restrict to one family. */
  family?: ChainFamily;
  /** Explicit list (overrides `family`). */
  chains?: ChainInfo[];
  includeTestnets?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
  ariaLabel?: string;
  className?: string;
  id?: string;
}

/** Native `<select>` of supported chains (testnets follow the Settings toggle unless overridden). */
export default function ChainSelect({ value, onChange, family, chains, includeTestnets, disabled, size = 'md', ariaLabel = 'Chain', className, id }: Props) {
  const showTestnets = useSettings((s) => s.showTestnets);
  const withTestnets = includeTestnets ?? showTestnets;
  const list = chains ?? (family ? chainsByFamily(family, withTestnets) : allChains(withTestnets));
  const known = list.some((c) => c.id === value);
  return (
    <select id={id} className={`input input--select${size === 'sm' ? ' input--sm' : ''}${className ? ` ${className}` : ''}`} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label={ariaLabel}>
      {!known && value && <option value={value}>{value}</option>}
      {list.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
