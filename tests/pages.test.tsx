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

import type { ChainActivity, NativeBalance, Transaction, TxListItem } from '@/lib/types';
import { evmChains, getChain } from '@/lib/chains/registry';
import { clearEndpointCooldowns } from '@/lib/http';
import { clearSolTxCache } from '@/lib/providers/sol/rpc';
import { useSettings } from '@/lib/settings/store';
import { useCases } from '@/lib/cases/store';
import AddressPage, { needsEtherscanKey, tabsFor, validateAddressRoute } from '@/pages/AddressPage';
import TxPage, { buildTxStats, extraLabel, extraValue } from '@/pages/TxPage';
import TracePage, { clampInt, describeTransfers, DEFAULT_TRACE_FORM } from '@/pages/TracePage';
import { activityHeadline, orderBalances, seenRange, txCountLabel } from '@/components/address/OverviewTab';
import { counterpartyOf } from '@/components/address/HistoryTable';
import { isActiveChain, orderActivity, otherActiveChains, summaryLooksInactive } from '@/hooks/useMultiChainActivity';
import { summarizeUtxos } from '@/hooks/useBtcUtxos';
import { enrichHint, splitEnrichedRows } from '@/hooks/useSolEnrichedHistory';
import { scannedSpan } from '@/hooks/useApprovals';
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
const BTC_UTXO_TXID = 'e'.repeat(64);

const SOL_PAYER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const SOL_RECIPIENT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_SYSTEM = '11111111111111111111111111111111';
const SOL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOL_SIG_1 = '5'.repeat(87);
const SOL_SIG_2 = '4'.repeat(87);

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

const BTC_UTXOS = [
  { txid: BTC_UTXO_TXID, vout: 1, status: { confirmed: true, block_height: 850_000 }, value: 100_000 },
  { txid: BTC_TXID, vout: 0, status: { confirmed: false }, value: 50_000 },
];

const solTokenBalance = (accountIndex: number, owner: string, amount: string) => ({
  accountIndex,
  mint: SOL_USDC,
  owner,
  programId: SOL_TOKEN_PROGRAM,
  uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) },
});

/** Payer → recipient: 1 SOL native + 2 USDC SPL, signed `sig`. */
function solRawTx(sig: string) {
  return {
    slot: 250_000_000,
    blockTime: 1_700_000_000,
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [10_000_000_000, 0, 1, 2_039_280, 2_039_280],
      postBalances: [8_999_995_000, 1_000_000_000, 1, 2_039_280, 2_039_280],
      preTokenBalances: [solTokenBalance(3, SOL_PAYER, '5000000')],
      postTokenBalances: [solTokenBalance(3, SOL_PAYER, '3000000'), solTokenBalance(4, SOL_RECIPIENT, '2000000')],
      logMessages: [],
    },
    transaction: {
      message: {
        accountKeys: [{ pubkey: SOL_PAYER, signer: true }, { pubkey: SOL_RECIPIENT }, { pubkey: SOL_SYSTEM }, { pubkey: 'ta3payer111111111111111111111111111111111111' }, { pubkey: 'ta4recipient11111111111111111111111111111111' }],
        instructions: [{ programId: SOL_SYSTEM, program: 'system', parsed: { type: 'transfer', info: {} } }],
      },
      signatures: [sig],
    },
  };
}

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
      return ok(zeroOnEthereum && isEthereum ? '0x0' : ONE_ETH_WEI);
    case 'eth_getCode':
      return ok('0x');
    case 'eth_getTransactionCount':
      return ok(zeroOnEthereum && isEthereum ? '0x0' : '0x5');
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
      return logsRefused ? { jsonrpc: '2.0', id: r.id, error: { code: -32005, message: 'query exceeds max block range' } } : ok([]);
    // Solana
    case 'getAccountInfo':
      return ok({ context: { slot: 1 }, value: { lamports: 8_999_995_000, owner: SOL_SYSTEM, executable: false, data: ['', 'base64'] } });
    case 'getBalance':
      return ok({ context: { slot: 1 }, value: 8_999_995_000 });
    case 'getTokenAccountsByOwner':
      return ok({ context: { slot: 1 }, value: [] });
    case 'getSignaturesForAddress':
      return ok([
        { signature: SOL_SIG_1, slot: 250_000_000, blockTime: 1_700_000_000, err: null },
        { signature: SOL_SIG_2, slot: 249_000_000, blockTime: 1_699_000_000, err: null },
      ]);
    case 'getTransaction': {
      const raw = solRawTx(String(params[0]));
      return ok(solTxNoSpl ? { ...raw, meta: { ...raw.meta, preTokenBalances: [], postTokenBalances: [] } } : raw);
    }
    default:
      return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `Method not found: ${r.method}` } };
  }
}

/** When set, Blockscout's internal-transactions endpoint keeps returning a next page (truncation path). */
let internalCallsEndless = false;
/** When set, Ethereum mainnet RPCs answer zero balance and zero nonce (the address is only active elsewhere). */
let zeroOnEthereum = false;
/** When set, every eth_getLogs call is refused with a range error (incomplete approval scan). */
let logsRefused = false;
/** Blockscout `/addresses/{a}/transactions` items (empty by default). */
let blockscoutTxItems: unknown[] = [];
/** When set, Solana `getTransaction` requests never answer (enrichment stays pending). */
let solTxHangs = false;
/** When set, Solana transactions move no SPL token (only the native transfer). */
let solTxNoSpl = false;

/** Mock fetch: JSON-RPC, Blockscout, Esplora, DefiLlama; 404 elsewhere. */
function installFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && init.body) {
      const req = JSON.parse(String(init.body)) as RpcReq | RpcReq[];
      if (solTxHangs && !Array.isArray(req) && req.method === 'getTransaction') return new Promise<Response>(() => undefined);
      return jsonResponse(Array.isArray(req) ? req.map((c) => answerRpc(c, url)) : answerRpc(req, url));
    }
    const path = new URL(url).pathname;
    if (path.includes('/api/v2/')) {
      const segments = path.split('/api/v2/')[1]?.split('/').filter(Boolean) ?? [];
      if (segments[0] === 'addresses' && segments.length === 2) {
        return jsonResponse({ hash: segments[1], is_contract: false, is_verified: false, name: null, ens_domain_name: null, token: null });
      }
      if (segments[0] === 'addresses' && segments[2] === 'transactions' && blockscoutTxItems.length) {
        return jsonResponse({ items: blockscoutTxItems, next_page_params: null });
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
      if (path.endsWith(`/address/${BTC_ADDR}/utxo`)) return jsonResponse(BTC_UTXOS);
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
  clearEndpointCooldowns();
  clearSolTxCache();
  zeroOnEthereum = false;
  logsRefused = false;
  blockscoutTxItems = [];
  solTxHangs = false;
  solTxNoSpl = false;
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

    // Multi-chain activity strip (card id used by the e2e suite) links each chain to its own profile and counts txs.
    const strip = byTestId(c, 'address-activity-strip') as HTMLElement;
    expect(strip).not.toBeNull();
    await waitFor(() => strip.querySelectorAll('.balance-tile').length > 0);
    const baseTile = strip.querySelector(`a.balance-tile[href="/address/base/${ADDRESS}"]`);
    expect(baseTile).not.toBeNull();
    expect(baseTile?.textContent).toContain('5 txs');
    expect(baseTile?.textContent).toContain('1 ETH');
    expect(strip.textContent).toMatch(/Active on \d+ of \d+ chains/);
    expect(strip.querySelectorAll('.activity-tile').length).toBe(evmChains(false).length);
    expect(byTestId(c, 'address-active-elsewhere')).toBeNull();
    // Counterparties card is present but empty without history rows.
    expect(c.textContent).toContain('Top counterparties');

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

  it('points at other chains when the address is idle on Ethereum but active elsewhere', async () => {
    zeroOnEthereum = true;
    const m = await mount(<AddressPage />, `/address/ethereum/${ADDRESS}`, '/address/:chain/:address');
    const c = m.container;
    await waitFor(() => byTestId(c, 'address-active-elsewhere') !== null);
    const callout = byTestId(c, 'address-active-elsewhere') as HTMLElement;
    expect(callout.textContent).toContain('No activity on Ethereum — this address is active on');
    expect(callout.textContent).toContain('Base (5 txs)');
    expect(callout.querySelector(`a[href="/address/base/${ADDRESS}"]`)).not.toBeNull();
    expect(callout.textContent).not.toContain('Ethereum (');
    // The strip ranks the idle current chain after the active ones and still shows its 0 txs.
    await waitFor(() => c.querySelectorAll('.balance-tile').length > 0);
    const tiles = Array.from(c.querySelectorAll<HTMLAnchorElement>('a.balance-tile'));
    expect(tiles[0].getAttribute('href')).not.toBe(`/address/ethereum/${ADDRESS}`);
    const eth = tiles.find((t) => t.getAttribute('href') === `/address/ethereum/${ADDRESS}`);
    expect(eth?.textContent).toContain('0 txs');
    expect(eth?.className).toContain('is-zero');
    m.unmount();
  });

  it('aggregates counterparties from the loaded history rows', async () => {
    blockscoutTxItems = [
      { hash: TX_HASH, from: { hash: RECIPIENT }, to: { hash: ADDRESS }, value: '2000000000000000000', timestamp: '2024-09-22T00:00:00.000000Z', block_number: 10, status: 'ok', method: 'transfer' },
      { hash: `0x${'cc'.repeat(32)}`, from: { hash: ADDRESS }, to: { hash: RECIPIENT }, value: '1000000000000000000', timestamp: '2024-09-21T00:00:00.000000Z', block_number: 9, status: 'ok', method: null },
      { hash: `0x${'dd'.repeat(32)}`, from: { hash: ADDRESS }, to: { hash: ADDRESS }, value: '1', timestamp: '2024-09-20T00:00:00.000000Z', block_number: 8, status: 'ok', method: null },
    ];
    const m = await mount(<AddressPage />, `/address/ethereum/${ADDRESS}`, '/address/:chain/:address');
    const c = m.container;
    await waitFor(() => c.querySelector(`a[href="/trace/ethereum/${RECIPIENT}"]`) !== null);
    const card = c.querySelector(`a[href="/trace/ethereum/${RECIPIENT}"]`)?.closest('.card') as HTMLElement;
    expect(card.textContent).toContain('Top counterparties');
    expect(card.textContent).toContain('From loaded pages only (3 rows)');
    const row = card.querySelector('table tbody tr') as HTMLElement;
    expect(row.textContent).toContain('2'); // row count
    expect(row.textContent).toContain('+2');
    expect(row.textContent).toContain('−1');
    expect(row.querySelector(`a[href="/address/ethereum/${RECIPIENT}"]`)).not.toBeNull();
    // The self transfer is skipped: only one counterparty row.
    expect(card.querySelectorAll('table tbody tr')).toHaveLength(1);
    m.unmount();
  });

  it('warns when the approval scan is incomplete and tells the risk assessment', async () => {
    logsRefused = true;
    const m = await mount(<AddressPage />, `/address/ethereum/${ADDRESS}?tab=approvals`, '/address/:chain/:address');
    const c = m.container;
    await waitFor(() => byTestId(c, 'approvals-incomplete') !== null);
    const banner = byTestId(c, 'approvals-incomplete') as HTMLElement;
    expect(banner.textContent).toContain('Approval scan incomplete');
    expect(banner.textContent).toContain('query exceeds max block range');
    expect(banner.querySelector('a[href="/settings"]')?.textContent).toContain('custom RPC in Settings');
    // Not an empty state: the warning is the headline, the table just says the scanned part was empty.
    expect(c.textContent).not.toContain('No active approvals found');
    expect(c.textContent).toContain('No approvals in the scanned part');
    expect(c.textContent).toMatch(/Scanned blocks [\d,]+–[\d,]+/);
    // Risk: approvals are passed as unknown and the caveat is visible.
    await waitFor(() => /approvals not scanned/.test(c.querySelector('.risk-toggle')?.getAttribute('title') ?? ''));
    expect(c.querySelector('.risk-toggle')?.textContent).toContain('approvals not scanned');
    await click(c.querySelector<HTMLElement>('.risk-toggle'));
    expect(c.querySelector('.flag-notes')?.textContent).toContain('approvals not scanned');
    expect(c.querySelector('.flag-notes')?.textContent).toContain('query exceeds max block range');
    m.unmount();
  });

  it('shows an API-key notice for key-gated chains until a key is configured', async () => {
    const m = await mount(<AddressPage />, `/address/bsc/${ADDRESS}`, '/address/:chain/:address');
    const notice = byTestId(m.container, 'address-key-notice');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('needs an Etherscan API key');
    expect(notice?.querySelector('a[href="/settings"]')).not.toBeNull();
    m.unmount();

    useSettings.getState().set({ etherscanApiKey: 'KEY' });
    const withKey = await mount(<AddressPage />, `/address/bsc/${ADDRESS}`, '/address/:chain/:address');
    expect(byTestId(withKey.container, 'address-key-notice')).toBeNull();
    withKey.unmount();

    const eth = await mount(<AddressPage />, `/address/ethereum/${ADDRESS}`, '/address/:chain/:address');
    expect(byTestId(eth.container, 'address-key-notice')).toBeNull();
    eth.unmount();
  });

  it('renders the Bitcoin UTXO card with count, total and the largest outputs', async () => {
    const m = await mount(<AddressPage />, `/address/bitcoin/${BTC_ADDR}`, '/address/:chain/:address');
    const c = m.container;
    await waitFor(() => (byTestId(c, 'address-utxos')?.querySelectorAll('table tbody tr').length ?? 0) === 2);
    const card = byTestId(c, 'address-utxos') as HTMLElement;
    expect(card.textContent).toContain('UTXOs');
    expect(card.textContent).toContain('1 confirmed');
    expect(card.textContent).toContain('0.0015 BTC');
    expect(card.textContent).toContain('$90.00');
    const rows = card.querySelectorAll('table tbody tr');
    // Largest first.
    expect(rows[0].textContent).toContain('#1');
    expect(rows[0].textContent).toContain('0.001 BTC');
    expect(rows[0].textContent).toContain('Confirmed');
    expect(rows[0].querySelector(`a[href="/tx/bitcoin/${BTC_UTXO_TXID}"]`)).not.toBeNull();
    expect(rows[1].textContent).toContain('In mempool');
    expect(card.textContent).toContain('All 2 unspent outputs shown');
    m.unmount();
  });

  it('enriches Solana signatures into direction / counterparty / value rows and an SPL transfers tab', async () => {
    const m = await mount(<AddressPage />, `/address/solana/${SOL_PAYER}?tab=transactions`, '/address/:chain/:address');
    const c = m.container;
    // Solana now has a Token transfers tab.
    expect(Array.from(c.querySelectorAll('[role="tab"]')).map((t) => t.textContent)).toContain('Token transfers');
    await waitFor(() => c.querySelectorAll('table tbody tr').length === 2 && (c.textContent?.includes('−1') ?? false));
    const row = c.querySelector('table tbody tr') as HTMLElement;
    expect(row.textContent).toContain('Out');
    expect(row.textContent).toContain('−1');
    expect(row.textContent).toContain('SOL');
    expect(row.querySelector(`a[href="/address/solana/${SOL_RECIPIENT}"]`)).not.toBeNull();
    expect(row.querySelector(`a[href="/tx/solana/${SOL_SIG_1}"]`)).not.toBeNull();
    expect(c.textContent).toContain('2 rows');
    expect(c.textContent).toContain('End of results');
    expect(c.textContent).not.toContain('enriching');

    // SPL rows land in the Token transfers tab.
    const transfers = Array.from(c.querySelectorAll<HTMLElement>('[role="tab"]')).find((t) => t.textContent === 'Token transfers');
    await click(transfers ?? null);
    await waitFor(() => c.querySelectorAll('table tbody tr').length === 2 && (c.textContent?.includes('USDC') ?? false));
    const spl = c.querySelector('table tbody tr') as HTMLElement;
    expect(spl.textContent).toContain('USDC');
    expect(spl.textContent).toContain('−2');
    expect(spl.querySelector(`a[href="/address/solana/${SOL_RECIPIENT}"]`)).not.toBeNull();

    // Top counterparties come from the enriched rows (4 rows: 2 native + 2 SPL, one counterparty).
    await click(Array.from(c.querySelectorAll<HTMLElement>('[role="tab"]')).find((t) => t.textContent === 'Overview') ?? null);
    await waitFor(() => c.querySelector(`a[href="/trace/solana/${SOL_RECIPIENT}"]`) !== null);
    const cp = c.querySelector(`a[href="/trace/solana/${SOL_RECIPIENT}"]`)?.closest('tr') as HTMLElement;
    expect(cp.textContent).toContain('4');
    expect(cp.textContent).toContain('(2 token)');
    expect(cp.textContent).toContain('−2 SOL');
    expect(c.textContent).toContain('From loaded pages only (4 rows)');
    m.unmount();
  });

  it('keeps the Solana Token transfers tab loading while enrichment is still running', async () => {
    solTxHangs = true;
    const m = await mount(<AddressPage />, `/address/solana/${SOL_PAYER}?tab=transfers`, '/address/:chain/:address');
    const c = m.container;
    // The signature list is loaded (footer reports the pending enrichment) but no page has been enriched yet.
    await waitFor(() => c.textContent?.includes('enriching 0 of 2…') ?? false);
    expect(c.textContent).toContain('Loading…');
    expect(c.textContent).not.toContain('No SPL transfers');
    m.unmount();
    // The detached getTransaction request is still pending; drop it so later tests do not share it.
    clearSolTxCache();
  });

  it('shows the Solana "No SPL transfers" empty state only once enrichment found no SPL rows', async () => {
    solTxNoSpl = true;
    const m = await mount(<AddressPage />, `/address/solana/${SOL_PAYER}?tab=transfers`, '/address/:chain/:address');
    const c = m.container;
    await waitFor(() => (c.textContent?.includes('No SPL transfers') ?? false) && !c.textContent?.includes('enriching'));
    expect(c.textContent).not.toContain('Loading…');
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
    expect(tabsFor('solana').map((t) => t.id)).toEqual(['overview', 'transactions', 'transfers', 'tokens']);
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

  it('orderActivity ranks active chains by USD then tx count, idle next, failures last', () => {
    const a = (chain: string, balance: bigint, txCount?: number, usd?: number, error?: string): ChainActivity => ({
      chain,
      balance: error && balance === 0n && txCount === undefined ? undefined : { chain, balance, decimals: 18, symbol: 'ETH', usd },
      txCount,
      error,
    });
    const list = [a('idle', 0n, 0), a('txonly', 0n, 7), a('rich', 10n ** 18n, 1, 2500), a('dead', 0n, undefined, undefined, 'boom'), a('small', 10n ** 17n, 50, 250), a('partial', 10n ** 18n, undefined, 2500, 'count failed')];
    expect(orderActivity(list).map((x) => x.chain)).toEqual(['rich', 'partial', 'small', 'txonly', 'idle', 'dead']);
    expect(isActiveChain(a('idle', 0n, 0))).toBe(false);
    expect(isActiveChain(a('txonly', 0n, 7))).toBe(true);
    expect(isActiveChain(a('dead', 0n, undefined, undefined, 'boom'))).toBe(false);
    expect(otherActiveChains(list, 'rich').map((x) => x.chain)).toEqual(['partial', 'small', 'txonly']);
    expect(activityHeadline(list)).toBe('Active on 4 of 6 chains · ≈ $5,250.00 in native balances');
    expect(activityHeadline([a('idle', 0n, 0)])).toBe('Active on 0 of 1 chain.');
    expect(txCountLabel(a('txonly', 0n, 1))).toBe('1 tx');
    expect(txCountLabel(a('dead', 0n, undefined, undefined, 'boom'))).toBe('n/a');
  });

  it('summaryLooksInactive needs a zero nonce and a zero balance on an EOA', () => {
    const base = { chain: 'ethereum', address: ADDRESS, isContract: false, txCount: 0, nativeBalance: { chain: 'ethereum', balance: 0n, decimals: 18, symbol: 'ETH' } };
    expect(summaryLooksInactive(base)).toBe(true);
    expect(summaryLooksInactive({ ...base, txCount: 1 })).toBe(false);
    expect(summaryLooksInactive({ ...base, nativeBalance: { ...base.nativeBalance, balance: 1n } })).toBe(false);
    expect(summaryLooksInactive({ ...base, nativeBalance: { ...base.nativeBalance, error: 'rpc' } })).toBe(false);
    expect(summaryLooksInactive({ ...base, isContract: true })).toBe(false);
    expect(summaryLooksInactive(undefined)).toBe(false);
  });

  it('summarizeUtxos totals and keeps the largest outputs', () => {
    const u = (vout: number, value: bigint, confirmed = true) => ({ txid: 'a'.repeat(64), vout, value, confirmed });
    const s = summarizeUtxos([u(0, 5n), u(1, 50n, false), u(2, 20n), u(3, 50n)], 2);
    expect(s.count).toBe(4);
    expect(s.confirmed).toBe(3);
    expect(s.total).toBe(125n);
    expect(s.top.map((x) => x.vout)).toEqual([3, 1]);
    expect(summarizeUtxos([])).toEqual({ count: 0, confirmed: 0, total: 0n, top: [] });
  });

  it('splitEnrichedRows, enrichHint and scannedSpan', () => {
    const native: TxListItem = { chain: 'solana', hash: SOL_SIG_1, from: SOL_PAYER, to: SOL_RECIPIENT, value: { raw: 1n, decimals: 9, symbol: 'SOL' }, status: 'success', direction: 'out', enriched: true };
    const spl: TxListItem = { ...native, token: { symbol: 'USDC', amount: { raw: 1n, decimals: 6, symbol: 'USDC' }, tokenAddress: SOL_USDC, kind: 'SPL' } };
    expect(splitEnrichedRows([native, spl], 'tx')).toEqual([native]);
    expect(splitEnrichedRows([native, spl], 'token')).toEqual([spl]);
    expect(splitEnrichedRows([native, spl], 'internal')).toEqual([]);
    expect(enrichHint({ done: 0, total: 25, loading: true })).toBe('enriching 0 of 25…');
    expect(enrichHint({ done: 25, total: 50, loading: true })).toBe('enriching 25 of 50…');
    expect(enrichHint({ done: 50, total: 50, loading: false })).toBeUndefined();
    expect(enrichHint({ done: 0, total: 0, loading: true })).toBeUndefined();
    expect(scannedSpan({ fromBlock: 1_000_000, toBlock: 3_000_000 })).toBe('Scanned blocks 1,000,000–3,000,000');
    expect(scannedSpan({ fromBlock: undefined, toBlock: 3 })).toBeUndefined();
    expect(scannedSpan(undefined)).toBeUndefined();
  });

  it('needsEtherscanKey is true only for key-gated chains without a key', () => {
    expect(needsEtherscanKey(getChain('bsc'), undefined)).toBe(true);
    expect(needsEtherscanKey(getChain('bsc'), '  ')).toBe(true);
    expect(needsEtherscanKey(getChain('bsc'), 'KEY')).toBe(false);
    expect(needsEtherscanKey(getChain('ethereum'), undefined)).toBe(false);
    expect(needsEtherscanKey(getChain('avalanche'), undefined)).toBe(false);
    expect(needsEtherscanKey(getChain('bitcoin'), undefined)).toBe(false);
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
