/**
 * Thin JSON-RPC layer for EVM chains.
 *
 * Every call goes through `jsonRpc` + `withFallback` over the ordered endpoint
 * list from Settings (`rpcUrlsFor`). viem is used only for pure utilities
 * (ABI encoding, namehash, checksums), never for transports.
 */
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  hexToBigInt,
  hexToNumber,
  hexToString,
  isAddress,
  namehash,
  parseAbi,
  toHex,
  type Hex,
} from 'viem';
import { normalize } from 'viem/ens';
import type { ChainInfo, NativeBalance, TokenInfo } from '@/lib/types';
import { jsonRpc, mapLimit, withFallback, RpcError } from '@/lib/http';
import { rpcUrlsFor } from '@/lib/settings/store';
import { getChain } from '@/lib/chains/registry';
import { shorten } from '@/lib/format';

// ---------------------------------------------------------------------------
// Raw node shapes (hex-string encoded, exactly as returned by the JSON-RPC)
// ---------------------------------------------------------------------------

export interface RawEvmLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash?: string;
  transactionHash: string;
  transactionIndex?: string;
  logIndex: string;
  removed?: boolean;
}

export interface RawEvmTx {
  hash: string;
  nonce: string;
  blockHash: string | null;
  blockNumber: string | null;
  transactionIndex: string | null;
  from: string;
  to: string | null;
  value: string;
  gas: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  input: string;
  type?: string;
  chainId?: string;
  v?: string;
  r?: string;
  s?: string;
  accessList?: unknown[];
}

export interface RawEvmReceipt {
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  blockNumber: string;
  from: string;
  to: string | null;
  cumulativeGasUsed: string;
  gasUsed: string;
  effectiveGasPrice?: string;
  contractAddress: string | null;
  logs: RawEvmLog[];
  logsBloom?: string;
  /** '0x1' success, '0x0' failure; absent on pre-Byzantium receipts. */
  status?: string | null;
  type?: string;
  root?: string;
  /** OP-stack / Arbitrum L1 data fee, when the node reports it. */
  l1Fee?: string;
  l1GasUsed?: string;
  l1GasPrice?: string;
}

export interface RawEvmBlock {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
  miner?: string;
  gasLimit: string;
  gasUsed: string;
  baseFeePerGas?: string;
  size?: string;
  /** Hashes (when fetched with `false`) or full objects. */
  transactions: (string | RawEvmTx)[];
  extraData?: string;
  nonce?: string;
  difficulty?: string;
}

// ---------------------------------------------------------------------------
// Core call plumbing
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 12_000;

export interface RpcCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Only try the first N endpoints (bounds fan-out for expensive calls like eth_getLogs). */
  maxUrls?: number;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Errors that are a property of the request rather than of the endpoint
 * (reverts, invalid params): retrying them on another RPC is pointless and
 * would only multiply traffic.
 */
function isDeterministicRpcError(err: unknown): boolean {
  if (!(err instanceof RpcError)) return false;
  if (err.code === 3 || err.code === -32602) return true;
  return /revert|invalid opcode|invalid jump|out of gas|execution error/i.test(err.message);
}

export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** One JSON-RPC call with ordered endpoint fallback. */
export async function rpcCall<T>(chain: ChainInfo, method: string, params: unknown[] = [], opts: RpcCallOptions = {}): Promise<T> {
  let urls = rpcUrlsFor(chain);
  if (opts.maxUrls !== undefined) urls = urls.slice(0, Math.max(1, opts.maxUrls));
  const outcome = await withFallback<Outcome<T>>(
    urls,
    async (url) => {
      try {
        const value = await jsonRpc<T>(url, method, params, { signal: opts.signal, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
        return { ok: true, value };
      } catch (err) {
        if (isDeterministicRpcError(err)) return { ok: false, error: err };
        throw err;
      }
    },
    { signal: opts.signal },
  );
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function asHex(s: string): Hex {
  return (s.startsWith('0x') ? s : `0x${s}`) as Hex;
}

/** Tolerant hex quantity → bigint ('0x', null and undefined become 0n). */
export function hexToBigIntSafe(s: string | null | undefined): bigint {
  if (!s || s === '0x') return 0n;
  try {
    return hexToBigInt(asHex(s));
  } catch {
    return 0n;
  }
}

export function hexToNumberSafe(s: string | null | undefined): number | undefined {
  if (!s || s === '0x') return undefined;
  try {
    return hexToNumber(asHex(s));
  } catch {
    return undefined;
  }
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function isZeroAddress(a: string | undefined): boolean {
  return !a || a.toLowerCase() === ZERO_ADDRESS;
}

function checksum(a: string): string {
  try {
    return getAddress(a);
  } catch {
    return a;
  }
}

// ---------------------------------------------------------------------------
// Basic node queries
// ---------------------------------------------------------------------------

export async function getBlockNumber(chain: ChainInfo, signal?: AbortSignal): Promise<number> {
  const hex = await rpcCall<string>(chain, 'eth_blockNumber', [], { signal });
  const n = hexToNumberSafe(hex);
  if (n === undefined) throw new Error(`Invalid eth_blockNumber response from ${chain.name}`);
  return n;
}

/** Native balance; never throws — RPC failures are reported through `error`. */
export async function getNativeBalance(chain: ChainInfo, address: string, signal?: AbortSignal): Promise<NativeBalance> {
  const base: NativeBalance = { chain: chain.id, balance: 0n, decimals: chain.native.decimals, symbol: chain.native.symbol };
  try {
    const hex = await rpcCall<string>(chain, 'eth_getBalance', [address, 'latest'], { signal });
    if (typeof hex !== 'string') throw new Error('Malformed eth_getBalance response');
    return { ...base, balance: hexToBigIntSafe(hex) };
  } catch (err) {
    return { ...base, error: errorMessage(err) };
  }
}

/** Deployed bytecode; `'0x'` for an EOA. */
export async function getCode(chain: ChainInfo, address: string, signal?: AbortSignal): Promise<string> {
  const code = await rpcCall<string | null>(chain, 'eth_getCode', [address, 'latest'], { signal });
  if (!code || code === '0x0') return '0x';
  return code.toLowerCase();
}

export async function getTransactionCount(chain: ChainInfo, address: string, signal?: AbortSignal): Promise<number> {
  const hex = await rpcCall<string>(chain, 'eth_getTransactionCount', [address, 'latest'], { signal });
  return hexToNumberSafe(hex) ?? 0;
}

export async function getTransaction(chain: ChainInfo, hash: string, signal?: AbortSignal): Promise<RawEvmTx | null> {
  const tx = await rpcCall<RawEvmTx | null>(chain, 'eth_getTransactionByHash', [hash], { signal });
  return tx && typeof tx === 'object' && typeof tx.hash === 'string' ? tx : null;
}

export async function getTransactionReceipt(chain: ChainInfo, hash: string, signal?: AbortSignal): Promise<RawEvmReceipt | null> {
  const r = await rpcCall<RawEvmReceipt | null>(chain, 'eth_getTransactionReceipt', [hash], { signal });
  if (!r || typeof r !== 'object') return null;
  return { ...r, logs: Array.isArray(r.logs) ? r.logs : [] };
}

export async function getBlock(chain: ChainInfo, numberOrTag: number | 'latest', signal?: AbortSignal): Promise<RawEvmBlock | null> {
  const tag = typeof numberOrTag === 'number' ? toHex(numberOrTag) : numberOrTag;
  const b = await rpcCall<RawEvmBlock | null>(chain, 'eth_getBlockByNumber', [tag, false], { signal });
  return b && typeof b === 'object' ? b : null;
}

export async function getStorageAt(chain: ChainInfo, address: string, slot: string, signal?: AbortSignal): Promise<string> {
  const v = await rpcCall<string | null>(chain, 'eth_getStorageAt', [address, slot, 'latest'], { signal });
  return v ?? '0x';
}

export async function ethCall(chain: ChainInfo, to: string, data: string, signal?: AbortSignal): Promise<string> {
  const out = await rpcCall<string | null>(chain, 'eth_call', [{ to, data }, 'latest'], { signal });
  return out ?? '0x';
}

export interface LogFilter {
  fromBlock: number | 'latest';
  toBlock: number | 'latest';
  address?: string | string[];
  topics?: (string | string[] | null)[];
}

/** eth_getLogs over a block range. Public RPCs cap the range; callers chunk as needed. */
export async function getLogs(chain: ChainInfo, filter: LogFilter, signal?: AbortSignal, opts: Omit<RpcCallOptions, 'signal'> = {}): Promise<RawEvmLog[]> {
  const param = {
    fromBlock: typeof filter.fromBlock === 'number' ? toHex(filter.fromBlock) : filter.fromBlock,
    toBlock: typeof filter.toBlock === 'number' ? toHex(filter.toBlock) : filter.toBlock,
    ...(filter.address ? { address: filter.address } : {}),
    ...(filter.topics ? { topics: filter.topics } : {}),
  };
  const logs = await rpcCall<RawEvmLog[] | null>(chain, 'eth_getLogs', [param], { signal, timeoutMs: opts.timeoutMs ?? 25_000, maxUrls: opts.maxUrls });
  return Array.isArray(logs) ? logs : [];
}

// ---------------------------------------------------------------------------
// ENS (Ethereum mainnet only)
// ---------------------------------------------------------------------------

export const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';

const ENS_REGISTRY_ABI = parseAbi(['function resolver(bytes32 node) view returns (address)']);
const ENS_RESOLVER_ABI = parseAbi([
  'function addr(bytes32 node) view returns (address)',
  'function name(bytes32 node) view returns (string)',
]);

function mainnet(): ChainInfo {
  return getChain('ethereum');
}

/** Resolver contract registered for `node`, or null when unset. */
async function ensResolverFor(node: Hex, signal?: AbortSignal): Promise<string | null> {
  const data = encodeFunctionData({ abi: ENS_REGISTRY_ABI, functionName: 'resolver', args: [node] });
  const out = await ethCall(mainnet(), ENS_REGISTRY, data, signal);
  if (!out || out === '0x') return null;
  try {
    const resolver = decodeFunctionResult({ abi: ENS_REGISTRY_ABI, functionName: 'resolver', data: asHex(out) });
    return isZeroAddress(resolver) ? null : resolver;
  } catch {
    return null;
  }
}

/** Run a resolver call; a reverting resolver counts as "no record", network errors propagate. */
async function resolverCall(resolver: string, data: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const out = await ethCall(mainnet(), resolver, data, signal);
    return out && out !== '0x' ? out : null;
  } catch (err) {
    if (err instanceof RpcError) return null;
    throw err;
  }
}

/**
 * Forward-resolve an ENS name on Ethereum mainnet through the registry →
 * resolver → `addr(bytes32)` path. Off-chain (CCIP-read) names are not
 * supported by a plain `eth_call` and resolve to null.
 */
export async function resolveEns(name: string, signal?: AbortSignal): Promise<string | null> {
  let normalized: string;
  try {
    normalized = normalize(name.trim());
  } catch {
    return null;
  }
  if (!normalized) return null;
  const node = namehash(normalized);
  const resolver = await ensResolverFor(node, signal);
  if (!resolver) return null;
  const data = encodeFunctionData({ abi: ENS_RESOLVER_ABI, functionName: 'addr', args: [node] });
  const out = await resolverCall(resolver, data, signal);
  if (!out) return null;
  try {
    const addr = decodeFunctionResult({ abi: ENS_RESOLVER_ABI, functionName: 'addr', data: asHex(out) });
    return isZeroAddress(addr) ? null : getAddress(addr);
  } catch {
    return null;
  }
}

/**
 * Reverse lookup (`<addr>.addr.reverse` → `name(bytes32)`), verified by a
 * forward resolution so a spoofed reverse record is never shown.
 */
export async function lookupEnsName(address: string, signal?: AbortSignal): Promise<string | null> {
  if (!isAddress(address)) return null;
  const node = namehash(`${address.toLowerCase().slice(2)}.addr.reverse`);
  const resolver = await ensResolverFor(node, signal);
  if (!resolver) return null;
  const data = encodeFunctionData({ abi: ENS_RESOLVER_ABI, functionName: 'name', args: [node] });
  const out = await resolverCall(resolver, data, signal);
  if (!out) return null;
  let name: string;
  try {
    name = decodeFunctionResult({ abi: ENS_RESOLVER_ABI, functionName: 'name', data: asHex(out) });
  } catch {
    return null;
  }
  if (!name) return null;
  const forward = await resolveEns(name, signal);
  return forward && forward.toLowerCase() === address.toLowerCase() ? name : null;
}

// ---------------------------------------------------------------------------
// Multi-chain helpers
// ---------------------------------------------------------------------------

/** Native balances across chains (6 in flight). Never rejects; failures set `error`. */
export async function multiChainBalances(chains: ChainInfo[], address: string, signal?: AbortSignal): Promise<NativeBalance[]> {
  return mapLimit(chains, 6, async (chain) => {
    try {
      return await getNativeBalance(chain, address, signal);
    } catch (err) {
      return { chain: chain.id, balance: 0n, decimals: chain.native.decimals, symbol: chain.native.symbol, error: errorMessage(err) };
    }
  });
}

/**
 * Probe every chain with eth_getTransactionByHash (8 in flight) and resolve
 * with the first chain that knows the hash. RPC failures count as "not found"
 * for that chain; remaining probes are cancelled once a hit is found.
 */
export function findTxChain(chains: ChainInfo[], hash: string, signal?: AbortSignal): Promise<ChainInfo | null> {
  return new Promise<ChainInfo | null>((resolve, reject) => {
    if (chains.length === 0) return resolve(null);
    const ctrl = new AbortController();
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      ctrl.abort(signal?.reason);
      reject(signal?.reason ?? new Error('aborted'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (chain: ChainInfo | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      ctrl.abort(new Error('findTxChain: resolved'));
      resolve(chain);
    };
    void mapLimit(chains, 8, async (chain) => {
      if (settled) return;
      try {
        const tx = await getTransaction(chain, hash, ctrl.signal);
        if (tx) finish(chain);
      } catch {
        /* unreachable RPC or malformed reply: treat as not found on this chain */
      }
    }).then(() => finish(null));
  });
}

// ---------------------------------------------------------------------------
// ERC-20 helpers
// ---------------------------------------------------------------------------

const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
]);

const MAX_META_LENGTH = 64;

function cleanLabel(s: string): string | undefined {
  // Strip control characters and trim; some scam tokens stuff junk in names.
  const cleaned = s.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) return undefined;
  return cleaned.length > MAX_META_LENGTH ? `${cleaned.slice(0, MAX_META_LENGTH - 1)}…` : cleaned;
}

/** Decode a `string` return value, tolerating tokens that return `bytes32` (e.g. MKR). */
export function decodeStringResult(out: string | undefined): string | undefined {
  if (!out || out === '0x') return undefined;
  const hex = asHex(out);
  try {
    const s = decodeFunctionResult({ abi: ERC20_ABI, functionName: 'name', data: hex });
    if (typeof s === 'string') return cleanLabel(s);
  } catch {
    /* not ABI-encoded string; try bytes32 */
  }
  if (hex.length === 66) {
    try {
      return cleanLabel(hexToString(hex).replace(/\0+$/, ''));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * name/symbol/decimals through eth_call. Reverting or absent functions are
 * tolerated (bytes32 names, missing decimals); network failures propagate.
 */
export async function erc20Meta(chain: ChainInfo, token: string, signal?: AbortSignal): Promise<TokenInfo> {
  const call = async (functionName: 'name' | 'symbol' | 'decimals'): Promise<string | undefined> => {
    try {
      return await ethCall(chain, token, encodeFunctionData({ abi: ERC20_ABI, functionName }), signal);
    } catch (err) {
      if (err instanceof RpcError && !isAbortError(err, signal)) return undefined;
      throw err;
    }
  };
  const [nameOut, symbolOut, decimalsOut] = await Promise.all([call('name'), call('symbol'), call('decimals')]);
  const name = decodeStringResult(nameOut);
  const symbol = decodeStringResult(symbolOut);
  let decimals: number | undefined;
  if (decimalsOut && decimalsOut !== '0x') {
    const d = hexToBigIntSafe(decimalsOut);
    if (d <= 255n) decimals = Number(d);
  }
  return {
    chain: chain.id,
    address: checksum(token),
    name: name ?? symbol ?? 'Unknown token',
    symbol: symbol ?? name?.slice(0, 11) ?? shorten(token),
    decimals: decimals ?? 0,
    type: decimals === undefined ? 'unknown' : 'ERC-20',
  };
}

export async function erc20Balance(chain: ChainInfo, token: string, owner: string, signal?: AbortSignal): Promise<bigint> {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [getAddress(owner)] });
  const out = await ethCall(chain, token, data, signal);
  return hexToBigIntSafe(out);
}
