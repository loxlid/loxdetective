import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, namehash, toFunctionSelector } from 'viem';
import { CHAINS, getChain } from '@/lib/chains/registry';
import { useSettings } from '@/lib/settings/store';
import { clearEndpointCooldowns, isEndpointCooling, RpcError } from '@/lib/http';
import {
  ENS_REGISTRY,
  decodeStringResult,
  erc20Balance,
  erc20Meta,
  ethCall,
  findTxChain,
  getBlock,
  getBlockNumber,
  getCode,
  getLogs,
  getNativeBalance,
  getTransaction,
  getTransactionReceipt,
  lookupEnsName,
  multiChainActivity,
  multiChainBalances,
  PROBE_TIMEOUT_MS,
  resolveEns,
} from '@/lib/providers/evm/rpc';

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

interface RpcReq {
  id: number;
  method: string;
  params: unknown[];
}

type Handler = (url: string, req: RpcReq) => unknown;

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) } as unknown as Response;
}

const ok = (req: RpcReq, result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
const rpcError = (req: RpcReq, code: number, message: string) => ({ jsonrpc: '2.0', id: req.id, error: { code, message } });
class HttpFailure {
  constructor(public status: number) {}
}

function installFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const req = init?.body ? (JSON.parse(String(init.body)) as RpcReq) : ({ id: 0, method: '', params: [] } as RpcReq);
    const out = await handler(url, req);
    if (out instanceof Error) throw out;
    if (out instanceof HttpFailure) return response({ message: 'boom' }, out.status);
    return response(out);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const pad32 = (addr: string) => `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}`;
const uint = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const encString = (s: string) => encodeAbiParameters([{ type: 'string' }], [s]);
const bytes32String = (s: string) => `0x${Buffer.from(s, 'utf8').toString('hex').padEnd(64, '0')}`;

const ETH = getChain('ethereum');
const BASE = getChain('base');
const ARB = getChain('arbitrum');
const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const MKR = '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2';
const RESOLVER = '0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41';
const TX_HASH = `0x${'ab'.repeat(32)}`;

const chainOf = (url: string) => CHAINS.find((c) => c.rpcUrls.includes(url));

beforeEach(() => {
  useSettings.getState().reset();
  clearEndpointCooldowns();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A fetch that never answers and only rejects once its signal is aborted (timeouts, cancellation). */
function installHangingFetch() {
  const fn = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

/**
 * Batch-aware fetch mock: `handler` answers one request at a time and the mock
 * assembles the array response. Returning `HttpFailure` / `Error` from the
 * handler fails the whole HTTP call; returning `{ single: ... }` replies with
 * that object instead of an array (an endpoint without batch support).
 */
function installBatchFetch(handler: (url: string, req: RpcReq) => unknown) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as RpcReq | RpcReq[];
    const reqs = Array.isArray(body) ? body : [body];
    const outs: unknown[] = [];
    for (const req of reqs) {
      const out = await handler(url, req);
      if (out instanceof Error) throw out;
      if (out instanceof HttpFailure) return response({ message: 'boom' }, out.status);
      if (out && typeof out === 'object' && 'single' in out) return response((out as { single: unknown }).single);
      outs.push(out);
    }
    return response(Array.isArray(body) ? outs : outs[0]);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

// ---------------------------------------------------------------------------

describe('rpc fallback', () => {
  it('falls back to the next endpoint when the first one is unreachable', async () => {
    const fetchMock = installFetch((url, req) => {
      if (url === ETH.rpcUrls[0]) return new TypeError('network down');
      if (url === ETH.rpcUrls[1]) return ok(req, '0x10');
      return new Error(`unexpected url ${url}`);
    });
    await expect(getBlockNumber(ETH)).resolves.toBe(16);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(ETH.rpcUrls[1]);
  });

  it('falls back on HTTP 5xx and on non-deterministic RPC errors', async () => {
    installFetch((url, req) => {
      if (url === ETH.rpcUrls[0]) return new HttpFailure(503);
      if (url === ETH.rpcUrls[1]) return rpcError(req, -32000, 'header not found');
      return ok(req, '0x2a');
    });
    await expect(getBlockNumber(ETH)).resolves.toBe(42);
  });

  it('uses user-configured RPC URLs before the registry defaults', async () => {
    useSettings.getState().set({ customRpc: { ethereum: ['https://my.private.rpc'] } });
    const fetchMock = installFetch((url, req) => (url === 'https://my.private.rpc' ? ok(req, '0x1') : new Error('should not be called')));
    await expect(getBlockNumber(ETH)).resolves.toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry deterministic errors (reverts) on other endpoints', async () => {
    const fetchMock = installFetch((_url, req) => rpcError(req, 3, 'execution reverted'));
    await expect(ethCall(ETH, USDC, '0x06fdde03')).rejects.toBeInstanceOf(RpcError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a 2xx non-JSON-RPC body as a failure and falls back to the next endpoint', async () => {
    const fetchMock = installFetch((url, req) => {
      if (url === ETH.rpcUrls[0]) return '<html>challenge</html>';
      if (url === ETH.rpcUrls[1]) return { message: 'x' };
      if (url === ETH.rpcUrls[2]) return undefined; // empty body
      return ok(req, '0x6080ab');
    });
    await expect(getCode(ETH, USDC)).resolves.toBe('0x6080ab');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(ETH.rpcUrls.slice(0, 4));
  });

  it('throws the last error when every endpoint fails', async () => {
    installFetch(() => new HttpFailure(500));
    await expect(getBlockNumber(ETH)).rejects.toThrow(/HTTP 500/);
  });

  it('honours an already-aborted signal', async () => {
    const fetchMock = installFetch((_url, req) => ok(req, '0x1'));
    const ctrl = new AbortController();
    ctrl.abort(new Error('cancelled'));
    await expect(getBlockNumber(ETH, ctrl.signal)).rejects.toThrow('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('basic queries', () => {
  it('getNativeBalance never throws and sets error on failure', async () => {
    installFetch(() => new HttpFailure(500));
    const b = await getNativeBalance(ETH, OWNER);
    expect(b.balance).toBe(0n);
    expect(b.error).toMatch(/HTTP 500/);
    expect(b.symbol).toBe('ETH');
    expect(b.decimals).toBe(18);
  });

  it('getNativeBalance parses hex wei', async () => {
    installFetch((_url, req) => {
      expect(req.method).toBe('eth_getBalance');
      expect(req.params).toEqual([OWNER, 'latest']);
      return ok(req, '0xde0b6b3a7640000');
    });
    const b = await getNativeBalance(ETH, OWNER);
    expect(b.balance).toBe(10n ** 18n);
    expect(b.error).toBeUndefined();
  });

  it('getCode normalises empty code to 0x', async () => {
    installFetch((_url, req) => ok(req, req.params[0] === OWNER ? '0x' : '0x6080AB'));
    await expect(getCode(ETH, OWNER)).resolves.toBe('0x');
    await expect(getCode(ETH, USDC)).resolves.toBe('0x6080ab');
  });

  it('getTransaction / getTransactionReceipt return null when unknown', async () => {
    installFetch((_url, req) => ok(req, null));
    await expect(getTransaction(ETH, TX_HASH)).resolves.toBeNull();
    await expect(getTransactionReceipt(ETH, TX_HASH)).resolves.toBeNull();
  });

  it('getBlock encodes the block number as a hex quantity', async () => {
    installFetch((_url, req) => {
      expect(req.method).toBe('eth_getBlockByNumber');
      expect(req.params).toEqual(['0x10', false]);
      return ok(req, { number: '0x10', timestamp: '0x65000000', transactions: [] });
    });
    const b = await getBlock(ETH, 16);
    expect(b?.timestamp).toBe('0x65000000');
  });
});

describe('multiChainBalances', () => {
  it('never rejects; failing chains carry an error', async () => {
    installFetch((url, req) => {
      const chain = chainOf(url);
      if (chain?.id === 'base') return new HttpFailure(500);
      return ok(req, '0x5');
    });
    const out = await multiChainBalances([ETH, BASE, ARB], OWNER);
    expect(out.map((b) => b.chain)).toEqual(['ethereum', 'base', 'arbitrum']);
    expect(out[0].balance).toBe(5n);
    expect(out[1].error).toBeDefined();
    expect(out[2].balance).toBe(5n);
  });
});

describe('multiChainActivity', () => {
  it('runs balance + nonce as one JSON-RPC batch per chain and never rejects', async () => {
    const fetchMock = installBatchFetch((url, req) => {
      const chain = chainOf(url);
      if (chain?.id === 'base') return new HttpFailure(500);
      if (req.method === 'eth_getBalance') return ok(req, '0xde0b6b3a7640000');
      if (req.method === 'eth_getTransactionCount') return ok(req, '0x2a');
      return rpcError(req, -32601, 'method not found');
    });
    const out = await multiChainActivity([ETH, BASE, ARB], OWNER);
    expect(out.map((a) => a.chain)).toEqual(['ethereum', 'base', 'arbitrum']);
    expect(out[0]).toEqual({ chain: 'ethereum', balance: { chain: 'ethereum', balance: 10n ** 18n, decimals: 18, symbol: 'ETH' }, txCount: 42 });
    expect(out[1].balance).toBeUndefined();
    expect(out[1].txCount).toBeUndefined();
    expect(out[1].error).toMatch(/HTTP 500/);
    expect(out[2]).toMatchObject({ chain: 'arbitrum', txCount: 42 });
    expect(out[2].balance?.balance).toBe(10n ** 18n);

    // One POST per healthy chain, carrying both calls in request order.
    const ethCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === ETH.rpcUrls[0]);
    expect(ethCalls).toHaveLength(1);
    const body = JSON.parse(String(ethCalls[0][1]?.body)) as RpcReq[];
    expect(body.map((r) => r.method)).toEqual(['eth_getBalance', 'eth_getTransactionCount']);
    expect(body.map((r) => r.params)).toEqual([[OWNER, 'latest'], [OWNER, 'latest']]);
  });

  it('falls back to the next endpoint when one does not support batches, without cooling it down', async () => {
    const fetchMock = installBatchFetch((url, req) => {
      if (url === ETH.rpcUrls[0]) return { single: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch requests are not supported' } } };
      if (req.method === 'eth_getBalance') return ok(req, '0x5');
      return ok(req, '0x1');
    });
    const [eth] = await multiChainActivity([ETH], OWNER);
    expect(eth).toEqual({ chain: 'ethereum', balance: { chain: 'ethereum', balance: 5n, decimals: 18, symbol: 'ETH' }, txCount: 1 });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([ETH.rpcUrls[0], ETH.rpcUrls[1]]);
    expect(isEndpointCooling(ETH.rpcUrls[0])).toBe(false);
  });

  it('treats a null / empty batch body as a missing response, falls back and cools no endpoint down', async () => {
    const fetchMock = installBatchFetch((url, req) => {
      if (url === ETH.rpcUrls[0]) return { single: null };
      if (req.method === 'eth_getBalance') return ok(req, '0x5');
      return ok(req, '0x1');
    });
    const [eth] = await multiChainActivity([ETH], OWNER);
    expect(eth).toEqual({ chain: 'ethereum', balance: { chain: 'ethereum', balance: 5n, decimals: 18, symbol: 'ETH' }, txCount: 1 });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([ETH.rpcUrls[0], ETH.rpcUrls[1]]);
    expect(isEndpointCooling(ETH.rpcUrls[0])).toBe(false);

    // Every endpoint answering null: the RpcError message is reported, nothing crashes, nothing cools down.
    clearEndpointCooldowns();
    installBatchFetch(() => ({ single: null }));
    const [again] = await multiChainActivity([ETH], OWNER);
    expect(again).toEqual({ chain: 'ethereum', error: 'missing batch response' });
    for (const u of ETH.rpcUrls) expect(isEndpointCooling(u)).toBe(false);
  });

  it('keeps a partial answer and explains the missing half', async () => {
    installBatchFetch((_url, req) => (req.method === 'eth_getBalance' ? ok(req, '0x7') : rpcError(req, -32000, 'nonce unavailable')));
    const [eth] = await multiChainActivity([ETH], OWNER);
    expect(eth.balance?.balance).toBe(7n);
    expect(eth.txCount).toBeUndefined();
    expect(eth.error).toMatch(/eth_getTransactionCount: nonce unavailable/);
  });

  it('reports the last error when every endpoint fails', async () => {
    installBatchFetch(() => new TypeError('network down'));
    const [eth] = await multiChainActivity([ETH], OWNER);
    expect(eth).toEqual({ chain: 'ethereum', error: 'network down' });
    for (const u of ETH.rpcUrls) expect(isEndpointCooling(u)).toBe(true);
  });

  it('gives up on an endpoint after PROBE_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    expect(PROBE_TIMEOUT_MS).toBe(6_000);
    const fetchMock = installHangingFetch();
    const p = multiChainActivity([ETH], OWNER);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS * ETH.rpcUrls.length + 10);
    const [eth] = await p;
    expect(eth.error).toMatch(/timeout after 6000ms/);
    expect(fetchMock).toHaveBeenCalledTimes(ETH.rpcUrls.length);
  });
});

describe('probe timeouts', () => {
  it('multiChainBalances times out each request after PROBE_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    installHangingFetch();
    const p = multiChainBalances([ETH], OWNER);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS * ETH.rpcUrls.length + 10);
    const [eth] = await p;
    expect(eth.balance).toBe(0n);
    expect(eth.error).toMatch(/timeout after 6000ms/);
  });

  it('findTxChain resolves null once every probe has timed out', async () => {
    vi.useFakeTimers();
    installHangingFetch();
    const p = findTxChain([ETH], TX_HASH);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS * ETH.rpcUrls.length + 10);
    await expect(p).resolves.toBeNull();
  });

  it('getNativeBalance keeps the longer default timeout', async () => {
    vi.useFakeTimers();
    installHangingFetch();
    let settled = false;
    const p = getNativeBalance(ETH, OWNER).then((b) => {
      settled = true;
      return b;
    });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS * ETH.rpcUrls.length + 10);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(12_000 * ETH.rpcUrls.length);
    const b = await p;
    expect(b.error).toMatch(/timeout after 12000ms/);
  });
});

describe('endpoint cooldown in rpcCall', () => {
  it('skips an endpoint that just failed and tries it again only as a last resort', async () => {
    const fetchMock = installFetch((url, req) => (url === ETH.rpcUrls[0] ? new HttpFailure(503) : ok(req, '0x1')));
    await expect(getBlockNumber(ETH)).resolves.toBe(1);
    expect(isEndpointCooling(ETH.rpcUrls[0])).toBe(true);
    fetchMock.mockClear();
    await expect(getBlockNumber(ETH)).resolves.toBe(1);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([ETH.rpcUrls[1]]);
  });

  it('maxUrls counts healthy endpoints only', async () => {
    // First call: endpoint 0 answers 503 and goes into cooldown.
    installFetch((url, req) => (url === ETH.rpcUrls[0] ? new HttpFailure(503) : ok(req, '0x1')));
    await expect(getBlockNumber(ETH)).resolves.toBe(1);
    expect(isEndpointCooling(ETH.rpcUrls[0])).toBe(true);

    // A 2-endpoint budget now goes to the first two healthy endpoints, not to the cooling one.
    const fetchMock = installFetch((_url, req) => rpcError(req, -32005, 'query exceeds max block range'));
    await expect(getLogs(ETH, { fromBlock: 0, toBlock: 10 }, undefined, { maxUrls: 2 })).rejects.toThrow(/max block range/);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([ETH.rpcUrls[1], ETH.rpcUrls[2]]);
  });
});

describe('findTxChain', () => {
  it('returns the first chain that knows the hash and treats RPC failures as not found', async () => {
    installFetch((url, req) => {
      const chain = chainOf(url);
      if (chain?.id === 'ethereum') return new HttpFailure(500);
      if (chain?.id === 'base') return ok(req, { hash: TX_HASH, from: OWNER, to: OTHER, value: '0x0', input: '0x', nonce: '0x1', gas: '0x5208', blockNumber: '0x1', blockHash: '0x', transactionIndex: '0x0' });
      return ok(req, null);
    });
    const hit = await findTxChain([ETH, BASE, ARB], TX_HASH);
    expect(hit?.id).toBe('base');
  });

  it('resolves null when no chain knows the hash', async () => {
    installFetch((_url, req) => ok(req, null));
    await expect(findTxChain([ETH, BASE, ARB], TX_HASH)).resolves.toBeNull();
  });

  it('resolves null for an empty chain list without touching the network', async () => {
    const fetchMock = installFetch((_url, req) => ok(req, null));
    await expect(findTxChain([], TX_HASH)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ENS', () => {
  const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

  function ensHandler(opts: { addr?: string; name?: string } = {}) {
    const calls: { to: string; data: string }[] = [];
    installFetch((_url, req) => {
      if (req.method !== 'eth_call') return ok(req, null);
      const { to, data } = req.params[0] as { to: string; data: string };
      calls.push({ to, data });
      const sel = data.slice(0, 10);
      if (to.toLowerCase() === ENS_REGISTRY.toLowerCase() && sel === toFunctionSelector('resolver(bytes32)')) return ok(req, pad32(RESOLVER));
      if (to.toLowerCase() === RESOLVER.toLowerCase() && sel === toFunctionSelector('addr(bytes32)')) return ok(req, pad32(opts.addr ?? VITALIK));
      if (to.toLowerCase() === RESOLVER.toLowerCase() && sel === toFunctionSelector('name(bytes32)')) return ok(req, encString(opts.name ?? 'vitalik.eth'));
      return ok(req, '0x');
    });
    return calls;
  }

  it('resolves a name through registry.resolver(bytes32) and resolver.addr(bytes32)', async () => {
    const calls = ensHandler();
    await expect(resolveEns('Vitalik.eth')).resolves.toBe(VITALIK);
    const node = namehash('vitalik.eth').slice(2);
    expect(calls[0].to).toBe(ENS_REGISTRY);
    expect(calls[0].data).toBe(`0x0178b8bf${node}`);
    expect(calls[1].to).toBe(RESOLVER);
    expect(calls[1].data).toBe(`0x3b3b57de${node}`);
  });

  it('returns null when no resolver is set', async () => {
    installFetch((_url, req) => ok(req, pad32('0x0000000000000000000000000000000000000000')));
    await expect(resolveEns('nobody.eth')).resolves.toBeNull();
  });

  it('reverse-resolves via <addr>.addr.reverse name(bytes32) and verifies forward', async () => {
    const calls = ensHandler();
    await expect(lookupEnsName(VITALIK)).resolves.toBe('vitalik.eth');
    const reverseNode = namehash(`${VITALIK.slice(2).toLowerCase()}.addr.reverse`).slice(2);
    expect(calls[0].data).toBe(`0x0178b8bf${reverseNode}`);
    expect(calls[1].data).toBe(`0x691f3431${reverseNode}`);
  });

  it('rejects a reverse record whose forward resolution points elsewhere', async () => {
    ensHandler({ addr: OTHER });
    await expect(lookupEnsName(VITALIK)).resolves.toBeNull();
  });
});

describe('erc20Meta', () => {
  it('decodes ABI strings and decimals', async () => {
    installFetch((_url, req) => {
      const { data } = req.params[0] as { data: string };
      if (data.startsWith('0x06fdde03')) return ok(req, encString('USD Coin'));
      if (data.startsWith('0x95d89b41')) return ok(req, encString('USDC'));
      if (data.startsWith('0x313ce567')) return ok(req, uint(6n));
      return ok(req, '0x');
    });
    const meta = await erc20Meta(ETH, USDC.toLowerCase());
    expect(meta).toEqual({ chain: 'ethereum', address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: 6, type: 'ERC-20' });
  });

  it('tolerates bytes32 name/symbol (MKR style)', async () => {
    installFetch((_url, req) => {
      const { data } = req.params[0] as { data: string };
      if (data.startsWith('0x06fdde03')) return ok(req, bytes32String('Maker'));
      if (data.startsWith('0x95d89b41')) return ok(req, bytes32String('MKR'));
      if (data.startsWith('0x313ce567')) return ok(req, uint(18n));
      return ok(req, '0x');
    });
    const meta = await erc20Meta(ETH, MKR);
    expect(meta.name).toBe('Maker');
    expect(meta.symbol).toBe('MKR');
    expect(meta.decimals).toBe(18);
  });

  it('tolerates a missing decimals() (reverts) and marks the type unknown', async () => {
    installFetch((_url, req) => {
      const { data } = req.params[0] as { data: string };
      if (data.startsWith('0x06fdde03')) return ok(req, encString('Bored Apes'));
      if (data.startsWith('0x95d89b41')) return ok(req, encString('BAYC'));
      return rpcError(req, 3, 'execution reverted');
    });
    const meta = await erc20Meta(ETH, OTHER);
    expect(meta.decimals).toBe(0);
    expect(meta.type).toBe('unknown');
    expect(meta.symbol).toBe('BAYC');
  });

  it('falls back to a shortened address when nothing decodes', async () => {
    installFetch((_url, req) => ok(req, '0x'));
    const meta = await erc20Meta(ETH, OTHER);
    expect(meta.name).toBe('Unknown token');
    expect(meta.symbol).toBe('0x2222…2222');
  });

  it('propagates network failures instead of inventing metadata', async () => {
    installFetch(() => new HttpFailure(500));
    await expect(erc20Meta(ETH, USDC)).rejects.toThrow(/HTTP 500/);
  });

  it('propagates transient RPC errors (rate limits) instead of returning decimals 0', async () => {
    installFetch((_url, req) => rpcError(req, -32005, 'rate limited'));
    await expect(erc20Meta(ETH, USDC)).rejects.toThrow(/rate limited/);
    installFetch((_url, req) => rpcError(req, -32000, 'missing trie node'));
    await expect(erc20Meta(ETH, USDC)).rejects.toThrow(/missing trie node/);
  });

  it('decodeStringResult handles both encodings', () => {
    expect(decodeStringResult(encString('Hello'))).toBe('Hello');
    expect(decodeStringResult(bytes32String('MKR'))).toBe('MKR');
    expect(decodeStringResult('0x')).toBeUndefined();
  });
});

describe('erc20Balance', () => {
  it('encodes balanceOf(owner) and decodes the uint256', async () => {
    installFetch((_url, req) => {
      const { to, data } = req.params[0] as { to: string; data: string };
      expect(to).toBe(USDC);
      expect(data).toBe(`0x70a08231${pad32(OWNER).slice(2)}`);
      return ok(req, uint(123456n));
    });
    await expect(erc20Balance(ETH, USDC, OWNER)).resolves.toBe(123456n);
  });

  it('treats an empty return (non-contract) as zero', async () => {
    installFetch((_url, req) => ok(req, '0x'));
    await expect(erc20Balance(ETH, OTHER, OWNER)).resolves.toBe(0n);
  });
});
