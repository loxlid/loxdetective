import { useEffect, useMemo, useState } from 'react';
import type { AppSettings, ChainId } from '@/lib/types';
import { allChains } from '@/lib/chains/registry';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, useSettings } from '@/lib/settings/store';
import { clearPriceCache } from '@/lib/providers/prices';
import { clearSanctionsCache, sanctionsFeedInfo } from '@/lib/intel/sanctions';
import { LABEL_CATEGORIES, USER_LABELS_STORAGE_KEY, applyUserLabels, clearUserLabels, exportUserLabelsCsv, loadUserLabels, parseLabelCsv, saveUserLabels } from '@/lib/intel/userLabels';
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
  const [labelsCsv, setLabelsCsv] = useState<string>(() => exportUserLabelsCsv(loadUserLabels()));
  const [labelsCount, setLabelsCount] = useState<number>(() => loadUserLabels().length);
  const [labelErrors, setLabelErrors] = useState<string[]>([]);

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

  const importLabels = () => {
    const { labels, errors } = parseLabelCsv(labelsCsv);
    setLabelErrors(errors);
    if (!labels.length && errors.length) {
      toast.push('No labels imported: fix the lines below', 'error');
      return;
    }
    saveUserLabels(labels);
    applyUserLabels(labels);
    bumpLabelsRevision();
    setLabelsCount(labels.length);
    if (!errors.length) setLabelsCsv(exportUserLabelsCsv(labels));
    toast.push(`${labels.length} custom label${labels.length === 1 ? '' : 's'} imported${errors.length ? ` · ${errors.length} line${errors.length === 1 ? '' : 's'} skipped` : ''}`, errors.length ? 'error' : 'success');
  };

  const clearLabels = () => {
    clearUserLabels();
    bumpLabelsRevision();
    setLabelsCsv(exportUserLabelsCsv([]));
    setLabelsCount(0);
    setLabelErrors([]);
    toast.push('Custom labels cleared');
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
          subtitle="Optional. Keys unlock history on chains without a Blockscout instance, add a dedicated RPC provider and raise rate limits. Each key is only ever sent to its own provider."
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
              <span className="field__label">Alchemy API key (EVM RPC)</span>
              <input data-testid="settings-alchemy-key" className="input mono" type={showKeys ? 'text' : 'password'} value={draft.alchemyApiKey} onChange={(e) => patch('alchemyApiKey', e.target.value)} placeholder="Optional" autoComplete="off" spellCheck={false} />
              <span className="field__hint">
                When set, <code>https://&lt;network&gt;.g.alchemy.com/v2/&lt;key&gt;</code> is used as the JSON-RPC endpoint for the EVM chains Alchemy serves (Ethereum, Base, Arbitrum, OP Mainnet, Polygon, zkSync, Linea, Scroll, Blast, BNB
                Chain, Avalanche, Gnosis, Polygon zkEVM, Celo, Sepolia), after your custom RPCs and before the public ones. Chains Alchemy does not serve keep using the public endpoints.
              </span>
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

      <Card
        title="Custom RPC endpoints"
        subtitle={`One URL per line. Custom endpoints are tried first, then Alchemy (when a key is set), then the built-in public ones; an endpoint that times out, errors or rate-limits is moved to the back of the queue for a minute. ${customCount ? `${customCount} custom endpoint${customCount === 1 ? '' : 's'} configured.` : ''}`}
      >
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

      <Card
        title="Custom labels"
        subtitle={`Your own address labels, one per line: address,name,category,chain. They override the built-in list and are stored only in this browser (${USER_LABELS_STORAGE_KEY}).`}
        actions={
          <button type="button" className="btn btn--ghost btn--sm" data-testid="settings-labels-clear" onClick={clearLabels} disabled={labelsCount === 0}>
            Clear
          </button>
        }
      >
        <div className="form-grid">
          <label className="field">
            <span className="field__label">Labels CSV</span>
            <textarea data-testid="settings-labels-csv" className="input mono" rows={8} value={labelsCsv} onChange={(e) => setLabelsCsv(e.target.value)} placeholder="address,name,category,chain" spellCheck={false} />
            <span className="field__hint">
              Header and lines starting with <code>#</code> are optional and ignored. Category: {LABEL_CATEGORIES.join(', ')} (blank = wallet). Chain: <code>evm</code> for every EVM network, or a chain id such as{' '}
              <code>ethereum</code>, <code>base</code>, <code>bitcoin</code>, <code>solana</code> (blank = evm / bitcoin / solana by address shape). Examples:
            </span>
            <pre className="mono small settings-labels-example">
              {['0x1234…abcd,Suspect hot wallet,wallet,evm', 'bc1q…,My exchange deposit,exchange,bitcoin', '5tzF…uAi9,Payout account,other,solana'].join('\n')}
            </pre>
          </label>
          {labelErrors.length > 0 && (
            <ul className="field__hint settings-labels-errors" role="alert" data-testid="settings-labels-errors">
              {labelErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <div className="btn-row">
            <button type="button" className="btn btn--primary" data-testid="settings-labels-import" onClick={importLabels}>
              Import
            </button>
            <p className="muted" data-testid="settings-labels-count">
              {labelsCount} custom label{labelsCount === 1 ? '' : 's'} active
            </p>
          </div>
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
