import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, maxUint256 } from 'viem';
import { getChain } from '@/lib/chains/registry';
import { useSettings } from '@/lib/settings/store';
import * as etherscan from '@/lib/providers/evm/etherscan';
import { SLOT_EIP1967_IMPLEMENTATION, TOPIC_APPROVAL, TOPIC_APPROVAL_FOR_ALL, TOPIC_TRANSFER } from '@/lib/providers/evm/decode';
import {
  clearTokenMetaCache,
  getAddressHistory,
  getAddressSummary,
  getApprovals,
  getContractInfo,
  getTokenBalances,
  getTransactionFull,
} from '@/lib/providers/evm/index';

// ---------------------------------------------------------------------------
// Fixtures & mock plumbing
// ---------------------------------------------------------------------------

const ETH = getChain('ethereum');
const BASE = getChain('base');
const BSC = getChain('bsc');
const AVAX = getChain('avalanche');
const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const SPENDER = '0x3333333333333333333333333333333333333333';
const OPERATOR = '0x5555555555555555555555555555555555555555';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
const IMPL = '0x4444444444444444444444444444444444444444';
const HASH = `0x${'ab'.repeat(32)}`;
const ZERO = '0x0000000000000000000000000000000000000000';

const pad32 = (addr: string) => `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}`;
const uint = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const encString = (s: string) => encodeAbiParameters([{ type: 'string' }], [s]);

interface RpcReq {
  id: number;
  method: string;
  params: unknown[];
}

type RpcHandler = (req: RpcReq, url: string) => unknown;
type HttpHandler = (url: URL) => { status?: number; body: unknown } | undefined;

class Fail {
  constructor(public status = 500) {}
}

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) } as unknown as Response;
}

/** Route JSON-RPC bodies to `rpc` and plain GETs to `http`. */
function installFetch(rpc: RpcHandler, http: HttpHandler = () => ({ status: 404, body: { message: 'Not found' } })) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.body) {
      const req = JSON.parse(String(init.body)) as RpcReq;
      const out = await rpc(req, url);
      if (out instanceof Fail) return response({ message: 'boom' }, out.status);
      if (out instanceof Error) throw out;
      if (out && typeof out === 'object' && 'error' in out) return response({ jsonrpc: '2.0', id: req.id, error: (out as { error: unknown }).error });
      return response({ jsonrpc: '2.0', id: req.id, result: out });
    }
    const out = http(new URL(url));
    if (!out) return response({ message: 'Not found' }, 404);
    return response(out.body, out.status ?? 200);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const rpcCalls = (fetchMock: ReturnType<typeof installFetch>, method: string) =>
  fetchMock.mock.calls.filter((c) => c[1]?.body && (JSON.parse(String(c[1].body)) as RpcReq).method === method);

/** eth_call responder for ERC-20 metadata. */
function erc20CallHandler(meta: Record<string, { name: string; symbol: string; decimals?: number }>) {
  return (req: RpcReq): unknown => {
    const { to, data } = req.params[0] as { to: string; data: string };
    const m = meta[to.toLowerCase()];
    if (!m) return '0x';
    if (data.startsWith('0x06fdde03')) return encString(m.name);
    if (data.startsWith('0x95d89b41')) return encString(m.symbol);
    if (data.startsWith('0x313ce567')) return m.decimals === undefined ? { error: { code: 3, message: 'execution reverted' } } : uint(BigInt(m.decimals));
    return '0x';
  };
}

beforeEach(() => {
  useSettings.getState().reset();
  clearTokenMetaCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Etherscan client
// ---------------------------------------------------------------------------

describe('etherscan', () => {
  const row = {
    hash: HASH,
    timeStamp: '1714564800',
    blockNumber: '19770000',
    from: OWNER.toLowerCase(),
    to: OTHER.toLowerCase(),
    value: '1000000000000000000',
    isError: '0',
    txreceipt_status: '1',
    functionName: 'transfer(address _to, uint256 _value)',
    input: '0xa9059cbb',
    contractAddress: '',
  };

  it('requires an API key for Etherscan V2 chains', async () => {
    const fetchMock = installFetch(() => null);
    expect(etherscan.hasEtherscan(ETH)).toBe(false);
    await expect(etherscan.addressTransactions(ETH, OWNER)).rejects.toThrow('Etherscan API key required (Settings)');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps txlist rows and sends chainid + apikey', async () => {
    useSettings.getState().set({ etherscanApiKey: 'KEY123' });
    const fetchMock = installFetch(
      () => null,
      (url) => {
        expect(url.origin + url.pathname).toBe('https://api.etherscan.io/v2/api');
        expect(url.searchParams.get('module')).toBe('account');
        expect(url.searchParams.get('action')).toBe('txlist');
        expect(url.searchParams.get('address')).toBe(OWNER);
        expect(url.searchParams.get('chainid')).toBe('1');
        expect(url.searchParams.get('apikey')).toBe('KEY123');
        expect(url.searchParams.get('page')).toBe('1');
        return { body: { status: '1', message: 'OK', result: [row, { ...row, from: OTHER, to: OWNER, isError: '1' }] } };
      },
    );
    const page = await etherscan.addressTransactions(ETH, OWNER);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(page.source).toBe('etherscan');
    expect(page.nextCursor).toBeUndefined();
    expect(page.items[0]).toMatchObject({
      chain: 'ethereum',
      hash: HASH,
      timestamp: 1714564800,
      blockNumber: 19770000,
      from: OWNER,
      to: OTHER,
      value: { raw: 10n ** 18n, decimals: 18, symbol: 'ETH' },
      status: 'success',
      methodName: 'transfer(address,uint256)',
      direction: 'out',
    });
    expect(page.items[1]).toMatchObject({ status: 'failed', direction: 'in' });
  });

  it('treats "No transactions found" as an empty page', async () => {
    useSettings.getState().set({ etherscanApiKey: 'KEY123' });
    installFetch(() => null, () => ({ body: { status: '0', message: 'No transactions found', result: [] } }));
    const page = await etherscan.addressTokenTransfers(ETH, OWNER);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('surfaces NOTOK / rate-limit / invalid-key responses as errors with the message', async () => {
    useSettings.getState().set({ etherscanApiKey: 'BAD' });
    installFetch(() => null, () => ({ body: { status: '0', message: 'NOTOK', result: 'Invalid API Key' } }));
    await expect(etherscan.addressTransactions(ETH, OWNER)).rejects.toThrow('Etherscan: Invalid API Key');
    installFetch(() => null, () => ({ body: { status: '0', message: 'NOTOK', result: 'Max rate limit reached' } }));
    await expect(etherscan.addressInternalTxs(ETH, OWNER)).rejects.toThrow('Etherscan: Max rate limit reached');
  });

  it('pages with numeric cursors when a page is full', async () => {
    useSettings.getState().set({ etherscanApiKey: 'KEY123' });
    const fetchMock = installFetch(() => null, () => ({ body: { status: '1', message: 'OK', result: Array.from({ length: 50 }, () => row) } }));
    const page = await etherscan.addressTransactions(ETH, OWNER, '3');
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('page')).toBe('3');
    expect(page.nextCursor).toBe('4');
  });

  it('uses keyless Routescan endpoints and reports the source', async () => {
    const fetchMock = installFetch(() => null, (url) => {
      expect(url.hostname).toBe('api.routescan.io');
      expect(url.searchParams.has('apikey')).toBe(false);
      expect(url.searchParams.has('chainid')).toBe(false);
      return { body: { status: '1', message: 'OK', result: [] } };
    });
    expect(etherscan.hasEtherscan(AVAX)).toBe(true);
    const page = await etherscan.addressTransactions(AVAX, OWNER);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(page.source).toBe('routescan');
  });

  it('maps tokentx rows', async () => {
    useSettings.getState().set({ etherscanApiKey: 'KEY123' });
    installFetch(() => null, () => ({
      body: {
        status: '1',
        message: 'OK',
        result: [{ ...row, contractAddress: USDC.toLowerCase(), value: '2500000', tokenSymbol: 'USDC', tokenDecimal: '6', tokenName: 'USD Coin', from: OTHER, to: OWNER }],
      },
    }));
    const page = await etherscan.addressTokenTransfers(ETH, OWNER);
    expect(page.items[0]).toMatchObject({ direction: 'in', value: { raw: 2_500_000n, decimals: 6, symbol: 'USDC' } });
    expect(page.items[0].token).toEqual({ symbol: 'USDC', amount: { raw: 2_500_000n, decimals: 6, symbol: 'USDC' }, tokenAddress: USDC, kind: 'ERC-20' });
  });
});

// ---------------------------------------------------------------------------
// Façade: summary
// ---------------------------------------------------------------------------

describe('getAddressSummary', () => {
  it('returns RPC data even when Blockscout and ENS are unavailable', async () => {
    const fetchMock = installFetch(
      (req) => {
        switch (req.method) {
          case 'eth_getBalance':
            return '0xde0b6b3a7640000';
          case 'eth_getCode':
            return '0x';
          case 'eth_getTransactionCount':
            return '0x2a';
          case 'eth_call':
            return pad32(ZERO); // no ENS resolver
          default:
            return null;
        }
      },
      () => ({ status: 500, body: { message: 'down' } }),
    );
    const s = await getAddressSummary(ETH, OWNER);
    expect(s).toMatchObject({ chain: 'ethereum', address: OWNER, isContract: false, txCount: 42, ensName: undefined });
    expect(s.nativeBalance).toEqual({ chain: 'ethereum', balance: 10n ** 18n, decimals: 18, symbol: 'ETH' });
    expect(s.contract).toBeUndefined();
    expect(rpcCalls(fetchMock, 'eth_call').length).toBeGreaterThan(0);
  });

  it('merges Blockscout contract info and counters', async () => {
    installFetch(
      (req) => (req.method === 'eth_getBalance' ? '0x0' : req.method === 'eth_getCode' ? '0x6080' : req.method === 'eth_getTransactionCount' ? '0x1' : pad32(ZERO)),
      (url) => {
        if (url.pathname.endsWith('/counters')) return { body: { transactions_count: '999', token_transfers_count: '5' } };
        if (url.pathname.endsWith(`/addresses/${USDC}`)) {
          return {
            body: {
              is_contract: true,
              is_verified: true,
              name: 'FiatTokenProxy',
              creator_address_hash: OWNER,
              creation_tx_hash: HASH,
              implementation_address: OTHER,
              token: { address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: '6', type: 'ERC-20' },
            },
          };
        }
        return undefined;
      },
    );
    const s = await getAddressSummary(ETH, USDC);
    expect(s.isContract).toBe(true);
    expect(s.txCount).toBe(999);
    expect(s.contract).toMatchObject({ verified: true, name: 'FiatTokenProxy', creator: OWNER, creationTx: HASH, implementation: OTHER, isToken: true });
    expect(s.contract?.token?.symbol).toBe('USDC');
  });

  it('throws only when the RPC itself fails', async () => {
    installFetch(() => new Fail(500));
    await expect(getAddressSummary(BASE, OWNER)).rejects.toThrow(/HTTP 500/);
  });
});

// ---------------------------------------------------------------------------
// Façade: history
// ---------------------------------------------------------------------------

describe('getAddressHistory', () => {
  const bsItem = { hash: HASH, timestamp: '2024-05-01T12:00:00Z', block_number: 1, from: { hash: OWNER }, to: { hash: OTHER }, value: '1', status: 'ok' };
  const esRow = { hash: HASH, timeStamp: '1', blockNumber: '1', from: OWNER, to: OTHER, value: '1', isError: '0' };

  it('prefers Blockscout when available', async () => {
    const fetchMock = installFetch(() => null, (url) => (url.hostname === 'base.blockscout.com' ? { body: { items: [bsItem], next_page_params: { block_number: 1 } } } : undefined));
    const page = await getAddressHistory(BASE, OWNER, { kind: 'tx' });
    expect(page.source).toBe('blockscout');
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('{"block_number":1}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to Etherscan when Blockscout fails and a key is configured', async () => {
    useSettings.getState().set({ etherscanApiKey: 'KEY' });
    installFetch(() => null, (url) => {
      if (url.hostname === 'base.blockscout.com') return { status: 500, body: {} };
      if (url.hostname === 'api.etherscan.io') {
        expect(url.searchParams.get('chainid')).toBe('8453');
        expect(url.searchParams.get('action')).toBe('tokentx');
        return { body: { status: '1', message: 'OK', result: [esRow] } };
      }
      return undefined;
    });
    const page = await getAddressHistory(BASE, OWNER, { kind: 'token' });
    expect(page.source).toBe('etherscan');
    expect(page.items[0].hash).toBe(HASH);
  });

  it('rethrows the Blockscout error when no fallback is configured', async () => {
    installFetch(() => null, () => ({ status: 502, body: {} }));
    await expect(getAddressHistory(BASE, OWNER, { kind: 'tx' })).rejects.toThrow(/HTTP 502/);
  });

  it('explains how to enable history for chains without any provider', async () => {
    const fetchMock = installFetch(() => null);
    await expect(getAddressHistory(BSC, OWNER, { kind: 'internal' })).rejects.toThrow('No history provider for BNB Smart Chain; add an Etherscan API key in Settings');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps later pages on the provider that issued the cursor', async () => {
    useSettings.getState().set({ etherscanApiKey: 'KEY' });
    const fetchMock = installFetch(() => null, (url) => {
      if (url.hostname === 'base.blockscout.com') return { body: { items: [] } };
      if (url.hostname === 'api.etherscan.io') return { body: { status: '1', message: 'OK', result: [] } };
      return undefined;
    });
    await getAddressHistory(BASE, OWNER, { kind: 'tx', cursor: '{"block_number":5}' });
    expect(new URL(String(fetchMock.mock.calls[0][0])).hostname).toBe('base.blockscout.com');
    await getAddressHistory(BASE, OWNER, { kind: 'tx', cursor: '2' });
    expect(new URL(String(fetchMock.mock.calls[1][0])).hostname).toBe('api.etherscan.io');
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('page')).toBe('2');
  });

  it('uses keyless Routescan for chains without Blockscout', async () => {
    installFetch(() => null, (url) => (url.hostname === 'api.routescan.io' ? { body: { status: '0', message: 'No transactions found', result: [] } } : undefined));
    const page = await getAddressHistory(AVAX, OWNER, { kind: 'tx' });
    expect(page).toEqual({ items: [], nextCursor: undefined, source: 'routescan' });
  });
});

// ---------------------------------------------------------------------------
// Façade: token balances
// ---------------------------------------------------------------------------

describe('getTokenBalances', () => {
  it('derives balances from Etherscan token transfers + balanceOf when Blockscout is missing', async () => {
    useSettings.getState().set({ etherscanApiKey: 'KEY' });
    const fetchMock = installFetch(
      (req) => {
        if (req.method !== 'eth_call') return null;
        const { to } = req.params[0] as { to: string };
        return to.toLowerCase() === USDC.toLowerCase() ? uint(5_000_000n) : uint(0n);
      },
      (url) =>
        url.hostname === 'api.etherscan.io'
          ? {
              body: {
                status: '1',
                message: 'OK',
                result: [
                  { hash: HASH, timeStamp: '1', blockNumber: '1', from: OTHER, to: OWNER, value: '1', contractAddress: USDC, tokenSymbol: 'USDC', tokenDecimal: '6', tokenName: 'USD Coin' },
                  { hash: HASH, timeStamp: '1', blockNumber: '1', from: OTHER, to: OWNER, value: '1', contractAddress: USDC, tokenSymbol: 'USDC', tokenDecimal: '6', tokenName: 'USD Coin' },
                  { hash: HASH, timeStamp: '1', blockNumber: '1', from: OTHER, to: OWNER, value: '1', contractAddress: DAI, tokenSymbol: 'DAI', tokenDecimal: '18', tokenName: 'Dai' },
                ],
              },
            }
          : undefined,
    );
    const balances = await getTokenBalances(BSC, OWNER);
    expect(rpcCalls(fetchMock, 'eth_call')).toHaveLength(2);
    expect(balances).toHaveLength(1);
    expect(balances[0]).toEqual({ token: { chain: 'bsc', address: USDC, name: 'USDC', symbol: 'USDC', decimals: 6, type: 'ERC-20' }, balance: 5_000_000n });
  });

  it('throws a helpful error when no provider can list tokens', async () => {
    installFetch(() => null);
    await expect(getTokenBalances(BSC, OWNER)).rejects.toThrow('No token balance provider for BNB Smart Chain; add an Etherscan API key in Settings');
  });
});

// ---------------------------------------------------------------------------
// Façade: full transaction
// ---------------------------------------------------------------------------

describe('getTransactionFull', () => {
  const tx = {
    hash: HASH,
    nonce: '0x5',
    blockHash: `0x${'11'.repeat(32)}`,
    blockNumber: '0x10',
    transactionIndex: '0x2',
    from: OWNER,
    to: USDC,
    value: '0x0',
    gas: '0x5208',
    gasPrice: '0x3b9aca00',
    maxFeePerGas: '0x77359400',
    input: `0xa9059cbb${pad32(OTHER).slice(2)}${uint(1_000_000n).slice(2)}`,
    type: '0x2',
  };
  const transferLog = {
    address: USDC.toLowerCase(),
    topics: [TOPIC_TRANSFER, pad32(OWNER), pad32(OTHER)],
    data: uint(1_000_000n),
    blockNumber: '0x10',
    transactionHash: HASH,
    logIndex: '0x3',
  };
  const receipt = { transactionHash: HASH, transactionIndex: '0x2', blockHash: tx.blockHash, blockNumber: '0x10', from: OWNER, to: USDC, cumulativeGasUsed: '0x1', gasUsed: '0xd6d8', effectiveGasPrice: '0x3b9aca00', contractAddress: null, logs: [transferLog], status: '0x1' };

  function rpcFor(opts: { withMeta?: boolean } = {}) {
    return (req: RpcReq): unknown => {
      switch (req.method) {
        case 'eth_getTransactionByHash':
          return tx;
        case 'eth_getTransactionReceipt':
          return receipt;
        case 'eth_getBlockByNumber':
          return { number: '0x10', timestamp: '0x65000000', transactions: [] };
        case 'eth_call':
          return opts.withMeta ? erc20CallHandler({ [USDC.toLowerCase()]: { name: 'USD Coin', symbol: 'USDC', decimals: 6 } })(req) : '0x';
        default:
          return null;
      }
    };
  }

  it('composes RPC + Blockscout data and decodes transfers with Blockscout token metadata', async () => {
    const fetchMock = installFetch(rpcFor(), (url) => {
      if (url.pathname === `/api/v2/transactions/${HASH}`) return { body: { hash: HASH, status: 'ok', method: 'transfer', timestamp: '2023-09-11T00:00:00Z', fee: { value: '1' } } };
      if (url.pathname.endsWith('/token-transfers')) {
        return {
          body: {
            items: [{ tx_hash: HASH, from: { hash: OWNER }, to: { hash: OTHER }, token: { address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: '6', type: 'ERC-20' }, total: { value: '1000000', decimals: '6' }, log_index: 3 }],
          },
        };
      }
      if (url.pathname.endsWith('/internal-transactions')) return { body: { items: [{ transaction_hash: HASH, from: { hash: USDC }, to: { hash: OTHER }, value: '0', type: 'call', success: true }] } };
      return undefined;
    });
    const t = await getTransactionFull(ETH, HASH);
    expect(t).toMatchObject({
      chain: 'ethereum',
      hash: HASH,
      status: 'success',
      blockNumber: 16,
      timestamp: 0x65000000,
      from: OWNER,
      to: USDC,
      value: { raw: 0n, decimals: 18, symbol: 'ETH' },
      gasUsed: 55000n,
      gasLimit: 21000n,
      gasPrice: 1_000_000_000n,
      nonce: 5,
      methodId: '0xa9059cbb',
      methodName: 'transfer(address,uint256)',
    });
    expect(t.fee).toEqual({ raw: 55000n * 1_000_000_000n, decimals: 18, symbol: 'ETH' });
    expect(t.transfers).toHaveLength(1);
    expect(t.transfers[0]).toMatchObject({ kind: 'ERC-20', from: OWNER, to: OTHER, amount: { raw: 1_000_000n, decimals: 6, symbol: 'USDC' }, index: 3 });
    expect(t.transfers[0].token?.name).toBe('USD Coin');
    expect(t.logs?.[0]).toMatchObject({ eventName: 'Transfer', logIndex: 3, decoded: { from: OWNER, to: OTHER, value: '1000000' } });
    expect(t.internal).toHaveLength(1);
    expect(t.extra).toMatchObject({ type: '0x2', transactionIndex: 2, maxFeePerGas: '2000000000', logCount: 1 });
    // Blockscout supplied the token metadata, so no eth_call round-trip was needed.
    expect(rpcCalls(fetchMock, 'eth_call')).toHaveLength(0);
  });

  it('falls back to erc20Meta via RPC and the built-in selector table without Blockscout', async () => {
    const fetchMock = installFetch(rpcFor({ withMeta: true }));
    const t = await getTransactionFull(BSC, HASH);
    expect(t.methodName).toBe('transfer(address,uint256)');
    expect(t.transfers[0].amount).toEqual({ raw: 1_000_000n, decimals: 6, symbol: 'USDC' });
    expect(t.internal).toBeUndefined();
    expect(rpcCalls(fetchMock, 'eth_call')).toHaveLength(3);
    // Second call hits the in-module cache.
    await getTransactionFull(BSC, HASH);
    expect(rpcCalls(fetchMock, 'eth_call')).toHaveLength(3);
  });

  it('marks reverted transactions as failed and unknown hashes as errors', async () => {
    installFetch((req) => (req.method === 'eth_getTransactionByHash' ? tx : req.method === 'eth_getTransactionReceipt' ? { ...receipt, status: '0x0', logs: [] } : null));
    const t = await getTransactionFull(BSC, HASH);
    expect(t.status).toBe('failed');
    expect(t.transfers).toEqual([]);
    installFetch(() => null);
    await expect(getTransactionFull(BSC, HASH)).rejects.toThrow(`Transaction ${HASH} not found on BNB Smart Chain`);
  });
});

// ---------------------------------------------------------------------------
// Façade: contract info
// ---------------------------------------------------------------------------

describe('getContractInfo', () => {
  it('combines Blockscout verification with on-chain proxy detection', async () => {
    installFetch(
      (req) => {
        if (req.method === 'eth_getCode') return '0x6080604052';
        if (req.method === 'eth_getStorageAt') return (req.params[1] as string) === SLOT_EIP1967_IMPLEMENTATION ? pad32(IMPL) : uint(0n);
        return null;
      },
      (url) => {
        if (url.pathname.startsWith('/api/v2/smart-contracts/')) return { body: { name: 'Proxy', compiler_version: 'v0.8.20', is_verified: true } };
        if (url.pathname.startsWith('/api/v2/addresses/')) return { body: { is_contract: true, creator_address_hash: OWNER, creation_tx_hash: HASH } };
        return undefined;
      },
    );
    const c = await getContractInfo(ETH, OTHER);
    expect(c).toMatchObject({ verified: true, name: 'Proxy', compiler: 'v0.8.20', creator: OWNER, creationTx: HASH, implementation: IMPL, proxyType: 'EIP-1967', isToken: false });
    expect(c.sourceUrl).toContain('eth.blockscout.com');
  });

  it('short-circuits for EOAs', async () => {
    const fetchMock = installFetch((req) => (req.method === 'eth_getCode' ? '0x' : null));
    await expect(getContractInfo(ETH, OWNER)).resolves.toEqual({ verified: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Façade: approvals
// ---------------------------------------------------------------------------

describe('getApprovals', () => {
  const LATEST = 3_000_000;
  const approvalLog = (token: string, spender: string, amount: bigint, block: number, idx: number, hash = HASH) => ({
    address: token.toLowerCase(),
    topics: [TOPIC_APPROVAL, pad32(OWNER), pad32(spender)],
    data: uint(amount),
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: hash,
    logIndex: `0x${idx.toString(16)}`,
  });
  const logs = [
    approvalLog(USDC, SPENDER, 1_000n, 1_200_000, 1, `0x${'01'.repeat(32)}`),
    approvalLog(USDC, SPENDER, maxUint256, 2_500_000, 2, `0x${'02'.repeat(32)}`),
    approvalLog(DAI, OTHER, 500n, 2_600_000, 1, `0x${'03'.repeat(32)}`),
    approvalLog(DAI, OTHER, 0n, 2_700_000, 1, `0x${'04'.repeat(32)}`), // revocation
    approvalLog(DAI, SPENDER, 1n << 255n, 2_800_000, 1, `0x${'05'.repeat(32)}`),
    {
      address: BAYC.toLowerCase(),
      topics: [TOPIC_APPROVAL_FOR_ALL, pad32(OWNER), pad32(OPERATOR)],
      data: uint(1n),
      blockNumber: `0x${(2_900_000).toString(16)}`,
      transactionHash: `0x${'06'.repeat(32)}`,
      logIndex: '0x0',
    },
    { address: BAYC.toLowerCase(), topics: [TOPIC_APPROVAL, pad32(OWNER), pad32(OTHER), uint(7n)], data: '0x', blockNumber: '0x2c4b40', transactionHash: HASH, logIndex: '0x1' }, // ERC-721 approve: ignored
  ];
  const meta = erc20CallHandler({
    [USDC.toLowerCase()]: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
    [DAI.toLowerCase()]: { name: 'Dai', symbol: 'DAI', decimals: 18 },
    [BAYC.toLowerCase()]: { name: 'Bored Ape Yacht Club', symbol: 'BAYC' },
  });

  function rpcWithLogs(opts: { maxRange: number }) {
    const ranges: [number, number][] = [];
    const handler = (req: RpcReq): unknown => {
      switch (req.method) {
        case 'eth_blockNumber':
          return `0x${LATEST.toString(16)}`;
        case 'eth_getLogs': {
          const f = req.params[0] as { fromBlock: string; toBlock: string; topics: unknown[] };
          const from = Number(f.fromBlock);
          const to = Number(f.toBlock);
          expect(f.topics[0]).toEqual([TOPIC_APPROVAL, TOPIC_APPROVAL_FOR_ALL]);
          expect(f.topics[1]).toBe(pad32(OWNER));
          if (to - from + 1 > opts.maxRange) return { error: { code: -32005, message: 'query exceeds max block range' } };
          ranges.push([from, to]);
          return logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
        }
        case 'eth_getBlockByNumber':
          return { number: req.params[0], timestamp: `0x${(1_700_000_000 + Number(req.params[0])).toString(16)}`, transactions: [] };
        case 'eth_call':
          return meta(req);
        default:
          return null;
      }
    };
    return { handler, ranges };
  }

  it('scans the last 2M blocks, splits into 5 chunks on refusal, dedupes by (token, spender) and flags unlimited', async () => {
    const { handler, ranges } = rpcWithLogs({ maxRange: 500_000 });
    installFetch(handler);
    const approvals = await getApprovals(ETH, OWNER);

    // One wide attempt (refused) then 5 contiguous chunks covering [latest-2M, latest].
    expect(ranges).toHaveLength(5);
    expect(ranges[0][0]).toBe(LATEST - 2_000_000);
    expect(ranges[4][1]).toBe(LATEST);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1] + 1);

    expect(approvals.map((a) => [a.token.symbol, a.spender])).toEqual([
      ['BAYC', OPERATOR],
      ['DAI', SPENDER],
      ['USDC', SPENDER],
    ]);
    const usdc = approvals[2];
    expect(usdc).toMatchObject({ amount: maxUint256, unlimited: true, txHash: `0x${'02'.repeat(32)}`, blockNumber: 2_500_000 });
    expect(usdc.token).toMatchObject({ name: 'USD Coin', decimals: 6, type: 'ERC-20' });
    expect(usdc.timestamp).toBe(1_700_000_000 + 2_500_000);
    expect(approvals[1]).toMatchObject({ amount: 1n << 255n, unlimited: true });
    expect(approvals[0]).toMatchObject({ amount: maxUint256, unlimited: true, spender: OPERATOR });
    expect(approvals[0].token.type).toBe('ERC-721');
  });

  it('uses a single wide request when the RPC accepts it', async () => {
    const { handler, ranges } = rpcWithLogs({ maxRange: 10_000_000 });
    installFetch(handler);
    const approvals = await getApprovals(ETH, OWNER);
    expect(ranges).toEqual([[LATEST - 2_000_000, LATEST]]);
    expect(approvals).toHaveLength(3);
  });

  it('returns [] with a warning instead of throwing when eth_getLogs is refused outright', async () => {
    const { handler } = rpcWithLogs({ maxRange: 10 });
    const fetchMock = installFetch(handler);
    await expect(getApprovals(BASE, OWNER)).resolves.toEqual([]);
    expect(console.warn).toHaveBeenCalled();
    // 1 wide + 5 chunks, each tried on at most 2 endpoints, never more than the budget.
    expect(rpcCalls(fetchMock, 'eth_getLogs').length).toBeLessThanOrEqual(12);
  });
});
