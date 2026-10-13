import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { btcUtxos } from '@/lib/providers/btc/esplora';
import { findChain } from '@/lib/chains/registry';
import { cacheKey, canonicalAddress } from './dispatch';

export type BtcUtxo = Awaited<ReturnType<typeof btcUtxos>>[number];

export interface UtxoSummary {
  count: number;
  confirmed: number;
  /** Sum of every unspent output in satoshis. */
  total: bigint;
  /** Largest outputs first, at most `top` of them. */
  top: BtcUtxo[];
}

export const UTXO_TOP_DEFAULT = 10;

/** Count, total and the largest outputs of a UTXO list (pure). */
export function summarizeUtxos(utxos: readonly BtcUtxo[], top = UTXO_TOP_DEFAULT): UtxoSummary {
  let total = 0n;
  let confirmed = 0;
  for (const u of utxos) {
    total += u.value;
    if (u.confirmed) confirmed++;
  }
  const sorted = [...utxos].sort((a, b) => (a.value === b.value ? (a.confirmed === b.confirmed ? 0 : a.confirmed ? -1 : 1) : b.value > a.value ? 1 : -1));
  return { count: utxos.length, confirmed, total, top: sorted.slice(0, Math.max(0, top)) };
}

export function btcUtxosQueryKey(address: string): readonly unknown[] {
  const info = findChain('bitcoin');
  return ['btc-utxos', cacheKey(info, canonicalAddress(info, address))] as const;
}

/**
 * Unspent outputs of a Bitcoin address, loaded lazily: the query only runs
 * while `enabled` is true (the UTXO card passes it when it is shown).
 */
export function useBtcUtxos(address: string, enabled = true): UseQueryResult<BtcUtxo[], Error> {
  const info = findChain('bitcoin');
  const canonical = canonicalAddress(info, address);
  return useQuery<BtcUtxo[], Error>({
    queryKey: btcUtxosQueryKey(canonical),
    queryFn: ({ signal }) => btcUtxos(canonical, signal),
    enabled: enabled && !!info && canonical.length > 0,
    staleTime: 60_000,
  });
}
