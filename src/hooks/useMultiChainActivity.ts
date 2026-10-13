import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ChainActivity, ChainId, ChainInfo } from '@/lib/types';
import { evmChains, findChain } from '@/lib/chains/registry';
import { multiChainActivity } from '@/lib/providers/evm';
import { getPrices, usdValue } from '@/lib/providers/prices';
import { useSettings } from '@/lib/settings/store';
import { isEvmAddress } from '@/lib/detect';
import type { ChainAddressSummary } from './dispatch';

/** True when the probe succeeded and the address holds a balance or has sent a transaction there. */
export function isActiveChain(a: ChainActivity): boolean {
  if (a.error && !a.balance && a.txCount === undefined) return false;
  const funded = !!a.balance && !a.balance.error && a.balance.balance > 0n;
  return funded || (a.txCount ?? 0) > 0;
}

/**
 * Active chains first (by USD, then by transaction count, then by raw
 * amount), idle chains next, failed probes last. Stable within a rank.
 */
export function orderActivity(list: readonly ChainActivity[]): ChainActivity[] {
  const rank = (a: ChainActivity) => (isActiveChain(a) ? 0 : a.error && !a.balance && a.txCount === undefined ? 2 : 1);
  const usd = (a: ChainActivity) => (a.balance && !a.balance.error ? (a.balance.usd ?? 0) : 0);
  const amount = (a: ChainActivity) => (a.balance && !a.balance.error ? Number(a.balance.balance) / 10 ** a.balance.decimals : 0);
  return list
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const r = rank(x.a) - rank(y.a);
      if (r) return r;
      const u = usd(y.a) - usd(x.a);
      if (u) return u;
      const t = (y.a.txCount ?? 0) - (x.a.txCount ?? 0);
      if (t) return t;
      const m = amount(y.a) - amount(x.a);
      if (m) return m;
      return x.i - y.i;
    })
    .map((x) => x.a);
}

/** Chains other than `current` where the address is active, most active first (for the "active elsewhere" callout). */
export function otherActiveChains(list: readonly ChainActivity[], current: ChainId): ChainActivity[] {
  return orderActivity(list.filter((a) => a.chain !== current && isActiveChain(a)));
}

/**
 * True when the loaded summary shows no activity on its own chain (EVM: zero
 * nonce and zero balance). Used to decide whether to point at other chains.
 */
export function summaryLooksInactive(summary: ChainAddressSummary | undefined): boolean {
  if (!summary) return false;
  if (summary.isContract) return false;
  const bal = summary.nativeBalance;
  const zeroBalance = !!bal && !bal.error && bal.balance === 0n;
  return summary.txCount === 0 && zeroBalance;
}

/** Native balance + nonce on every EVM chain with USD where a price is known. Never rejects on RPC failure. */
export async function loadMultiChainActivity(address: string, includeTestnets: boolean, signal?: AbortSignal): Promise<ChainActivity[]> {
  const chains = evmChains(includeTestnets);
  const activity = await multiChainActivity(chains, address, signal);
  const keys = Array.from(new Set(chains.map((c) => c.native.priceKey).filter((k): k is string => !!k)));
  let prices: Record<string, number> = {};
  try {
    prices = await getPrices(keys, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  const byId = new Map<ChainId, ChainInfo>(chains.map((c) => [c.id, c]));
  return activity.map((a) => {
    const b = a.balance;
    if (!b || b.error) return a;
    const key = byId.get(a.chain)?.native.priceKey;
    const usd = usdValue(b.balance, b.decimals, key ? prices[key] : undefined);
    return usd === undefined ? a : { ...a, balance: { ...b, usd } };
  });
}

export function multiChainActivityQueryKey(address: string, includeTestnets: boolean): readonly unknown[] {
  return ['multi-activity', address.trim().toLowerCase(), includeTestnets] as const;
}

/** Multi-chain activity strip for an EVM address (disabled for non-EVM input). */
export function useMultiChainActivity(address: string): UseQueryResult<ChainActivity[], Error> {
  const includeTestnets = useSettings((s) => s.showTestnets);
  const a = (address ?? '').trim();
  const enabled = isEvmAddress(a);
  return useQuery<ChainActivity[], Error>({
    queryKey: multiChainActivityQueryKey(a, includeTestnets),
    queryFn: ({ signal }) => loadMultiChainActivity(a, includeTestnets, signal),
    enabled,
    staleTime: 2 * 60_000,
  });
}

/** Display name of a chain id (falls back to the id). */
export function chainName(id: ChainId): string {
  return findChain(id)?.name ?? id;
}
