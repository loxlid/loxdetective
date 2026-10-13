// @vitest-environment jsdom
/**
 * UI module tests: hooks' pure logic (dispatch, search resolution, recent
 * searches, theme, prices) with a mocked `fetch`, plus client-rendered
 * components and pages in jsdom (`createRoot` + `act`), so zustand stores and
 * effects behave as in the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { encodeAbiParameters, getAddress, namehash } from 'viem';

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

import type { AddressLabel, TokenBalance, TxListItem } from '@/lib/types';
import { CHAINS, allChains, getChain } from '@/lib/chains/registry';
import { useSettings } from '@/lib/settings/store';
import { useCases } from '@/lib/cases/store';
import { registerLabels } from '@/lib/intel/labels';
import { canonicalAddress, cacheKey, fetchHistoryPage, fetchTokenBalances, historySupported } from '@/hooks/dispatch';
import { resolveSearch } from '@/hooks/useSearchResolver';
import { RECENT_SEARCHES_KEY, RECENT_SEARCHES_MAX, addRecentSearch, clearRecentSearches, readRecentSearches, removeRecentSearch } from '@/hooks/useRecentSearches';
import { applyTheme, nextTheme } from '@/hooks/useTheme';
import { normalizePriceKeys, priceBalances, tokenPriceKey } from '@/hooks/usePrices';
import { sortBalances } from '@/hooks/useTokenBalances';
import { labelApprovals } from '@/hooks/useApprovals';
import { buildRiskInput, counterpartyLabels } from '@/hooks/useRisk';
import { toDraft, fromDraft, insecureRpcUrls } from '@/pages/SettingsPage';
import App from '@/App';
import Layout from '@/components/Layout';
import SearchBar, { searchPath } from '@/components/SearchBar';
import ChainBadge from '@/components/ChainBadge';
import AddressDisplay from '@/components/AddressDisplay';
import HashDisplay from '@/components/HashDisplay';
import RiskBadge from '@/components/RiskBadge';
import LabelChip from '@/components/LabelChip';
import AmountCell from '@/components/AmountCell';
import Timestamp from '@/components/Timestamp';
import DataTable from '@/components/DataTable';
import StatGrid from '@/components/StatGrid';
import Tabs from '@/components/Tabs';
import ErrorBox, { errorMessage } from '@/components/ErrorBox';
import LoadMore, { Pagination } from '@/components/LoadMore';
import EmptyState from '@/components/EmptyState';
import Card from '@/components/Card';
import ChainSelect from '@/components/ChainSelect';
import AddToCaseButton from '@/components/AddToCaseButton';
import HomePage from '@/pages/HomePage';
import SettingsPage from '@/pages/SettingsPage';
import CasesPage from '@/pages/CasesPage';
import AboutPage from '@/pages/AboutPage';
import NotFoundPage from '@/pages/NotFoundPage';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const ADDRESS = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const VITALIK = getAddress('0xd8da6bf26964af9d7eed9e03e51415d37aa96045');
const RESOLVER = getAddress('0x231b0ee14048e9dccd1d247744d114a4eb5e8e63');
const TX_HASH = `0x${'aa'.repeat(32)}`;
const ZERO_WORD = `0x${'00'.repeat(32)}`;
const BLOCKSCOUT_ETH = getChain('ethereum').blockscoutUrl as string;

type RpcReq = { id: number; method: string; params?: unknown[] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** eth_call answering the ENS registry / resolver for `name`. */
function ensCallResult(name: string, data: string): string {
  const node = namehash(name);
  const selector = data.slice(0, 10).toLowerCase();
  const arg = `0x${data.slice(10, 74)}`.toLowerCase();
  if (arg !== node.toLowerCase()) return ZERO_WORD;
  if (selector === '0x0178b8bf') return encodeAbiParameters([{ type: 'address' }], [RESOLVER]); // resolver(bytes32)
  if (selector === '0x3b3b57de') return encodeAbiParameters([{ type: 'address' }], [VITALIK]); // addr(bytes32)
  return ZERO_WORD;
}

/** Mock fetch: JSON-RPC by method, Blockscout collections, 404 elsewhere. */
function installFetch(opts: { txOn?: string; ens?: string; blockscoutItems?: unknown[] } = {}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && init.body) {
      const req = JSON.parse(String(init.body)) as RpcReq | RpcReq[];
      const answer = (r: RpcReq) => {
        const params = r.params ?? [];
        switch (r.method) {
          case 'eth_getTransactionByHash': {
            const hit = !!opts.txOn && url.includes(opts.txOn) && String(params[0]).toLowerCase() === TX_HASH;
            return { jsonrpc: '2.0', id: r.id, result: hit ? { hash: TX_HASH, from: ADDRESS, to: USDC, value: '0x0', input: '0x', gas: '0x5208', nonce: '0x1', blockNumber: '0x10' } : null };
          }
          case 'eth_call': {
            const call = params[0] as { data?: string };
            return { jsonrpc: '2.0', id: r.id, result: opts.ens ? ensCallResult(opts.ens, call?.data ?? '') : ZERO_WORD };
          }
          case 'getAccountInfo':
            return { jsonrpc: '2.0', id: r.id, result: { context: { slot: 1 }, value: null } };
          case 'getBalance':
            return { jsonrpc: '2.0', id: r.id, result: { context: { slot: 1 }, value: 0 } };
          default:
            return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `Method not found: ${r.method}` } };
        }
      };
      return jsonResponse(Array.isArray(req) ? req.map(answer) : answer(req));
    }
    if (url.includes('/api/v2/addresses/') && /\/(transactions|token-transfers|internal-transactions)/.test(url)) {
      return jsonResponse({ items: opts.blockscoutItems ?? [], next_page_params: null });
    }
    if (url.includes('mempool.space') || url.includes('blockstream.info')) return jsonResponse({ error: 'not found' }, 404);
    return jsonResponse({}, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

interface Mounted {
  container: HTMLElement;
  html: string;
  unmount(): void;
}

/** Client-render inside providers; effects run, stores are live. */
async function mount(el: ReactElement, path = '/'): Promise<Mounted> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>{el}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return {
    container,
    html: container.innerHTML,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      client.clear();
    },
  };
}

/** Render, capture markup, unmount. */
async function render(el: ReactElement, path = '/'): Promise<string> {
  const m = await mount(el, path);
  m.unmount();
  return m.html;
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

beforeEach(() => {
  installFetch();
  localStorage.clear();
  clearRecentSearches();
  useSettings.getState().reset();
  useCases.setState({ cases: [], activeCaseId: undefined });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// dispatch.ts
// ---------------------------------------------------------------------------

describe('dispatch', () => {
  it('canonicalises addresses per family', () => {
    expect(canonicalAddress(getChain('ethereum'), ADDRESS.toLowerCase())).toBe(ADDRESS);
    expect(canonicalAddress(getChain('ethereum'), 'not-an-address')).toBe('not-an-address');
    expect(canonicalAddress(getChain('bitcoin'), 'BC1QGDJQV0AV3Q56JVD82TKDJPY7GDP9UT8TLQMGRPMV24SQ90ECNVQQJWVW97')).toBe('bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97');
    expect(canonicalAddress(getChain('solana'), '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9')).toBe('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
    expect(canonicalAddress(undefined, ` ${ADDRESS} `)).toBe(ADDRESS);
  });

  it('builds case-folded cache keys only where the chain is case-insensitive', () => {
    expect(cacheKey(getChain('ethereum'), ADDRESS)).toBe(ADDRESS.toLowerCase());
    expect(cacheKey(getChain('bitcoin'), '1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF')).toBe('1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF');
    expect(cacheKey(getChain('bitcoin'), 'AB'.repeat(32))).toBe('ab'.repeat(32));
    expect(cacheKey(getChain('solana'), 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')).toBe('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
  });

  it('only EVM chains support token / internal history', () => {
    expect(historySupported(getChain('ethereum'), 'internal')).toBe(true);
    expect(historySupported(getChain('bitcoin'), 'tx')).toBe(true);
    expect(historySupported(getChain('bitcoin'), 'token')).toBe(false);
    expect(historySupported(getChain('solana'), 'internal')).toBe(false);
  });

  it('answers non-EVM token/internal history with an empty page without touching the network', async () => {
    const fetchMock = installFetch();
    await expect(fetchHistoryPage(getChain('bitcoin'), 'bc1qxyz', 'token')).resolves.toEqual({ items: [], source: 'esplora' });
    await expect(fetchHistoryPage(getChain('solana'), '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', 'internal')).resolves.toEqual({ items: [], source: 'solana-rpc' });
    await expect(fetchTokenBalances(getChain('bitcoin'), 'bc1qxyz')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes EVM history to the façade (Blockscout first)', async () => {
    const fetchMock = installFetch({
      blockscoutItems: [
        {
          hash: TX_HASH,
          from: { hash: ADDRESS },
          to: { hash: USDC },
          value: '0',
          timestamp: '2024-09-22T00:00:00.000000Z',
          block_number: 1,
          status: 'ok',
          method: 'transfer',
        },
      ],
    });
    const page = await fetchHistoryPage(getChain('ethereum'), ADDRESS, 'tx');
    expect(page.source).toBe('blockscout');
    expect(page.items).toHaveLength(1);
    expect(page.items[0].hash).toBe(TX_HASH);
    expect(page.items[0].direction).toBe('out');
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.startsWith(`${BLOCKSCOUT_ETH}/api/v2/addresses/`))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveSearch
// ---------------------------------------------------------------------------

describe('resolveSearch', () => {
  it('redirects EVM addresses to Ethereum, checksummed', async () => {
    const out = await resolveSearch(ADDRESS.toLowerCase());
    expect(out).toEqual({ status: 'redirect', kind: 'evm-address', chain: 'ethereum', path: `/address/ethereum/${ADDRESS}` });
  });

  it('redirects Solana and bech32 Bitcoin inputs without network calls', async () => {
    const fetchMock = installFetch();
    expect(await resolveSearch('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')).toMatchObject({ status: 'redirect', chain: 'solana', path: '/address/solana/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' });
    const sig = '5'.repeat(87);
    expect(await resolveSearch(sig)).toMatchObject({ status: 'redirect', chain: 'solana', path: `/tx/solana/${sig}` });
    expect(await resolveSearch('BC1QGDJQV0AV3Q56JVD82TKDJPY7GDP9UT8TLQMGRPMV24SQ90ECNVQQJWVW97')).toMatchObject({ status: 'redirect', chain: 'bitcoin', path: '/address/bitcoin/bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves ENS names through the registry and resolver', async () => {
    installFetch({ ens: 'vitalik.eth' });
    const out = await resolveSearch('Vitalik.eth');
    expect(out).toEqual({ status: 'redirect', kind: 'ens-name', chain: 'ethereum', path: `/address/ethereum/${VITALIK}` });
  });

  it('reports an error for ENS names without a record', async () => {
    const out = await resolveSearch('nobody-here-xyz.eth');
    expect(out.status).toBe('error');
    if (out.status === 'error') expect(out.message).toMatch(/does not resolve/);
  });

  it('finds the chain of an EVM transaction hash', async () => {
    installFetch({ txOn: 'base' });
    const out = await resolveSearch(TX_HASH);
    expect(out).toEqual({ status: 'redirect', kind: 'evm-tx', chain: 'base', path: `/tx/base/${TX_HASH}` });
  });

  it('offers chain choices when no chain knows the hash', async () => {
    const out = await resolveSearch(TX_HASH);
    expect(out.status).toBe('choices');
    if (out.status === 'choices') {
      expect(out.choices.length).toBe(allChains(false).filter((c) => c.family === 'evm').length);
      expect(out.choices.every((c) => c.found === false && c.path?.startsWith('/tx/'))).toBe(true);
    }
  });

  it('probes Bitcoin and EVM for a bare 64-hex hash and redirects to the single hit', async () => {
    installFetch({ txOn: 'arbitrum' });
    const bare = TX_HASH.slice(2);
    const out = await resolveSearch(bare);
    expect(out).toMatchObject({ status: 'redirect', chain: 'arbitrum', path: `/tx/arbitrum/${TX_HASH}` });
  });

  it('shows explorer links for block numbers and an error for garbage', async () => {
    const block = await resolveSearch('19000000');
    expect(block.status).toBe('choices');
    if (block.status === 'choices') {
      expect(block.choices[0].href).toContain('/block/19000000');
      expect(block.choices.every((c) => c.href && !c.path)).toBe(true);
    }
    const junk = await resolveSearch('hello world!!');
    expect(junk.status).toBe('error');
    expect((await resolveSearch('   ')).status).toBe('error');
  });

  it('propagates aborts', async () => {
    installFetch({ ens: 'vitalik.eth' });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(resolveSearch('vitalik.eth', { signal: ctrl.signal })).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Recent searches, theme, prices, settings drafts
// ---------------------------------------------------------------------------

describe('recent searches', () => {
  it('adds, de-duplicates (case-insensitive), caps at 10 and persists', () => {
    addRecentSearch({ query: 'vitalik.eth', kind: 'ens-name', chain: 'ethereum', path: `/address/ethereum/${VITALIK}` });
    addRecentSearch({ query: ADDRESS, kind: 'evm-address', chain: 'ethereum' });
    addRecentSearch({ query: 'VITALIK.ETH', kind: 'ens-name', chain: 'ethereum' });
    let list = readRecentSearches();
    expect(list.map((r) => r.query)).toEqual(['VITALIK.ETH', ADDRESS]);
    for (let i = 0; i < 15; i++) addRecentSearch({ query: `q${i}`, kind: 'unknown' });
    list = readRecentSearches();
    expect(list).toHaveLength(RECENT_SEARCHES_MAX);
    expect(list[0].query).toBe('q14');
    expect(JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) ?? '[]')).toHaveLength(RECENT_SEARCHES_MAX);
    removeRecentSearch('Q14');
    expect(readRecentSearches()[0].query).toBe('q13');
    clearRecentSearches();
    expect(readRecentSearches()).toEqual([]);
    expect(addRecentSearch({ query: '   ', kind: 'unknown' })).toEqual([]);
  });

  it('ignores corrupt storage', () => {
    localStorage.setItem(RECENT_SEARCHES_KEY, '{not json');
    addRecentSearch({ query: 'x', kind: 'unknown' });
    expect(readRecentSearches().map((r) => r.query)).toEqual(['x']);
  });

  it('drops persisted entries whose path is not an in-app route', async () => {
    const good = { query: 'ok', kind: 'unknown', at: 1, path: `/address/ethereum/${VITALIK}` };
    localStorage.setItem(
      RECENT_SEARCHES_KEY,
      JSON.stringify([
        { query: 'js', kind: 'unknown', at: 4, path: 'javascript:alert(1)' },
        { query: 'ext', kind: 'unknown', at: 3, path: '//evil.example/x' },
        { query: 'abs', kind: 'unknown', at: 2, path: 'https://evil.example/x' },
        { query: 'num', kind: 'unknown', at: 2, path: 5 },
        { query: 'chain', kind: 'unknown', at: 2, chain: 7 },
        good,
        { query: 'nopath', kind: 'unknown', at: 0 },
      ]),
    );
    // Fresh module instance so the in-memory cache is bypassed and storage is re-read.
    vi.resetModules();
    const fresh = await import('@/hooks/useRecentSearches');
    expect(fresh.readRecentSearches()).toEqual([good, { query: 'nopath', kind: 'unknown', at: 0 }]);
    vi.resetModules();
  });
});

describe('theme', () => {
  it('cycles system → dark → light → system', () => {
    expect(nextTheme('system')).toBe('dark');
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('light')).toBe('system');
  });

  it('writes data-theme on the document element (empty for system)', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBe('');
  });
});

describe('prices & balances helpers', () => {
  const usdc = { chain: 'ethereum', address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: 6, type: 'ERC-20' as const };
  const junk = { chain: 'ethereum', address: '0x1111111111111111111111111111111111111111', name: 'Junk', symbol: 'JUNK', decimals: 18, type: 'ERC-20' as const };

  it('normalises price keys and derives token keys per chain', () => {
    expect(normalizePriceKeys([' b ', 'a', 'b', ''])).toEqual(['a', 'b']);
    expect(tokenPriceKey(usdc)).toBe(`ethereum:${USDC.toLowerCase()}`);
    expect(tokenPriceKey({ ...usdc, chain: 'bsc', type: 'native' })).toBe('coingecko:binancecoin');
    expect(tokenPriceKey({ ...usdc, chain: 'nope' })).toBeUndefined();
  });

  it('attaches USD and sorts priced balances first', () => {
    const balances: TokenBalance[] = [
      { token: junk, balance: 10n ** 24n },
      { token: usdc, balance: 2_500_000n },
    ];
    const priced = priceBalances(balances, { [`ethereum:${USDC.toLowerCase()}`]: 1 });
    expect(priced[1].usd).toBeCloseTo(2.5);
    expect(priced[0].usd).toBeUndefined();
    const sorted = sortBalances(priced);
    expect(sorted[0].token.symbol).toBe('USDC');
  });
});

describe('settings drafts', () => {
  it('round-trips custom RPCs and keys, dropping invalid URLs', () => {
    const draft = toDraft({ customRpc: { ethereum: ['https://a', 'https://b'] }, etherscanApiKey: 'K', alchemyApiKey: undefined, heliusApiKey: undefined, showTestnets: true, enableSanctionsFeed: false });
    expect(draft.rpc.ethereum).toBe('https://a\nhttps://b');
    expect(draft.etherscanApiKey).toBe('K');
    const back = fromDraft({ ...draft, rpc: { ethereum: ' https://a \nnot a url\n\nhttps://c', base: '' }, etherscanApiKey: '  ' });
    expect(back.customRpc).toEqual({ ethereum: ['https://a', 'https://c'] });
    expect(back.etherscanApiKey).toBeUndefined();
    expect(back.showTestnets).toBe(true);
    expect(back.enableSanctionsFeed).toBe(false);
  });

  it('toDraft tolerates malformed persisted customRpc values', () => {
    const bad = { customRpc: { ethereum: 'https://x', base: ['https://ok', 5], bitcoin: null }, etherscanApiKey: undefined, alchemyApiKey: undefined, heliusApiKey: undefined, showTestnets: false, enableSanctionsFeed: true };
    const draft = toDraft(bad as unknown as Parameters<typeof toDraft>[0]);
    expect(draft.rpc.ethereum).toBe('');
    expect(draft.rpc.base).toBe('https://ok');
    expect(draft.rpc.bitcoin).toBe('');
  });

  it('insecureRpcUrls flags plain-http endpoints except loopback hosts', () => {
    expect(insecureRpcUrls({ ethereum: ['http://10.0.0.5:8545', 'https://a', 'http://localhost:8545', 'http://127.0.0.1:8545', 'http://[::1]:8545', 'http://node.localhost'], base: ['HTTP://evil.example'] })).toEqual(['http://10.0.0.5:8545', 'HTTP://evil.example']);
    expect(insecureRpcUrls({})).toEqual([]);
  });
});

describe('risk / approvals helpers', () => {
  it('labels spenders and counterparties from the registry', () => {
    const tornado = '0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b';
    const approvals = labelApprovals('ethereum', [
      { token: { chain: 'ethereum', address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: 6, type: 'ERC-20' }, spender: tornado, amount: 1n, unlimited: false, txHash: TX_HASH },
      { token: { chain: 'ethereum', address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: 6, type: 'ERC-20' }, spender: '0x2222222222222222222222222222222222222222', amount: 1n, unlimited: false, txHash: TX_HASH },
    ]);
    expect(approvals[0].spenderLabel).toMatch(/tornado/i);
    expect(approvals[1].spenderLabel).toBeUndefined();

    const rows: TxListItem[] = [
      { chain: 'ethereum', hash: TX_HASH, from: ADDRESS, to: tornado, value: { raw: 1n, decimals: 18, symbol: 'ETH' }, status: 'success', direction: 'out' },
      { chain: 'bitcoin', hash: 'b'.repeat(64), from: `${tornado},${ADDRESS}`, to: ADDRESS, value: { raw: 1n, decimals: 8, symbol: 'BTC' }, status: 'success', direction: 'in' },
    ];
    const labels = counterpartyLabels('ethereum', rows, ADDRESS);
    expect(labels.get(tornado.toLowerCase())?.category).toMatch(/mixer|sanctioned/);
    expect(labels.has(ADDRESS.toLowerCase())).toBe(false);
    const input = buildRiskInput('ethereum', ADDRESS, { history: rows, nativePriceUsd: 2500 });
    expect(input.counterpartyLabels?.size).toBe(1);
    expect(input.nativePriceUsd).toBe(2500);
    expect(input.historyComplete).toBeUndefined();
    expect(buildRiskInput('ethereum', ADDRESS, { history: rows, historyComplete: false }).historyComplete).toBe(false);
    expect(buildRiskInput('ethereum', ADDRESS, { history: rows, historyComplete: true }).historyComplete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

describe('components', () => {
  it('ChainBadge shows the short name, full name and brand colour', async () => {
    const html = await render(<ChainBadge chain="ethereum" />);
    expect(html).toContain('ETH');
    expect(html).toContain('--chain-color: #627eea');
    expect(await render(<ChainBadge chain="bitcoin" showName />)).toContain('Bitcoin');
    expect(await render(<ChainBadge chain="nope" />)).toContain('nope');
  });

  it('RiskBadge carries the test id and the level text', async () => {
    const html = await render(<RiskBadge report={{ score: 62, level: 'high', flags: [] }} />);
    expect(html).toContain('data-testid="risk-badge"');
    expect(html).toContain('high');
    expect(html).toContain('62');
    expect(await render(<RiskBadge loading testId={null} />)).not.toContain('data-testid');
    expect(await render(<RiskBadge />)).toContain('none');
  });

  it('AddressDisplay checksums, links, labels known addresses and splits comma lists', async () => {
    const html = await render(<AddressDisplay address={USDC.toLowerCase()} chain="ethereum" copy />);
    expect(html).toContain(`href="/address/ethereum/${USDC}"`);
    expect(html).toContain('0xA0b8…eB48');
    expect(html).toMatch(/chip chip--token[^>]*>[^<]*USDC/);
    expect(html).toContain('copy-btn');
    expect(await render(<AddressDisplay address="coinbase" chain="bitcoin" />)).toContain('block reward');
    const multi = await render(<AddressDisplay address={`${ADDRESS},${USDC},${VITALIK},${RESOLVER}`} chain="ethereum" />);
    expect(count(multi, 'href="/address/ethereum/')).toBe(3);
    expect(multi).toContain('+1 more');
    const labelOnly = await render(<AddressDisplay address={USDC} chain="ethereum" labelOnly />);
    expect(labelOnly).not.toContain('0xA0b8…eB48');
    expect(labelOnly).toContain('USDC');
  });

  it('AddressDisplay does not treat Object.prototype keys as special placeholders', async () => {
    for (const value of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const html = await render(<AddressDisplay address={value} chain="ethereum" />);
      expect(html).not.toContain('addr--special');
      expect(html).toContain('addr__text');
      expect(html).toContain(value);
    }
    expect(await render(<AddressDisplay address="unknown" chain="ethereum" />)).toContain('addr--special');
  });

  it('reflects case tags registered as labels', async () => {
    const custom: AddressLabel = { address: ADDRESS, chain: 'ethereum', name: 'Suspect #1', category: 'wallet', source: 'case' };
    registerLabels([custom]);
    expect(await render(<AddressDisplay address={ADDRESS} chain="ethereum" />)).toContain('Suspect #1');
    expect(await render(<LabelChip label={custom} />)).toContain('chip--wallet');
    expect(await render(<LabelChip label={{ ...custom, url: 'https://example.org' }} />)).toContain('href="https://example.org"');
  });

  it('HashDisplay links to the transaction page', async () => {
    const html = await render(<HashDisplay hash={TX_HASH} chain="base" copy />);
    expect(html).toContain(`href="/tx/base/${TX_HASH}"`);
    expect(html).toContain('0xaaaaaa…aaaaaa');
  });

  it('AmountCell formats values with direction signs and USD', async () => {
    const amount = { raw: 1_500_000_000_000_000_000n, decimals: 18, symbol: 'ETH' };
    expect(await render(<AmountCell amount={amount} direction="in" usd={3750} />)).toMatch(/\+1\.5.*ETH.*\$3,750\.00/s);
    expect(await render(<AmountCell amount={amount} direction="out" />)).toContain('−1.5');
    expect(await render(<AmountCell amount={{ ...amount, raw: 0n }} direction="out" />)).not.toContain('−');
    expect(await render(<AmountCell amount={amount} hideSymbol />)).not.toContain('amount__symbol');
  });

  it('Timestamp renders relative / absolute forms', async () => {
    const ts = 1_700_000_000;
    expect(await render(<Timestamp ts={ts} mode="date" />)).toContain('2023-11-14 22:13:20 UTC');
    expect(await render(<Timestamp ts={ts} />)).toMatch(/ago/);
    expect(await render(<Timestamp ts={ts} mode="both" />)).toContain('ts__abs');
    expect(await render(<Timestamp />)).toContain('—');
  });

  it('DataTable renders rows, loading, error and empty states', async () => {
    const columns = [
      { key: 'a', header: 'A', render: (r: { a: string }) => r.a },
      { key: 'b', header: 'B', render: () => 'x', hideOnMobile: true, align: 'right' as const },
    ];
    const rows = await render(<DataTable columns={columns} rows={[{ a: 'one' }, { a: 'two' }]} rowKey={(r) => r.a} testId="t" />);
    expect(rows).toContain('data-testid="t"');
    expect(count(rows, '<tr')).toBe(3);
    expect(rows).toContain('hide-mobile');
    expect(rows).toContain('align-right');
    expect(await render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.a} loading />)).toContain('spinner');
    expect(await render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.a} error={new Error('boom')} />)).toContain('boom');
    expect(await render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.a} emptyTitle="Nothing" />)).toContain('Nothing');
    expect(await render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.a} emptyNode={<i>custom</i>} />)).toContain('<i>custom</i>');
  });

  it('StatGrid, Tabs, Card, EmptyState and LoadMore render their structure', async () => {
    const grid = await render(<StatGrid stats={[{ label: 'Balance', value: '1 ETH', hint: '$2,500', testId: 'address-native-balance', mono: true }]} />);
    expect(grid).toContain('data-testid="address-native-balance"');
    expect(grid).toContain('1 ETH');
    expect(grid).toContain('$2,500');

    const tabs = await render(<Tabs tabs={[{ id: 'a', label: 'A', testId: 'address-tab-transactions', count: 3 }, { id: 'b', label: 'B', disabled: true }]} active="a" onChange={() => undefined} />);
    expect(tabs).toContain('data-testid="address-tab-transactions"');
    expect(tabs).toContain('aria-selected="true"');
    expect(tabs).toContain('disabled=""');
    expect(tabs).toContain('tabs__count');

    const card = await render(
      <Card title="Title" subtitle="Sub" actions={<b>act</b>} testId="card">
        body
      </Card>,
    );
    expect(card).toContain('data-testid="card"');
    expect(card).toContain('<h2 class="card__title">Title</h2>');
    expect(card).toContain('<b>act</b>');

    expect(await render(<EmptyState title="Empty" hint="hint" action={<a href="/">go</a>} />)).toContain('empty__action');
    expect(await render(<LoadMore hasMore loading={false} onLoadMore={() => undefined} count={25} source="blockscout" />)).toMatch(/25 rows.*blockscout.*Load more/s);
    expect(await render(<Pagination hasMore={false} loading={false} onLoadMore={() => undefined} count={3} />)).toContain('End of results');
    expect(await render(<LoadMore hasMore loading onLoadMore={() => undefined} />)).toContain('Loading…');
  });

  it('ErrorBox adds a Settings hint for provider / API key errors', async () => {
    const html = await render(<ErrorBox error={new Error('No history provider for BNB Smart Chain; add an Etherscan API key in Settings')} onRetry={() => undefined} />);
    expect(html).toContain('href="/settings"');
    expect(html).toContain('Retry');
    expect(await render(<ErrorBox message="plain" />)).not.toContain('href="/settings"');
    expect(await render(<ErrorBox error={new Error('HTTP 429 from x')} />)).toContain('rate-limited');
    expect(errorMessage(new Error('x'))).toBe('x');
    expect(errorMessage('s')).toBe('s');
    expect(errorMessage({ message: 'm' })).toBe('m');
    expect(errorMessage(42)).toBe('Unknown error');
  });

  it('SearchBar carries the test ids and builds the search route', async () => {
    const m = await mount(<SearchBar size="hero" initial="abc" />);
    expect(m.html).toContain('data-testid="search-input"');
    expect(m.html).toContain('data-testid="search-submit"');
    expect(m.container.querySelector<HTMLInputElement>('[data-testid="search-input"]')?.value).toBe('abc');
    m.unmount();
    expect(searchPath(' vitalik.eth ')).toBe('/search/vitalik.eth');
    expect(searchPath('a b')).toBe('/search/a%20b');
  });

  it('ChainSelect lists chains and honours the testnet setting', async () => {
    expect(await render(<ChainSelect value="ethereum" onChange={() => undefined} />)).not.toContain('Sepolia');
    expect(await render(<ChainSelect value="ethereum" onChange={() => undefined} includeTestnets />)).toContain('Sepolia');
    const m = await mount(<ChainSelect value="bitcoin" onChange={() => undefined} family="evm" />);
    expect(m.container.querySelector('select')?.value).toBe('bitcoin');
    expect(m.html).not.toContain('Bitcoin</option>');
    m.unmount();
  });

  it('AddToCaseButton reflects membership in the active case', async () => {
    expect(await render(<AddToCaseButton chain="ethereum" kind="address" value={ADDRESS} />)).toContain('+ Add to case');
    const c = useCases.getState().createCase('Case A');
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'address', value: ADDRESS });
    expect(await render(<AddToCaseButton chain="ethereum" kind="address" value={ADDRESS.toLowerCase()} />)).toContain('✓ In case');
    useCases.getState().createCase('Case B');
    expect(await render(<AddToCaseButton chain="ethereum" kind="address" value={ADDRESS} />)).toContain('<select');
  });

  it('AddToCaseButton creates a case on first use and toggles membership on click', async () => {
    const m = await mount(<AddToCaseButton chain="ethereum" kind="tx" value={TX_HASH} />);
    const button = () => m.container.querySelector('button') as HTMLButtonElement;
    await act(async () => button().click());
    expect(useCases.getState().cases).toHaveLength(1);
    expect(useCases.getState().cases[0].entities[0].value).toBe(TX_HASH);
    expect(button().textContent).toContain('In case');
    await act(async () => button().click());
    expect(useCases.getState().cases[0].entities).toHaveLength(0);
    expect(button().textContent).toContain('Add to case');
    m.unmount();
  });
});

// ---------------------------------------------------------------------------
// Layout & pages
// ---------------------------------------------------------------------------

describe('layout', () => {
  it('shows the nav test ids, the compact search only off-home and the footer note', async () => {
    const home = await render(<Layout>x</Layout>, '/');
    for (const id of ['nav-home', 'nav-cases', 'nav-settings', 'nav-about']) expect(home).toContain(`data-testid="${id}"`);
    expect(home).not.toContain('data-testid="search-input"');
    expect(home).toContain('All data is fetched client-side from public endpoints.');
    expect(home).toContain('https://github.com/loxlid/loxdetective');

    const other = await mount(<Layout>x</Layout>, '/search/vitalik.eth');
    expect(count(other.html, 'data-testid="search-input"')).toBe(1);
    expect(other.container.querySelector<HTMLInputElement>('[data-testid="search-input"]')?.value).toBe('vitalik.eth');
    other.unmount();
  });

  it('skip link moves focus to the main region instead of navigating the router', async () => {
    const m = await mount(
      <Routes>
        <Route
          path="/about"
          element={
            <Layout>
              <span data-testid="about-body">About body</span>
            </Layout>
          }
        />
        <Route path="*" element={<span data-testid="not-found">404</span>} />
      </Routes>,
      '/about',
    );
    const skip = m.container.querySelector<HTMLAnchorElement>('a.skip-link');
    const main = m.container.querySelector<HTMLElement>('main#main');
    expect(skip?.getAttribute('href')).toBe('#main');
    expect(main?.getAttribute('tabindex')).toBe('-1');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    let notPrevented = true;
    await act(async () => {
      notPrevented = skip!.dispatchEvent(ev);
    });
    expect(notPrevented).toBe(false);
    expect(document.activeElement?.id).toBe('main');
    expect(m.container.querySelector('[data-testid="about-body"]')).not.toBeNull();
    expect(m.container.querySelector('[data-testid="not-found"]')).toBeNull();
    m.unmount();
  });
});

describe('pages', () => {
  it('Home renders one h1, the hero search, six tiles, the chain strip and recent searches', async () => {
    addRecentSearch({ query: 'vitalik.eth', kind: 'ens-name', chain: 'ethereum', path: `/address/ethereum/${VITALIK}` });
    const html = await render(<HomePage />);
    expect(count(html, '<h1')).toBe(1);
    expect(html).toContain('Follow the money across every chain.');
    expect(count(html, 'data-testid="search-input"')).toBe(1);
    expect(count(html, 'class="tile"')).toBe(6);
    expect(count(html, 'chain-badge__name')).toBeGreaterThanOrEqual(allChains(false).length);
    expect(html).toContain('Recent searches');
    expect(html).toContain(`href="/address/ethereum/${VITALIK}"`);
  });

  it('Home hides testnets unless enabled', async () => {
    expect(await render(<HomePage />)).not.toContain('Sepolia');
    useSettings.getState().set({ showTestnets: true });
    expect(await render(<HomePage />)).toContain('Sepolia');
  });

  it('Settings exposes one textarea per chain plus key / save test ids, reflecting the store', async () => {
    useSettings.getState().set({ customRpc: { ethereum: ['https://example-rpc.test'] }, etherscanApiKey: 'KEY' });
    const m = await mount(<SettingsPage />);
    expect(m.html).toContain('data-testid="settings-page"');
    expect(m.html).toContain('data-testid="settings-save"');
    expect(m.container.querySelector<HTMLInputElement>('[data-testid="settings-etherscan-key"]')?.value).toBe('KEY');
    expect(m.container.querySelector<HTMLTextAreaElement>('[data-testid="settings-rpc-ethereum"]')?.value).toBe('https://example-rpc.test');
    for (const c of CHAINS.filter((c) => !c.testnet)) expect(m.html).toContain(`data-testid="settings-rpc-${c.id}"`);
    expect(m.html).not.toContain('data-testid="settings-rpc-sepolia"');
    m.unmount();
    useSettings.getState().set({ showTestnets: true });
    expect(await render(<SettingsPage />)).toContain('data-testid="settings-rpc-sepolia"');
  });

  it('Settings saves edited RPCs and keys through the store on Save', async () => {
    const m = await mount(<SettingsPage />);
    const ta = m.container.querySelector<HTMLTextAreaElement>('[data-testid="settings-rpc-ethereum"]') as HTMLTextAreaElement;
    const key = m.container.querySelector<HTMLInputElement>('[data-testid="settings-etherscan-key"]') as HTMLInputElement;
    // React listens to the native `input` event; set the value through the prototype setter so the tracker notices.
    const setValue = (el: HTMLTextAreaElement | HTMLInputElement, value: string) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => setValue(ta, 'https://example-rpc.test\nftp://nope'));
    await act(async () => setValue(key, 'ABC'));
    await act(async () => (m.container.querySelector('[data-testid="settings-save"]') as HTMLButtonElement).click());
    expect(useSettings.getState().customRpc).toEqual({ ethereum: ['https://example-rpc.test'] });
    expect(useSettings.getState().etherscanApiKey).toBe('ABC');
    expect(localStorage.getItem('loxdetective.settings.v1')).toContain('https://example-rpc.test');
    m.unmount();
  });

  it('Cases shows the create form, the selected case notes panel and persisted content', async () => {
    const empty = await render(<CasesPage />);
    expect(empty).toContain('data-testid="cases-page"');
    expect(empty).toContain('data-testid="case-title-input"');
    expect(empty).toContain('data-testid="case-create"');
    expect(empty).not.toContain('data-testid="case-note-input"');

    const c = useCases.getState().createCase('Test case');
    useCases.getState().setActive(c.id);
    useCases.getState().addNote(c.id, 'hello');
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'address', value: ADDRESS, tag: 'Suspect' });
    const m = await mount(<CasesPage />);
    expect(m.html).toContain('Test case');
    expect(m.html).toContain('hello');
    expect(m.html).toContain('data-testid="case-note-input"');
    expect(m.html).toContain('data-testid="case-add-note"');
    expect(m.html).toContain(`href="/address/ethereum/${ADDRESS}"`);
    expect(m.container.querySelector<HTMLInputElement>('.entity__tag')?.value).toBe('Suspect');
    m.unmount();
  });

  it('Cases: create selects the new case and add-note appends to it', async () => {
    const m = await mount(<CasesPage />);
    const q = <T extends Element>(sel: string) => m.container.querySelector<T>(sel) as T;
    const setValue = (el: HTMLTextAreaElement | HTMLInputElement, value: string) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => setValue(q<HTMLInputElement>('[data-testid="case-title-input"]'), 'Test case'));
    await act(async () => q<HTMLButtonElement>('[data-testid="case-create"]').click());
    const created = useCases.getState().cases[0];
    expect(created.title).toBe('Test case');
    expect(useCases.getState().activeCaseId).toBe(created.id);
    expect(q<HTMLInputElement>('[data-testid="case-title-input"]').value).toBe('');
    await act(async () => setValue(q<HTMLTextAreaElement>('[data-testid="case-note-input"]'), 'hello'));
    await act(async () => q<HTMLButtonElement>('[data-testid="case-add-note"]').click());
    expect(useCases.getState().cases[0].notes[0].text).toBe('hello');
    expect(m.container.textContent).toContain('hello');
    expect(localStorage.getItem('loxdetective.cases.v1')).toContain('hello');
    // A second case created while one is active still becomes the selection.
    await act(async () => q<HTMLButtonElement>('[data-testid="case-create"]').click());
    expect(useCases.getState().cases).toHaveLength(2);
    expect(useCases.getState().activeCaseId).toBe(useCases.getState().cases[1].id);
    m.unmount();
  });

  it('About lists every chain and the privacy / disclaimer sections', async () => {
    const html = await render(<AboutPage />);
    for (const c of CHAINS) expect(html).toContain(c.name);
    expect(html).toContain('Privacy');
    expect(html).toContain('Disclaimer');
    expect(html).toContain('coins.llama.fi');
  });

  it('NotFound shows the path', async () => {
    expect(await render(<NotFoundPage />, '/nope/here')).toContain('/nope/here');
  });

  it('App routes to the stub pages with their test ids', async () => {
    const html = (path: string) => render(<App />, path);
    expect(await html(`/tx/ethereum/${TX_HASH}`)).toContain('data-testid="tx-page"');
    expect(await html(`/address/ethereum/${ADDRESS}`)).toContain('data-testid="address-page"');
    expect(await html(`/trace/ethereum/${ADDRESS}`)).toContain('data-testid="trace-page"');
    expect(await html('/settings')).toContain('data-testid="settings-page"');
    expect(await html('/cases')).toContain('data-testid="cases-page"');
    expect(await html('/about')).toContain('About LoxDetective');
    expect(await html('/whatever')).toContain('Page not found');
    const home = await html('/');
    expect(count(home, '<h1')).toBe(1);
    expect(count(home, 'data-testid="search-input"')).toBe(1);
    const search = await html('/search/hello%20world!!');
    expect(search).toContain('hello world!!');
    expect(count(search, 'data-testid="search-input"')).toBe(1);
  });

  it('App applies the theme to <html> and title to the document', async () => {
    useSettings.getState().set({ theme: 'light' });
    const m = await mount(<App />, '/settings');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.title).toContain('Settings');
    expect(document.title).toContain('LoxDetective');
    m.unmount();
  });

  it('routes render inside a Routes element', async () => {
    const html = await render(
      <Routes>
        <Route path="/x" element={<p>ok</p>} />
      </Routes>,
      '/x',
    );
    expect(html).toBe('<p>ok</p>');
  });
});
