import { useEffect, useMemo, useState } from 'react';
import type { AppSettings, ChainId } from '@/lib/types';
import { allChains } from '@/lib/chains/registry';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, useSettings } from '@/lib/settings/store';
import { clearPriceCache } from '@/lib/providers/prices';
import { clearSanctionsCache, sanctionsFeedInfo } from '@/lib/intel/sanctions';
import { CASES_STORAGE_KEY } from '@/lib/cases/store';
import { clearRecentSearches } from '@/hooks/useRecentSearches';
import { useTheme, type Theme } from '@/hooks/useTheme';
import { usePageTitle } from '@/hooks/usePageTitle';
import { bumpLabelsRevision } from '@/hooks/useLabel';
import { useSanctionsFeed } from '@/hooks/useSanctionsFeed';
import Card from '@/components/Card';
import ChainBadge from '@/components/ChainBadge';
import { useToast } from '@/components/Toast';
import { formatDate } from '@/lib/format';

interface Draft {
  rpc: Record<ChainId, string>;
  etherscanApiKey: string;
  alchemyApiKey: string;
  heliusApiKey: string;
  showTestnets: boolean;
  enableSanctionsFeed: boolean;
}

type StoreSlice = Pick<AppSettings, 'customRpc' | 'etherscanApiKey' | 'alchemyApiKey' | 'heliusApiKey' | 'showTestnets' | 'enableSanctionsFeed'>;

/** Draft form state from the persisted settings (one textarea string per chain). */
export function toDraft(s: StoreSlice): Draft {
  const rpc: Record<ChainId, string> = {};
  for (const [id, urls] of Object.entries(s.customRpc ?? {})) rpc[id] = Array.isArray(urls) ? urls.filter((u): u is string => typeof u === 'string').join('\n') : '';
  return {
    rpc,
    etherscanApiKey: s.etherscanApiKey ?? '',
    alchemyApiKey: s.alchemyApiKey ?? '',
    heliusApiKey: s.heliusApiKey ?? '',
    showTestnets: s.showTestnets,
    enableSanctionsFeed: s.enableSanctionsFeed,
  };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Plain-http endpoints that an https deployment cannot reach (mixed content); loopback hosts are allowed. */
export function insecureRpcUrls(customRpc: Record<ChainId, string[]>): string[] {
  return Object.values(customRpc)
    .flat()
    .filter((u) => {
      if (!/^http:\/\//i.test(u)) return false;
      try {
        const h = new URL(u).hostname.toLowerCase();
        return !(LOCAL_HOSTS.has(h) || h.endsWith('.localhost'));
      } catch {
        return true;
      }
    });
}

/** Parse the draft back into a settings patch; blank lines and non-http(s) URLs are dropped. */
export function fromDraft(d: Draft): StoreSlice {
  const customRpc: Record<ChainId, string[]> = {};
  for (const [id, text] of Object.entries(d.rpc)) {
    const urls = text
      .split(/\r?\n/)
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//i.test(u));
    if (urls.length) customRpc[id] = urls;
  }
  return {
    customRpc,
    etherscanApiKey: d.etherscanApiKey.trim() || undefined,
    alchemyApiKey: d.alchemyApiKey.trim() || undefined,
    heliusApiKey: d.heliusApiKey.trim() || undefined,
    showTestnets: d.showTestnets,
    enableSanctionsFeed: d.enableSanctionsFeed,
  };
}

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'system', label: 'Follow system' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

export default function SettingsPage() {
  usePageTitle('Settings');
  const customRpc = useSettings((s) => s.customRpc);
  const etherscanApiKey = useSettings((s) => s.etherscanApiKey);
  const alchemyApiKey = useSettings((s) => s.alchemyApiKey);
  const heliusApiKey = useSettings((s) => s.heliusApiKey);
  const showTestnets = useSettings((s) => s.showTestnets);
  const enableSanctionsFeed = useSettings((s) => s.enableSanctionsFeed);
  const set = useSettings((s) => s.set);
  const reset = useSettings((s) => s.reset);
  const { theme, setTheme } = useTheme();
  const toast = useToast();
  const feed = useSanctionsFeed();

  const stored = useMemo<StoreSlice>(
    () => ({ customRpc, etherscanApiKey, alchemyApiKey, heliusApiKey, showTestnets, enableSanctionsFeed }),
    [customRpc, etherscanApiKey, alchemyApiKey, heliusApiKey, showTestnets, enableSanctionsFeed],
  );
  const [draft, setDraft] = useState<Draft>(() => toDraft(stored));
  const [dirty, setDirty] = useState(false);
  const [showKeys, setShowKeys] = useState(false);

  // Follow external changes (store hydration, reset) while the form is untouched.
  useEffect(() => {
    if (!dirty) setDraft(toDraft(stored));
  }, [stored, dirty]);

  const chains = allChains(draft.showTestnets);
  const patch = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  };
  const patchRpc = (id: ChainId, value: string) => {
    setDraft((d) => ({ ...d, rpc: { ...d.rpc, [id]: value } }));
    setDirty(true);
  };

  const save = () => {
    set(fromDraft(draft));
    setDirty(false);
    toast.push('Settings saved', 'success');
  };

  const resetAll = () => {
    if (typeof window !== 'undefined' && !window.confirm('Reset all settings to their defaults? Custom RPCs and API keys will be removed.')) return;
    reset();
    setDirty(false);
    clearPriceCache();
    toast.push('Settings reset to defaults');
  };

  const clearCaches = () => {
    clearPriceCache();
    clearSanctionsCache();
    clearRecentSearches();
    bumpLabelsRevision();
    toast.push('Caches cleared (prices, sanctions feed, recent searches)');
  };

  const feedInfo = feed.data ? { fetchedAt: feed.fetchedAt, eth: feed.ethCount, btc: feed.btcCount } : sanctionsFeedInfo();
  const draftRpc = fromDraft(draft).customRpc;
  const customCount = Object.values(draftRpc).reduce((n, l) => n + l.length, 0);
  const insecureRpc = insecureRpcUrls(draftRpc);
  const onHttps = typeof location !== 'undefined' && location.protocol === 'https:';

  return (
    <div className="settings-page" data-testid="settings-page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">
            Everything here is stored in your browser only (<code>localStorage</code> key <code>{SETTINGS_STORAGE_KEY}</code>). Nothing is sent anywhere except to the endpoints you configure.
          </p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="btn" onClick={resetAll}>
            Reset to defaults
          </button>
          <button type="button" className="btn btn--primary" data-testid="settings-save" onClick={save}>
            Save{dirty ? ' changes' : ''}
          </button>
        </div>
      </div>

      <div className="settings-grid">
        <Card
          title="API keys"
          subtitle="Optional. Keys unlock history on chains without a Blockscout instance and raise rate limits."
          actions={
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowKeys((v) => !v)}>
              {showKeys ? 'Hide keys' : 'Show keys'}
            </button>
          }
        >
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Etherscan API key (V2, all chains)</span>
              <input data-testid="settings-etherscan-key" className="input mono" type={showKeys ? 'text' : 'password'} value={draft.etherscanApiKey} onChange={(e) => patch('etherscanApiKey', e.target.value)} placeholder="Free key from etherscan.io" autoComplete="off" spellCheck={false} />
              <span className="field__hint">Used for transaction / token / internal history on BNB Chain, Cronos, Moonbeam and as a fallback everywhere else.</span>
            </label>
            <label className="field">
              <span className="field__label">Helius API key (Solana)</span>
              <input className="input mono" type={showKeys ? 'text' : 'password'} value={draft.heliusApiKey} onChange={(e) => patch('heliusApiKey', e.target.value)} placeholder="Optional" autoComplete="off" spellCheck={false} />
              <span className="field__hint">When set, Helius is tried before the public Solana RPCs.</span>
            </label>
            <label className="field">
              <span className="field__label">Alchemy API key</span>
              <input className="input mono" type={showKeys ? 'text' : 'password'} value={draft.alchemyApiKey} onChange={(e) => patch('alchemyApiKey', e.target.value)} placeholder="Optional (stored for future use)" autoComplete="off" spellCheck={false} />
              <span className="field__hint">Stored only; add an Alchemy URL as a custom RPC below to use it today.</span>
            </label>
          </div>
        </Card>

        <Card title="Intelligence & display">
          <div className="form-grid">
            <label className="field field--row">
              <input type="checkbox" checked={draft.enableSanctionsFeed} onChange={(e) => patch('enableSanctionsFeed', e.target.checked)} />
              <span>
                <span className="field__label">OFAC sanctions feed</span>
                <span className="field__hint">
                  Fetch the community mirror of the SDN list (ETH + BTC) once a day from raw.githubusercontent.com.{' '}
                  {feedInfo && feedInfo.fetchedAt > 0 ? `Last fetched ${formatDate(Math.floor(feedInfo.fetchedAt / 1000))} · ${feedInfo.eth} ETH / ${feedInfo.btc} BTC addresses.` : 'Built-in snapshot only until the feed loads.'}
                </span>
              </span>
            </label>
            <label className="field field--row">
              <input type="checkbox" checked={draft.showTestnets} onChange={(e) => patch('showTestnets', e.target.checked)} />
              <span>
                <span className="field__label">Show testnets</span>
                <span className="field__hint">Adds Sepolia to chain lists, balance strips and transaction probes.</span>
              </span>
            </label>
            <label className="field">
              <span className="field__label">Theme</span>
              <select className="input input--select" value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
                {THEME_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className="field__hint">Applies immediately.</span>
            </label>
          </div>
        </Card>
      </div>

      <Card title="Custom RPC endpoints" subtitle={`One URL per line. Custom endpoints are tried first, then the built-in public ones. ${customCount ? `${customCount} custom endpoint${customCount === 1 ? '' : 's'} configured.` : ''}`}>
        {onHttps && insecureRpc.length > 0 && (
          <p className="field__hint" role="alert" data-testid="settings-rpc-insecure">
            This site is served over https, so the browser blocks plain http:// endpoints (mixed content) and they will be skipped in favour of the public RPCs: {insecureRpc.join(', ')}. Use an https URL, a reverse proxy with TLS, or http://localhost.
          </p>
        )}
        <div className="rpc-grid">
          {chains.map((c) => (
            <label key={c.id} className="field rpc-field">
              <span className="field__label rpc-field__label">
                <ChainBadge chain={c} showName />
                <span className="muted rpc-field__kind">{c.family === 'bitcoin' ? 'Esplora REST' : c.family === 'solana' ? 'Solana JSON-RPC' : `JSON-RPC · id ${c.evmChainId}`}</span>
              </span>
              <textarea data-testid={`settings-rpc-${c.id}`} className="input mono rpc-field__input" rows={2} value={draft.rpc[c.id] ?? ''} onChange={(e) => patchRpc(c.id, e.target.value)} placeholder={c.rpcUrls[0]} spellCheck={false} />
            </label>
          ))}
        </div>
      </Card>

      <Card title="Maintenance" className="card--danger">
        <div className="btn-row">
          <button type="button" className="btn" onClick={clearCaches}>
            Clear caches
          </button>
          <button type="button" className="btn btn--danger" onClick={resetAll}>
            Reset settings
          </button>
        </div>
        <p className="muted">
          Cases are stored separately under <code>{CASES_STORAGE_KEY}</code> and are not affected by a settings reset. Default sanctions feed: {DEFAULT_SETTINGS.enableSanctionsFeed ? 'enabled' : 'disabled'}.
        </p>
      </Card>

      <div className="page-foot">
        <button type="button" className="btn btn--primary" onClick={save}>
          Save{dirty ? ' changes' : ''}
        </button>
      </div>
    </div>
  );
}
