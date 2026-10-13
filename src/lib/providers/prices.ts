/**
 * USD prices via the DefiLlama coins API (keyless, CORS-enabled).
 *
 * `GET https://coins.llama.fi/prices/current/<key>,<key>,…` →
 * `{ coins: { [key]: { price, symbol, decimals, timestamp, confidence } } }`.
 *
 * Requests are batched (≤100 keys), results are cached in memory for five
 * minutes (misses included, so unknown tokens are not re-queried on every
 * render) and failures degrade to "no price" rather than throwing.
 */
import { formatUnits } from 'viem';
import { fetchJson, mapLimit } from '@/lib/http';
import type { ChainId, ChainInfo } from '@/lib/types';

/** 'coingecko:ethereum' | 'ethereum:0xa0b8…' | 'solana:<mint>' | 'bsc:0x…' */
export type PriceKey = string;

export const LLAMA_PRICES_URL = 'https://coins.llama.fi/prices/current';
export const PRICE_CACHE_TTL_MS = 5 * 60_000;
export const PRICE_BATCH_SIZE = 100;
/** DefiLlama confidence (0–1) below which a price is treated as unknown (thin / fake markets). */
export const PRICE_MIN_CONFIDENCE = 0.5;
const BATCH_CONCURRENCY = 3;

/** LoxDetective chain id → DefiLlama chain slug. */
export const LLAMA_CHAIN_SLUGS: Record<ChainId, string> = {
  ethereum: 'ethereum',
  bsc: 'bsc',
  polygon: 'polygon',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  base: 'base',
  avalanche: 'avax',
  gnosis: 'xdai',
  fantom: 'fantom',
  zksync: 'era',
  linea: 'linea',
  scroll: 'scroll',
  'polygon-zkevm': 'polygon_zkevm',
  blast: 'blast',
  mantle: 'mantle',
  celo: 'celo',
  cronos: 'cronos',
  moonbeam: 'moonbeam',
  solana: 'solana',
  bitcoin: 'bitcoin',
};

interface LlamaCoin {
  price?: number;
  symbol?: string;
  decimals?: number;
  timestamp?: number;
  confidence?: number;
}

interface LlamaResponse {
  coins?: Record<string, LlamaCoin>;
}

interface CacheEntry {
  /** undefined = DefiLlama answered but knows no price for the key. */
  price?: number;
  fetchedAt: number;
}

const cache = new Map<PriceKey, CacheEntry>();

/** Drop every cached price (tests, settings reset). */
export function clearPriceCache(): void {
  cache.clear();
}

/**
 * Price key for a token on a chain. An empty address or 'native' yields the
 * chain's native key. EVM addresses are lower-cased; Solana mints are
 * case-sensitive and kept as-is.
 */
export function priceKeyForToken(chain: ChainInfo, tokenAddress: string): PriceKey {
  const addr = tokenAddress.trim();
  if (!addr || addr.toLowerCase() === 'native') return chain.native.priceKey ?? `coingecko:${chain.id}`;
  const slug = LLAMA_CHAIN_SLUGS[chain.id] ?? chain.id;
  return `${slug}:${chain.family === 'evm' ? addr.toLowerCase() : addr}`;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function usablePrice(coin: LlamaCoin | undefined): number | undefined {
  if (!coin || typeof coin.price !== 'number' || !Number.isFinite(coin.price) || coin.price < 0) return undefined;
  if (typeof coin.confidence === 'number' && coin.confidence < PRICE_MIN_CONFIDENCE) return undefined;
  return coin.price;
}

/**
 * Fetch one batch. Returns a lower-cased key → price map, or undefined when
 * the request failed (so the keys are neither returned nor cached).
 */
async function fetchBatch(keys: readonly PriceKey[], signal?: AbortSignal): Promise<Map<string, number | undefined> | undefined> {
  // Keys are already URL-safe (`chain:address`, base58 mints), matching DefiLlama's documented form.
  const url = `${LLAMA_PRICES_URL}/${keys.join(',')}`;
  try {
    const res = await fetchJson<LlamaResponse>(url, { signal, timeoutMs: 10_000 });
    const found = new Map<string, number | undefined>();
    for (const [key, coin] of Object.entries(res?.coins ?? {})) found.set(key.toLowerCase(), usablePrice(coin));
    return found;
  } catch (err) {
    if (signal?.aborted) throw err;
    return undefined;
  }
}

/**
 * Current USD prices for the given keys. Keys without a price are omitted.
 * Batches of ≤100 keys, five-minute in-memory cache, tolerant to failures.
 */
export async function getPrices(keys: PriceKey[], signal?: AbortSignal): Promise<Record<PriceKey, number>> {
  const out: Record<PriceKey, number> = {};
  const now = Date.now();
  const missing: PriceKey[] = [];
  const seen = new Set<PriceKey>();

  for (const raw of keys) {
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const hit = cache.get(key);
    if (hit && now - hit.fetchedAt < PRICE_CACHE_TTL_MS) {
      if (hit.price !== undefined) out[key] = hit.price;
    } else {
      missing.push(key);
    }
  }
  if (missing.length === 0) return out;

  await mapLimit(chunk(missing, PRICE_BATCH_SIZE), BATCH_CONCURRENCY, async (batch) => {
    const found = await fetchBatch(batch, signal);
    if (!found) return;
    const fetchedAt = Date.now();
    for (const key of batch) {
      const price = found.get(key.toLowerCase());
      cache.set(key, { price, fetchedAt });
      if (price !== undefined) out[key] = price;
    }
  });
  return out;
}

/** USD price of a chain's native coin, if the chain declares a price key. */
export async function nativePrice(chain: ChainInfo, signal?: AbortSignal): Promise<number | undefined> {
  const key = chain.native.priceKey;
  if (!key) return undefined;
  const prices = await getPrices([key], signal);
  return prices[key];
}

/** USD value of a base-unit amount; undefined when the price is unknown or the maths is not finite. */
export function usdValue(raw: bigint, decimals: number, price: number | undefined): number | undefined {
  if (price === undefined || !Number.isFinite(price)) return undefined;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) return undefined;
  const quantity = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(quantity)) return undefined;
  const value = quantity * price;
  return Number.isFinite(value) ? value : undefined;
}
