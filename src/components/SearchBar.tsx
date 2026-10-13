import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { detectInput } from '@/lib/detect';

interface Props {
  /** 'hero' on the home page, 'compact' in the nav. */
  size?: 'hero' | 'compact';
  initial?: string;
  autoFocus?: boolean;
  placeholder?: string;
  /** Override navigation (default: `/search/<query>`). */
  onSubmit?: (query: string) => void;
  className?: string;
}

/** Route for a raw search query. */
export function searchPath(query: string): string {
  return `/search/${encodeURIComponent(query.trim())}`;
}

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <line x1="16.5" y1="16.5" x2="21" y2="21" />
  </svg>
);

/**
 * Universal search input. Carries the `search-input` / `search-submit`
 * test ids, so render only one instance per page.
 */
export default function SearchBar({ size = 'compact', initial = '', autoFocus, placeholder, onSubmit, className }: Props) {
  const [value, setValue] = useState(initial);
  const navigate = useNavigate();
  const detected = useMemo(() => detectInput(value), [value]);
  const hero = size === 'hero';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    if (onSubmit) onSubmit(q);
    else navigate(searchPath(q));
  };

  return (
    <form className={`search search--${size}${className ? ` ${className}` : ''}`} role="search" onSubmit={submit}>
      <div className="search__field">
        <span className="search__icon">
          <SearchIcon />
        </span>
        <input
          data-testid="search-input"
          className="search__input"
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder ?? (hero ? 'Address, transaction hash, ENS name, Bitcoin or Solana…' : 'Search address / tx / ENS')}
          autoFocus={autoFocus}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Search"
        />
        <button data-testid="search-submit" type="submit" className="btn btn--primary search__submit" disabled={!value.trim()}>
          {hero ? 'Investigate' : 'Go'}
        </button>
      </div>
      {hero && <div className={`search__hint${value.trim() && detected.kind === 'unknown' ? ' search__hint--warn' : ''}`}>{value.trim() ? detected.hint : 'Supports every EVM network, Bitcoin and Solana.'}</div>}
    </form>
  );
}
