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

function cleanUrls(list: string[] | undefined): string[] {
  return (list ?? []).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u));
}

/** Ordered endpoint list for a chain: user overrides first, then the registry defaults. */
export function rpcUrlsFor(chain: ChainInfo): string[] {
  const custom = cleanUrls(getSettings().customRpc[chain.id]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of [...custom, ...chain.rpcUrls]) {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}
