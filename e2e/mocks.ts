/**
 * Shared Playwright harness: network fixtures + console-error capture.
 *
 * The specs run against the production build served by `vite preview` (see
 * playwright.config.ts). CI containers have no access to blockchain APIs, so
 * every request that leaves the preview server is intercepted with
 * `page.route` and answered from the fixtures below:
 *
 *   - JSON-RPC POSTs (any host) are dispatched by `method`; batch arrays are
 *     answered element by element. The mocked transaction exists on Ethereum
 *     mainnet endpoints only; every other chain reports `null`.
 *   - Blockscout v2 GETs return empty collections / a plain EOA profile.
 *   - DefiLlama returns a fixed ETH price, the OFAC mirror an empty list.
 *   - Anything else external is answered with a 404 JSON body so the app can
 *     never hang on a real network call. Requests to the preview server
 *     (127.0.0.1) are passed through untouched.
 *
 * Every test collects console errors and uncaught page errors and asserts at
 * the end that none occurred (resource 404s and favicon noise are tolerated).
 *
 * Specs import `test` / `expect` from this module so every test gets the
 * mocks and the `consoleErrors` fixture automatically. A test that needs one
 * JSON-RPC method to answer differently (an error, another value) installs an
 * override with `overrideRpc(page, …)` before navigating; every other request
 * keeps the base fixtures.
 */
import { expect, test as base, type Page, type Request, type Route } from '@playwright/test';
import { CHAINS } from '../src/lib/chains/registry';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const ADDRESS = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
export const TX_HASH = `0x${'aa'.repeat(32)}`;
const BLOCK_HASH = `0x${'bb'.repeat(32)}`;
const PARENT_HASH = `0x${'cc'.repeat(32)}`;
const BLOCK_NUMBER = '0x1234567';
const BLOCK_TIMESTAMP = '0x66f00000';
const ONE_ETH_WEI = '0xde0b6b3a7640000';
const ONE_USDC = 1_000_000n; // 1 USDC in base units (6 decimals)
const GAS_PRICE = '0x3b9aca00'; // 1 gwei
const ZERO_WORD = `0x${'00'.repeat(32)}`;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
export const CUSTOM_RPC = 'https://example-rpc.test';
export const SETTINGS_KEY = 'loxdetective.settings.v1';
export const CASES_KEY = 'loxdetective.cases.v1';

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Ethereum mainnet endpoints from the registry: the only ones that know the mocked tx. */
const ETHEREUM_RPCS = new Set((CHAINS.find((c) => c.id === 'ethereum')?.rpcUrls ?? []).map(normalizeUrl));

/** EVM mainnets probed by the address page's activity strip (testnets are off by default). */
export const EVM_MAINNET_CHAINS = CHAINS.filter((c) => c.family === 'evm' && !c.testnet);

function normalizeUrl(u: string): string {
  return u.replace(/\/+$/, '').toLowerCase();
}

/** 32-byte ABI word as hex without the 0x prefix. */
function word(n: bigint | number): string {
  return BigInt(n).toString(16).padStart(64, '0');
}

function uint256(n: bigint | number): string {
  return `0x${word(n)}`;
}

/** Address left-padded to a 32-byte topic. */
function topicAddress(address: string): string {
  return `0x${address.toLowerCase().slice(2).padStart(64, '0')}`;
}

/** ABI-encoded `string` return value: offset, length, padded UTF-8 bytes. */
function abiString(s: string): string {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  return `0x${word(32)}${word(hex.length / 2)}${padded}`;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `transfer(address,uint256)` calldata moving 1 USDC to RECIPIENT. */
const TRANSFER_CALLDATA = `0xa9059cbb${topicAddress(RECIPIENT).slice(2)}${word(ONE_USDC)}`;

const MOCK_TX = {
  hash: TX_HASH,
  nonce: '0x5',
  blockHash: BLOCK_HASH,
  blockNumber: BLOCK_NUMBER,
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
  chainId: '0x1',
  v: '0x0',
  r: ZERO_WORD,
  s: ZERO_WORD,
  accessList: [],
};

const MOCK_RECEIPT = {
  transactionHash: TX_HASH,
  transactionIndex: '0x1',
  blockHash: BLOCK_HASH,
  blockNumber: BLOCK_NUMBER,
  from: ADDRESS.toLowerCase(),
  to: USDC.toLowerCase(),
  cumulativeGasUsed: '0xd6d8',
  gasUsed: '0xd6d8',
  effectiveGasPrice: GAS_PRICE,
  contractAddress: null,
  status: '0x1',
  type: '0x2',
  logsBloom: `0x${'00'.repeat(256)}`,
  logs: [
    {
      address: USDC.toLowerCase(),
      topics: [TRANSFER_TOPIC, topicAddress(ADDRESS), topicAddress(RECIPIENT)],
      data: uint256(ONE_USDC),
      blockNumber: BLOCK_NUMBER,
      blockHash: BLOCK_HASH,
      transactionHash: TX_HASH,
      transactionIndex: '0x1',
      logIndex: '0x0',
      removed: false,
    },
  ],
};

const MOCK_BLOCK = {
  number: BLOCK_NUMBER,
  hash: BLOCK_HASH,
  parentHash: PARENT_HASH,
  timestamp: BLOCK_TIMESTAMP,
  miner: ZERO_ADDRESS,
  gasLimit: '0x1c9c380',
  gasUsed: '0xd6d8',
  baseFeePerGas: GAS_PRICE,
  size: '0x400',
  transactions: [TX_HASH],
  extraData: '0x',
  nonce: '0x0000000000000000',
  difficulty: '0x0',
};

const MOCK_PRICES = {
  coins: {
    'coingecko:ethereum': { price: 2500, symbol: 'ETH', decimals: 18, timestamp: Math.floor(Date.now() / 1000), confidence: 0.99 },
  },
};

// ---------------------------------------------------------------------------
// Network mocks
// ---------------------------------------------------------------------------

type Fulfill = NonNullable<Parameters<Route['fulfill']>[0]>;

export interface RpcCall {
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

export type RpcResult = { result: unknown } | { error: { code: number; message: string } };

/** Per-test JSON-RPC override: return a reply to take over a call, `undefined` to keep the base fixture. */
export type RpcOverride = (call: RpcCall, isEthereum: boolean) => RpcResult | undefined;

/** Override that answers every `method` call (single or batched) with a JSON-RPC error. */
export function rpcErrorFor(method: string, message: string, code = -32005): RpcOverride {
  return (call) => (call.method === method ? { error: { code, message } } : undefined);
}

function json(status: number, body: unknown): Fulfill {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function parseJson(text: string | null): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `eth_call` answered by 4-byte selector: USDC metadata, a zero word for everything else. */
function ethCallResult(params: unknown[]): string {
  const call = params[0] as { data?: string } | undefined;
  switch ((call?.data ?? '').slice(0, 10).toLowerCase()) {
    case '0x313ce567': // decimals()
      return uint256(6);
    case '0x95d89b41': // symbol()
      return abiString('USDC');
    case '0x06fdde03': // name()
      return abiString('USD Coin');
    default:
      return ZERO_WORD;
  }
}

function answerRpc(call: RpcCall, isEthereum: boolean, override?: RpcOverride): RpcResult {
  const overridden = override?.(call, isEthereum);
  if (overridden) return overridden;
  const params = Array.isArray(call.params) ? call.params : [];
  const wantsMockTx = isEthereum && String(params[0] ?? '').toLowerCase() === TX_HASH;
  switch (call.method) {
    case 'eth_blockNumber':
      return { result: BLOCK_NUMBER };
    case 'eth_getBalance':
      return { result: ONE_ETH_WEI };
    case 'eth_getCode':
      return { result: '0x' };
    case 'eth_getTransactionCount':
      return { result: '0x5' };
    case 'eth_getTransactionByHash':
      return { result: wantsMockTx ? MOCK_TX : null };
    case 'eth_getTransactionReceipt':
      return { result: wantsMockTx ? MOCK_RECEIPT : null };
    case 'eth_getBlockByNumber':
      return { result: MOCK_BLOCK };
    case 'eth_call':
      return { result: ethCallResult(params) };
    case 'eth_getStorageAt':
      return { result: ZERO_WORD };
    case 'eth_getLogs':
      return { result: [] };
    case 'eth_gasPrice':
      return { result: GAS_PRICE };
    default:
      return { error: { code: -32601, message: `Method not found: ${String(call.method)}` } };
  }
}

/** JSON-RPC reply for a single call or a batch, preserving ids. */
function rpcResponse(payload: unknown, url: URL, override?: RpcOverride): Fulfill {
  const isEthereum = ETHEREUM_RPCS.has(normalizeUrl(`${url.origin}${url.pathname}`));
  const reply = (c: RpcCall) => ({ jsonrpc: '2.0', id: c.id ?? null, ...answerRpc(c, isEthereum, override) });
  if (Array.isArray(payload)) return json(200, payload.map((c) => reply(c as RpcCall)));
  return json(200, reply(payload as RpcCall));
}

/** Resources Blockscout serves as `{ items, next_page_params }` collections. */
const BLOCKSCOUT_COLLECTIONS = new Set(['transactions', 'token-transfers', 'tokens', 'internal-transactions', 'logs', 'withdrawals']);

function blockscoutResponse(url: URL): Fulfill {
  const segments = url.pathname.split('/api/v2/')[1]?.split('/').filter(Boolean) ?? [];
  if (segments[0] === 'addresses' && segments.length === 2) {
    return json(200, {
      hash: segments[1],
      is_contract: false,
      is_verified: false,
      name: null,
      ens_domain_name: null,
      token: null,
      creator_address_hash: null,
      creation_tx_hash: null,
      implementation_address: null,
    });
  }
  if (BLOCKSCOUT_COLLECTIONS.has(segments[segments.length - 1] ?? '')) {
    return json(200, { items: [], next_page_params: null });
  }
  return json(404, { message: 'Not found' });
}

function esploraResponse(url: URL): Fulfill {
  if (url.pathname.endsWith('/blocks/tip/height')) return { status: 200, contentType: 'text/plain', body: '860000' };
  return json(404, {});
}

function mockResponse(request: Request, url: URL): Fulfill {
  if (request.method() === 'POST') {
    const payload = parseJson(request.postData());
    if (Array.isArray(payload) || (payload !== null && typeof payload === 'object')) return rpcResponse(payload, url);
    return json(404, {});
  }
  if (url.pathname.includes('/api/v2/')) return blockscoutResponse(url);
  switch (url.hostname) {
    case 'coins.llama.fi':
      return json(200, MOCK_PRICES);
    case 'raw.githubusercontent.com':
      return json(200, []);
    case 'api.openchain.xyz':
      return json(200, { ok: true, result: { function: {} } });
    case 'www.4byte.directory':
      return json(200, { count: 0, next: null, previous: null, results: [] });
    case 'mempool.space':
    case 'blockstream.info':
      return esploraResponse(url);
    default:
      return json(404, {});
  }
}

/**
 * Intercept everything: pass the preview server through, answer the rest from
 * fixtures. Playwright adds the CORS headers for fulfilled cross-origin
 * responses and answers preflights itself, so none are set here.
 */
export async function installNetworkMocks(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (LOCAL_HOSTS.has(url.hostname)) {
      await route.continue();
      return;
    }
    try {
      await route.fulfill(mockResponse(request, url));
    } catch {
      /* the page navigated away or closed while the request was in flight */
    }
  });
}

/**
 * Answer selected JSON-RPC calls differently for the rest of a test. Playwright
 * consults the most recently registered route first, so this handler sees the
 * request before the base mocks; it answers JSON-RPC POSTs itself (base
 * fixtures for the calls the override leaves alone) and hands everything else
 * back with `route.fallback()`. Call it before navigating.
 */
export async function overrideRpc(page: Page, override: RpcOverride): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const payload = request.method() === 'POST' && !LOCAL_HOSTS.has(url.hostname) ? parseJson(request.postData()) : undefined;
    if (!Array.isArray(payload) && (payload === null || typeof payload !== 'object')) {
      await route.fallback();
      return;
    }
    try {
      await route.fulfill(rpcResponse(payload, url, override));
    } catch {
      /* the page navigated away or closed while the request was in flight */
    }
  });
}

// ---------------------------------------------------------------------------
// Test harness: mocks + console error capture for every test
// ---------------------------------------------------------------------------

const ALLOWED_CONSOLE_PATTERNS = [/favicon/i, /net::ERR/i, /404/];

export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      page.on('pageerror', (err) => errors.push(`Uncaught error: ${err.message}`));
      await installNetworkMocks(page);
      await use(errors);
    },
    { auto: true },
  ],
});

export function expectNoConsoleErrors(errors: string[]): void {
  const unexpected = errors.filter((e) => !ALLOWED_CONSOLE_PATTERNS.some((re) => re.test(e)));
  expect(unexpected, 'console errors during the test').toEqual([]);
}

/** Hash route relative to the configured baseURL (VITE_BASE, default `/loxdetective/`). */
export const hashRoute = (path: string): string => `#${path}`;
export const LOAD_TIMEOUT = 20_000;

export { expect };
