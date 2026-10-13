import { useEffect } from 'react';

export const APP_TITLE = 'LoxDetective — Web3 On-Chain Investigator';

/** Sets `document.title` while mounted ("<title> · LoxDetective"); restores the default on unmount. */
export function usePageTitle(title?: string): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title = title ? `${title} · LoxDetective` : APP_TITLE;
    return () => {
      document.title = APP_TITLE;
    };
  }, [title]);
}
