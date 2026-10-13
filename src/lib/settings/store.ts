import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AppSettings, ChainInfo } from '../types';

export const SETTINGS_STORAGE_KEY = 'loxdetective.settings.v1';

export const DEFAULT_SETTINGS: AppSettings = {
  customRpc: {},
  etherscanApiKey: undefined,
  alchemyApiKey: undefined,
  heliusApiKey: undefined,
  showTestnets: false,
  enableSanctionsFeed: true,
  currency: 'usd',
};

export interface SettingsState extends AppSettings {
  theme: 'system' | 'dark' | 'light';
  set(patch: Partial<AppSettings & { theme: SettingsState['theme'] }>): void;
  reset(): void;
}

/** Memory fallback so the store works in tests / private windows where localStorage throws. */
function safeStorage(): Storage {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.getItem('__probe__');
      return localStorage;
    }
  } catch {
    /* fall through */
  }
  const mem = new Map<string, string>();
  return {
    get length() {
      return mem.size;
    },
    clear: () => mem.clear(),
    getItem: (k) => mem.get(k) ?? null,
    key: (i) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k) => void mem.delete(k),
    setItem: (k, v) => void mem.set(k, v),
  } as Storage;
}

const THEMES: readonly SettingsState['theme'][] = ['system', 'dark', 'light'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optKey = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * Shape-check a persisted settings blob (localStorage can hold anything: an
 * older schema, a hand-edited value, another app's junk) so a bad entry never
 * poisons the store; unknown or malformed fields fall back to the defaults.
 */
export function sanitizeSettings(raw: unknown): Partial<SettingsState> {
  if (!isObj(raw)) return {};
  const out: Partial<SettingsState> = {};
  if (isObj(raw.customRpc)) {
    const customRpc: Record<string, string[]> = {};
    for (const [chain, urls] of Object.entries(raw.customRpc)) if (Array.isArray(urls)) customRpc[chain] = urls.filter((u): u is string => typeof u === 'string');
    out.customRpc = customRpc as AppSettings['customRpc'];
  }
  if ('etherscanApiKey' in raw) out.etherscanApiKey = optKey(raw.etherscanApiKey);
  if ('alchemyApiKey' in raw) out.alchemyApiKey = optKey(raw.alchemyApiKey);
  if ('heliusApiKey' in raw) out.heliusApiKey = optKey(raw.heliusApiKey);
  if ('showTestnets' in raw) out.showTestnets = raw.showTestnets === true;
  if ('enableSanctionsFeed' in raw) out.enableSanctionsFeed = raw.enableSanctionsFeed !== false;
  if ('currency' in raw) out.currency = 'usd';
  if ('theme' in raw) out.theme = THEMES.includes(raw.theme as SettingsState['theme']) ? (raw.theme as SettingsState['theme']) : 'system';
  return out;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      theme: 'system',
      set: (patch) => set((s) => ({ ...s, ...patch })),
      reset: () => set({ ...DEFAULT_SETTINGS, theme: 'system' }),
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      storage: createJSONStorage(safeStorage),
      version: 1,
      merge: (persisted, current) => ({ ...current, ...sanitizeSettings(persisted) }),
    },
  ),
);

/** Non-hook read for providers and other plain modules. */
export function getSettings(): AppSettings & { theme: SettingsState['theme'] } {
  const s = useSettings.getState();
  return {
    customRpc: s.customRpc,
    etherscanApiKey: s.etherscanApiKey,
    alchemyApiKey: s.alchemyApiKey,
    heliusApiKey: s.heliusApiKey,
    showTestnets: s.showTestnets,
    enableSanctionsFeed: s.enableSanctionsFeed,
    currency: s.currency,
    theme: s.theme,
  };
}

function cleanUrls(list: unknown): string[] {
  return (Array.isArray(list) ? list : [])
    .filter((u): u is string => typeof u === 'string')
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u));
}

/**
 * Alchemy network slugs for the chains it serves; the RPC URL is
 * `https://<slug>.g.alchemy.com/v2/<key>`.
 */
export const ALCHEMY_SLUGS: Readonly<Record<string, string>> = {
  ethereum: 'eth-mainnet',
  base: 'base-mainnet',
  arbitrum: 'arb-mainnet',
  optimism: 'opt-mainnet',
  polygon: 'polygon-mainnet',
  zksync: 'zksync-mainnet',
  linea: 'linea-mainnet',
  scroll: 'scroll-mainnet',
  blast: 'blast-mainnet',
  bsc: 'bnb-mainnet',
  avalanche: 'avax-mainnet',
  gnosis: 'gnosis-mainnet',
  'polygon-zkevm': 'polygonzkevm-mainnet',
  celo: 'celo-mainnet',
  sepolia: 'eth-sepolia',
};

/** Alchemy JSON-RPC URL for `chain` when a key is configured and Alchemy serves that network. */
export function alchemyUrlFor(chain: ChainInfo, apiKey: string | undefined = getSettings().alchemyApiKey): string | undefined {
  const key = apiKey?.trim();
  const slug = ALCHEMY_SLUGS[chain.id];
  if (!key || !slug) return undefined;
  return `https://${slug}.g.alchemy.com/v2/${encodeURIComponent(key)}`;
}

/** Ordered endpoint list for a chain: user overrides first, then Alchemy (when a key is set), then the registry defaults. */
export function rpcUrlsFor(chain: ChainInfo): string[] {
  const settings = getSettings();
  const custom = cleanUrls(settings.customRpc?.[chain.id]);
  const alchemy = alchemyUrlFor(chain, settings.alchemyApiKey);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of [...custom, ...(alchemy ? [alchemy] : []), ...chain.rpcUrls]) {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}
