import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ApprovalInfo, ChainId } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { getApprovals } from '@/lib/providers/evm';
import { lookupLabel } from '@/lib/intel/labels';
import { cacheKey, canonicalAddress, requireChain } from './dispatch';

/** Fill `spenderLabel` from the label registry (the EVM module leaves it empty on purpose). */
export function labelApprovals(chain: ChainId, approvals: ApprovalInfo[]): ApprovalInfo[] {
  return approvals.map((a) => {
    if (a.spenderLabel) return a;
    const label = lookupLabel(a.spender, chain);
    return label ? { ...a, spenderLabel: label.name } : a;
  });
}

/** Live token allowances granted by an EVM address (empty / disabled for other families). */
export function useApprovals(chain: ChainId, address: string): UseQueryResult<ApprovalInfo[], Error> {
  const info = findChain(chain);
  const canonical = canonicalAddress(info, address);
  const enabled = info?.family === 'evm' && canonical.length > 0;
  return useQuery<ApprovalInfo[], Error>({
    queryKey: ['approvals', chain, cacheKey(info, canonical)],
    queryFn: async ({ signal }) => labelApprovals(chain, await getApprovals(requireChain(chain), canonical, signal)),
    enabled,
    staleTime: 5 * 60_000,
  });
}
