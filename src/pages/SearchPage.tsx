import { useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { addRecentSearch } from '@/hooks/useRecentSearches';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useSearchResolver, type ResolveOutcome, type SearchChoice } from '@/hooks/useSearchResolver';
import Card from '@/components/Card';
import ChainBadge from '@/components/ChainBadge';
import ErrorBox from '@/components/ErrorBox';
import Spinner from '@/components/Spinner';

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function ChoiceRow({ choice, onPick }: { choice: SearchChoice; onPick: (c: SearchChoice) => void }) {
  const status = choice.found === true ? 'found' : choice.found === false ? 'missing' : 'unknown';
  const inner = (
    <>
      <ChainBadge chain={choice.chain} showName />
      <span className="choice__detail">{choice.detail}</span>
      <span className={`choice__status choice__status--${status}`}>{choice.found === true ? 'Found' : choice.found === false ? 'Not found' : ''}</span>
    </>
  );
  if (choice.href) {
    return (
      <a className="choice" href={choice.href} target="_blank" rel="noreferrer noopener">
        {inner}
      </a>
    );
  }
  return (
    <button type="button" className={`choice${choice.found === true ? ' choice--found' : ''}`} onClick={() => onPick(choice)}>
      {inner}
    </button>
  );
}

/** `/search/:query` — classifies the input, probes providers where needed and redirects (replace) to the right page. */
export default function SearchPage() {
  const { query: rawQuery = '' } = useParams();
  const query = safeDecode(rawQuery).trim();
  const navigate = useNavigate();
  usePageTitle(query ? `Search: ${query}` : 'Search');

  const onRedirect = useCallback(
    (o: Extract<ResolveOutcome, { status: 'redirect' }>) => {
      addRecentSearch({ query, kind: o.kind, chain: o.chain, path: o.path });
      navigate(o.path, { replace: true });
    },
    [navigate, query],
  );
  const { resolving, outcome, detected } = useSearchResolver(query, onRedirect);

  const pick = (c: SearchChoice) => {
    if (!c.path) return;
    addRecentSearch({ query, kind: outcome?.kind ?? detected.kind, chain: c.chain, path: c.path });
    navigate(c.path, { replace: true });
  };

  return (
    <div className="search-page">
      <Card title={resolving ? 'Resolving…' : outcome?.status === 'choices' ? 'Choose where to look' : 'Search'} subtitle={<span className="mono search-page__query">{query || '(empty)'}</span>}>
        <p className="muted search-page__hint">{detected.hint}</p>
        {resolving && <Spinner block label="Resolving…" />}
        {outcome?.status === 'error' && (
          <>
            <ErrorBox title="Could not resolve this search" message={outcome.message} hint={outcome.hint} />
            <p>
              <Link to="/">Back to search</Link>
            </p>
          </>
        )}
        {outcome?.status === 'choices' && (
          <>
            <p>{outcome.message}</p>
            <div className="choices">
              {outcome.choices.map((c) => (
                <ChoiceRow key={`${c.chain}:${c.path ?? c.href}`} choice={c} onPick={pick} />
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
