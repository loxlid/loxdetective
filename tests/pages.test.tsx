// @vitest-environment jsdom
/**
 * Investigation pages (Address / Tx / Trace) rendered in jsdom with a mocked
 * `fetch`: JSON-RPC answered by method, Blockscout empty collections, an
 * Esplora address + transaction fixture, DefiLlama prices. Plus the pure
 * helpers the pages export.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

import type { NativeBalance, Transaction, TxListItem } from '@/lib/types';
import { getChain } from '@/lib/chains/registry';
import { useSettings } from '@/lib/settings/store';
import { useCases } from '@/lib/cases/store';
import AddressPage, { tabsFor, validateAddressRoute } from '@/pages/AddressPage';
import TxPage, { buildTxStats, extraLabel, extraValue } from '@/pages/TxPage';
import TracePage, { clampInt, describeTransfers, DEFAULT_TRACE_FORM } from '@/pages/TracePage';
import { orderBalances, seenRange } from '@/components/address/OverviewTab';
import { counterpartyOf } from '@/components/address/HistoryTable';
import { transferPriceKey } from '@/components/tx/TransfersTable';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ADDRESS = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TX_HASH = `0x${'aa'.repeat(32)}`;
const BLOCK_HASH = `0x${'bb'.repeat(32)}`;
const ZERO_WORD = `0x${'00'.repeat(32)}`;
const ONE_ETH_WEI = '0xde0b6b3a7640000';
const GAS_PRICE = '0x3b9aca00'; // 1 gwei
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const BTC_ADDR = 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97';
const BTC_OTHER = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const BTC_TXID = 'b'.repeat(64);

function word(n: bigint | number): string {
  return BigInt(n).toString(16).padStart(64, '0');
}
function topicAddress(address: string): string {
  return `0x${address.toLowerCase().slice(2).padStart(64, '0')}`;
}
function abiString(s: string): string {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  return `0x${word(32)}${word(hex.length / 2)}${hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')}`;
}

const TRANSFER_CALLDATA = `0xa9059cbb${topicAddress(RECIPIENT).slice(2)}${word(1_000_000)}`;

const MOCK_TX = {
  hash: TX_HASH,
  nonce: '0x5',
  blockHash: BLOCK_HASH,
  blockNumber: '0x1234567',
  transactionIndex: '0x1',
  from: ADDRESS.toLowerCase(),
  to: USDC.toLowerCase(),
  value: '0x0',
  gas: '0x186a0',
  gasPrice: GAS_PRICE,
  maxFeePerGas: GAS_PRICE,
  maxPriorityFeePerGas: GAS_PRICE,
  input: TRANSFER_CALLDATA,
  type: '0x2',
};
const MOCK_RECEIPT = {
  transactionHash: TX_HASH,
  transactionIndex: '0x1',
  blockHash: BLOCK_HASH,
  blockNumber: '0x1234567',
  from: ADDRESS.toLowerCase(),
  to: USDC.toLowerCase(),
  gasUsed: '0xd6d8',
  effectiveGasPrice: GAS_PRICE,
  contractAddress: null,
  status: '0x1',
  logs: [
    {
      address: USDC.toLowerCase(),
      topics: [TRANSFER_TOPIC, topicAddress(ADDRESS), topicAddress(RECIPIENT)],
      data: `0x${word(1_000_000)}`,
      blockNumber: '0x1234567',
      transactionHash: TX_HASH,
      logIndex: '0x0',
      removed: false,
    },
  ],
};
const MOCK_BLOCK = { number: '0x1234567', hash: BLOCK_HASH, timestamp: '0x66f00000', transactions: [TX_HASH] };

const BTC_TX = {
  txid: BTC_TXID,
  version: 2,
  locktime: 0,
  vin: [{ txid: 'c'.repeat(64), vout: 0, prevout: { scriptpubkey_address: BTC_OTHER, scriptpubkey_type: 'v0_p2wpkh', value: 150_000 }, is_coinbase: false, sequence: 0xfffffffd }],
  vout: [
    { scriptpubkey_address: BTC_ADDR, scriptpubkey_type: 'v0_p2wsh', value: 100_000 },
    { scriptpubkey_address: BTC_OTHER, scriptpubkey_type: 'v0_p2wpkh', value: 49_000 },
  ],
  size: 222,
  weight: 561,
  fee: 1000,
  status: { confirmed: true, block_height: 850_000, block_hash: 'd'.repeat(64), block_time: 1_720_000_000 },
};
const BTC_STATS = {
  address: BTC_ADDR,
  chain_stats: { funded_txo_count: 1, funded_txo_sum: 100_000, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 1 },
  mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
};
const PRICES = {
  coins: {
    'coingecko:ethereum': { price: 2500, symbol: 'ETH', decimals: 18, timestamp: 1_720_000_000, confidence: 0.99 },
    'coingecko:bitcoin': { price: 60_000, symbol: 'BTC', decimals: 8, timestamp: 1_720_000_000, confidence: 0.99 },
    [`ethereum:${USDC.toLowerCase()}`]: { price: 1, symbol: 'USDC', decimals: 6, timestamp: 1_720_000_000, confidence: 0.99 },
  },
};

const COLLECTIONS = new Set(['transactions', 'token-transfers', 'tokens', 'internal-transactions', 'logs']);

type RpcReq = { id: number; method: string; params?: unknown[] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function ethCall(data: string): string {
  switch (data.slice(0, 10).toLowerCase()) {
    case '0x313ce567':
      return `0x${word(6)}`;
    case '0x95d89b41':
      return abiString('USDC');
    case '0x06fdde03':
      return abiString('USD Coin');
    default:
      return ZERO_WORD;
  }
}

/** Ethereum mainnet endpoints: the only ones that know the mocked transaction. */
const ETHEREUM_RPCS = new Set(getChain('ethereum').rpcUrls.map((u) => u.replace(/\/+$/, '').toLowerCase()));

function answerRpc(r: RpcReq, url: string): unknown {
  const params = r.params ?? [];
  const isEthereum = ETHEREUM_RPCS.has(url.replace(/\/+$/, '').toLowerCase());
  const wantsTx = isEthereum && String(params[0] ?? '').toLowerCase() === TX_HASH;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: r.id, result });
  switch (r.method) {
    case 'eth_blockNumber':
      return ok('0x1234567');
    case 'eth_getBalance':
      return ok(ONE_ETH_WEI);
    case 'eth_getCode':
      return ok('0x');
    case 'eth_getTransactionCount':
      return ok('0x5');
    case 'eth_getTransactionByHash':
      return ok(wantsTx ? MOCK_TX : null);
    case 'eth_getTransactionReceipt':
      return ok(wantsTx ? MOCK_RECEIPT : null);
    case 'eth_getBlockByNumber':
      return ok(MOCK_BLOCK);
    case 'eth_call':
      return ok(ethCall((params[0] as { data?: string })?.data ?? ''));
    case 'eth_getStorageAt':
      return ok(ZERO_WORD);
    case 'eth_getLogs':
      return ok([]);
    default:
      return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `Method not found: ${r.method}` } };
  }
}

/** When set, Blockscout's internal-transactions endpoint keeps returning a next page (truncation path). */
let internalCallsEndless = false;

/** Mock fetch: JSON-RPC, Blockscout, Esplora, DefiLlama; 404 elsewhere. */
function installFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && init.body) {
      const req = JSON.parse(String(init.body)) as RpcReq | RpcReq[];
      return jsonResponse(Array.isArray(req) ? req.map((c) => answerRpc(c, url)) : answerRpc(req, url));
    }
    const path = new URL(url).pathname;
    if (path.includes('/api/v2/')) {
      const segments = path.split('/api/v2/')[1]?.split('/').filter(Boolean) ?? [];
      if (segments[0] === 'addresses' && segments.length === 2) {
        return jsonResponse({ hash: segments[1], is_contract: false, is_verified: false, name: null, ens_domain_name: null, token: null });
      }
      if (internalCallsEndless && segments[segments.length - 1] === 'internal-transactions') {
        return jsonResponse({ items: [{ transaction_hash: TX_HASH, from: { hash: USDC }, to: { hash: ADDRESS }, value: '0', type: 'call', success: true }], next_page_params: { index: 1 } });
      }
      if (COLLECTIONS.has(segments[segments.length - 1] ?? '')) return jsonResponse({ items: [], next_page_params: null });
      return jsonResponse({ message: 'Not found' }, 404);
    }
    if (url.includes('mempool.space') || url.includes('blockstream.info')) {
      if (path.endsWith('/blocks/tip/height')) return new Response('860000', { status: 200 });
      if (path.endsWith(`/address/${BTC_ADDR}`)) return jsonResponse(BTC_STATS);
      if (path.endsWith(`/address/${BTC_ADDR}/txs`)) return jsonResponse([BTC_TX]);
      if (path.endsWith(`/tx/${BTC_TXID}`)) return jsonResponse(BTC_TX);
      return jsonResponse({ error: 'not found' }, 404);
    }
    if (url.includes('coins.llama.fi')) return jsonResponse(PRICES);
    if (url.includes('raw.githubusercontent.com')) return jsonResponse([]);
    return jsonResponse({}, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Mounted {
  container: HTMLElement;
  unmount(): void;
}

function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="loc">{`${loc.pathname}${loc.search}`}</span>;
}

/** Roots still mounted when a test ends early (failed assertion); unmounted in `afterEach`. */
const live = new Set<Mounted>();

/** Client-render inside providers; effects run, stores are live. */
async function mount(el: ReactElement, path: string, routePattern: string): Promise<Mounted> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path={routePattern}
              element={
                <>
                  {el}
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  const mounted: Mounted = {
    container,
    unmount: () => {
      live.delete(mounted);
      act(() => root.unmount());
      container.remove();
      client.clear();
    },
  };
  live.add(mounted);
  return mounted;
}

/** Poll (inside `act`) until `check` passes. */
async function waitFor(check: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
}

const byTestId = (c: HTMLElement, id: string): HTMLElement | null => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const textOf = (c: HTMLElement, id: string): string => byTestId(c, id)?.textContent ?? '';

async function click(el: HTMLElement | null): Promise<void> {
  if (!el) throw new Error('click: element not found');
  await act(async () => {
    el.click();
  });
}

beforeEach(() => {
  installFetch();
  localStorage.clear();
  useSettings.getState().reset();
  useCases.setState({ cases: [], activeCaseId: undefined });
});

afterEach(() => {
  for (const m of Array.from(live)) m.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// Address page
// ---------------------------------------------------------------------------

describe('AddressPage', () => {
  it('renders an Ethereum EOA: balance with USD, counters, tabs with test ids, risk badge, tab in the URL', async () => {
    const m = await mount(<AddressPage />, `/address/ethereum/${ADDRESS.toLowerCase()}`, '/address/:chain/:address');
    const c = m.container;
    expect(byTestId(c, 'address-page')).not.toBeNull();
    // Header shows the checksummed address immediately, before data arrives.
    expect(c.querySelector('h1')?.textContent).toBe(ADDRESS);
    for (const id of ['address-tab-transactions', 'address-tab-tokens', 'address-tab-approvals', 'address-tab-contract', 'risk-badge', 'address-native-balance']) {
      expect(byTestId(c, id), id).not.toBeNull();
    }

    await waitFor(() => textOf(c, 'address-native-balance').includes('1 ETH'));
    expect(textOf(c, 'address-native-balance')).toContain('$2,500.00');
    expect(c.textContent).toContain('EOA');
    expect(c.textContent).toContain('Etherscan');
    expect(c.querySelector('a[href="/trace/ethereum/' + ADDRESS + '"]')).not.toBeNull();
    await waitFor(() => /none|low|medium|high|critical/i.test(textOf(c, 'risk-badge')));
    expect(textOf(c, 'risk-badge')).toMatch(/none/i);

    // Multi-chain strip links each chain to its own profile.
    await waitFor(() => c.querySelectorAll('.balance-tile').length > 0);
    expect(c.querySelector(`a.balance-tile[href="/address/base/${ADDRESS}"]`)).not.toBeNull();

    // Tabs: the selection is reflected in the URL query and the panel changes.
    await click(byTestId(c, 'address-tab-tokens'));
    expect(textOf(c, 'loc')).toBe(`/address/ethereum/${ADDRESS.toLowerCase()}?tab=tokens`);
    await waitFor(() => c.textContent?.includes('No token balances') ?? false);

    await click(byTestId(c, 'address-tab-transactions'));
    expect(textOf(c, 'loc')).toContain('?tab=transactions');
    await waitFor(() => c.textContent?.includes('No transactions found') ?? false);

    await click(byTestId(c, 'address-tab-approvals'));
    await waitFor(() => c.textContent?.includes('No active approvals found') ?? false);

    await click(byTestId(c, 'address-tab-contract'));
    await waitFor(() => c.textContent?.includes('Not a contract') ?? false);

    // Risk flags panel toggles open.
    await click(c.querySelector<HTMLElement>('.risk-toggle'));
    expect(c.textContent).toContain('Risk indicators');
    expect(c.textContent).toContain('No risk indicators found');
    m.unmount();
  });

  it('opens a tab directly from the URL query', async () => {
    const m = await mount(<AddressPage />, `/address/ethereum/${ADDRESS}?tab=approvals`, '/address/:chain/:address');
    await waitFor(() => m.container.textContent?.includes('Token approvals') ?? false);
    expect(m.container.querySelector('[data-testid="address-tab-approvals"]')?.className).toContain('is-active');
    m.unmount();
  });

  it('renders a Bitcoin address with received / sent / UTXO figures and the transactions tab', async () => {
    const m = await mount(<AddressPage />, `/address/bitcoin/${BTC_ADDR.toUpperCase()}`, '/address/:chain/:address');
    const c = m.container;
    expect(c.querySelector('h1')?.textContent).toBe(BTC_ADDR);
    // Only Overview + Transactions for Bitcoin.
    expect(byTestId(c, 'address-tab-tokens')).toBeNull();
    expect(byTestId(c, 'address-tab-contract')).toBeNull();

    await waitFor(() => textOf(c, 'address-native-balance').includes('0.001 BTC'));
    expect(textOf(c, 'address-native-balance')).toContain('$60.00');
    expect(c.textContent).toContain('Total received');
    expect(c.textContent).toContain('Unspent outputs');
    expect(c.textContent).toContain('SegWit script (P2WSH)');

    await click(byTestId(c, 'address-tab-transactions'));
    await waitFor(() => c.querySelectorAll('table tbody tr').length === 1);
    const row = c.querySelector('table tbody tr') as HTMLElement;
    expect(row.textContent).toContain('In');
    expect(row.textContent).toContain('+0.001');
    expect(row.querySelector(`a[href="/address/bitcoin/${BTC_OTHER}"]`)).not.toBeNull();
    expect(row.querySelector(`a[href="/tx/bitcoin/${BTC_TXID}"]`)).not.toBeNull();
    m.unmount();
  });

  it('shows an error for an unknown chain or an invalid EVM address but keeps the page root', async () => {
    const bad = await mount(<AddressPage />, '/address/nope/0x1234', '/address/:chain/:address');
    expect(byTestId(bad.container, 'address-page')).not.toBeNull();
    expect(bad.container.textContent).toContain('Unknown chain "nope"');
    bad.unmount();

    const invalid = await mount(<AddressPage />, '/address/base/not-an-address', '/address/:chain/:address');
    expect(invalid.container.textContent).toContain('not a valid EVM address');
    invalid.unmount();
  });
});

// ---------------------------------------------------------------------------
// Transaction page
// ---------------------------------------------------------------------------

describe('TxPage', () => {
  it('renders the mocked Ethereum transaction: status, parties, gas, decoded USDC transfer, event and calldata', async () => {
    const m = await mount(<TxPage />, `/tx/ethereum/${TX_HASH}`, '/tx/:chain/:hash');
    const c = m.container;
    expect(byTestId(c, 'tx-page')).not.toBeNull();
    expect(c.querySelector('h1')?.textContent).toBe(TX_HASH);

    await waitFor(() => /success/i.test(textOf(c, 'tx-status')));
    expect(byTestId(c, 'tx-status')?.className).toContain('status--success');
    await waitFor(() => textOf(c, 'tx-transfers').includes('USDC'));
    const transfers = textOf(c, 'tx-transfers');
    expect(transfers).toContain('1 USDC');
    expect(transfers).toContain('ERC-20');
    await waitFor(() => textOf(c, 'tx-transfers').includes('$1.00'));

    const text = c.textContent ?? '';
    expect(text).toContain('transfer(address,uint256)');
    expect(text).toContain('55,000 / 100,000');
    expect(text).toContain('55.0% of the limit');
    expect(text).toContain('1 gwei');
    expect(text).toContain('0.000055 ETH');
    expect(text).toContain('Block 19,088,743');
    expect(text).toContain('Transfer'); // decoded event name
    expect(text).toContain('Raw logs (1)');
    expect(text).toContain('68 bytes');
    expect(c.querySelector(`a[href="/address/ethereum/${USDC}"]`)).not.toBeNull();
    expect(c.querySelector(`a[href="/trace/ethereum/${ADDRESS}"]`)).not.toBeNull();
    m.unmount();
  });

  it('tells the reader when the explorer has more internal calls than were fetched', async () => {
    internalCallsEndless = true;
    try {
      const m = await mount(<TxPage />, `/tx/ethereum/${TX_HASH}`, '/tx/:chain/:hash');
      const c = m.container;
      await waitFor(() => (c.textContent ?? '').includes('explorer has more'));
      expect(c.textContent).toContain('first 5 calls (explorer has more)');
      expect(c.textContent).not.toContain('internalTruncated');
      m.unmount();
    } finally {
      internalCallsEndless = false;
    }
  });

  it('renders a Bitcoin transaction with inputs and outputs', async () => {
    const m = await mount(<TxPage />, `/tx/bitcoin/${BTC_TXID}`, '/tx/:chain/:hash');
    const c = m.container;
    await waitFor(() => /success/i.test(textOf(c, 'tx-status')));
    const text = c.textContent ?? '';
    expect(text).toContain('Inputs (1)');
    expect(text).toContain('Outputs (2)');
    expect(text).toContain('0.00001 BTC'); // fee
    expect(text).toContain('0.00149 BTC'); // total output
    expect(text).toContain('confirmations');
    expect(text).toContain('largest input');
    expect(textOf(c, 'tx-transfers')).toContain('BTC');
    expect(c.querySelectorAll(`a[href="/address/bitcoin/${BTC_OTHER}"]`).length).toBeGreaterThan(0);
    m.unmount();
  });

  it('shows a retryable error when the transaction does not exist', async () => {
    const m = await mount(<TxPage />, `/tx/base/${TX_HASH}`, '/tx/:chain/:hash');
    await waitFor(() => m.container.textContent?.includes('not found on Base') ?? false);
    expect(byTestId(m.container, 'tx-status')).toBeNull();
    expect(m.container.querySelector('.error-box button')?.textContent).toContain('Retry');
    m.unmount();
  });
});

// ---------------------------------------------------------------------------
// Trace page
// ---------------------------------------------------------------------------

describe('TracePage', () => {
  it('does not run on mount, traces on Run and keeps the graph', async () => {
    const fetchMock = installFetch();
    const m = await mount(<TracePage />, `/trace/ethereum/${ADDRESS}`, '/trace/:chain/:address');
    const c = m.container;
    expect(byTestId(c, 'trace-page')).not.toBeNull();
    expect(byTestId(c, 'trace-run')).not.toBeNull();
    expect(byTestId(c, 'flow-graph')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(c.textContent).toContain('Not started');

    await click(byTestId(c, 'trace-run'));
    await waitFor(() => c.textContent?.includes('Done:') ?? false);
    expect(byTestId(c, 'flow-graph')).not.toBeNull();
    expect(c.textContent).toContain('1 address,');
    expect(fetchMock).toHaveBeenCalled();
    expect(c.querySelectorAll('button').length).toBeGreaterThan(0);
    expect((byTestId(c, 'trace-run') as HTMLButtonElement).disabled).toBe(false);
    expect(byTestId(c, 'trace-run')?.textContent).toContain('Run again');
    m.unmount();
  });

  it('lets the numeric options be cleared and retyped, clamping only on blur', async () => {
    const m = await mount(<TracePage />, `/trace/ethereum/${ADDRESS}`, '/trace/:chain/:address');
    const hops = byTestId(m.container, 'trace-max-hops') as HTMLInputElement;
    const fanout = byTestId(m.container, 'trace-max-fanout') as HTMLInputElement;
    expect(hops.value).toBe('2');
    expect(fanout.value).toBe('8');
    const setValue = (el: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const blur = (el: HTMLInputElement) => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    // Clearing does not snap to the minimum mid-edit; the next digit is the whole value.
    await act(async () => setValue(hops, ''));
    expect(hops.value).toBe('');
    await act(async () => setValue(hops, '3'));
    expect(hops.value).toBe('3');
    await act(async () => blur(hops));
    expect(hops.value).toBe('3');
    // Out-of-range values clamp on commit; an empty field resets to the default.
    await act(async () => setValue(hops, '99'));
    await act(async () => blur(hops));
    expect(hops.value).toBe('4');
    await act(async () => setValue(fanout, ''));
    await act(async () => blur(fanout));
    expect(fanout.value).toBe('8');
    await act(async () => setValue(fanout, '0'));
    await act(async () => blur(fanout));
    expect(fanout.value).toBe('1');
    m.unmount();
  });

  it('rejects unknown chains without rendering the form', async () => {
    const m = await mount(<TracePage />, '/trace/nope/0x1234', '/trace/:chain/:address');
    expect(byTestId(m.container, 'trace-page')).not.toBeNull();
    expect(byTestId(m.container, 'trace-run')).toBeNull();
    expect(m.container.textContent).toContain('Unknown chain');
    m.unmount();
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('helpers', () => {
  it('tabsFor is family aware and carries the e2e test ids', () => {
    expect(tabsFor('evm').map((t) => t.id)).toEqual(['overview', 'transactions', 'transfers', 'internal', 'tokens', 'approvals', 'contract']);
    expect(tabsFor('bitcoin').map((t) => t.id)).toEqual(['overview', 'transactions']);
    expect(tabsFor('solana').map((t) => t.id)).toEqual(['overview', 'transactions', 'tokens']);
    expect(tabsFor('evm').map((t) => t.testId).filter(Boolean)).toEqual(['address-tab-transactions', 'address-tab-tokens', 'address-tab-approvals', 'address-tab-contract']);
  });

  it('validateAddressRoute canonicalises and rejects bad input', () => {
    expect(validateAddressRoute('ethereum', ADDRESS.toLowerCase())).toEqual({ info: getChain('ethereum'), address: ADDRESS });
    expect(validateAddressRoute('bitcoin', BTC_ADDR.toUpperCase()).address).toBe(BTC_ADDR);
    expect(validateAddressRoute('nope', ADDRESS).error).toMatch(/Unknown chain/);
    expect(validateAddressRoute('base', '0x12').error).toMatch(/not a valid EVM address/);
    expect(validateAddressRoute('base', '').error).toMatch(/No address/);
  });

  it('seenRange prefers provider values and only derives firstSeen from a complete history', () => {
    const rows: TxListItem[] = [
      { chain: 'ethereum', hash: '0x1', timestamp: 300, from: ADDRESS, value: { raw: 0n, decimals: 18, symbol: 'ETH' }, status: 'success', direction: 'out' },
      { chain: 'ethereum', hash: '0x2', timestamp: 100, from: ADDRESS, value: { raw: 0n, decimals: 18, symbol: 'ETH' }, status: 'success', direction: 'out' },
    ];
    expect(seenRange(undefined, rows, false)).toEqual({ first: 100, last: 300, derived: true });
    expect(seenRange(undefined, rows, true)).toEqual({ first: undefined, last: 300, derived: true });
    const summary = { chain: 'ethereum', address: ADDRESS, isContract: false, firstSeen: 1, lastSeen: 2 };
    expect(seenRange(summary, rows, true)).toEqual({ first: 1, last: 2, derived: false });
    expect(seenRange(undefined, [], false)).toEqual({ first: undefined, last: undefined, derived: false });
  });

  it('orderBalances puts funded chains first and RPC failures last', () => {
    const b = (chain: string, balance: bigint, usd?: number, error?: string): NativeBalance => ({ chain, balance, decimals: 18, symbol: 'ETH', usd, error });
    const sorted = orderBalances([b('a', 0n), b('b', 10n ** 18n, 2500), b('c', 0n, undefined, 'boom'), b('d', 5n * 10n ** 18n, 12_500), b('e', 10n ** 17n)]);
    expect(sorted.map((x) => x.chain)).toEqual(['d', 'b', 'e', 'a', 'c']);
  });

  it('counterpartyOf follows the direction', () => {
    const base: TxListItem = { chain: 'ethereum', hash: '0x1', from: 'A', to: 'B', value: { raw: 0n, decimals: 18, symbol: 'ETH' }, status: 'success', direction: 'in' };
    expect(counterpartyOf(base)).toBe('A');
    expect(counterpartyOf({ ...base, direction: 'out' })).toBe('B');
    expect(counterpartyOf({ ...base, direction: 'self' })).toBe('B');
    expect(counterpartyOf({ ...base, direction: 'unknown', to: undefined })).toBe('A');
  });

  it('transferPriceKey maps native and fungible transfers only', () => {
    const eth = getChain('ethereum');
    const amount = { raw: 1n, decimals: 6, symbol: 'USDC' };
    const token = { chain: 'ethereum', address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: 6, type: 'ERC-20' as const };
    expect(transferPriceKey(eth, { kind: 'native', from: 'a', to: 'b', amount })).toBe('coingecko:ethereum');
    expect(transferPriceKey(eth, { kind: 'ERC-20', from: 'a', to: 'b', amount, token })).toBe(`ethereum:${USDC.toLowerCase()}`);
    expect(transferPriceKey(eth, { kind: 'ERC-721', from: 'a', to: 'b', amount, token: { ...token, type: 'ERC-721' }, tokenId: '1' })).toBeUndefined();
  });

  it('extraLabel / extraValue humanise transaction extras', () => {
    const eth = getChain('ethereum');
    expect(extraLabel('maxFeePerGas')).toBe('Max fee per gas');
    expect(extraLabel('somethingElse')).toBe('Something else');
    expect(extraValue('maxFeePerGas', '1000000000', eth)).toBe('1 gwei');
    expect(extraValue('l1Fee', '1000000000000000', eth)).toBe('0.001 ETH');
    expect(extraValue('coinbase', true, eth)).toBe('Yes');
    expect(extraValue('size', 1234, eth)).toBe('1,234');
    expect(extraValue('feeRateSatPerVb', 4.5, eth)).toBe('4.5');
  });

  it('buildTxStats covers contract creation and family specifics', () => {
    const eth = getChain('ethereum');
    const tx: Transaction = {
      chain: 'ethereum',
      hash: TX_HASH,
      status: 'success',
      from: ADDRESS,
      value: { raw: 10n ** 18n, decimals: 18, symbol: 'ETH' },
      fee: { raw: 10n ** 15n, decimals: 18, symbol: 'ETH' },
      gasUsed: 21_000n,
      gasLimit: 21_000n,
      gasPrice: 10n ** 9n,
      nonce: 7,
      contractCreated: RECIPIENT,
      transfers: [],
    };
    const labels = buildTxStats(tx, eth, 2500).map((s) => s.label);
    expect(labels).toEqual(['From', 'To', 'Value', 'Fee', 'Gas used / limit', 'Gas price', 'Nonce', 'Method']);
    const to = buildTxStats(tx, eth, 2500)[1];
    expect(to.value).toBe('Contract creation');
    const sol = buildTxStats({ ...tx, chain: 'solana', gasUsed: 5000n, methodId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', methodName: 'Jupiter v6' }, getChain('solana'), undefined).map((s) => s.label);
    expect(sol).toContain('Compute units');
    expect(sol).toContain('Program');
    expect(sol).not.toContain('Nonce');
  });

  it('clampInt, describeTransfers and the trace form defaults', () => {
    expect(clampInt('3', 1, 4, 2)).toBe(3);
    expect(clampInt('99', 1, 4, 2)).toBe(4);
    expect(clampInt('-1', 1, 4, 2)).toBe(1);
    expect(clampInt('abc', 1, 4, 2)).toBe(2);
    expect(clampInt('', 1, 4, 2)).toBe(2);
    expect(clampInt('  ', 1, 4, 2)).toBe(2);
    expect(DEFAULT_TRACE_FORM).toEqual({ maxHops: 2, maxFanOut: 8, direction: 'both', stopAtLabelled: true, minUsd: 0, includeTokens: true });
    const usdc = { chain: 'ethereum', address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: 6, type: 'ERC-20' as const };
    expect(
      describeTransfers([
        { kind: 'native', from: 'a', to: 'b', amount: { raw: 2n * 10n ** 18n, decimals: 18, symbol: 'ETH' } },
        { kind: 'native', from: 'a', to: 'b', amount: { raw: 10n ** 18n, decimals: 18, symbol: 'ETH' } },
        { kind: 'ERC-20', from: 'a', to: 'b', amount: { raw: 50_000_000n, decimals: 6, symbol: 'USDC' }, token: usdc },
      ]),
    ).toBe('3 ETH · 50 USDC');
  });
});
