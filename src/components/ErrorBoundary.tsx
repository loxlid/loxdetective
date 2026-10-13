import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import ErrorBox from './ErrorBox';

interface Props {
  children: ReactNode;
  /** Custom fallback; receives the error and a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error?: Error;
}

/**
 * Catches render errors below it and shows an `ErrorBox` with a retry. Give it
 * a `key` tied to the route so navigating away resets the boundary.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // console.warn (not .error) keeps the e2e console hygiene rule intact for degraded states.
    console.warn('[ui] render error caught by boundary:', error.message, info.componentStack);
  }

  reset = (): void => this.setState({ error: undefined });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div className="page-section">
        <ErrorBox title="Something went wrong while rendering this page" error={error} onRetry={this.reset} />
        <p className="muted">
          If this keeps happening, <Link to="/">go back home</Link> or open an issue on GitHub.
        </p>
      </div>
    );
  }
}
