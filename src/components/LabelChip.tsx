import type { AddressLabel } from '@/lib/types';

interface Props {
  label: AddressLabel;
  /** Truncate long names. */
  compact?: boolean;
  className?: string;
}

/** Known-address label (exchange / mixer / sanctioned / case tag…) coloured by category. */
export default function LabelChip({ label, compact, className }: Props) {
  const title = `${label.name} · ${label.category} · ${label.source}`;
  const cls = `chip chip--${label.category}${compact ? ' chip--compact' : ''}${className ? ` ${className}` : ''}`;
  if (label.url) {
    return (
      <a className={cls} href={label.url} target="_blank" rel="noreferrer noopener" title={title} onClick={(e) => e.stopPropagation()}>
        {label.name}
      </a>
    );
  }
  return (
    <span className={cls} title={title}>
      {label.name}
    </span>
  );
}
