import { useMemo } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import type { ChainId, PagedResult, TxListItem } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { solEnrichHistory } from '@/lib/providers/sol/rpc';
import type { HistoryKind } from './dispatch';
import { canonicalAddress } from './dispatch';
import { useAddressHistory, type AddressHistoryResult } from './useAddressHistory';

export interface EnrichProgress {
  /** Signature rows whose page has been enriched. */
  done: number;
  /** Signature rows loaded so far. */
  total: number;
  /** True while at least one page is being enriched. */
  loading: boolean;
}

export interface SolEnrichedHistory {
  /** The underlying signature pager (load more, errors, provenance). */
  history: AddressHistoryResult;
  /** Enriched rows of every loaded page in order (native + SPL); raw signature rows for pages not yet enriched. */
  items: TxListItem[];
  /** Enriched rows of the first page only (undefined until that page is enriched). */
  firstPage?: TxListItem[];
  progress: EnrichProgress;
  /** False for non-Solana chains (the hook then stays idle). */
  enabled: boolean;
}

/** Query key of one page's enrichment, keyed by the page's first signature. */
export function solEnrichQueryKey(address: string, firstSignature: string | undefined): readonly unknown[] {
  return ['sol-enrich', address, firstSignature ?? ''] as const;
}

/** Native (`tx`) vs SPL (`token`) rows of an enriched list; `internal` has no Solana equivalent. */
export function splitEnrichedRows(rows: readonly TxListItem[], kind: HistoryKind): TxListItem[] {
  if (kind === 'token') return rows.filter((r) => !!r.token);
  if (kind === 'tx') return rows.filter((r) => !r.token);
  return [];
}

/** "enriching n of m…" footer text while pages are being resolved; undefined when idle. */
export function enrichHint(p: EnrichProgress): string | undefined {
  if (!p.loading || p.total === 0) return undefined;
  return `enriching ${p.done.toLocaleString('en-US')} of ${p.total.toLocaleString('en-US')}…`;
}

interface Combined {
  data: (TxListItem[] | undefined)[];
  loading: boolean[];
}

function combineEnrich(results: UseQueryResult<TxListItem[], Error>[]): Combined {
  return {
    data: results.map((r) => r.data),
    loading: results.map((r) => r.isPending && r.fetchStatus !== 'idle'),
  };
}

const NO_PAGES: PagedResult<TxListItem>[] = [];

/**
 * Solana history with `getTransaction` enrichment: every signature page is
 * resolved through `solEnrichHistory` (react-query key
 * `['sol-enrich', address, firstSignature]`) so rows carry direction,
 * counterparty and value like EVM rows. SPL rows are the "token transfers"
 * of a Solana address. On other chain families the hook is inert.
 */
export function useSolEnrichedHistory(chain: ChainId, address: string): SolEnrichedHistory {
  const info = findChain(chain);
  const enabled = info?.family === 'solana';
  const canonical = canonicalAddress(info, address);
  const history = useAddressHistory(chain, address, 'tx');
  const pages = enabled ? (history.query.data?.pages ?? NO_PAGES) : NO_PAGES;

  const combined = useQueries({
    queries: pages.map((p) => ({
      queryKey: solEnrichQueryKey(canonical, p.items[0]?.hash),
      queryFn: ({ signal }: { signal: AbortSignal }) => solEnrichHistory(canonical, p.items, { signal }),
      enabled: p.items.length > 0,
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 10 * 60_000,
      retry: false,
    })),
    combine: combineEnrich,
  });

  const items = useMemo(() => pages.flatMap((p, i) => combined.data[i] ?? p.items), [pages, combined.data]);
  const firstPage = pages.length > 0 ? (combined.data[0] ?? (pages[0].items.length === 0 ? [] : undefined)) : undefined;
  const progress = useMemo<EnrichProgress>(() => {
    let done = 0;
    let total = 0;
    for (let i = 0; i < pages.length; i++) {
      total += pages[i].items.length;
      if (combined.data[i] !== undefined || pages[i].items.length === 0) done += pages[i].items.length;
    }
    return { done, total, loading: combined.loading.some(Boolean) };
  }, [pages, combined]);

  return { history, items, firstPage, progress, enabled };
}
