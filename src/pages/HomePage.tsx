import { Link, useNavigate } from 'react-router-dom';
import { allChains } from '@/lib/chains/registry';
import { useSettings } from '@/lib/settings/store';
import { useRecentSearches } from '@/hooks/useRecentSearches';
import { usePageTitle } from '@/hooks/usePageTitle';
import { searchPath } from '@/components/SearchBar';
import SearchBar from '@/components/SearchBar';
import ChainBadge from '@/components/ChainBadge';
import Timestamp from '@/components/Timestamp';

interface Feature {
  title: string;
  text: string;
  icon: JSX.Element;
}

const icon = (path: JSX.Element) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

const FEATURES: Feature[] = [
  {
    title: 'Universal search',
    text: 'Paste an address, hash, ENS name, Bitcoin address or Solana signature. The chain is detected for you.',
    icon: icon(
      <>
        <circle cx="11" cy="11" r="7" />
        <line x1="16.5" y1="16.5" x2="21" y2="21" />
      </>,
    ),
  },
  {
    title: 'Address profiles',
    text: 'Balances on 19 EVM networks, token holdings with USD, history, approvals and contract details in one place.',
    icon: icon(
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </>,
    ),
  },
  {
    title: 'Transaction decoding',
    text: 'Status, fees, method names, ERC-20/721/1155 transfers, internal calls and decoded events, plus BTC inputs/outputs.',
    icon: icon(
      <>
        <path d="M4 7h16M4 12h10M4 17h7" />
        <path d="m17 15 3 3-3 3" />
      </>,
    ),
  },
  {
    title: 'Fund-flow tracer',
    text: 'Follow value hop by hop with an interactive graph; stop at exchanges and export the result as CSV or JSON.',
    icon: icon(
      <>
        <circle cx="5" cy="12" r="2.5" />
        <circle cx="19" cy="6" r="2.5" />
        <circle cx="19" cy="18" r="2.5" />
        <path d="M7.3 11 16.7 6.8M7.3 13l9.4 4.2" />
      </>,
    ),
  },
  {
    title: 'Risk & labels',
    text: 'Deterministic risk flags (mixers, sanctions, pass-through, fresh wallets…) with built-in and OFAC labels.',
    icon: icon(
      <>
        <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" />
        <path d="m9 12 2 2 4-4" />
      </>,
    ),
  },
  {
    title: 'Cases & notes',
    text: 'Group addresses and transactions into cases, tag them, keep notes and share everything as a JSON file.',
    icon: icon(
      <>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <path d="M8 13h8" />
      </>,
    ),
  },
];

const EXAMPLES: { label: string; query: string }[] = [
  { label: 'vitalik.eth', query: 'vitalik.eth' },
  { label: 'Tornado Cash router', query: '0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b' },
  { label: 'Binance BTC cold wallet', query: '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo' },
  { label: 'Jupiter v6 (Solana)', query: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' },
];

export default function HomePage() {
  usePageTitle();
  const showTestnets = useSettings((s) => s.showTestnets);
  const chains = allChains(showTestnets);
  const { recent, remove, clear } = useRecentSearches();
  const navigate = useNavigate();

  return (
    <div className="home">
      <section className="hero">
        <div className="hero__glow" aria-hidden="true" />
        <p className="hero__kicker">Client-side on-chain investigation</p>
        <h1 className="hero__title">LoxDetective</h1>
        <p className="hero__tagline">Follow the money across every chain.</p>
        <SearchBar size="hero" autoFocus />
        <div className="hero__examples">
          <span className="muted">Try:</span>
          {EXAMPLES.map((e) => (
            <button key={e.query} type="button" className="link-btn" onClick={() => navigate(searchPath(e.query))}>
              {e.label}
            </button>
          ))}
        </div>
      </section>

      {recent.length > 0 && (
        <section className="section">
          <div className="section__head">
            <h2>Recent searches</h2>
            <button type="button" className="btn btn--ghost btn--sm" onClick={clear}>
              Clear
            </button>
          </div>
          <ul className="recent">
            {recent.map((r) => (
              <li key={r.query} className="recent__item">
                <Link className="recent__link" to={r.path ?? searchPath(r.query)}>
                  {r.chain && <ChainBadge chain={r.chain} size="sm" />}
                  <span className="recent__query mono">{r.query}</span>
                  <span className="recent__kind muted">{r.kind.replace('-', ' ')}</span>
                  <Timestamp ts={Math.floor(r.at / 1000)} className="recent__time" />
                </Link>
                <button type="button" className="btn btn--icon btn--sm" onClick={() => remove(r.query)} aria-label={`Remove ${r.query} from recent searches`} title="Remove">
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="section">
        <div className="section__head">
          <h2>What you can do</h2>
        </div>
        <div className="tiles">
          {FEATURES.map((f) => (
            <article key={f.title} className="tile">
              <div className="tile__icon">{f.icon}</div>
              <h3 className="tile__title">{f.title}</h3>
              <p className="tile__text">{f.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <h2>Supported networks</h2>
          <span className="muted">
            {chains.length} chains · <Link to="/settings">add your own RPCs</Link>
          </span>
        </div>
        <div className="chain-strip">
          {chains.map((c) => (
            <ChainBadge key={c.id} chain={c} showName />
          ))}
        </div>
      </section>

      <section className="section section--note">
        <p className="muted">
          No backend, no accounts, no tracking. Queries go straight from your browser to public RPCs and explorer APIs; API keys you add stay in your browser's local storage.{' '}
          <Link to="/about">Read more about data sources and privacy.</Link>
        </p>
      </section>
    </div>
  );
}
