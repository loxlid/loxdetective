interface Props {
  size?: 'sm' | 'md' | 'lg';
  /** Text next to the spinner, e.g. "Resolving…". */
  label?: string;
  /** Centre the spinner in a block (for empty panels). */
  block?: boolean;
  className?: string;
}

export default function Spinner({ size = 'md', label, block, className }: Props) {
  const cls = `spinner-wrap${block ? ' spinner-wrap--block' : ''}${className ? ` ${className}` : ''}`;
  return (
    <span className={cls} role="status" aria-live="polite" aria-label={label ?? 'Loading'}>
      <span className={`spinner spinner--${size}`} aria-hidden="true" />
      {label && <span className="spinner__label">{label}</span>}
    </span>
  );
}
