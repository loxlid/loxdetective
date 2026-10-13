import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ChainId } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { cacheKey, canonicalAddress, fetchAddressSummary, requireChain, type ChainAddressSummary } from './dispatch';

export function summaryQueryKey(chain: ChainId, address: string): readonly unknown[] {
  return ['summary', chain, cacheKey(findChain(chain), address)] as const;
}

/** Address summary (balance, nonce, contract flag, ENS, labels from explorers) for any chain family. */
export function useAddressSummary(chain: ChainId, address: string): UseQueryResult<ChainAddressSummary, Error> {
  const info = findChain(chain);
  const canonical = canonicalAddress(info, address);
  return useQuery<ChainAddressSummary, Error>({
    queryKey: summaryQueryKey(chain, canonical),
    queryFn: ({ signal }) => fetchAddressSummary(requireChain(chain), canonical, signal),
    enabled: !!info && canonical.length > 0,
  });
}
