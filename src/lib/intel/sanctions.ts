/**
 * OFAC sanctions intelligence: a built-in snapshot of well-documented SDN
 * entries plus an optional runtime feed from the community-maintained mirror
 * at github.com/0xB10C/ofac-sanctioned-digital-currency-addresses.
 *
 * The feed is cached in localStorage for 24h and every failure degrades to
 * the cached or built-in data; `loadSanctionsFeed` never throws except when
 * the caller's own AbortSignal fires.
 */
import type { AddressLabel } from '../types';
import { fetchJson } from '../http';
import { lookupLabel, normalizeAddress, registerLabels, unregisterLabels } from './labels';

export const SANCTIONS_FEED_URL =
  'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.json';
export const SANCTIONS_FEED_BTC_URL =
  'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_XBT.json';
export const SANCTIONS_CACHE_KEY = 'loxdetective.sanctions.v1';
export const SANCTIONS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const SANCTIONS_FEED_SOURCE = 'OFAC SDN (0xB10C mirror)';
const BUILTIN_SOURCE = 'OFAC SDN (builtin snapshot)';
const FEED_INFO_URL = 'https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses';
const FETCH_TIMEOUT_MS = 10_000;

export interface SanctionsFeedResult {
  /** Lower-cased EVM addresses (builtin + feed). */
  eth: string[];
  /** Bitcoin addresses (builtin + feed). */
  btc: string[];
  /** When the feed was fetched (ms epoch); 0 when only built-in data is available. */
  fetchedAt: number;
}

function S(address: string, name: string, chain: AddressLabel['chain'], url: string): AddressLabel {
  return { address, chain, name, category: 'sanctioned', source: BUILTIN_SOURCE, url };
}

const OFAC_TORNADO = 'https://ofac.treasury.gov/recent-actions/20220808';
const OFAC_LAZARUS_RONIN = 'https://ofac.treasury.gov/recent-actions/20220414';
const OFAC_LAZARUS_UPDATE = 'https://ofac.treasury.gov/recent-actions/20220422';
const OFAC_GARANTEX = 'https://ofac.treasury.gov/recent-actions/20220405';

/**
 * Built-in snapshot. The Tornado Cash set was designated on 2022-08-08 and
 * delisted on 2025-03-21; it is kept here because interaction with these
 * contracts remains a primary laundering indicator for investigators.
 */
export const BUILTIN_SANCTIONED: AddressLabel[] = [
  // Lazarus Group (DPRK) — Ronin Bridge exploit and follow-up addresses.
  S('0x098B716B8Aaf21512996dC57EB0615e2383E2f96', 'Lazarus Group: Ronin Bridge exploiter (OFAC SDN 2022-04-14)', 'evm', OFAC_LAZARUS_RONIN),
  S('0xa0e1c89Ef1a489c9C7dE96311eD5Ce5D32c20E4B', 'Lazarus Group (OFAC SDN 2022-04-22)', 'evm', OFAC_LAZARUS_UPDATE),
  S('0x3Cffd56B47B7b41c56258D9C7731ABaDc360E073', 'Lazarus Group (OFAC SDN 2022-04-22)', 'evm', OFAC_LAZARUS_UPDATE),
  S('0x53b6936513e738f44FB50d2b9476730C0Ab3Bfc1', 'Lazarus Group (OFAC SDN 2022-04-22)', 'evm', OFAC_LAZARUS_UPDATE),
  // Garantex exchange (Russia).
  S('0x7F367cC41522cE07553e823bf3be79A889DEbe1B', 'Garantex exchange (OFAC SDN 2022-04-05)', 'evm', OFAC_GARANTEX),
  // Tornado Cash contract set (Ethereum).
  S('0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b', 'Tornado Cash: Router (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0x722122dF12D4e14e13Ac3b6895a86e84145b6967', 'Tornado Cash: Proxy (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc', 'Tornado Cash: 0.1 ETH pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936', 'Tornado Cash: 1 ETH pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF', 'Tornado Cash: 10 ETH pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0xA160cdAB225685dA1d56aa342Ad8841c3b53f291', 'Tornado Cash: 100 ETH pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0xD4B88Df4D29F5CedD6857912842cff3b20C8Cfa3', 'Tornado Cash: 100 DAI pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0xFD8610d20aA15b7B2E3Be39B396a1bC3516c7144', 'Tornado Cash: 1,000 DAI pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0x07687e702b410Fa43f4cB4Af7FA097918ffD2730', 'Tornado Cash: 10,000 DAI pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0x23773E65ed146A459791799d01336DB287f25334', 'Tornado Cash: 100,000 DAI pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0x22aaA7720ddd5388A3c0A3333430953C68f1849b', 'Tornado Cash: 5,000 cDAI pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0x03893a7c7463AE47D46bc7f091665f1893656003', 'Tornado Cash: 50,000 cDAI pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0x2717c5e28cf931547B621a5dddb772Ab6A35B701', 'Tornado Cash: 500,000 cDAI pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0xD21be7248e0197Ee08E0c20D4a96DEBdaC3D20Af', 'Tornado Cash: 5,000,000 cDAI pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0xd96f2B1c14Db8458374d9Aca76E26c3D18364307', 'Tornado Cash: 100 USDC pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0x4736dCf1b7A3d580672CcE6E7c65cd5cc9cFBa19', 'Tornado Cash: 1,000 USDC pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0x169AD27A470D064DEDE56a2D3ff727986b15D52B', 'Tornado Cash: 100 USDT pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0x0836222F2B2B24A3F36f98668Ed8F0B38D1a872f', 'Tornado Cash: 1,000 USDT pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0x178169B423a011fff22B9e3F3abeA13414dDD0F1', 'Tornado Cash: 0.1 WBTC pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0x610B717796ad172B316836AC95a2ffad065CeaB4', 'Tornado Cash: 1 WBTC pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0xbB93e510BbCD0B7beb5A853875f9eC60275CF498', 'Tornado Cash: 10 WBTC pool (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0x77777FeDdddFfC19Ff86DB637967013e6C6A116C', 'Tornado Cash: TORN token (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
  S('0x5efda50f22d34F262c29268506C5Fa42cB56A1Ce', 'Tornado Cash: Governance (OFAC SDN 2022-08-08, delisted 2025-03-21)', 'ethereum', OFAC_TORNADO),
];

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const BTC_RE = /^([13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[02-9ac-hj-np-z]{11,87})$/i;

/** normalised address → label, for everything we currently consider sanctioned. */
let sanctioned = new Map<string, AddressLabel>();
let memo: SanctionsFeedResult | undefined;
let inflight: Promise<SanctionsFeedResult> | undefined;

function seedBuiltin(): void {
  sanctioned = new Map(BUILTIN_SANCTIONED.map((l) => [normalizeAddress(l.address), l]));
  registerLabels(BUILTIN_SANCTIONED);
}
seedBuiltin();

function unique(list: string[]): string[] {
  return Array.from(new Set(list));
}

/** Keep only well-formed EVM addresses, lower-cased and de-duplicated. */
function sanitizeEth(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return unique(v.filter((a): a is string => typeof a === 'string' && EVM_RE.test(a.trim())).map((a) => a.trim().toLowerCase()));
}

/** Keep only plausible Bitcoin addresses (legacy/P2SH verbatim, bech32 lower-cased). */
function sanitizeBtc(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return unique(v.filter((a): a is string => typeof a === 'string' && BTC_RE.test(a.trim())).map((a) => normalizeAddress(a)));
}

function feedLabel(address: string, chain: 'evm' | 'bitcoin'): AddressLabel {
  return { address, chain, name: 'OFAC SDN listed address', category: 'sanctioned', source: SANCTIONS_FEED_SOURCE, url: FEED_INFO_URL };
}

/** Merge feed addresses into the sanctioned set and the shared label registry. */
function apply(result: SanctionsFeedResult): void {
  const fresh: AddressLabel[] = [];
  for (const [list, chain] of [[result.eth, 'evm'], [result.btc, 'bitcoin']] as const) {
    for (const addr of list) {
      const key = normalizeAddress(addr);
      if (sanctioned.has(key)) continue;
      const label = feedLabel(addr, chain);
      sanctioned.set(key, label);
      fresh.push(label);
    }
  }
  if (fresh.length) registerLabels(fresh);
}

function builtinLists(): { eth: string[]; btc: string[] } {
  const eth: string[] = [];
  const btc: string[] = [];
  for (const l of BUILTIN_SANCTIONED) (l.chain === 'bitcoin' ? btc : eth).push(normalizeAddress(l.address));
  return { eth, btc };
}

function withBuiltin(r: SanctionsFeedResult): SanctionsFeedResult {
  const b = builtinLists();
  return { eth: unique([...b.eth, ...r.eth]), btc: unique([...b.btc, ...r.btc]), fetchedAt: r.fetchedAt };
}

// ---------------------------------------------------------------------------
// localStorage cache (guarded: private windows / SSR / blocked storage)
// ---------------------------------------------------------------------------

function readCache(): SanctionsFeedResult | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const raw = localStorage.getItem(SANCTIONS_CACHE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<SanctionsFeedResult> | null;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const fetchedAt = typeof parsed.fetchedAt === 'number' && Number.isFinite(parsed.fetchedAt) ? parsed.fetchedAt : 0;
    if (fetchedAt <= 0) return undefined;
    return { eth: sanitizeEth(parsed.eth), btc: sanitizeBtc(parsed.btc), fetchedAt };
  } catch {
    return undefined;
  }
}

function writeCache(r: SanctionsFeedResult): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SANCTIONS_CACHE_KEY, JSON.stringify(r));
  } catch {
    /* storage unavailable or full: the feed still works for this session */
  }
}

async function fetchList(url: string, kind: 'eth' | 'btc', signal?: AbortSignal): Promise<string[] | undefined> {
  try {
    const body = await fetchJson<unknown>(url, { signal, timeoutMs: FETCH_TIMEOUT_MS });
    return kind === 'eth' ? sanitizeEth(body) : sanitizeBtc(body);
  } catch (err) {
    if (signal?.aborted) throw err;
    return undefined;
  }
}

/**
 * Load the OFAC mirror (ETH + BTC lists), register the addresses as
 * `sanctioned` labels and return the full known set. Resolution order:
 * in-memory result (< 24h) → localStorage cache (< 24h) → network → stale
 * cache → built-in snapshot only (`fetchedAt: 0`). Concurrent callers share
 * one request. The caller decides whether the feed is enabled (Settings).
 */
export async function loadSanctionsFeed(signal?: AbortSignal): Promise<SanctionsFeedResult> {
  const now = Date.now();
  if (memo && now - memo.fetchedAt < SANCTIONS_CACHE_TTL_MS) return withBuiltin(memo);

  const cached = readCache();
  if (cached && now - cached.fetchedAt < SANCTIONS_CACHE_TTL_MS) {
    apply(cached);
    memo = cached;
    return withBuiltin(cached);
  }

  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const [eth, btc] = await Promise.all([
        fetchList(SANCTIONS_FEED_URL, 'eth', signal),
        fetchList(SANCTIONS_FEED_BTC_URL, 'btc', signal),
      ]);
      if (eth === undefined && btc === undefined) throw new Error('sanctions feed unavailable');
      const result: SanctionsFeedResult = {
        eth: eth ?? cached?.eth ?? [],
        btc: btc ?? cached?.btc ?? [],
        fetchedAt: Date.now(),
      };
      apply(result);
      // Only trust the result for 24h when both lists were actually fetched.
      if (eth !== undefined && btc !== undefined) {
        writeCache(result);
        memo = result;
      }
      return withBuiltin(result);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (cached) {
        apply(cached);
        return withBuiltin(cached);
      }
      return withBuiltin({ eth: [], btc: [], fetchedAt: 0 });
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** The sanctioned label for an address (builtin, feed, or any registered label with category `sanctioned`). */
export function isSanctioned(address: string): AddressLabel | undefined {
  if (!address) return undefined;
  const hit = sanctioned.get(normalizeAddress(address));
  if (hit) return hit;
  const label = lookupLabel(address);
  return label?.category === 'sanctioned' ? label : undefined;
}

/** Number of addresses currently known to be sanctioned (builtin + feed). */
export function sanctionedCount(): number {
  return sanctioned.size;
}

/** Last successful feed load in this session, if any (for the Settings page). */
export function sanctionsFeedInfo(): { fetchedAt: number; eth: number; btc: number } | undefined {
  const r = memo ?? readCache();
  return r ? { fetchedAt: r.fetchedAt, eth: r.eth.length, btc: r.btc.length } : undefined;
}

/**
 * Forget feed data: in-memory and feed labels always, localStorage unless
 * `storage: false`. Built-in entries are re-seeded. Used by tests and when
 * the feed is disabled in Settings.
 */
export function clearSanctionsCache(opts: { storage?: boolean } = {}): void {
  memo = undefined;
  inflight = undefined;
  unregisterLabels((l) => l.source === SANCTIONS_FEED_SOURCE);
  seedBuiltin();
  if (opts.storage === false) return;
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(SANCTIONS_CACHE_KEY);
  } catch {
    /* ignore */
  }
}
