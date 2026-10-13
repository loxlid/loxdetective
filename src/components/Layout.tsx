import type { ReactNode } from 'react';
import { Link, NavLink, matchPath, useLocation } from 'react-router-dom';
import SearchBar from './SearchBar';
import ThemeToggle from './ThemeToggle';

export const GITHUB_URL = 'https://github.com/loxlid/loxdetective';

/** Inline magnifier logo (same artwork as the favicon). */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg className="logo" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="lox-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-strong)" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="#0e1117" />
      <circle cx="27" cy="27" r="13" fill="none" stroke="url(#lox-g)" strokeWidth="5" />
      <line x1="37" y1="37" x2="52" y2="52" stroke="url(#lox-g)" strokeWidth="7" strokeLinecap="round" />
      <circle cx="27" cy="27" r="4" fill="url(#lox-g)" />
    </svg>
  );
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const navClass = ({ isActive }: { isActive: boolean }) => `nav__link${isActive ? ' is-active' : ''}`;

/** App chrome: top nav (brand, compact search off-home, links, theme toggle), content, footer. */
export default function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const isHome = pathname === '/';
  const searchMatch = matchPath('/search/:query', pathname);
  const initialQuery = searchMatch?.params.query ? safeDecode(searchMatch.params.query) : '';

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="nav">
        <div className="container nav__inner">
          <Link to="/" className="nav__brand" data-testid="nav-home" aria-label="LoxDetective home">
            <Logo size={26} />
            <span className="nav__brand-text">LoxDetective</span>
          </Link>
          {!isHome && (
            <div className="nav__search">
              <SearchBar key={initialQuery} size="compact" initial={initialQuery} />
            </div>
          )}
          <nav className="nav__links" aria-label="Primary">
            <NavLink to="/cases" className={navClass} data-testid="nav-cases">
              Cases
            </NavLink>
            <NavLink to="/settings" className={navClass} data-testid="nav-settings">
              Settings
            </NavLink>
            <NavLink to="/about" className={navClass} data-testid="nav-about">
              About
            </NavLink>
            <ThemeToggle />
          </nav>
        </div>
      </header>
      <main id="main" className="container page">
        {children}
      </main>
      <footer className="footer">
        <div className="container footer__inner">
          <span>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer noopener">
              GitHub
            </a>
            {' · '}
            <Link to="/about">About &amp; data sources</Link>
            {' · '}
            <span className="muted">MIT licensed</span>
          </span>
          <span className="muted">All data is fetched client-side from public endpoints.</span>
        </div>
      </footer>
    </div>
  );
}
