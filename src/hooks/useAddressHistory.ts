import { useCallback, useMemo } from 'react';
import { useInfiniteQuery, type InfiniteData, type UseInfiniteQueryResult } from '@tanstack/react-query';
import type { ChainId, PagedResult, TxListItem } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { cacheKey, canonicalAddress, fetchHistoryPage, historySupported, requireChain, type HistoryKind } from './dispatch';

export interface AddressHistoryResult {
  /** The underlying infinite query (pages, status flags, refetch). */
  query: UseInfiniteQueryResult<InfiniteData<PagedResult<TxListItem>, string | undefined>, Error>;
  /** All rows loaded so far, in page order. */
  items: TxListItem[];
  /** Which backend served the first page ('blockscout', 'etherscan', 'routescan', 'esplora', 'solana-rpc'). */
  source?: string;
  hasMore: boolean;
  /** True while the first page loads. */
  isLoading: boolean;
  /** True while an additional page loads. */
  isLoadingMore: boolean;
  error: Error | null;
  loadMore(): void;
  refetch(): void;
  /** False for history kinds the chain family does not expose (BTC / Solana token & internal). */
  supported: boolean;
}

export function historyQueryKey(chain: ChainId, address: string, kind: HistoryKind): readonly unknown[] {
  return ['history', chain, cacheKey(findChain(chain), address), kind] as const;
}

/**
 * Cursor-paged address history (`tx` | `token` | `internal`) as an infinite
 * query. The opaque provider cursor is the page param; pass it back verbatim.
 */
export function useAddressHistory(chain: ChainId, address: string, kind: HistoryKind): AddressHistoryResult {
  const info = findChain(chain);
  const canonical = canonicalAddress(info, address);
  const supported = !!info && historySupported(info, kind);

  const query = useInfiniteQuery<PagedResult<TxListItem>, Error, InfiniteData<PagedResult<TxListItem>, string | undefined>, readonly unknown[], string | undefined>({
    queryKey: historyQueryKey(chain, canonical, kind),
    queryFn: ({ pageParam, signal }) => fetchHistoryPage(requireChain(chain), canonical, kind, pageParam, signal),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor || undefined,
    enabled: supported && canonical.length > 0,
  });

  const pages = query.data?.pages;
  const items = useMemo(() => (pages ? pages.flatMap((p) => p.items) : []), [pages]);
  const { fetchNextPage, refetch, hasNextPage, isFetchingNextPage } = query;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);
  const doRefetch = useCallback(() => void refetch(), [refetch]);

  return {
    query,
    items,
    source: pages?.[0]?.source,
    hasMore: !!hasNextPage,
    isLoading: query.isLoading,
    isLoadingMore: isFetchingNextPage,
    error: query.error,
    loadMore,
    refetch: doRefetch,
    supported,
  };
}
