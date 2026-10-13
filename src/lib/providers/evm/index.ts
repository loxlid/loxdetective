/**
 * EVM provider façade used by the UI.
 *
 * Composes the raw RPC layer with Blockscout / Etherscan where available and
 * degrades gracefully: explorer failures never hide RPC data, and only an
 * unreachable RPC makes the "summary" style calls throw.
 */
import { maxUint256 } from 'viem';
import type { AddressSummary, ApprovalInfo, ApprovalScan, ChainInfo, ContractInfo, PagedResult, TokenBalance, TokenInfo, Transaction, TxListItem } from '@/lib/types';
import { mapLimit } from '@/lib/http';
import {
  erc20Balance,
  erc20Meta,
  ethCall,
  getBlock,
  getBlockNumber,
  getCode,
  getLogs,
  getNativeBalance,
  getStorageAt,
  getTransaction,
  getTransactionCount,
  getTransactionReceipt,
  hexToBigIntSafe,
  hexToNumberSafe,
  isAbortError,
  lookupEnsName,
  type RawEvmLog,
} from './rpc';
import {
  TOPIC_APPROVAL,
  TOPIC_APPROVAL_FOR_ALL,
  TRANSFER_TOPICS,
  WELL_KNOWN_SELECTORS,
  decodeKnownEvents,
  decodeTransfersFromLogs,
  detectProxy,
  lookupSelector,
  selectorOf,
  topicToAddress,
} from './decode';
import * as blockscout from './blockscout';
import * as etherscan from './etherscan';

export { findTxChain, multiChainActivity, multiChainBalances, resolveEns, lookupEnsName, PROBE_TIMEOUT_MS } from './rpc';
export { hasBlockscout } from './blockscout';
export { hasEtherscan } from './etherscan';

// ---------------------------------------------------------------------------
// Token metadata cache (per chain + address, process lifetime)
// ---------------------------------------------------------------------------

const tokenMetaCache = new Map<string, TokenInfo>();

function metaKey(chain: ChainInfo, address: string): string {
  return `${chain.id}:${address.toLowerCase()}`;
}

export function getCachedTokenMeta(chain: ChainInfo, address: string): TokenInfo | undefined {
  return tokenMetaCache.get(metaKey(chain, address));
}

export function rememberTokenMeta(token: TokenInfo): void {
  tokenMetaCache.set(`${token.chain}:${token.address.toLowerCase()}`, token);
}

export function clearTokenMetaCache(): void {
  tokenMetaCache.clear();
}

/** Resolve metadata for `addresses` via cache → RPC `erc20Meta`; RPC failures leave the entry unresolved. */
async function resolveTokenMeta(chain: ChainInfo, addresses: string[], signal?: AbortSignal): Promise<void> {
  const missing = Array.from(new Set(addresses.map((a) => a.toLowerCase()))).filter((a) => !tokenMetaCache.has(`${chain.id}:${a}`));
  await mapLimit(missing.slice(0, 25), 4, async (addr) => {
    try {
      rememberTokenMeta(await erc20Meta(chain, addr, signal));
    } catch (err) {
      if (isAbortError(err, signal)) throw err;
      /* leave unresolved; decoders fall back to a shortened address */
    }
  });
}

/** Swallow non-abort failures from optional data sources. */
async function optional<T>(p: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  try {
    return await p;
  } catch (err) {
    if (isAbortError(err, signal)) throw err;
    return undefined;
  }
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

// ---------------------------------------------------------------------------
// Address summary
// ---------------------------------------------------------------------------

/**
 * RPC balance + code + nonce, ENS reverse on Ethereum, Blockscout address
 * info/counters when available. Only `eth_getCode` failing makes this throw.
 */
export async function getAddressSummary(chain: ChainInfo, address: string, signal?: AbortSignal): Promise<AddressSummary> {
  const bs = blockscout.hasBlockscout(chain);
  const [nativeBalance, code, nonce, ensReverse, info, counters] = await Promise.all([
    getNativeBalance(chain, address, signal),
    getCode(chain, address, signal),
    optional(getTransactionCount(chain, address, signal), signal),
    chain.id === 'ethereum' ? optional(lookupEnsName(address, signal), signal) : undefined,
    bs ? optional(blockscout.addressInfo(chain, address, signal), signal) : undefined,
    bs ? optional(blockscout.addressCounters(chain, address, signal), signal) : undefined,
  ]);

  const isContract = code !== '0x' || !!info?.isContract;
  const summary: AddressSummary = {
    chain: chain.id,
    address,
    isContract,
    nativeBalance,
    txCount: counters?.txCount ?? (isContract ? undefined : nonce),
    ensName: ensReverse ?? info?.ensName,
  };
  if (isContract) {
    summary.contract = {
      verified: !!info?.isVerified,
      name: info?.name,
      creator: info?.creatorAddress,
      creationTx: info?.creationTx,
      implementation: info?.implementation,
      isToken: !!info?.token,
      token: info?.token,
    };
    if (info?.token) rememberTokenMeta(info.token);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export type HistoryKind = 'tx' | 'token' | 'internal';

function noHistoryError(chain: ChainInfo): Error {
  return new Error(`No history provider for ${chain.name}; add an Etherscan API key in Settings`);
}

function isBlockscoutCursor(cursor: string | undefined): boolean {
  return !!cursor && cursor.trim().startsWith('{');
}

/**
 * Paged history: Blockscout first, then Etherscan/Routescan. A cursor is
 * provider-specific, so later pages stay on the provider that served page 1.
 */
export async function getAddressHistory(
  chain: ChainInfo,
  address: string,
  opts: { cursor?: string; kind: HistoryKind },
  signal?: AbortSignal,
): Promise<PagedResult<TxListItem>> {
  const { cursor, kind } = opts;
  const bsOk = blockscout.hasBlockscout(chain);
  const esOk = etherscan.hasEtherscan(chain);
  const bsFn = kind === 'tx' ? blockscout.addressTransactions : kind === 'token' ? blockscout.addressTokenTransfers : blockscout.addressInternalTxs;
  const esFn = kind === 'tx' ? etherscan.addressTransactions : kind === 'token' ? etherscan.addressTokenTransfers : etherscan.addressInternalTxs;

  if (cursor) {
    if (isBlockscoutCursor(cursor)) {
      if (!bsOk) throw new Error(`Blockscout not available for ${chain.name}`);
      return bsFn(chain, address, cursor, signal);
    }
    if (!esOk) throw noHistoryError(chain);
    return esFn(chain, address, cursor, signal);
  }

  if (bsOk) {
    try {
      return await bsFn(chain, address, undefined, signal);
    } catch (err) {
      if (isAbortError(err, signal) || !esOk) throw err;
      console.warn(`[evm] Blockscout history failed for ${chain.id}, falling back to Etherscan:`, err instanceof Error ? err.message : err);
    }
  }
  if (esOk) return esFn(chain, address, undefined, signal);
  throw noHistoryError(chain);
}

// ---------------------------------------------------------------------------
// Token balances
// ---------------------------------------------------------------------------

const MAX_DERIVED_TOKENS = 25;

/**
 * Blockscout token list when available; otherwise the tokens seen in recent
 * Etherscan token transfers, re-queried via `balanceOf` on the RPC.
 */
export async function getTokenBalances(chain: ChainInfo, address: string, signal?: AbortSignal): Promise<TokenBalance[]> {
  if (blockscout.hasBlockscout(chain)) {
    const balances = await blockscout.addressTokenBalances(chain, address, signal);
    for (const b of balances) rememberTokenMeta(b.token);
    return balances;
  }
  if (!etherscan.hasEtherscan(chain)) {
    throw new Error(`No token balance provider for ${chain.name}; add an Etherscan API key in Settings`);
  }
  const page = await etherscan.addressTokenTransfers(chain, address, undefined, signal);
  interface SeenToken {
    address: string;
    symbol: string;
    decimals: number;
  }
  const seen = new Map<string, SeenToken>();
  for (const item of page.items) {
    const t = item.token;
    if (!t?.tokenAddress || t.kind !== 'ERC-20') continue;
    const k = t.tokenAddress.toLowerCase();
    if (!seen.has(k)) seen.set(k, { address: t.tokenAddress, symbol: t.symbol, decimals: t.amount.decimals });
  }
  const tokens = Array.from(seen.values()).slice(0, MAX_DERIVED_TOKENS);
  const out = await mapLimit(tokens, 4, async (t): Promise<TokenBalance | undefined> => {
    try {
      const balance = await erc20Balance(chain, t.address, address, signal);
      if (balance === 0n) return undefined;
      let token = getCachedTokenMeta(chain, t.address);
      if (!token) {
        token = { chain: chain.id, address: t.address, name: t.symbol, symbol: t.symbol, decimals: t.decimals, type: 'ERC-20' };
        rememberTokenMeta(token);
      }
      return { token, balance };
    } catch (err) {
      if (isAbortError(err, signal)) throw err;
      return undefined;
    }
  });
  return out.filter((b): b is TokenBalance => b !== undefined);
}

// ---------------------------------------------------------------------------
// Full transaction
// ---------------------------------------------------------------------------

const BLOCK_TS_CACHE = new Map<string, number>();

async function blockTimestamp(chain: ChainInfo, blockNumber: number, signal?: AbortSignal): Promise<number | undefined> {
  const key = `${chain.id}:${blockNumber}`;
  const cached = BLOCK_TS_CACHE.get(key);
  if (cached !== undefined) return cached;
  const block = await optional(getBlock(chain, blockNumber, signal), signal);
  const ts = hexToNumberSafe(block?.timestamp);
  if (ts !== undefined) BLOCK_TS_CACHE.set(key, ts);
  return ts;
}

/**
 * RPC tx + receipt + block, logs decoded into transfers/events, method name
 * via the built-in selector table → Blockscout → signature databases, and
 * internal calls / token metadata from Blockscout when available.
 */
export async function getTransactionFull(chain: ChainInfo, hash: string, signal?: AbortSignal): Promise<Transaction> {
  const tx = await getTransaction(chain, hash, signal);
  if (!tx) throw new Error(`Transaction ${hash} not found on ${chain.name}`);
  const receipt = await getTransactionReceipt(chain, hash, signal);
  const bs = blockscout.hasBlockscout(chain);
  const blockNumber = hexToNumberSafe(receipt?.blockNumber ?? tx.blockNumber ?? undefined);

  const [blockTs, summary, bsTransfers, bsInternal] = await Promise.all([
    blockNumber !== undefined ? blockTimestamp(chain, blockNumber, signal) : undefined,
    bs ? optional(blockscout.txSummary(chain, hash, signal), signal) : undefined,
    bs ? optional(blockscout.txTokenTransfers(chain, hash, signal), signal) : undefined,
    bs ? optional(blockscout.txInternalPaged(chain, hash, signal), signal) : undefined,
  ]);

  const rawLogs: RawEvmLog[] = receipt?.logs ?? [];
  for (const t of bsTransfers ?? []) if (t.token) rememberTokenMeta(t.token);
  const tokenAddresses = rawLogs.filter((l) => TRANSFER_TOPICS.has(l.topics?.[0]?.toLowerCase() ?? '')).map((l) => l.address);
  await resolveTokenMeta(chain, tokenAddresses, signal);

  const transfers = decodeTransfersFromLogs(chain.id, rawLogs, (a) => getCachedTokenMeta(chain, a));
  const logs = decodeKnownEvents(rawLogs);

  const selector = selectorOf(tx.input);
  let methodName = selector ? (WELL_KNOWN_SELECTORS[selector] ?? summary?.methodName) : undefined;
  if (selector && !methodName) methodName = await lookupSelector(selector, signal);

  const native = { decimals: chain.native.decimals, symbol: chain.native.symbol };
  const gasUsed = receipt ? hexToBigIntSafe(receipt.gasUsed) : undefined;
  const gasPrice = receipt?.effectiveGasPrice ? hexToBigIntSafe(receipt.effectiveGasPrice) : tx.gasPrice ? hexToBigIntSafe(tx.gasPrice) : undefined;
  const l1Fee = receipt?.l1Fee ? hexToBigIntSafe(receipt.l1Fee) : 0n;
  const fee = gasUsed !== undefined && gasPrice !== undefined ? { raw: gasUsed * gasPrice + l1Fee, ...native } : summary?.fee;

  let status: Transaction['status'] = 'pending';
  if (receipt) {
    if (receipt.status === undefined || receipt.status === null) status = summary?.status ?? 'success';
    else status = hexToBigIntSafe(receipt.status) === 1n ? 'success' : 'failed';
  }

  const extra: NonNullable<Transaction['extra']> = {};
  if (tx.type) extra.type = tx.type;
  const txIndex = hexToNumberSafe(receipt?.transactionIndex ?? tx.transactionIndex ?? undefined);
  if (txIndex !== undefined) extra.transactionIndex = txIndex;
  if (tx.maxFeePerGas) extra.maxFeePerGas = hexToBigIntSafe(tx.maxFeePerGas).toString();
  if (tx.maxPriorityFeePerGas) extra.maxPriorityFeePerGas = hexToBigIntSafe(tx.maxPriorityFeePerGas).toString();
  if (receipt?.l1Fee) extra.l1Fee = l1Fee.toString();
  if (receipt?.logs) extra.logCount = receipt.logs.length;
  if (bsInternal?.truncated) extra.internalTruncated = true;

  return {
    chain: chain.id,
    hash: tx.hash,
    status,
    blockNumber,
    timestamp: blockTs ?? summary?.timestamp,
    from: tx.from,
    to: tx.to ?? undefined,
    value: { raw: hexToBigIntSafe(tx.value), ...native },
    fee,
    gasUsed,
    gasLimit: hexToBigIntSafe(tx.gas),
    gasPrice,
    nonce: hexToNumberSafe(tx.nonce),
    input: tx.input,
    methodId: selector,
    methodName,
    contractCreated: receipt?.contractAddress ?? summary?.contractCreated,
    transfers,
    internal: bsInternal?.calls,
    logs,
    extra,
  };
}

// ---------------------------------------------------------------------------
// Contract info
// ---------------------------------------------------------------------------

/** Blockscout verification data merged with on-chain proxy detection (storage slots / bytecode). */
export async function getContractInfo(chain: ChainInfo, address: string, signal?: AbortSignal): Promise<ContractInfo> {
  const code = await getCode(chain, address, signal);
  if (code === '0x') return { verified: false };
  const bs = blockscout.hasBlockscout(chain);
  const [proxy, verified, info] = await Promise.all([
    detectProxy(
      (slot) => getStorageAt(chain, address, slot, signal),
      code,
      (to, data) => ethCall(chain, to, data, signal),
    ),
    bs ? optional(blockscout.contractInfo(chain, address, signal), signal) : undefined,
    bs ? optional(blockscout.addressInfo(chain, address, signal), signal) : undefined,
  ]);
  const result: ContractInfo = {
    verified: !!(verified?.verified ?? info?.isVerified),
    name: verified?.name ?? info?.name,
    compiler: verified?.compiler,
    creator: info?.creatorAddress,
    creationTx: info?.creationTx,
    implementation: proxy.implementation ?? verified?.implementation ?? info?.implementation,
    proxyType: proxy.proxyType ?? verified?.proxyType,
    isToken: !!info?.token,
    token: info?.token,
    sourceUrl: verified?.sourceUrl,
  };
  if (result.implementation && !result.proxyType) result.proxyType = 'unknown';
  if (info?.token) rememberTokenMeta(info.token);
  return result;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/** Block span scanned for approvals (~9 months on Ethereum, weeks on fast L2s). */
const APPROVAL_SPAN_BLOCKS = 2_000_000;
const APPROVAL_SPLIT = 5;
const APPROVAL_MAX_REQUESTS = 10;
const APPROVAL_TS_LOOKUPS = 10;
const UNLIMITED_THRESHOLD = 1n << 255n;

function padTopicAddress(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

/**
 * Token allowances granted by `address`, with scan status.
 *
 * Blockscout's `/addresses/{a}/logs` endpoint cannot filter by topic, so the
 * only explorer-independent source is `eth_getLogs` on the RPC: topic0 ∈
 * {Approval, ApprovalForAll} with topics[1] = the owner, over the last
 * ~2,000,000 blocks. Public RPCs disagree on the largest range they accept,
 * so one wide request is tried first; if it is refused the span is split once
 * into 5 chunks (a refused chunk fails fast rather than re-splitting, so a
 * capped RPC costs at most 2 eth_getLogs calls), with a hard cap of 10
 * requests in total. Logs are deduplicated by (token, spender) keeping the
 * latest, zero allowances (revocations) are dropped and token metadata comes
 * from `erc20Meta`.
 *
 * When the RPC refuses the query, the request budget runs out or a chunk
 * fails, the approvals from the chunks that did succeed are returned with
 * `scanIncomplete: true` and a human-readable `reason`, so the UI can say
 * "scan incomplete" instead of showing an empty list as if nothing existed.
 * Only `eth_blockNumber` failing (RPC down) makes this throw.
 */
export async function scanApprovals(chain: ChainInfo, address: string, signal?: AbortSignal): Promise<ApprovalScan> {
  const latest = await getBlockNumber(chain, signal);
  const fromBlock = Math.max(0, latest - APPROVAL_SPAN_BLOCKS);
  const topics = [[TOPIC_APPROVAL, TOPIC_APPROVAL_FOR_ALL], padTopicAddress(address)];
  let requests = 0;
  const logs: RawEvmLog[] = [];
  let reason: string | undefined;

  const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const span = (from: number, to: number) => `blocks ${from.toLocaleString('en-US')}–${to.toLocaleString('en-US')}`;

  const fetchRange = async (from: number, to: number): Promise<RawEvmLog[]> => {
    if (requests >= APPROVAL_MAX_REQUESTS) throw new Error('eth_getLogs request budget exhausted');
    requests++;
    return getLogs(chain, { fromBlock: from, toBlock: to, topics }, signal, { maxUrls: 2 });
  };

  try {
    logs.push(...(await fetchRange(fromBlock, latest)));
  } catch (wideErr) {
    if (isAbortError(wideErr, signal)) throw wideErr;
    const size = latest - fromBlock + 1;
    // Single-level split only: a second level could never finish within the budget
    // (its siblings would exhaust it and discard everything fetched so far).
    if (size < 1_000 || requests + APPROVAL_SPLIT > APPROVAL_MAX_REQUESTS) {
      reason = `The ${chain.name} RPC refused the approval log query (${describe(wideErr)}); ${span(fromBlock, latest)} were not scanned.`;
    } else {
      const step = Math.ceil(size / APPROVAL_SPLIT);
      for (let start = fromBlock; start <= latest; start += step) {
        const end = Math.min(latest, start + step - 1);
        try {
          logs.push(...(await fetchRange(start, end)));
        } catch (chunkErr) {
          if (isAbortError(chunkErr, signal)) throw chunkErr;
          // Fail fast: a capped RPC would refuse every remaining chunk too.
          reason = `The ${chain.name} RPC refused the approval log query (${describe(chunkErr)}); ${span(start, latest)} were not scanned.`;
          break;
        }
      }
    }
  }
  if (reason) console.warn(`[evm] approval scan incomplete on ${chain.id}: ${reason}`);

  const approvals = await approvalsFromLogs(chain, address, logs, signal);
  return { approvals, scanIncomplete: reason !== undefined, fromBlock, toBlock: latest, reason };
}

/** Approvals only; see {@link scanApprovals} for the scan status. */
export async function getApprovals(chain: ChainInfo, address: string, signal?: AbortSignal): Promise<ApprovalInfo[]> {
  return (await scanApprovals(chain, address, signal)).approvals;
}

/** Reduce raw Approval / ApprovalForAll logs to the active allowances with token metadata and timestamps. */
async function approvalsFromLogs(chain: ChainInfo, address: string, logs: RawEvmLog[], signal?: AbortSignal): Promise<ApprovalInfo[]> {
  // Latest approval per (token, spender) wins.
  interface Pending {
    token: string;
    spender: string;
    amount: bigint;
    forAll: boolean;
    txHash: string;
    blockNumber: number;
    logIndex: number;
  }
  const latestByKey = new Map<string, Pending>();
  const ordered = logs
    .map((l) => ({ l, block: hexToNumberSafe(l.blockNumber) ?? 0, idx: hexToNumberSafe(l.logIndex) ?? 0 }))
    .sort((a, b) => a.block - b.block || a.idx - b.idx);
  for (const { l, block, idx } of ordered) {
    const topic0 = l.topics?.[0]?.toLowerCase();
    if (!topic0 || l.topics.length !== 3 || !sameAddress(topicToAddress(l.topics[1]), address)) continue;
    const spender = topicToAddress(l.topics[2]);
    const value = hexToBigIntSafe(l.data);
    let entry: Pending;
    if (topic0 === TOPIC_APPROVAL) {
      entry = { token: l.address, spender, amount: value, forAll: false, txHash: l.transactionHash, blockNumber: block, logIndex: idx };
    } else if (topic0 === TOPIC_APPROVAL_FOR_ALL) {
      entry = { token: l.address, spender, amount: value !== 0n ? maxUint256 : 0n, forAll: true, txHash: l.transactionHash, blockNumber: block, logIndex: idx };
    } else continue;
    latestByKey.set(`${entry.token.toLowerCase()}:${spender.toLowerCase()}`, entry);
  }
  const active = Array.from(latestByKey.values())
    .filter((p) => p.amount > 0n)
    .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
  if (active.length === 0) return [];

  await resolveTokenMeta(chain, active.map((p) => p.token), signal);

  const blocks = Array.from(new Set(active.map((p) => p.blockNumber))).slice(0, APPROVAL_TS_LOOKUPS);
  const timestamps = new Map<number, number>();
  await mapLimit(blocks, 4, async (b) => {
    const ts = await blockTimestamp(chain, b, signal);
    if (ts !== undefined) timestamps.set(b, ts);
  });

  return active.map((p) => {
    const cached = getCachedTokenMeta(chain, p.token);
    const fallbackType: TokenInfo['type'] = p.forAll ? 'ERC-721' : 'ERC-20';
    const token: TokenInfo = cached
      ? p.forAll && cached.type !== 'ERC-1155'
        ? { ...cached, type: 'ERC-721', decimals: 0 }
        : cached
      : { chain: chain.id, address: p.token, name: 'Unknown token', symbol: `${p.token.slice(0, 6)}…${p.token.slice(-4)}`, decimals: 0, type: fallbackType };
    return {
      token,
      spender: p.spender,
      amount: p.amount,
      unlimited: p.forAll || p.amount >= UNLIMITED_THRESHOLD,
      txHash: p.txHash,
      timestamp: timestamps.get(p.blockNumber),
      blockNumber: p.blockNumber,
    };
  });
}
