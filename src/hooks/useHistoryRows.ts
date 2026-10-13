import { useMemo } from 'react';
import type { ChainId, TxListItem } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { useAddressHistory, type AddressHistoryResult } from './useAddressHistory';
import { splitEnrichedRows, useSolEnrichedHistory, type EnrichProgress } from './useSolEnrichedHistory';

export interface HistoryRows {
  /** Native-value rows loaded so far (all pages; Solana: enriched native rows). */
  tx: TxListItem[];
  /** Token transfer rows loaded so far (EVM: token history; Solana: enriched SPL rows; Bitcoin: none). */
  token: TxListItem[];
  /** Rows of the first page only, as the risk heuristics expect (undefined until loaded). */
  firstPage: { tx?: TxListItem[]; token?: TxListItem[] };
  /** True when the loaded rows are the whole history (no further pages). */
  historyComplete: boolean;
  loading: boolean;
  errors: Error[];
  /** Solana enrichment progress (undefined elsewhere). */
  enrich?: EnrichProgress;
  txHistory: AddressHistoryResult;
  tokenHistory: AddressHistoryResult;
}

const EMPTY: TxListItem[] = [];

/**
 * Family-aware view of the loaded history rows shared by the Overview
 * (counterparties), the risk hook and the tables: EVM reads the `tx` and
 * `token` pagers, Solana splits the enriched signature pages into native and
 * SPL rows, Bitcoin only has `tx` rows. All queries share the react-query
 * cache with the tabs, so nothing is fetched twice.
 */
export function useHistoryRows(chain: ChainId, address: string): HistoryRows {
  const info = findChain(chain);
  const txH = useAddressHistory(chain, address, 'tx');
  const tokenH = useAddressHistory(chain, address, 'token');
  const sol = useSolEnrichedHistory(chain, address);
  const isSol = sol.enabled;

  const tx = useMemo(() => (isSol ? splitEnrichedRows(sol.items, 'tx') : txH.items), [isSol, sol.items, txH.items]);
  const token = useMemo(() => (isSol ? splitEnrichedRows(sol.items, 'token') : tokenH.supported ? tokenH.items : EMPTY), [isSol, sol.items, tokenH.supported, tokenH.items]);

  const rawFirstTx = txH.query.data?.pages[0]?.items;
  const rawFirstToken = tokenH.query.data?.pages[0]?.items;
  const firstPage = useMemo(() => {
    if (isSol) {
      const enriched = sol.firstPage;
      return {
        // Until the first page is enriched the raw signature rows feed the assessment (no value, no counterparty).
        tx: enriched ? splitEnrichedRows(enriched, 'tx') : rawFirstTx,
        token: enriched ? splitEnrichedRows(enriched, 'token') : undefined,
      };
    }
    return { tx: rawFirstTx, token: tokenH.supported ? rawFirstToken : undefined };
  }, [isSol, sol.firstPage, rawFirstTx, rawFirstToken, tokenH.supported]);

  const historyComplete = txH.query.isSuccess && !txH.query.hasNextPage && (!tokenH.supported || (tokenH.query.isSuccess && !tokenH.query.hasNextPage));
  const errors = [txH.error, tokenH.error].filter((e): e is Error => !!e);
  const loading = txH.isLoading || (tokenH.supported && tokenH.isLoading);

  return {
    tx,
    token,
    firstPage,
    historyComplete,
    loading: !!info && loading,
    errors,
    enrich: isSol ? sol.progress : undefined,
    txHistory: txH,
    tokenHistory: tokenH,
  };
}
