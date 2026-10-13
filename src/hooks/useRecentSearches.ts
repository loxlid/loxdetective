import { useCallback, useSyncExternalStore } from 'react';
import type { ChainId, InputKind } from '@/lib/types';

export const RECENT_SEARCHES_KEY = 'loxdetective.recent.v1';
export const RECENT_SEARCHES_MAX = 10;

export interface RecentSearch {
  /** What the user typed (trimmed). */
  query: string;
  kind: InputKind;
  /** Chain the search resolved to, when known. */
  chain?: ChainId;
  /** In-app route the search resolved to. */
  path?: string;
  /** Unix milliseconds. */
  at: number;
}

const EMPTY: RecentSearch[] = [];
let cache: RecentSearch[] | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    localStorage.getItem('__probe__');
    return localStorage;
  } catch {
    return undefined;
  }
}

/** Only in-app routes may be stored as `path` (it is rendered as a Link href). */
function isAppPath(p: string): boolean {
  return p.startsWith('/') && !p.startsWith('//');
}

function isRecent(v: unknown): v is RecentSearch {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<RecentSearch>;
  return (
    typeof r.query === 'string' &&
    typeof r.kind === 'string' &&
    typeof r.at === 'number' &&
    (r.chain === undefined || typeof r.chain === 'string') &&
    (r.path === undefined || (typeof r.path === 'string' && isAppPath(r.path)))
  );
}

/** Read the persisted list (tolerant to missing / corrupt storage). */
export function readRecentSearches(): RecentSearch[] {
  if (cache) return cache;
  let out: RecentSearch[] = EMPTY;
  try {
    const raw = storage()?.getItem(RECENT_SEARCHES_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) out = parsed.filter(isRecent).slice(0, RECENT_SEARCHES_MAX);
    }
  } catch {
    out = EMPTY;
  }
  cache = out;
  return out;
}

function write(list: RecentSearch[]): void {
  cache = list;
  try {
    storage()?.setItem(RECENT_SEARCHES_KEY, JSON.stringify(list));
  } catch {
    /* quota / private mode: keep the in-memory copy */
  }
  for (const l of Array.from(listeners)) l();
}

/** Add (or move to the front) a search; keeps at most `RECENT_SEARCHES_MAX` entries. */
export function addRecentSearch(entry: Omit<RecentSearch, 'at'> & { at?: number }): RecentSearch[] {
  const query = entry.query.trim();
  if (!query) return readRecentSearches();
  const item: RecentSearch = { ...entry, query, at: entry.at ?? Date.now() };
  const rest = readRecentSearches().filter((r) => r.query.toLowerCase() !== query.toLowerCase());
  const next = [item, ...rest].slice(0, RECENT_SEARCHES_MAX);
  write(next);
  return next;
}

export function removeRecentSearch(query: string): RecentSearch[] {
  const next = readRecentSearches().filter((r) => r.query.toLowerCase() !== query.trim().toLowerCase());
  write(next);
  return next;
}

export function clearRecentSearches(): void {
  write(EMPTY);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === RECENT_SEARCHES_KEY) {
      cache = undefined;
      listener();
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

const getServerSnapshot = () => EMPTY;

export function useRecentSearches(): {
  recent: RecentSearch[];
  add: typeof addRecentSearch;
  remove: (query: string) => void;
  clear: () => void;
} {
  const recent = useSyncExternalStore(subscribe, readRecentSearches, getServerSnapshot);
  const remove = useCallback((query: string) => void removeRecentSearch(query), []);
  const clear = useCallback(() => clearRecentSearches(), []);
  return { recent, add: addRecentSearch, remove, clear };
}
