import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ApprovalInfo, ApprovalScan, ChainId } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { scanApprovals } from '@/lib/providers/evm';
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

/** Same scan with labelled approvals. */
export function labelApprovalScan(chain: ChainId, scan: ApprovalScan): ApprovalScan {
  return { ...scan, approvals: labelApprovals(chain, scan.approvals) };
}

/** Text for the "Scanned blocks X–Y" footer; undefined when the span is unknown. */
export function scannedSpan(scan: Pick<ApprovalScan, 'fromBlock' | 'toBlock'> | undefined): string | undefined {
  if (!scan || scan.fromBlock === undefined || scan.toBlock === undefined) return undefined;
  return `Scanned blocks ${scan.fromBlock.toLocaleString('en-US')}–${scan.toBlock.toLocaleString('en-US')}`;
}

export function approvalsQueryKey(chain: ChainId, address: string): readonly unknown[] {
  const info = findChain(chain);
  return ['approvals', chain, cacheKey(info, canonicalAddress(info, address))] as const;
}

async function fetchScan(chain: ChainId, address: string, signal?: AbortSignal): Promise<ApprovalScan> {
  return labelApprovalScan(chain, await scanApprovals(requireChain(chain), address, signal));
}

/**
 * Approval log scan of an EVM address: the allowances found plus whether the
 * scan covered the whole block span (`scanIncomplete` + `reason` when the RPC
 * refused part of it). Disabled for other families.
 */
export function useApprovalScan(chain: ChainId, address: string): UseQueryResult<ApprovalScan, Error> {
  const info = findChain(chain);
  const canonical = canonicalAddress(info, address);
  const enabled = info?.family === 'evm' && canonical.length > 0;
  return useQuery<ApprovalScan, Error>({
    queryKey: approvalsQueryKey(chain, canonical),
    queryFn: ({ signal }) => fetchScan(chain, canonical, signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

const selectApprovals = (scan: ApprovalScan): ApprovalInfo[] => scan.approvals;

/**
 * Live token allowances granted by an EVM address (empty / disabled for other
 * families). Shares the query of {@link useApprovalScan}; use that hook when
 * the scan status matters.
 */
export function useApprovals(chain: ChainId, address: string): UseQueryResult<ApprovalInfo[], Error> {
  const info = findChain(chain);
  const canonical = canonicalAddress(info, address);
  const enabled = info?.family === 'evm' && canonical.length > 0;
  return useQuery<ApprovalScan, Error, ApprovalInfo[]>({
    queryKey: approvalsQueryKey(chain, canonical),
    queryFn: ({ signal }) => fetchScan(chain, canonical, signal),
    enabled,
    staleTime: 5 * 60_000,
    select: selectApprovals,
  });
}
