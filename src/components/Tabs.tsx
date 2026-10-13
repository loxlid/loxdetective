import type { ReactNode } from 'react';

export interface TabDef {
  id: string;
  label: ReactNode;
  /** `data-testid` for the tab button (e.g. `address-tab-transactions`). */
  testId?: string;
  disabled?: boolean;
  /** Small counter / badge after the label. */
  count?: number | string;
  title?: string;
}

interface Props {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
  ariaLabel?: string;
}

/** Horizontal tab strip (scrolls on narrow screens). Content rendering is up to the caller. */
export default function Tabs({ tabs, active, onChange, className, ariaLabel }: Props) {
  return (
    <div className={`tabs${className ? ` ${className}` : ''}`} role="tablist" aria-label={ariaLabel}>
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-disabled={t.disabled || undefined}
            disabled={t.disabled}
            className={`tabs__tab${isActive ? ' is-active' : ''}`}
            data-testid={t.testId}
            title={t.title}
            onClick={() => {
              if (!t.disabled) onChange(t.id);
            }}
          >
            <span className="tabs__label">{t.label}</span>
            {t.count !== undefined && t.count !== '' && <span className="tabs__count">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
