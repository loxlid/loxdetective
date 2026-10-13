import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChain } from '@/lib/chains/registry';
import {
  addressCounters,
  addressInfo,
  addressInternalTxs,
  addressTokenBalances,
  addressTokenTransfers,
  addressTransactions,
  contractInfo,
  hasBlockscout,
  normalizeSignature,
  parseTimestamp,
  txInternal,
  txInternalPaged,
  txSummary,
  txTokenTransfers,
} from '@/lib/providers/evm/blockscout';

const ETH = getChain('ethereum');
const BSC = getChain('bsc');
const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
const HASH = `0x${'ab'.repeat(32)}`;
const TS = '2024-05-01T12:00:00.000000Z';
const TS_UNIX = Math.floor(Date.parse(TS) / 1000);

type Route = (url: URL) => { status?: number; body: unknown } | unknown;

function installFetch(route: Route) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const out = route(url) as { status?: number; body?: unknown } | unknown;
    const isEnvelope = !!out && typeof out === 'object' && 'body' in (out as object) && 'status' in (out as object);
    const status = isEnvelope ? ((out as { status?: number }).status ?? 200) : 200;
    const body = isEnvelope ? (out as { body: unknown }).body : out;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('availability', () => {
  it('hasBlockscout reflects the registry', () => {
    expect(hasBlockscout(ETH)).toBe(true);
    expect(hasBlockscout(BSC)).toBe(false);
  });

  it('every function throws a clear error for chains without Blockscout', async () => {
    const fetchMock = installFetch(() => ({}));
    await expect(addressTransactions(BSC, OWNER)).rejects.toThrow('Blockscout not available for BNB Smart Chain');
    await expect(txSummary(BSC, HASH)).rejects.toThrow('Blockscout not available for BNB Smart Chain');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('addressTransactions', () => {
  const items = [
    { hash: HASH, timestamp: TS, block_number: 100, from: { hash: OWNER.toLowerCase() }, to: { hash: OTHER.toLowerCase() }, value: '1000', fee: { value: '21' }, status: 'ok', method: 'transfer', tx_types: ['coin_transfer'] },
    { hash: `0x${'cd'.repeat(32)}`, timestamp: TS, block: 99, from: { hash: OTHER }, to: { hash: OWNER }, value: '0', status: 'error', result: 'Reverted', method: '0x12345678' },
    { hash: `0x${'ef'.repeat(32)}`, timestamp: TS, block_number: 98, from: { hash: OWNER }, to: { hash: OWNER }, value: '5', status: null },
    { hash: `0x${'01'.repeat(32)}`, timestamp: TS, block_number: 97, from: { hash: OWNER }, to: null, created_contract: { hash: USDC }, value: '0', status: 'ok' },
  ];

  it('maps items, computes direction against the queried address and serialises the cursor', async () => {
    const fetchMock = installFetch((url) => {
      expect(url.href).toBe(`https://eth.blockscout.com/api/v2/addresses/${OWNER}/transactions`);
      return { items, next_page_params: { block_number: 97, index: 0, items_count: 50 } };
    });
    const page = await addressTransactions(ETH, OWNER);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(page.source).toBe('blockscout');
    expect(page.nextCursor).toBe(JSON.stringify({ block_number: 97, index: 0, items_count: 50 }));
    expect(page.items).toHaveLength(4);
    expect(page.items[0]).toMatchObject({ chain: 'ethereum', hash: HASH, timestamp: TS_UNIX, blockNumber: 100, from: OWNER, to: OTHER, status: 'success', methodName: 'transfer', direction: 'out' });
    expect(page.items[0].value).toEqual({ raw: 1000n, decimals: 18, symbol: 'ETH' });
    expect(page.items[1]).toMatchObject({ blockNumber: 99, status: 'failed', direction: 'in', methodName: undefined });
    expect(page.items[2]).toMatchObject({ status: 'pending', direction: 'self' });
    expect(page.items[3]).toMatchObject({ to: USDC, direction: 'out' });
  });

  it('passes the cursor back as query parameters', async () => {
    const fetchMock = installFetch(() => ({ items: [] }));
    const cursor = JSON.stringify({ block_number: 97, index: 0, items_count: 50 });
    const page = await addressTransactions(ETH, OWNER, cursor);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('block_number')).toBe('97');
    expect(url.searchParams.get('index')).toBe('0');
    expect(url.searchParams.get('items_count')).toBe('50');
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('rejects a cursor that is not JSON', async () => {
    installFetch(() => ({ items: [] }));
    await expect(addressTransactions(ETH, OWNER, '3')).rejects.toThrow('Invalid Blockscout page cursor');
  });
});

describe('token transfers', () => {
  const erc20 = {
    tx_hash: HASH,
    timestamp: TS,
    block_number: 100,
    log_index: 4,
    from: { hash: OTHER },
    to: { hash: OWNER },
    token: { address: USDC.toLowerCase(), name: 'USD Coin', symbol: 'USDC', decimals: '6', type: 'ERC-20' },
    total: { value: '2500000', decimals: '6' },
    method: 'transfer',
  };
  const erc721 = {
    transaction_hash: HASH,
    timestamp: TS,
    block_number: 100,
    log_index: 5,
    from: { hash: OWNER },
    to: { hash: OTHER },
    token: { address: BAYC, name: 'Bored Ape Yacht Club', symbol: 'BAYC', decimals: null, type: 'ERC-721' },
    total: { token_id: '42' },
  };

  it('addressTokenTransfers maps ERC-20 and ERC-721 rows with direction and token summary', async () => {
    installFetch(() => ({ items: [erc20, erc721], next_page_params: null }));
    const page = await addressTokenTransfers(ETH, OWNER);
    expect(page.nextCursor).toBeUndefined();
    const [a, b] = page.items;
    expect(a).toMatchObject({ hash: HASH, from: OTHER, to: OWNER, direction: 'in', methodName: 'transfer', status: 'success' });
    expect(a.value).toEqual({ raw: 2_500_000n, decimals: 6, symbol: 'USDC' });
    expect(a.token).toEqual({ symbol: 'USDC', amount: { raw: 2_500_000n, decimals: 6, symbol: 'USDC' }, tokenAddress: USDC, kind: 'ERC-20' });
    expect(b).toMatchObject({ hash: HASH, direction: 'out' });
    expect(b.token).toMatchObject({ symbol: 'BAYC', kind: 'ERC-721', amount: { raw: 1n, decimals: 0 } });
  });

  const erc1155Batch = {
    tx_hash: HASH,
    timestamp: TS,
    block_number: 100,
    log_index: 6,
    from: { hash: OTHER },
    to: { hash: OWNER },
    token: { address: BAYC, name: 'Multi', symbol: 'MULTI', decimals: null, type: 'ERC-1155' },
    total: [
      { token_id: '7', value: '500', decimals: null },
      { token_id: '8', value: '2', decimals: null },
    ],
  };

  it('sums ERC-1155 batch totals in history rows and expands them into one Transfer per id', async () => {
    installFetch(() => ({ items: [erc1155Batch], next_page_params: null }));
    const page = await addressTokenTransfers(ETH, OWNER);
    expect(page.items[0].value).toEqual({ raw: 502n, decimals: 0, symbol: 'MULTI' });
    expect(page.items[0].token).toMatchObject({ kind: 'ERC-1155', amount: { raw: 502n } });

    const transfers = await txTokenTransfers(ETH, HASH);
    expect(transfers).toHaveLength(2);
    expect(transfers[0]).toMatchObject({ kind: 'ERC-1155', tokenId: '7', index: 6, from: OTHER, to: OWNER, amount: { raw: 500n, decimals: 0 } });
    expect(transfers[1]).toMatchObject({ kind: 'ERC-1155', tokenId: '8', index: 6, amount: { raw: 2n, decimals: 0 } });
  });

  it('txTokenTransfers maps to Transfer objects with token metadata', async () => {
    installFetch((url) => {
      expect(url.pathname).toBe(`/api/v2/transactions/${HASH}/token-transfers`);
      return { items: [erc20, erc721] };
    });
    const [a, b] = await txTokenTransfers(ETH, HASH);
    expect(a).toMatchObject({ kind: 'ERC-20', from: OTHER, to: OWNER, index: 4, amount: { raw: 2_500_000n, decimals: 6 } });
    expect(a.token).toMatchObject({ chain: 'ethereum', address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: 6, type: 'ERC-20' });
    expect(b).toMatchObject({ kind: 'ERC-721', tokenId: '42', index: 5 });
    expect(b.token?.decimals).toBe(0);
  });
});

describe('addressTokenBalances', () => {
  it('requests all token types and follows pagination', async () => {
    const fetchMock = installFetch((url) => {
      expect(url.searchParams.get('type')).toBe('ERC-20,ERC-721,ERC-1155');
      if (!url.searchParams.has('items_count')) {
        return {
          items: [{ token: { address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: '6', type: 'ERC-20' }, value: '1000000' }],
          next_page_params: { items_count: 50, fiat_value: null },
        };
      }
      return { items: [{ token: { address: BAYC, name: 'BAYC', symbol: 'BAYC', type: 'ERC-721' }, value: '2', token_id: null }], next_page_params: null };
    });
    const out = await addressTokenBalances(ETH, OWNER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ token: { chain: 'ethereum', address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: 6, type: 'ERC-20', logoUrl: undefined }, balance: 1_000_000n });
    expect(out[1].token.type).toBe('ERC-721');
    expect(out[1].balance).toBe(2n);
  });
});

describe('internal transactions', () => {
  const item = { transaction_hash: HASH, timestamp: TS, block_number: 100, from: { hash: USDC }, to: { hash: OWNER }, value: '777', type: 'call', success: true, error: null };
  const failed = { transaction_hash: HASH, timestamp: TS, block_number: 100, from: { hash: OWNER }, to: { hash: OTHER }, value: '0', type: 'delegatecall', success: false, error: 'out of gas' };

  it('addressInternalTxs maps rows', async () => {
    installFetch(() => ({ items: [item, failed], next_page_params: { block_number: 1 } }));
    const page = await addressInternalTxs(ETH, OWNER);
    expect(page.items[0]).toMatchObject({ hash: HASH, from: USDC, to: OWNER, direction: 'in', status: 'success', methodName: 'call', value: { raw: 777n } });
    expect(page.items[1]).toMatchObject({ direction: 'out', status: 'failed' });
    expect(page.nextCursor).toBe('{"block_number":1}');
  });

  it('txInternal maps to InternalCall', async () => {
    installFetch(() => ({ items: [item, failed] }));
    const calls = await txInternal(ETH, HASH);
    expect(calls[0]).toEqual({ from: USDC, to: OWNER, value: { raw: 777n, decimals: 18, symbol: 'ETH' }, type: 'call', error: undefined });
    expect(calls[1]).toMatchObject({ type: 'delegatecall', error: 'out of gas' });
  });

  it('txInternal follows next_page_params and concatenates pages', async () => {
    const fetchMock = installFetch((url) => {
      expect(url.pathname).toBe(`/api/v2/transactions/${HASH}/internal-transactions`);
      if (!url.searchParams.has('index')) return { items: [item], next_page_params: { index: 50, block_number: 100 } };
      expect(url.searchParams.get('index')).toBe('50');
      expect(url.searchParams.get('block_number')).toBe('100');
      return { items: [failed], next_page_params: null };
    });
    const calls = await txInternal(ETH, HASH);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
    expect(calls[0].type).toBe('call');
    expect(calls[1].type).toBe('delegatecall');
  });

  it('txInternal stops after 5 pages', async () => {
    const fetchMock = installFetch(() => ({ items: [item], next_page_params: { index: 1 } }));
    const calls = await txInternal(ETH, HASH);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(calls).toHaveLength(5);
  });

  it('txInternalPaged reports whether the explorer still had more pages', async () => {
    installFetch(() => ({ items: [item], next_page_params: { index: 1 } }));
    const more = await txInternalPaged(ETH, HASH);
    expect(more.calls).toHaveLength(5);
    expect(more.truncated).toBe(true);

    installFetch((url) => (url.searchParams.has('index') ? { items: [failed], next_page_params: null } : { items: [item], next_page_params: { index: 1 } }));
    const done = await txInternalPaged(ETH, HASH);
    expect(done.calls).toHaveLength(2);
    expect(done.truncated).toBe(false);
  });
});

describe('txSummary', () => {
  it('maps method, fee, status, timestamp and gas fields', async () => {
    installFetch(() => ({
      hash: HASH,
      timestamp: TS,
      block_number: 123,
      from: { hash: OWNER },
      to: { hash: USDC },
      value: '0',
      fee: { type: 'actual', value: '21000000000000' },
      status: 'ok',
      method: 'transfer',
      decoded_input: { method_call: 'transfer(address _to, uint256 _value)', method_id: 'a9059cbb' },
      gas_used: '52000',
      gas_limit: '60000',
      gas_price: '1000000000',
      nonce: 7,
      raw_input: '0xa9059cbb',
    }));
    const s = await txSummary(ETH, HASH);
    expect(s).toMatchObject({
      chain: 'ethereum',
      hash: HASH,
      status: 'success',
      blockNumber: 123,
      timestamp: TS_UNIX,
      from: OWNER,
      to: USDC,
      methodName: 'transfer(address,uint256)',
      methodId: '0xa9059cbb',
      gasUsed: 52000n,
      gasLimit: 60000n,
      gasPrice: 1_000_000_000n,
      nonce: 7,
      input: '0xa9059cbb',
    });
    expect(s.fee).toEqual({ raw: 21_000_000_000_000n, decimals: 18, symbol: 'ETH' });
  });

  it('maps error status and falls back to the plain method name', async () => {
    installFetch(() => ({ hash: HASH, status: 'error', result: 'Reverted', method: 'swap' }));
    const s = await txSummary(ETH, HASH);
    expect(s.status).toBe('failed');
    expect(s.methodName).toBe('swap');
    expect(s.fee).toBeUndefined();
  });
});

describe('addressInfo / contractInfo / counters', () => {
  it('addressInfo maps contract metadata and token', async () => {
    installFetch(() => ({
      hash: USDC,
      is_contract: true,
      is_verified: true,
      name: 'FiatTokenProxy',
      ens_domain_name: null,
      creator_address_hash: OWNER.toLowerCase(),
      creation_tx_hash: HASH,
      implementation_address: OTHER.toLowerCase(),
      implementations: [{ address: OTHER.toLowerCase(), name: 'FiatTokenV2_2' }],
      token: { address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: '6', type: 'ERC-20', icon_url: 'https://x/usdc.png' },
    }));
    const info = await addressInfo(ETH, USDC);
    expect(info).toEqual({
      isContract: true,
      name: 'FiatTokenProxy',
      isVerified: true,
      ensName: undefined,
      creatorAddress: OWNER,
      creationTx: HASH,
      implementation: OTHER,
      token: { chain: 'ethereum', address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: 6, type: 'ERC-20', logoUrl: 'https://x/usdc.png' },
    });
  });

  it('addressInfo treats a 404 as a plain EOA', async () => {
    installFetch(() => ({ status: 404, body: { message: 'Not found' } }));
    await expect(addressInfo(ETH, OWNER)).resolves.toEqual({ isContract: false });
  });

  it('addressInfo propagates other HTTP errors', async () => {
    installFetch(() => ({ status: 500, body: { message: 'boom' } }));
    await expect(addressInfo(ETH, OWNER)).rejects.toThrow(/HTTP 500/);
  });

  it('contractInfo maps verification, compiler and proxy data', async () => {
    installFetch(() => ({
      name: 'FiatTokenProxy',
      compiler_version: 'v0.4.24+commit.e67f0147',
      is_verified: true,
      proxy_type: 'eip1967',
      implementations: [{ address: OTHER.toLowerCase(), name: 'FiatTokenV2_2' }],
    }));
    const c = await contractInfo(ETH, USDC);
    expect(c).toEqual({
      verified: true,
      name: 'FiatTokenProxy',
      compiler: 'v0.4.24+commit.e67f0147',
      implementation: OTHER,
      proxyType: 'EIP-1967',
      sourceUrl: `https://eth.blockscout.com/address/${USDC}?tab=contract`,
    });
  });

  it('contractInfo returns unverified on 404', async () => {
    installFetch(() => ({ status: 404, body: { message: 'Not found' } }));
    await expect(contractInfo(ETH, OTHER)).resolves.toEqual({ verified: false });
  });

  it('addressCounters parses string counters', async () => {
    installFetch((url) => {
      expect(url.pathname).toBe(`/api/v2/addresses/${OWNER}/counters`);
      return { transactions_count: '1234', token_transfers_count: '56', gas_usage_count: '7890000', validations_count: '0' };
    });
    await expect(addressCounters(ETH, OWNER)).resolves.toEqual({ txCount: 1234, tokenTransfers: 56, gasUsed: 7_890_000n });
  });
});

describe('helpers', () => {
  it('normalizeSignature strips parameter names and keeps tuples', () => {
    expect(normalizeSignature('transfer(address _to, uint256 _value)')).toBe('transfer(address,uint256)');
    expect(normalizeSignature('withdraw()')).toBe('withdraw()');
    expect(normalizeSignature('exactInputSingle((address tokenIn, address tokenOut, uint24 fee) params)')).toBe('exactInputSingle((address,address,uint24))');
    expect(normalizeSignature('not a signature')).toBeUndefined();
    expect(normalizeSignature(undefined)).toBeUndefined();
  });

  it('parseTimestamp accepts ISO strings, unix seconds and millis', () => {
    expect(parseTimestamp(TS)).toBe(TS_UNIX);
    expect(parseTimestamp(1_714_564_800)).toBe(1_714_564_800);
    expect(parseTimestamp(1_714_564_800_000)).toBe(1_714_564_800);
    expect(parseTimestamp('1714564800')).toBe(1_714_564_800);
    expect(parseTimestamp(null)).toBeUndefined();
    expect(parseTimestamp('garbage')).toBeUndefined();
  });
});
