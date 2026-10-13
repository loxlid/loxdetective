import { Link } from 'react-router-dom';
import { allChains } from '@/lib/chains/registry';
import { SANCTIONS_FEED_URL } from '@/lib/intel/sanctions';
import { LLAMA_PRICES_URL } from '@/lib/providers/prices';
import { SETTINGS_STORAGE_KEY } from '@/lib/settings/store';
import { CASES_STORAGE_KEY } from '@/lib/cases/store';
import { usePageTitle } from '@/hooks/usePageTitle';
import Card from '@/components/Card';
import ChainBadge from '@/components/ChainBadge';
import { GITHUB_URL } from '@/components/Layout';

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export default function AboutPage() {
  usePageTitle('About');
  const chains = allChains(true);

  return (
    <div className="about-page">
      <div className="page-head">
        <div>
          <h1>About LoxDetective</h1>
          <p className="muted">A client-only, multi-chain on-chain investigation toolkit. Open source, MIT licensed.</p>
        </div>
        <div className="page-head__actions">
          <a className="btn" href={GITHUB_URL} target="_blank" rel="noreferrer noopener">
            Source on GitHub
          </a>
        </div>
      </div>

      <Card title="What it is">
        <p>
          Block explorers show you <em>a</em> transaction. Investigations need the story: where funds came from, where they went, who the counterparties are and whether any of it touches a mixer, a
          sanctioned entity or a known scam. LoxDetective answers the common questions directly from public blockchain APIs, in your browser, with code you can read.
        </p>
        <ul className="bullets">
          <li>Universal search across every supported EVM network, Bitcoin and Solana.</li>
          <li>Address profiles with multi-chain balances, history, token holdings, approvals and contract details.</li>
          <li>Transaction decoding (transfers, internal calls, events), a fund-flow tracer with an interactive graph, deterministic risk heuristics and built-in labels.</li>
          <li>Local investigation cases with tags, notes, saved traces and JSON export / import.</li>
        </ul>
      </Card>

      <Card title="Data sources & their limits" subtitle="Every request goes straight from your browser to one of these public endpoints. Custom RPCs from Settings are tried first, then Alchemy when a key is set, then the public list.">
        <div className="table-scroll">
          <table className="table table--compact">
            <thead>
              <tr>
                <th scope="col">Chain</th>
                <th scope="col">RPC / REST endpoints</th>
                <th scope="col">Explorer API</th>
                <th scope="col">Outbound links</th>
              </tr>
            </thead>
            <tbody>
              {chains.map((c) => (
                <tr key={c.id}>
                  <td>
                    <ChainBadge chain={c} showName />
                  </td>
                  <td className="mono small">{c.rpcUrls.map(host).join(', ')}</td>
                  <td className="small">
                    {c.blockscoutUrl && <div>Blockscout v2 ({host(c.blockscoutUrl)})</div>}
                    {c.etherscanApi && <div>{c.etherscanApi.requiresKey ? 'Etherscan V2 (API key required)' : 'Routescan (keyless)'}</div>}
                    {!c.blockscoutUrl && !c.etherscanApi && c.family === 'bitcoin' && <div>Esplora (mempool.space, Blockstream)</div>}
                    {!c.blockscoutUrl && !c.etherscanApi && c.family === 'solana' && <div>Solana JSON-RPC (optionally Helius)</div>}
                  </td>
                  <td className="small">
                    <a href={c.explorer.url} target="_blank" rel="noreferrer noopener">
                      {c.explorer.name}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3 className="mt">Other services</h3>
        <ul className="bullets">
          <li>
            <strong>Prices</strong> — DefiLlama coins API (<code>{host(LLAMA_PRICES_URL)}</code>), cached for five minutes. Low-confidence prices are ignored, so thin or fake tokens show no USD value.
          </li>
          <li>
            <strong>Function signatures</strong> — openchain.xyz and 4byte.directory, only for selectors missing from the built-in table.
          </li>
          <li>
            <strong>ENS</strong> — resolved on Ethereum mainnet through the ENS registry (<code>eth_call</code>); off-chain (CCIP-read) names are not supported.
          </li>
          <li>
            <strong>Sanctions</strong> — a built-in snapshot of well-documented OFAC SDN entries plus an optional daily feed from the community mirror (<code>{host(SANCTIONS_FEED_URL)}</code>). Toggle it in{' '}
            <Link to="/settings">Settings</Link>.
          </li>
        </ul>
        <h3 className="mt">Endpoint fallback & cooldown</h3>
        <ul className="bullets">
          <li>
            Every chain has an ordered list of endpoints (your custom RPCs, then Alchemy when a key is set, then the public ones). A request that fails is retried on the next endpoint, except for errors the provider recognises as
            deterministic — EVM JSON-RPC reverts and invalid-parameter errors, and 4xx answers from the Bitcoin (Esplora) API — which fail immediately. Only timeouts, network errors and HTTP 5xx / 429 answers mark the endpoint as
            unhealthy.
          </li>
          <li>
            An endpoint that failed that way is put on a one-minute <strong>cooldown</strong>: it is not dropped but moved to the back of the queue, so healthy endpoints answer first and a request only fails when every endpoint
            is down. A successful answer clears the cooldown immediately.
          </li>
        </ul>
        <h3 className="mt">Known limits</h3>
        <ul className="bullets">
          <li>
            Public RPCs are rate-limited and sometimes refuse large <code>eth_getLogs</code> ranges. The approvals scan splits the range into chunks and keeps what it found before a refusal; the Approvals tab then shows a{' '}
            <strong>scan status</strong> that says which block range was covered and why it stopped, instead of pretending the list is complete.
          </li>
          <li>History on chains without a Blockscout instance (BNB Chain, Cronos, Moonbeam…) needs an Etherscan API key; Avalanche and Fantom use the keyless Routescan API.</li>
          <li>
            Bitcoin history is limited to the Esplora page size (25 confirmed transactions per page). Solana rows start as signatures and are enriched with the actual SOL / SPL transfers for the newest entries only.
          </li>
          <li>Labels and risk heuristics are hints, not verdicts. Verify with primary sources before acting on them.</li>
        </ul>
      </Card>

      <Card title="Privacy">
        <ul className="bullets">
          <li>There is no backend. The site is static files on GitHub Pages; nothing you type is logged by LoxDetective.</li>
          <li>
            Queries go directly to the public RPCs, explorer APIs and price services listed above, which see your IP address and the addresses you look up, like any block explorer would.
          </li>
          <li>
            API keys, custom endpoints, theme (<code>{SETTINGS_STORAGE_KEY}</code>), cases (<code>{CASES_STORAGE_KEY}</code>) and recent searches live only in this browser's <code>localStorage</code>. Clear them any time
            from Settings or your browser.
          </li>
        </ul>
      </Card>

      <Card title="Disclaimer">
        <p>
          LoxDetective is an open-source research tool provided "as is", without warranty of any kind. Data comes from third-party public services that may be incomplete, delayed or wrong. Risk scores
          and labels are heuristics and must not be the sole basis for legal, compliance or financial decisions. Use responsibly and in accordance with the laws that apply to you.
        </p>
      </Card>
    </div>
  );
}
