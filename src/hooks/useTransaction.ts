import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ChainId, Transaction } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { cacheKey, fetchTransaction, requireChain } from './dispatch';

export function transactionQueryKey(chain: ChainId, hash: string): readonly unknown[] {
  return ['tx', chain, cacheKey(findChain(chain), hash)] as const;
}

/** Full transaction (receipt, decoded transfers, logs / inputs / outputs) for any chain family. */
export function useTransaction(chain: ChainId, hash: string): UseQueryResult<Transaction, Error> {
  const info = findChain(chain);
  const h = (hash ?? '').trim();
  return useQuery<Transaction, Error>({
    queryKey: transactionQueryKey(chain, h),
    queryFn: ({ signal }) => fetchTransaction(requireChain(chain), h, signal),
    enabled: !!info && h.length > 0,
    // A hash either exists or it does not; do not hammer public RPCs for "not found".
    retry: (count, err) => count < 1 && !/not found/i.test(err.message),
  });
}
