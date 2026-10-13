import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ChainId, ContractInfo } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { getContractInfo } from '@/lib/providers/evm';
import { cacheKey, canonicalAddress, requireChain } from './dispatch';

/** Verification / proxy details for an EVM contract. Pass `enabled=false` for EOAs to skip the calls. */
export function useContractInfo(chain: ChainId, address: string, enabled = true): UseQueryResult<ContractInfo, Error> {
  const info = findChain(chain);
  const canonical = canonicalAddress(info, address);
  return useQuery<ContractInfo, Error>({
    queryKey: ['contract', chain, cacheKey(info, canonical)],
    queryFn: ({ signal }) => getContractInfo(requireChain(chain), canonical, signal),
    enabled: enabled && info?.family === 'evm' && canonical.length > 0,
    staleTime: 10 * 60_000,
  });
}
