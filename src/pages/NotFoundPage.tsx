import { Link, useLocation } from 'react-router-dom';
import { usePageTitle } from '@/hooks/usePageTitle';
import EmptyState from '@/components/EmptyState';

export default function NotFoundPage() {
  usePageTitle('Not found');
  const { pathname } = useLocation();
  return (
    <div className="notfound-page">
      <EmptyState
        title="Page not found"
        hint={
          <>
            There is nothing at <code className="mono">{pathname}</code>.
          </>
        }
        action={
          <Link className="btn btn--primary" to="/">
            Back to search
          </Link>
        }
      />
    </div>
  );
}
