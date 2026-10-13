import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, maxUint256, toEventSelector, toFunctionSelector } from 'viem';
import type { TokenInfo } from '@/lib/types';
import {
  KNOWN_EVENTS_ABI,
  SLOT_EIP1822_PROXIABLE,
  SLOT_EIP1967_BEACON,
  SLOT_EIP1967_IMPLEMENTATION,
  TOPIC_APPROVAL,
  TOPIC_APPROVAL_FOR_ALL,
  TOPIC_DEPOSIT,
  TOPIC_TRANSFER,
  TOPIC_TRANSFER_BATCH,
  TOPIC_TRANSFER_SINGLE,
  TOPIC_WITHDRAWAL,
  WELL_KNOWN_SELECTORS,
  ZERO_ADDRESS,
  decodeKnownEvents,
  decodeTransfersFromLogs,
  detectProxy,
  lookupSelector,
  selectorOf,
  storageToAddress,
  topicToAddress,
  type RawLog,
} from '@/lib/providers/evm/decode';

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const OPERATOR = '0x3333333333333333333333333333333333333333';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const BAYC = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
const IMPL = '0x4444444444444444444444444444444444444444';

const pad32 = (addr: string) => `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}`;
const uint = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

const META: Record<string, TokenInfo> = {
  [USDC.toLowerCase()]: { chain: 'ethereum', address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: 6, type: 'ERC-20' },
  [WETH.toLowerCase()]: { chain: 'ethereum', address: WETH, name: 'Wrapped Ether', symbol: 'WETH', decimals: 18, type: 'ERC-20' },
  [BAYC.toLowerCase()]: { chain: 'ethereum', address: BAYC, name: 'Bored Ape Yacht Club', symbol: 'BAYC', decimals: 0, type: 'ERC-721' },
};
const meta = (a: string) => META[a.toLowerCase()];

function log(address: string, topics: string[], data: string, logIndex: string | number = 0): RawLog {
  return { address, topics, data, logIndex };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('event topic constants', () => {
  it('match the keccak of the canonical signatures', () => {
    expect(TOPIC_TRANSFER).toBe(toEventSelector('Transfer(address,address,uint256)'));
    expect(TOPIC_APPROVAL).toBe(toEventSelector('Approval(address,address,uint256)'));
    expect(TOPIC_APPROVAL_FOR_ALL).toBe(toEventSelector('ApprovalForAll(address,address,bool)'));
    expect(TOPIC_TRANSFER_SINGLE).toBe(toEventSelector('TransferSingle(address,address,address,uint256,uint256)'));
    expect(TOPIC_TRANSFER_BATCH).toBe(toEventSelector('TransferBatch(address,address,address,uint256[],uint256[])'));
    expect(TOPIC_DEPOSIT).toBe(toEventSelector('Deposit(address,uint256)'));
    expect(TOPIC_WITHDRAWAL).toBe(toEventSelector('Withdrawal(address,uint256)'));
  });

  it('known events ABI covers the spec list', () => {
    const names = new Set<string>(KNOWN_EVENTS_ABI.map((e) => e.name));
    for (const n of ['Transfer', 'Approval', 'ApprovalForAll', 'TransferSingle', 'TransferBatch', 'Swap', 'Deposit', 'Withdrawal', 'OwnershipTransferred', 'Upgraded', 'Sync']) {
      expect(names.has(n), n).toBe(true);
    }
  });
});

describe('decodeTransfersFromLogs', () => {
  it('decodes a 3-topic Transfer with 32-byte data as ERC-20', () => {
    const [t] = decodeTransfersFromLogs('ethereum', [log(USDC, [TOPIC_TRANSFER, pad32(OWNER), pad32(OTHER)], uint(1_000_000n), '0x3')], meta);
    expect(t.kind).toBe('ERC-20');
    expect(t.from).toBe(OWNER);
    expect(t.to).toBe(OTHER);
    expect(t.amount).toEqual({ raw: 1_000_000n, decimals: 6, symbol: 'USDC' });
    expect(t.token?.symbol).toBe('USDC');
    expect(t.index).toBe(3);
    expect(t.tokenId).toBeUndefined();
  });

  it('decodes a 4-topic Transfer as ERC-721 with the indexed tokenId', () => {
    const [t] = decodeTransfersFromLogs('ethereum', [log(BAYC, [TOPIC_TRANSFER, pad32(OWNER), pad32(OTHER), uint(1234n)], '0x', 7)], meta);
    expect(t.kind).toBe('ERC-721');
    expect(t.tokenId).toBe('1234');
    expect(t.amount).toEqual({ raw: 1n, decimals: 0, symbol: 'BAYC' });
    expect(t.index).toBe(7);
  });

  it('treats a 4-topic Transfer from a token with ERC-20 metadata as an NFT anyway', () => {
    const [t] = decodeTransfersFromLogs('ethereum', [log(USDC, [TOPIC_TRANSFER, pad32(OWNER), pad32(OTHER), uint(5n)], '0x')], meta);
    expect(t.kind).toBe('ERC-721');
    expect(t.token?.type).toBe('ERC-721');
    expect(t.amount.decimals).toBe(0);
  });

  it('decodes a legacy non-indexed Transfer (1 topic, 96-byte data)', () => {
    const data = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [OWNER, OTHER, 42n]);
    const [t] = decodeTransfersFromLogs('ethereum', [log(USDC, [TOPIC_TRANSFER], data)], meta);
    expect(t.kind).toBe('ERC-20');
    expect(t.amount.raw).toBe(42n);
  });

  it('decodes ERC-1155 TransferSingle and TransferBatch', () => {
    const single = log(BAYC, [TOPIC_TRANSFER_SINGLE, pad32(OPERATOR), pad32(OWNER), pad32(OTHER)], encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [9n, 3n]), 1);
    const batch = log(BAYC, [TOPIC_TRANSFER_BATCH, pad32(OPERATOR), pad32(OWNER), pad32(OTHER)], encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [[1n, 2n], [10n, 20n]]), 2);
    const out = decodeTransfersFromLogs('ethereum', [single, batch], meta);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ kind: 'ERC-1155', from: OWNER, to: OTHER, tokenId: '9', amount: { raw: 3n, decimals: 0 } });
    expect(out[1]).toMatchObject({ kind: 'ERC-1155', tokenId: '1', amount: { raw: 10n } });
    expect(out[2]).toMatchObject({ kind: 'ERC-1155', tokenId: '2', amount: { raw: 20n } });
    expect(out[0].token?.type).toBe('ERC-1155');
  });

  it('turns WETH Deposit/Withdrawal into mint/burn-style transfers, but ignores other contracts', () => {
    const out = decodeTransfersFromLogs(
      'ethereum',
      [
        log(WETH, [TOPIC_DEPOSIT, pad32(OWNER)], uint(10n ** 18n), 0),
        log(WETH, [TOPIC_WITHDRAWAL, pad32(OTHER)], uint(5n), 1),
        log(USDC, [TOPIC_DEPOSIT, pad32(OWNER)], uint(7n), 2),
      ],
      meta,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'ERC-20', from: ZERO_ADDRESS, to: OWNER, amount: { raw: 10n ** 18n, decimals: 18, symbol: 'WETH' } });
    expect(out[1]).toMatchObject({ kind: 'ERC-20', from: OTHER, to: ZERO_ADDRESS, amount: { raw: 5n } });
  });

  it('uses a shortened-address fallback token when metadata is unknown', () => {
    const [t] = decodeTransfersFromLogs('base', [log(OPERATOR, [TOPIC_TRANSFER, pad32(OWNER), pad32(OTHER)], uint(1n))], () => undefined);
    expect(t.token).toMatchObject({ chain: 'base', address: OPERATOR, symbol: '0x3333…3333', decimals: 0, type: 'ERC-20' });
  });

  it('skips malformed logs and unrelated topics', () => {
    const out = decodeTransfersFromLogs(
      'ethereum',
      [
        log(USDC, [TOPIC_TRANSFER, pad32(OWNER), pad32(OTHER)], '0x'), // ERC-20 shape with no data
        log(USDC, [TOPIC_APPROVAL, pad32(OWNER), pad32(OTHER)], uint(1n)),
        log(USDC, [], '0x'),
      ],
      meta,
    );
    expect(out).toEqual([]);
  });
});

describe('decodeKnownEvents', () => {
  it('names ERC-20 and ERC-721 Transfer logs and decodes their args', () => {
    const [erc20, erc721, approval] = decodeKnownEvents([
      log(USDC, [TOPIC_TRANSFER, pad32(OWNER), pad32(OTHER)], uint(5n), '0x1'),
      log(BAYC, [TOPIC_TRANSFER, pad32(OWNER), pad32(OTHER), uint(77n)], '0x', 2),
      log(USDC, [TOPIC_APPROVAL, pad32(OWNER), pad32(OTHER)], uint(maxUint256), 3),
    ]);
    expect(erc20.eventName).toBe('Transfer');
    expect(erc20.decoded).toEqual({ from: OWNER, to: OTHER, value: '5' });
    expect(erc20.logIndex).toBe(1);
    expect(erc721.eventName).toBe('Transfer');
    expect(erc721.decoded).toEqual({ from: OWNER, to: OTHER, tokenId: '77' });
    expect(approval.eventName).toBe('Approval');
    expect(approval.decoded?.value).toBe(maxUint256.toString());
  });

  it('decodes Uniswap V2 and V3 Swap events', () => {
    const v2Topic = toEventSelector('Swap(address,uint256,uint256,uint256,uint256,address)');
    const v3Topic = toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)');
    const v2Data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1n, 0n, 0n, 2n]);
    const v3Data = encodeAbiParameters([{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [-10n, 10n, 1n, 2n, -5]);
    const [v2, v3] = decodeKnownEvents([log(OPERATOR, [v2Topic, pad32(OWNER), pad32(OTHER)], v2Data), log(OPERATOR, [v3Topic, pad32(OWNER), pad32(OTHER)], v3Data)]);
    expect(v2.eventName).toBe('Swap');
    expect(v2.decoded).toEqual({ sender: OWNER, to: OTHER, amount0In: '1', amount1In: '0', amount0Out: '0', amount1Out: '2' });
    expect(v3.eventName).toBe('Swap');
    expect(v3.decoded).toEqual({ sender: OWNER, recipient: OTHER, amount0: '-10', amount1: '10', sqrtPriceX96: '1', liquidity: '2', tick: '-5' });
  });

  it('decodes ApprovalForAll, TransferBatch, OwnershipTransferred and Upgraded', () => {
    const batchData = encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [[1n], [2n]]);
    const out = decodeKnownEvents([
      log(BAYC, [TOPIC_APPROVAL_FOR_ALL, pad32(OWNER), pad32(OPERATOR)], uint(1n)),
      log(BAYC, [TOPIC_TRANSFER_BATCH, pad32(OPERATOR), pad32(OWNER), pad32(OTHER)], batchData),
      log(OPERATOR, [toEventSelector('OwnershipTransferred(address,address)'), pad32(OWNER), pad32(OTHER)], '0x'),
      log(OPERATOR, [toEventSelector('Upgraded(address)'), pad32(IMPL)], '0x'),
    ]);
    expect(out[0].decoded).toEqual({ owner: OWNER, operator: OPERATOR, approved: 'true' });
    expect(out[1].decoded).toEqual({ operator: OPERATOR, from: OWNER, to: OTHER, ids: '["1"]', values: '["2"]' });
    expect(out[2].eventName).toBe('OwnershipTransferred');
    expect(out[3]).toMatchObject({ eventName: 'Upgraded', decoded: { implementation: IMPL } });
  });

  it('passes unknown logs through without a name', () => {
    const [u] = decodeKnownEvents([log(OPERATOR, [`0x${'99'.repeat(32)}`], '0x', '0x5')]);
    expect(u.eventName).toBeUndefined();
    expect(u.decoded).toBeUndefined();
    expect(u.logIndex).toBe(5);
  });
});

describe('selectors', () => {
  it('selectorOf extracts the first four bytes', () => {
    expect(selectorOf(`0xA9059CBB${'00'.repeat(64)}`)).toBe('0xa9059cbb');
    expect(selectorOf('0xa9059cbb')).toBe('0xa9059cbb');
    expect(selectorOf('0x')).toBeUndefined();
    expect(selectorOf('0xabc')).toBeUndefined();
    expect(selectorOf(undefined)).toBeUndefined();
  });

  it('WELL_KNOWN_SELECTORS has at least 40 entries that all match toFunctionSelector', () => {
    const entries = Object.entries(WELL_KNOWN_SELECTORS);
    expect(entries.length).toBeGreaterThanOrEqual(40);
    for (const [selector, signature] of entries) {
      expect(selector, signature).toBe(toFunctionSelector(signature));
    }
    expect(WELL_KNOWN_SELECTORS['0xa9059cbb']).toBe('transfer(address,uint256)');
    expect(WELL_KNOWN_SELECTORS['0x3593564c']).toBe('execute(bytes,bytes[],uint256)');
  });

  it('lookupSelector answers from the built-in table without network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(lookupSelector('0xA9059CBB')).resolves.toBe('transfer(address,uint256)');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lookupSelector uses openchain, falls back to 4byte, and memoises', async () => {
    const sel = '0x12345678';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('openchain')) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { function: { [sel]: [{ name: 'foo(uint256)', filtered: false }] } } }) };
      throw new Error('unexpected');
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(lookupSelector(sel)).resolves.toBe('foo(uint256)');
    await expect(lookupSelector(sel)).resolves.toBe('foo(uint256)');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const sel2 = '0x87654321';
    const fallbackMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('openchain')) return { ok: false, status: 500, text: async () => '' };
      if (url.includes('4byte')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ results: [{ id: 900, text_signature: 'collision(uint8)' }, { id: 12, text_signature: 'bar(address)' }] }),
        };
      }
      throw new Error('unexpected');
    });
    vi.stubGlobal('fetch', fallbackMock);
    await expect(lookupSelector(sel2)).resolves.toBe('bar(address)');
    expect(fallbackMock).toHaveBeenCalledTimes(2);
  });

  it('lookupSelector returns undefined (never throws) when both databases fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => '' })));
    await expect(lookupSelector('0xdeadbeef')).resolves.toBeUndefined();
    await expect(lookupSelector('nonsense')).resolves.toBeUndefined();
  });
});

describe('detectProxy', () => {
  const zero = async () => `0x${'0'.repeat(64)}`;

  it('returns nothing for an EOA', async () => {
    const getStorage = vi.fn(zero);
    await expect(detectProxy(getStorage, '0x')).resolves.toEqual({});
    expect(getStorage).not.toHaveBeenCalled();
  });

  it('detects an EIP-1167 minimal proxy from bytecode without touching storage', async () => {
    const code = `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`;
    const getStorage = vi.fn(zero);
    await expect(detectProxy(getStorage, code)).resolves.toEqual({ implementation: IMPL, proxyType: 'EIP-1167' });
    expect(getStorage).not.toHaveBeenCalled();
  });

  it('detects an EIP-1967 implementation slot', async () => {
    const getStorage = vi.fn(async (slot: string) => (slot === SLOT_EIP1967_IMPLEMENTATION ? pad32(IMPL) : zero()));
    await expect(detectProxy(getStorage, '0x6080')).resolves.toEqual({ implementation: IMPL, proxyType: 'EIP-1967' });
  });

  it('resolves beacon proxies through beacon.implementation() when a call helper is given', async () => {
    const BEACON = '0x5555555555555555555555555555555555555555';
    const getStorage = vi.fn(async (slot: string) => (slot === SLOT_EIP1967_BEACON ? pad32(BEACON) : zero()));
    const call = vi.fn(async (to: string, data: string) => {
      expect(to).toBe(BEACON);
      expect(data).toBe('0x5c60da1b');
      return pad32(IMPL);
    });
    await expect(detectProxy(getStorage, '0x6080', call)).resolves.toEqual({ implementation: IMPL, beacon: BEACON, proxyType: 'EIP-1967' });
    await expect(detectProxy(getStorage, '0x6080')).resolves.toEqual({ implementation: undefined, beacon: BEACON, proxyType: 'EIP-1967' });
  });

  it('detects EIP-1822 (UUPS) and tolerates storage read failures', async () => {
    const getStorage = vi.fn(async (slot: string) => {
      if (slot === SLOT_EIP1967_IMPLEMENTATION) throw new Error('rpc down');
      return slot === SLOT_EIP1822_PROXIABLE ? pad32(IMPL) : zero();
    });
    await expect(detectProxy(getStorage, '0x6080')).resolves.toEqual({ implementation: IMPL, proxyType: 'EIP-1822' });
  });

  it('returns nothing when no slot is populated', async () => {
    await expect(detectProxy(vi.fn(zero), '0x6080')).resolves.toEqual({});
  });

  it('storageToAddress / topicToAddress handle short and zero values', () => {
    expect(storageToAddress('0x0')).toBeUndefined();
    expect(storageToAddress(undefined)).toBeUndefined();
    expect(storageToAddress(IMPL.slice(2))).toBe(IMPL);
    expect(topicToAddress(pad32(USDC))).toBe(USDC);
  });
});
