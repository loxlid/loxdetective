/**
 * Chain-family dispatch for the data hooks.
 *
 * Pages ask for "the summary of address X on chain Y"; this module routes the
 * call to the EVM façade, the Bitcoin Esplora provider or the Solana RPC
 * provider based on `ChainInfo.family`. Everything here is a plain async
 * function so it can be unit-tested with a mocked `fetch` and reused by
 * non-React code (e.g. the fund-flow tracer).
 */
import { getAddress, isAddress } from 'viem';
import type { AddressSummary, ChainId, ChainInfo, PagedResult, TokenBalance, Transaction, TxListItem } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { getAddressHistory, getAddressSummary, getTokenBalances, getTransactionFull, type HistoryKind } from '@/lib/providers/evm';
import { btcAddressSummary, btcAddressTxs, btcTransaction } from '@/lib/providers/btc/esplora';
import { solAddressSummary, solSignatures, solTokenBalances, solTransaction } from '@/lib/providers/sol/rpc';

export type { HistoryKind };

/** Address summary plus the family-specific extras the BTC / Solana providers attach. */
export type ChainAddressSummary = AddressSummary &
  Partial<{
    /** Bitcoin */
    utxoCount: number;
    received: bigint;
    sent: bigint;
    /** Solana */
    executable: boolean;
    owner: string;
    lamports: bigint;
    accountType: string;
  }>;

const BTC_SOURCE = 'esplora';
const SOL_SOURCE = 'solana-rpc';

/** Resolve a chain id or throw a readable error (hooks disable themselves before this can throw). */
export function requireChain(chain: ChainId): ChainInfo {
  const info = findChain(chain);
  if (!info) throw new Error(`Unknown chain: ${chain}`);
  return info;
}

/**
 * Display form of an address for a chain: checksummed for EVM, lower-cased
 * for bech32 Bitcoin, verbatim (base58 is case-sensitive) otherwise.
 */
export function canonicalAddress(chain: ChainInfo | undefined, address: string): string {
  const a = (address ?? '').trim();
  if (!chain) return a;
  if (chain.family === 'evm') return isAddress(a, { strict: false }) ? getAddress(a) : a;
  if (chain.family === 'bitcoin' && /^bc1/i.test(a)) return a.toLowerCase();
  return a;
}

/** Cache key form of an address / hash: case-folded where the chain is case-insensitive. */
export function cacheKey(chain: ChainInfo | undefined, value: string): string {
  const v = (value ?? '').trim();
  if (!chain) return v;
  if (chain.family === 'evm') return v.toLowerCase();
  if (chain.family === 'bitcoin' && (/^bc1/i.test(v) || /^[0-9a-f]{64}$/i.test(v))) return v.toLowerCase();
  return v;
}

/** Whether a history kind exists for the chain family (BTC / Solana only expose plain tx lists). */
export function historySupported(chain: ChainInfo, kind: HistoryKind): boolean {
  return chain.family === 'evm' || kind === 'tx';
}

export async function fetchAddressSummary(chain: ChainInfo, address: string, signal?: AbortSignal): Promise<ChainAddressSummary> {
  switch (chain.family) {
    case 'evm':
      return getAddressSummary(chain, address, signal);
    case 'bitcoin':
      return btcAddressSummary(address, signal);
    case 'solana':
      return solAddressSummary(address, signal);
    default:
      throw new Error(`Unsupported chain family for ${chain.id}`);
  }
}

/** One page of history. Non-EVM chains answer token / internal requests with an empty page. */
export async function fetchHistoryPage(
  chain: ChainInfo,
  address: string,
  kind: HistoryKind,
  cursor?: string,
  signal?: AbortSignal,
): Promise<PagedResult<TxListItem>> {
  if (chain.family === 'evm') return getAddressHistory(chain, address, { cursor, kind }, signal);
  if (chain.family === 'bitcoin') {
    if (kind !== 'tx') return { items: [], source: BTC_SOURCE };
    return btcAddressTxs(address, cursor, signal);
  }
  if (kind !== 'tx') return { items: [], source: SOL_SOURCE };
  return solSignatures(address, cursor, 25, signal);
}

export async function fetchTokenBalances(chain: ChainInfo, address: string, signal?: AbortSignal): Promise<TokenBalance[]> {
  switch (chain.family) {
    case 'evm':
      return getTokenBalances(chain, address, signal);
    case 'solana':
      return solTokenBalances(address, signal);
    default:
      return [];
  }
}

export async function fetchTransaction(chain: ChainInfo, hash: string, signal?: AbortSignal): Promise<Transaction> {
  switch (chain.family) {
    case 'evm':
      return getTransactionFull(chain, hash, signal);
    case 'bitcoin':
      return btcTransaction(hash, signal);
    case 'solana':
      return solTransaction(hash, signal);
    default:
      throw new Error(`Unsupported chain family for ${chain.id}`);
  }
}
