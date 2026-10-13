import { useMemo } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ChainId, TokenBalance, TokenInfo } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { PRICE_CACHE_TTL_MS, getPrices, priceKeyForToken, usdValue, type PriceKey } from '@/lib/providers/prices';

/** Stable, de-duplicated, sorted key list so the query key does not churn. */
export function normalizePriceKeys(keys: readonly PriceKey[]): PriceKey[] {
  return Array.from(new Set(keys.map((k) => k.trim()).filter(Boolean))).sort();
}

/** USD prices for DefiLlama keys. Never errors on network failure (missing keys are simply absent). */
export function usePrices(keys: readonly PriceKey[]): UseQueryResult<Record<PriceKey, number>, Error> {
  const normalized = useMemo(() => normalizePriceKeys(keys), [keys]);
  return useQuery<Record<PriceKey, number>, Error>({
    queryKey: ['prices', normalized],
    queryFn: ({ signal }) => getPrices(normalized, signal),
    enabled: normalized.length > 0,
    staleTime: PRICE_CACHE_TTL_MS,
    placeholderData: (prev) => prev,
  });
}

/** Price of a chain's native coin (undefined while loading or unknown). */
export function useNativePrice(chain: ChainId | undefined): number | undefined {
  const info = chain ? findChain(chain) : undefined;
  const key = info?.native.priceKey;
  const keys = useMemo(() => (key ? [key] : []), [key]);
  const q = usePrices(keys);
  return key ? q.data?.[key] : undefined;
}

/** Price key for a token on its chain (native coins use the chain's key). */
export function tokenPriceKey(token: TokenInfo): PriceKey | undefined {
  const info = findChain(token.chain);
  if (!info) return undefined;
  return priceKeyForToken(info, token.type === 'native' ? '' : token.address);
}

/** Attach `usd` to balances from a price map (pure; used by hooks and tests). */
export function priceBalances(balances: TokenBalance[], prices: Record<PriceKey, number>): TokenBalance[] {
  return balances.map((b) => {
    const key = tokenPriceKey(b.token);
    const price = key ? prices[key] : undefined;
    const usd = usdValue(b.balance, b.token.decimals, price);
    return usd === undefined ? b : { ...b, usd };
  });
}
