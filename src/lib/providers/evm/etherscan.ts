/**
 * Etherscan-compatible account API (`module=account&action=txlist|tokentx|txlistinternal|balance`).
 *
 * Works against Etherscan V2 (shared endpoint + `chainid`, key required) and
 * keyless Routescan endpoints. Cursors are plain page numbers.
 */
import { getAddress } from 'viem';
import type { ChainInfo, PagedResult, Transfer, TxListItem, TxStatus } from '@/lib/types';
import { fetchJson, qs } from '@/lib/http';
import { getSettings } from '@/lib/settings/store';
import { normalizeSignature } from './blockscout';

const PAGE_SIZE = 50;
const TIMEOUT_MS = 20_000;

export const KEY_REQUIRED_MESSAGE = 'Etherscan API key required (Settings)';

interface EsEnvelope<T> {
  status?: string;
  message?: string;
  result?: T | string | null;
}

interface EsTxRow {
  hash?: string;
  timeStamp?: string;
  blockNumber?: string;
  from?: string;
  to?: string;
  value?: string;
  isError?: string;
  txreceipt_status?: string;
  functionName?: string;
  methodId?: string;
  input?: string;
  contractAddress?: string;
  // tokentx / tokennfttx
  tokenSymbol?: string;
  tokenDecimal?: string;
  tokenName?: string;
  tokenID?: string;
  tokenValue?: string;
  // txlistinternal
  type?: string;
  errCode?: string;
  traceId?: string;
}

/** Whether this chain can be served: an endpoint exists and, if required, a key is configured. */
export function hasEtherscan(chain: ChainInfo): boolean {
  const api = chain.etherscanApi;
  if (!api) return false;
  return !api.requiresKey || !!getSettings().etherscanApiKey?.trim();
}

export function etherscanSource(chain: ChainInfo): string {
  return /routescan/i.test(chain.etherscanApi?.url ?? '') ? 'routescan' : 'etherscan';
}

function isEmptyResult(message: string | undefined, result: unknown): boolean {
  const m = (message ?? '').toLowerCase();
  const r = typeof result === 'string' ? result.toLowerCase() : '';
  return /no (transactions|records|data) found/.test(m) || /no (transactions|records|data) found/.test(r);
}

async function call<T>(chain: ChainInfo, params: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
  const api = chain.etherscanApi;
  if (!api) throw new Error(`Etherscan API not available for ${chain.name}`);
  const key = getSettings().etherscanApiKey?.trim();
  if (api.requiresKey && !key) throw new Error(KEY_REQUIRED_MESSAGE);
  const url = `${api.url}${qs({ ...params, chainid: api.v2ChainId, apikey: key || undefined })}`;
  const res = await fetchJson<EsEnvelope<T>>(url, { signal, timeoutMs: TIMEOUT_MS });
  if (!res || typeof res !== 'object') throw new Error('Etherscan: malformed response');
  if (res.status === '0') {
    if (isEmptyResult(res.message, res.result)) return [] as unknown as T;
    const detail = typeof res.result === 'string' && res.result ? res.result : (res.message ?? 'unknown error');
    throw new Error(`Etherscan: ${detail}`);
  }
  if (typeof res.result === 'string' && res.status !== '1') throw new Error(`Etherscan: ${res.result}`);
  return res.result as T;
}

function checksum(a: string | undefined): string | undefined {
  if (!a) return undefined;
  try {
    return getAddress(a);
  } catch {
    return a;
  }
}

function eq(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function direction(address: string, from: string | undefined, to: string | undefined): TxListItem['direction'] {
  const isFrom = eq(address, from);
  const isTo = eq(address, to);
  if (isFrom && isTo) return 'self';
  if (isFrom) return 'out';
  if (isTo) return 'in';
  return 'unknown';
}

function toBigInt(v: string | undefined): bigint {
  if (!v) return 0n;
  try {
    return BigInt(v.trim());
  } catch {
    return 0n;
  }
}

function toNum(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function statusOf(row: EsTxRow): TxStatus {
  if (row.isError === '1' || row.txreceipt_status === '0') return 'failed';
  return 'success';
}

function mapTx(chain: ChainInfo, row: EsTxRow, address: string): TxListItem {
  const from = checksum(row.from);
  const to = checksum(row.to) || checksum(row.contractAddress) || undefined;
  return {
    chain: chain.id,
    hash: row.hash ?? '',
    timestamp: toNum(row.timeStamp),
    blockNumber: toNum(row.blockNumber),
    from: from ?? '',
    to,
    value: { raw: toBigInt(row.value), decimals: chain.native.decimals, symbol: chain.native.symbol },
    status: statusOf(row),
    methodName: normalizeSignature(row.functionName) ?? (row.functionName?.trim() || undefined),
    direction: direction(address, from, to),
  };
}

function mapTokenTx(chain: ChainInfo, row: EsTxRow, address: string): TxListItem {
  const from = checksum(row.from);
  const to = checksum(row.to);
  const tokenAddress = checksum(row.contractAddress);
  const isNft = row.tokenID !== undefined && row.tokenID !== '';
  const kind: Transfer['kind'] = isNft ? (row.tokenValue !== undefined ? 'ERC-1155' : 'ERC-721') : 'ERC-20';
  const decimals = isNft ? 0 : (toNum(row.tokenDecimal) ?? 0);
  const rawValue = isNft ? (row.tokenValue !== undefined ? toBigInt(row.tokenValue) : 1n) : toBigInt(row.value);
  const symbol = row.tokenSymbol?.trim() || (tokenAddress ? `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}` : '?');
  const amount = { raw: rawValue, decimals, symbol };
  return {
    chain: chain.id,
    hash: row.hash ?? '',
    timestamp: toNum(row.timeStamp),
    blockNumber: toNum(row.blockNumber),
    from: from ?? '',
    to,
    value: amount,
    status: 'success',
    direction: direction(address, from, to),
    token: { symbol, amount, tokenAddress, kind },
  };
}

function mapInternalTx(chain: ChainInfo, row: EsTxRow, address: string): TxListItem {
  const from = checksum(row.from);
  const to = checksum(row.to) || checksum(row.contractAddress) || undefined;
  return {
    chain: chain.id,
    hash: row.hash ?? '',
    timestamp: toNum(row.timeStamp),
    blockNumber: toNum(row.blockNumber),
    from: from ?? '',
    to,
    value: { raw: toBigInt(row.value), decimals: chain.native.decimals, symbol: chain.native.symbol },
    status: row.isError === '1' ? 'failed' : 'success',
    methodName: row.type || undefined,
    direction: direction(address, from, to),
  };
}

function pageOf(cursor: string | undefined): number {
  if (!cursor) return 1;
  const n = Number.parseInt(cursor, 10);
  if (!Number.isInteger(n) || n < 1) throw new Error('Invalid Etherscan page cursor');
  return n;
}

async function listAction(
  chain: ChainInfo,
  action: 'txlist' | 'tokentx' | 'txlistinternal',
  address: string,
  cursor: string | undefined,
  signal: AbortSignal | undefined,
  map: (row: EsTxRow) => TxListItem,
): Promise<PagedResult<TxListItem>> {
  const page = pageOf(cursor);
  const rows = await call<EsTxRow[]>(chain, { module: 'account', action, address, page, offset: PAGE_SIZE, sort: 'desc' }, signal);
  const list = Array.isArray(rows) ? rows : [];
  return {
    items: list.map(map),
    nextCursor: list.length >= PAGE_SIZE ? String(page + 1) : undefined,
    source: etherscanSource(chain),
  };
}

export async function addressTransactions(chain: ChainInfo, address: string, cursor?: string, signal?: AbortSignal): Promise<PagedResult<TxListItem>> {
  return listAction(chain, 'txlist', address, cursor, signal, (r) => mapTx(chain, r, address));
}

export async function addressTokenTransfers(chain: ChainInfo, address: string, cursor?: string, signal?: AbortSignal): Promise<PagedResult<TxListItem>> {
  return listAction(chain, 'tokentx', address, cursor, signal, (r) => mapTokenTx(chain, r, address));
}

export async function addressInternalTxs(chain: ChainInfo, address: string, cursor?: string, signal?: AbortSignal): Promise<PagedResult<TxListItem>> {
  return listAction(chain, 'txlistinternal', address, cursor, signal, (r) => mapInternalTx(chain, r, address));
}

/** `action=balance` (wei). */
export async function nativeBalance(chain: ChainInfo, address: string, signal?: AbortSignal): Promise<bigint> {
  const res = await call<string>(chain, { module: 'account', action: 'balance', address, tag: 'latest' }, signal);
  return toBigInt(typeof res === 'string' ? res : undefined);
}
