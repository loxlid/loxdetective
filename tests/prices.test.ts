import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChain } from '@/lib/chains/registry';
import {
  clearPriceCache,
  getPrices,
  LLAMA_PRICES_URL,
  nativePrice,
  PRICE_BATCH_SIZE,
  PRICE_CACHE_TTL_MS,
  priceKeyForToken,
  usdValue,
} from '@/lib/providers/prices';

type Coin = { price: number; symbol?: string; decimals?: number; timestamp?: number; confidence?: number };

/** Stub fetch; `price(key)` returns the coin for a requested key or undefined to omit it. */
function mockLlama(price: (key: string) => Coin | undefined, opts: { status?: number } = {}): string[][] {
  const batches: string[][] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      expect(url.startsWith(`${LLAMA_PRICES_URL}/`)).toBe(true);
      const keys = url.slice(LLAMA_PRICES_URL.length + 1).split(',');
      batches.push(keys);
      if (opts.status && opts.status >= 400) return new Response('error', { status: opts.status });
      const coins: Record<string, Coin> = {};
      for (const k of keys) {
        const c = price(k);
        if (c) coins[k] = c;
      }
      return new Response(JSON.stringify({ coins }), { status: 200 });
    }),
  );
  return batches;
}

beforeEach(() => {
  vi.restoreAllMocks();
  clearPriceCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('priceKeyForToken', () => {
  it('maps chains to DefiLlama slugs and lower-cases EVM addresses', () => {
    const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    expect(priceKeyForToken(getChain('ethereum'), usdc)).toBe(`ethereum:${usdc.toLowerCase()}`);
    expect(priceKeyForToken(getChain('avalanche'), usdc)).toBe(`avax:${usdc.toLowerCase()}`);
    expect(priceKeyForToken(getChain('gnosis'), usdc)).toBe(`xdai:${usdc.toLowerCase()}`);
    expect(priceKeyForToken(getChain('zksync'), usdc)).toBe(`era:${usdc.toLowerCase()}`);
    expect(priceKeyForToken(getChain('polygon-zkevm'), usdc)).toBe(`polygon_zkevm:${usdc.toLowerCase()}`);
    expect(priceKeyForToken(getChain('bsc'), usdc)).toBe(`bsc:${usdc.toLowerCase()}`);
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    expect(priceKeyForToken(getChain('solana'), mint)).toBe(`solana:${mint}`);
  });

  it('returns the native key for an empty / "native" address', () => {
    expect(priceKeyForToken(getChain('ethereum'), '')).toBe('coingecko:ethereum');
    expect(priceKeyForToken(getChain('bitcoin'), 'native')).toBe('coingecko:bitcoin');
  });
});

describe('getPrices', () => {
  it('splits more than 100 keys into two requests and merges the results', async () => {
    const keys = Array.from({ length: 150 }, (_, i) => `ethereum:0x${i.toString(16).padStart(40, '0')}`);
    // Price = index + 1, derived from the hex address so every key gets a finite price.
    const batches = mockLlama((k) => ({ price: parseInt(k.slice(-40), 16) + 1, confidence: 0.99 }));
    const prices = await getPrices(keys);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(PRICE_BATCH_SIZE);
    expect(batches[1]).toHaveLength(50);
    expect(Object.keys(prices)).toHaveLength(150);
    expect(prices[keys[0]]).toBe(1);
    expect(prices[keys[149]]).toBe(150);
  });

  it('caches for five minutes, de-duplicates keys and omits unknown or low-confidence ones', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));
    const batches = mockLlama((k) => {
      if (k === 'coingecko:ethereum') return { price: 2500.5, symbol: 'ETH', confidence: 0.99 };
      if (k === 'ethereum:0xscam') return { price: 1e9, confidence: 0.1 };
      return undefined;
    });

    const first = await getPrices(['coingecko:ethereum', 'coingecko:ethereum', 'ethereum:0xscam', 'ethereum:0xnothing']);
    expect(first).toEqual({ 'coingecko:ethereum': 2500.5 });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(['coingecko:ethereum', 'ethereum:0xscam', 'ethereum:0xnothing']);

    // Everything (hits and misses) is served from cache within the TTL.
    const second = await getPrices(['coingecko:ethereum', 'ethereum:0xnothing']);
    expect(second).toEqual({ 'coingecko:ethereum': 2500.5 });
    expect(batches).toHaveLength(1);

    // Only the keys that are not cached are requested.
    await getPrices(['coingecko:ethereum', 'coingecko:bitcoin']);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual(['coingecko:bitcoin']);

    vi.setSystemTime(new Date(Date.now() + PRICE_CACHE_TTL_MS + 1));
    await getPrices(['coingecko:ethereum']);
    expect(batches).toHaveLength(3);
    expect(batches[2]).toEqual(['coingecko:ethereum']);
  });

  it('matches response keys case-insensitively', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ coins: { 'ethereum:0xABCDEF': { price: 2 } } }), { status: 200 })),
    );
    expect(await getPrices(['ethereum:0xabcdef'])).toEqual({ 'ethereum:0xabcdef': 2 });
  });

  it('degrades to an empty result on failure without caching the failure', async () => {
    const failing = mockLlama(() => undefined, { status: 503 });
    expect(await getPrices(['coingecko:ethereum'])).toEqual({});
    expect(failing).toHaveLength(1);

    const ok = mockLlama(() => ({ price: 3 }));
    expect(await getPrices(['coingecko:ethereum'])).toEqual({ 'coingecko:ethereum': 3 });
    expect(ok).toHaveLength(1);
  });

  it('rethrows when the caller aborted', async () => {
    const ctrl = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        ctrl.abort(new Error('user cancelled'));
        init?.signal?.throwIfAborted();
        return new Response('{}', { status: 200 });
      }),
    );
    await expect(getPrices(['coingecko:ethereum'], ctrl.signal)).rejects.toThrow();
  });

  it('returns an empty object without a request for no keys', async () => {
    const batches = mockLlama(() => ({ price: 1 }));
    expect(await getPrices([])).toEqual({});
    expect(await getPrices(['', '  '])).toEqual({});
    expect(batches).toHaveLength(0);
  });
});

describe('nativePrice', () => {
  it('uses the chain native price key', async () => {
    const batches = mockLlama((k) => (k === 'coingecko:bitcoin' ? { price: 65_000 } : undefined));
    expect(await nativePrice(getChain('bitcoin'))).toBe(65_000);
    expect(batches[0]).toEqual(['coingecko:bitcoin']);
    expect(await nativePrice(getChain('ethereum'))).toBeUndefined();
  });

  it('returns undefined without a request when the chain has no price key', async () => {
    const batches = mockLlama(() => ({ price: 1 }));
    const chain = { ...getChain('ethereum'), native: { ...getChain('ethereum').native, priceKey: undefined } };
    expect(await nativePrice(chain)).toBeUndefined();
    expect(batches).toHaveLength(0);
  });
});

describe('usdValue', () => {
  it('converts base units with decimals and multiplies by the price', () => {
    expect(usdValue(1_500_000_000_000_000_000n, 18, 2000)).toBe(3000);
    expect(usdValue(2_500_000n, 6, 1)).toBe(2.5);
    expect(usdValue(100_000_000n, 8, 65_000)).toBe(65_000);
    expect(usdValue(0n, 18, 2000)).toBe(0);
    expect(usdValue(-1_000_000_000n, 9, 150)).toBe(-150);
  });

  it('returns undefined when the price or decimals are unusable', () => {
    expect(usdValue(1n, 18, undefined)).toBeUndefined();
    expect(usdValue(1n, 18, Number.NaN)).toBeUndefined();
    expect(usdValue(1n, -1, 1)).toBeUndefined();
    expect(usdValue(1n, 1.5, 1)).toBeUndefined();
  });
});
