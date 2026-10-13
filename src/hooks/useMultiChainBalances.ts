import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { NativeBalance } from '@/lib/types';
import { evmChains } from '@/lib/chains/registry';
import { multiChainBalances } from '@/lib/providers/evm';
import { getPrices, usdValue } from '@/lib/providers/prices';
import { useSettings } from '@/lib/settings/store';
import { isEvmAddress } from '@/lib/detect';

/** Native balance on every EVM chain with USD where a price is known; RPC failures surface as `.error` per chain. */
export async function loadMultiChainBalances(address: string, includeTestnets: boolean, signal?: AbortSignal): Promise<NativeBalance[]> {
  const chains = evmChains(includeTestnets);
  const balances = await multiChainBalances(chains, address, signal);
  const keys = Array.from(new Set(chains.map((c) => c.native.priceKey).filter((k): k is string => !!k)));
  let prices: Record<string, number> = {};
  try {
    prices = await getPrices(keys, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  return balances.map((b) => {
    const key = chains.find((c) => c.id === b.chain)?.native.priceKey;
    const usd = b.error ? undefined : usdValue(b.balance, b.decimals, key ? prices[key] : undefined);
    return usd === undefined ? b : { ...b, usd };
  });
}

/** Multi-chain native balance strip for an EVM address (disabled for non-EVM input). */
export function useMultiChainBalances(address: string): UseQueryResult<NativeBalance[], Error> {
  const includeTestnets = useSettings((s) => s.showTestnets);
  const a = (address ?? '').trim();
  const enabled = isEvmAddress(a);
  return useQuery<NativeBalance[], Error>({
    queryKey: ['multi-balances', a.toLowerCase(), includeTestnets],
    queryFn: ({ signal }) => loadMultiChainBalances(a, includeTestnets, signal),
    enabled,
    staleTime: 2 * 60_000,
  });
}
