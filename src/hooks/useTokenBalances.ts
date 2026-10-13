import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ChainId, TokenBalance } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { getPrices } from '@/lib/providers/prices';
import { cacheKey, canonicalAddress, fetchTokenBalances, requireChain } from './dispatch';
import { priceBalances, tokenPriceKey } from './usePrices';

/** Sort: priced value desc, then unpriced by raw balance (per-token decimals make cross-token order approximate). */
export function sortBalances(balances: TokenBalance[]): TokenBalance[] {
  return [...balances].sort((a, b) => {
    if (a.usd !== undefined || b.usd !== undefined) return (b.usd ?? -1) - (a.usd ?? -1);
    const ua = Number(a.balance) / 10 ** a.token.decimals;
    const ub = Number(b.balance) / 10 ** b.token.decimals;
    return ub - ua;
  });
}

/** Token balances with USD values (DefiLlama prices are best-effort and never fail the query). */
export async function loadPricedBalances(chain: ChainId, address: string, signal?: AbortSignal): Promise<TokenBalance[]> {
  const info = requireChain(chain);
  const balances = await fetchTokenBalances(info, address, signal);
  const keys = balances.map((b) => tokenPriceKey(b.token)).filter((k): k is string => !!k);
  let prices: Record<string, number> = {};
  if (keys.length) {
    try {
      prices = await getPrices(keys, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      prices = {};
    }
  }
  return sortBalances(priceBalances(balances, prices));
}

export function useTokenBalances(chain: ChainId, address: string): UseQueryResult<TokenBalance[], Error> {
  const info = findChain(chain);
  const canonical = canonicalAddress(info, address);
  return useQuery<TokenBalance[], Error>({
    queryKey: ['tokens', chain, cacheKey(info, canonical)],
    queryFn: ({ signal }) => loadPricedBalances(chain, canonical, signal),
    enabled: !!info && canonical.length > 0,
  });
}
