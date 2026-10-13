import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_LABELS, lookupLabel, resetLabels } from '@/lib/intel/labels';
import {
  BUILTIN_SANCTIONED,
  SANCTIONS_CACHE_KEY,
  SANCTIONS_CACHE_TTL_MS,
  SANCTIONS_FEED_BTC_URL,
  SANCTIONS_FEED_SOURCE,
  SANCTIONS_FEED_URL,
  clearSanctionsCache,
  isSanctioned,
  loadSanctionsFeed,
  sanctionedCount,
  sanctionsFeedInfo,
} from '@/lib/intel/sanctions';

const RONIN_EXPLOITER = '0x098B716B8Aaf21512996dC57EB0615e2383E2f96';
const TORNADO_10_ETH = '0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF';
const FEED_ETH_1 = '0x8589427373D6D84E98730D7795D8f6f8731FDA16'; // checksummed, as published
const FEED_ETH_2 = '0x722122DF12D4E14E13AC3B6895A86E84145B6967'; // upper-case variant
const FEED_BTC_1 = '12QtD5BFwRsdNsAZY76UVE1xyCGNTojH9h';
const FEED_BTC_2 = 'bc1qw4cxpe6sxa5dg46xulj87ndv9zdyt3ldz3qyj3';
const RANDOM = '0x1234567890123456789012345678901234567890';

/** Minimal in-memory localStorage; `throwing` simulates a blocked storage. */
function makeStorage(throwing = false): Storage {
  const mem = new Map<string, string>();
  const guard = () => {
    if (throwing) throw new Error('storage blocked');
  };
  return {
    get length() {
      guard();
      return mem.size;
    },
    clear: () => {
      guard();
      mem.clear();
    },
    getItem: (k: string) => {
      guard();
      return mem.get(k) ?? null;
    },
    key: (i: number) => {
      guard();
      return Array.from(mem.keys())[i] ?? null;
    },
    removeItem: (k: string) => {
      guard();
      mem.delete(k);
    },
    setItem: (k: string, v: string) => {
      guard();
      mem.set(k, v);
    },
  } as Storage;
}

type Route = { status?: number; body?: unknown; reject?: boolean };

/** Stub fetch with per-URL routes; returns the mock so tests can inspect calls. */
function mockFeed(routes: Partial<Record<'eth' | 'btc', Route>>) {
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const key = url === SANCTIONS_FEED_URL ? 'eth' : url === SANCTIONS_FEED_BTC_URL ? 'btc' : undefined;
    if (!key) return new Response('not found', { status: 404 });
    const route = routes[key] ?? {};
    if (route.reject) throw new TypeError('network down');
    return new Response(JSON.stringify(route.body ?? []), { status: route.status ?? 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const GOOD_ROUTES = { eth: { body: [FEED_ETH_1, FEED_ETH_2] }, btc: { body: [FEED_BTC_1, FEED_BTC_2] } };

let storage: Storage;

beforeEach(() => {
  storage = makeStorage();
  vi.stubGlobal('localStorage', storage);
  resetLabels();
  clearSanctionsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('BUILTIN_SANCTIONED / isSanctioned', () => {
  it('ships a sanctioned snapshot with the Tornado set and Lazarus entries', () => {
    expect(BUILTIN_SANCTIONED.length).toBeGreaterThanOrEqual(20);
    for (const l of BUILTIN_SANCTIONED) {
      expect(l.category).toBe('sanctioned');
      expect(l.source).toBe('OFAC SDN (builtin snapshot)');
      expect(l.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    expect(BUILTIN_SANCTIONED.some((l) => l.address === RONIN_EXPLOITER)).toBe(true);
    expect(BUILTIN_SANCTIONED.some((l) => l.address === TORNADO_10_ETH)).toBe(true);
  });

  it('matches builtin entries case-insensitively and ignores unknown addresses', () => {
    expect(isSanctioned(RONIN_EXPLOITER)?.name).toMatch(/Lazarus/);
    expect(isSanctioned(RONIN_EXPLOITER.toLowerCase())?.name).toMatch(/Lazarus/);
    expect(isSanctioned(RONIN_EXPLOITER.toUpperCase().replace('0X', '0x'))).toBeDefined();
    expect(isSanctioned(TORNADO_10_ETH.toLowerCase())?.category).toBe('sanctioned');
    expect(isSanctioned(RANDOM)).toBeUndefined();
    expect(isSanctioned('')).toBeUndefined();
  });

  it('names the Tornado stablecoin pools by their real denominations and agrees with the label list', () => {
    const name = (a: string) => BUILTIN_SANCTIONED.find((l) => l.address.toLowerCase() === a.toLowerCase())?.name;
    expect(name('0xd96f2B1c14Db8458374d9Aca76E26c3D18364307')).toMatch(/^Tornado Cash: 100 USDC pool/);
    expect(name('0x4736dCf1b7A3d580672CcE6E7c65cd5cc9cFBa19')).toMatch(/^Tornado Cash: 1,000 USDC pool/);
    expect(name('0x169AD27A470D064DEDE56a2D3ff727986b15D52B')).toMatch(/^Tornado Cash: 100 USDT pool/);
    expect(name('0x0836222F2B2B24A3F36f98668Ed8F0B38D1a872f')).toMatch(/^Tornado Cash: 1,000 USDT pool/);
    expect(BUILTIN_SANCTIONED.some((l) => /10,000 USDC/.test(l.name))).toBe(false);
    // Every Tornado pool here is also a builtin label, and both files agree on the denomination.
    for (const s of BUILTIN_SANCTIONED.filter((l) => /^Tornado Cash: .* pool/.test(l.name))) {
      const l = BUILTIN_LABELS.find((b) => b.address.toLowerCase() === s.address.toLowerCase());
      expect(l, s.address).toBeDefined();
      expect(s.name.startsWith(`${l!.name} (`), `${s.name} vs ${l!.name}`).toBe(true);
    }
  });

  it('registers builtin entries in the shared label registry', () => {
    expect(lookupLabel(RONIN_EXPLOITER, 'base')?.category).toBe('sanctioned');
    expect(lookupLabel(TORNADO_10_ETH, 'ethereum')?.category).toBe('sanctioned');
    expect(lookupLabel(TORNADO_10_ETH, 'ethereum')?.name).toMatch(/Tornado Cash/);
  });
});

describe('loadSanctionsFeed', () => {
  it('fetches both lists, normalises, registers labels and caches', async () => {
    const fetchMock = mockFeed(GOOD_ROUTES);
    const before = sanctionedCount();
    const res = await loadSanctionsFeed();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => String(c[0])).sort();
    expect(urls).toEqual([SANCTIONS_FEED_URL, SANCTIONS_FEED_BTC_URL].sort());

    expect(res.fetchedAt).toBeGreaterThan(0);
    expect(res.eth).toContain(FEED_ETH_1.toLowerCase());
    expect(res.eth).toContain(FEED_ETH_2.toLowerCase());
    expect(res.eth).not.toContain(FEED_ETH_1); // lower-cased
    expect(res.eth).toContain(RONIN_EXPLOITER.toLowerCase()); // builtin merged in
    expect(res.btc).toEqual(expect.arrayContaining([FEED_BTC_1, FEED_BTC_2]));

    expect(sanctionedCount()).toBeGreaterThan(before);
    expect(isSanctioned(FEED_ETH_1)?.source).toBe(SANCTIONS_FEED_SOURCE);
    expect(isSanctioned(FEED_ETH_1.toLowerCase())).toBeDefined();
    expect(isSanctioned(FEED_BTC_1)).toBeDefined();
    expect(isSanctioned(FEED_BTC_2.toUpperCase())).toBeDefined();

    const l = lookupLabel(FEED_ETH_1, 'base');
    expect(l?.category).toBe('sanctioned');
    expect(l?.chain).toBe('evm');
    expect(lookupLabel(FEED_BTC_1, 'bitcoin')?.chain).toBe('bitcoin');
    expect(lookupLabel(FEED_BTC_1, 'ethereum')).toBeUndefined();

    const cached = JSON.parse(storage.getItem(SANCTIONS_CACHE_KEY) ?? 'null');
    expect(cached.eth).toEqual([FEED_ETH_1.toLowerCase(), FEED_ETH_2.toLowerCase()]);
    expect(cached.btc).toEqual([FEED_BTC_1, FEED_BTC_2]);
    expect(cached.fetchedAt).toBe(res.fetchedAt);
    expect(sanctionsFeedInfo()).toEqual({ fetchedAt: res.fetchedAt, eth: 2, btc: 2 });
  });

  it('filters malformed entries and de-duplicates', async () => {
    mockFeed({
      eth: { body: [FEED_ETH_1, FEED_ETH_1.toLowerCase(), 'not-an-address', 42, null, '0x1234', { a: 1 }] },
      btc: { body: ['', 'xyz', FEED_BTC_1, FEED_BTC_1, 7] },
    });
    const res = await loadSanctionsFeed();
    const feedEth = res.eth.filter((a) => a === FEED_ETH_1.toLowerCase());
    expect(feedEth).toHaveLength(1);
    expect(res.eth.every((a) => /^0x[0-9a-f]{40}$/.test(a))).toBe(true);
    expect(res.btc).toEqual([FEED_BTC_1]);
  });

  it('tolerates a non-array payload', async () => {
    mockFeed({ eth: { body: { error: 'oops' } }, btc: { body: 'nope' } });
    const res = await loadSanctionsFeed();
    expect(res.fetchedAt).toBeGreaterThan(0);
    expect(res.eth).toContain(RONIN_EXPLOITER.toLowerCase());
    expect(res.btc).toEqual([]);
  });

  it('serves a fresh localStorage cache without hitting the network', async () => {
    const first = mockFeed(GOOD_ROUTES);
    const res1 = await loadSanctionsFeed();
    expect(first).toHaveBeenCalledTimes(2);

    // Forget the in-memory state (and the registered labels) but keep localStorage.
    clearSanctionsCache({ storage: false });
    resetLabels();
    expect(isSanctioned(FEED_ETH_1)).toBeUndefined();

    const second = mockFeed(GOOD_ROUTES);
    const res2 = await loadSanctionsFeed();
    expect(second).not.toHaveBeenCalled();
    expect(res2.fetchedAt).toBe(res1.fetchedAt);
    expect(res2.eth).toEqual(res1.eth);
    expect(isSanctioned(FEED_ETH_1)).toBeDefined();
    expect(lookupLabel(FEED_ETH_1, 'ethereum')?.category).toBe('sanctioned');
  });

  it('memoises within the session and shares one in-flight request', async () => {
    const fetchMock = mockFeed(GOOD_ROUTES);
    const [a, b] = await Promise.all([loadSanctionsFeed(), loadSanctionsFeed()]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(a.fetchedAt).toBe(b.fetchedAt);
    await loadSanctionsFeed();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refetches when the cache is older than 24h', async () => {
    storage.setItem(
      SANCTIONS_CACHE_KEY,
      JSON.stringify({ eth: [RANDOM], btc: [], fetchedAt: Date.now() - SANCTIONS_CACHE_TTL_MS - 1000 }),
    );
    const fetchMock = mockFeed(GOOD_ROUTES);
    const res = await loadSanctionsFeed();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.eth).toContain(FEED_ETH_1.toLowerCase());
    expect(res.eth).not.toContain(RANDOM);
    expect(Date.now() - res.fetchedAt).toBeLessThan(SANCTIONS_CACHE_TTL_MS);
  });

  it('ignores a corrupt cache entry', async () => {
    storage.setItem(SANCTIONS_CACHE_KEY, '{not json');
    const fetchMock = mockFeed(GOOD_ROUTES);
    await loadSanctionsFeed();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    storage.setItem(SANCTIONS_CACHE_KEY, JSON.stringify({ eth: 'x', fetchedAt: 'yesterday' }));
    clearSanctionsCache({ storage: false });
    const again = mockFeed(GOOD_ROUTES);
    await loadSanctionsFeed();
    expect(again).toHaveBeenCalledTimes(2);
  });

  it('falls back to the builtin snapshot when the network fails', async () => {
    mockFeed({ eth: { reject: true }, btc: { status: 500 } });
    const res = await loadSanctionsFeed();
    expect(res.fetchedAt).toBe(0);
    expect(res.eth).toEqual(BUILTIN_SANCTIONED.map((l) => l.address.toLowerCase()));
    expect(res.btc).toEqual([]);
    expect(storage.getItem(SANCTIONS_CACHE_KEY)).toBeNull();
    expect(isSanctioned(RONIN_EXPLOITER)).toBeDefined();
    expect(sanctionsFeedInfo()).toBeUndefined();
  });

  it('falls back to a stale cache when the network fails', async () => {
    const staleAt = Date.now() - 2 * SANCTIONS_CACHE_TTL_MS;
    storage.setItem(SANCTIONS_CACHE_KEY, JSON.stringify({ eth: [FEED_ETH_1], btc: [FEED_BTC_1], fetchedAt: staleAt }));
    mockFeed({ eth: { status: 503 }, btc: { reject: true } });
    const res = await loadSanctionsFeed();
    expect(res.fetchedAt).toBe(staleAt);
    expect(res.eth).toContain(FEED_ETH_1.toLowerCase());
    expect(res.btc).toEqual([FEED_BTC_1]);
    expect(isSanctioned(FEED_ETH_1)).toBeDefined();
  });

  it('uses the lists that did load on partial failure and does not cache them for 24h', async () => {
    const fetchMock = mockFeed({ eth: { body: [FEED_ETH_1] }, btc: { status: 500 } });
    const res = await loadSanctionsFeed();
    expect(res.fetchedAt).toBeGreaterThan(0);
    expect(res.eth).toContain(FEED_ETH_1.toLowerCase());
    expect(res.btc).toEqual([]);
    expect(isSanctioned(FEED_ETH_1)).toBeDefined();
    expect(storage.getItem(SANCTIONS_CACHE_KEY)).toBeNull();
    // A later call retries instead of trusting the partial result.
    await loadSanctionsFeed();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('works when localStorage throws', async () => {
    vi.stubGlobal('localStorage', makeStorage(true));
    const fetchMock = mockFeed(GOOD_ROUTES);
    const res = await loadSanctionsFeed();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.eth).toContain(FEED_ETH_1.toLowerCase());
    expect(isSanctioned(FEED_ETH_1)).toBeDefined();
    expect(() => clearSanctionsCache()).not.toThrow();
  });

  it('works when localStorage is undefined', async () => {
    vi.stubGlobal('localStorage', undefined);
    mockFeed(GOOD_ROUTES);
    const res = await loadSanctionsFeed();
    expect(res.eth).toContain(FEED_ETH_2.toLowerCase());
  });

  it('propagates the caller abort instead of degrading', async () => {
    mockFeed(GOOD_ROUTES);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(loadSanctionsFeed(ctrl.signal)).rejects.toBeDefined();
  });

  it('clearSanctionsCache removes feed data but keeps the builtin snapshot', async () => {
    mockFeed(GOOD_ROUTES);
    await loadSanctionsFeed();
    expect(isSanctioned(FEED_ETH_1)).toBeDefined();
    clearSanctionsCache();
    expect(isSanctioned(FEED_ETH_1)).toBeUndefined();
    expect(isSanctioned(RONIN_EXPLOITER)).toBeDefined();
    expect(storage.getItem(SANCTIONS_CACHE_KEY)).toBeNull();
    expect(sanctionedCount()).toBe(BUILTIN_SANCTIONED.length);
  });

  it('isSanctioned also honours sanctioned labels registered by other modules', async () => {
    const { registerLabels } = await import('@/lib/intel/labels');
    registerLabels([{ address: RANDOM, chain: 'evm', name: 'User-flagged', category: 'sanctioned', source: 'case' }]);
    expect(isSanctioned(RANDOM)?.name).toBe('User-flagged');
    registerLabels([{ address: RANDOM, chain: 'evm', name: 'Just a wallet', category: 'wallet', source: 'case' }]);
    expect(isSanctioned(RANDOM)).toBeUndefined();
  });
});
