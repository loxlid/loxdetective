import type { ReactNode } from 'react';

interface Props {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned header content (buttons, badges). */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Remove the body padding (for tables that fill the card). */
  flush?: boolean;
  testId?: string;
  id?: string;
}

/** Elevated panel with an optional header row. */
export default function Card({ title, subtitle, actions, children, className, flush, testId, id }: Props) {
  const hasHeader = title !== undefined || actions !== undefined || subtitle !== undefined;
  return (
    <section className={`card${flush ? ' card--flush' : ''}${className ? ` ${className}` : ''}`} data-testid={testId} id={id}>
      {hasHeader && (
        <header className="card__header">
          <div className="card__heading">
            {title !== undefined && <h2 className="card__title">{title}</h2>}
            {subtitle && <div className="card__subtitle">{subtitle}</div>}
          </div>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      <div className="card__body">{children}</div>
    </section>
  );
}
