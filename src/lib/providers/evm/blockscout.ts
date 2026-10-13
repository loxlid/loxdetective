/**
 * Blockscout REST API v2 client (`${chain.blockscoutUrl}/api/v2/...`).
 *
 * Every mapper is defensive about shapes: Blockscout instances run different
 * versions and omit fields freely, so missing data degrades to `undefined`
 * rather than throwing.
 */
import { getAddress } from 'viem';
import type { ChainInfo, ContractInfo, InternalCall, PagedResult, TokenBalance, TokenInfo, Transaction, Transfer, TxListItem, TxStatus } from '@/lib/types';
import { fetchJson, HttpError, qs } from '@/lib/http';

const TIMEOUT_MS = 20_000;
export const SOURCE = 'blockscout';

// ---------------------------------------------------------------------------
// Raw API shapes (subset)
// ---------------------------------------------------------------------------

interface BsAddressRef {
  hash?: string;
  name?: string | null;
  is_contract?: boolean;
  ens_domain_name?: string | null;
}

interface BsToken {
  address?: string;
  address_hash?: string;
  name?: string | null;
  symbol?: string | null;
  decimals?: string | number | null;
  type?: string | null;
  icon_url?: string | null;
}

interface BsTx {
  hash?: string;
  timestamp?: string | number | null;
  block?: number | null;
  block_number?: number | null;
  from?: BsAddressRef | null;
  to?: BsAddressRef | null;
  created_contract?: BsAddressRef | null;
  value?: string | null;
  fee?: { type?: string; value?: string | null } | null;
  status?: string | null;
  result?: string | null;
  method?: string | null;
  tx_types?: string[];
  transaction_types?: string[];
  gas_used?: string | null;
  gas_limit?: string | null;
  gas_price?: string | null;
  nonce?: number | null;
  raw_input?: string | null;
  decoded_input?: { method_call?: string; method_id?: string } | null;
}

interface BsTokenTransfer {
  tx_hash?: string;
  transaction_hash?: string;
  timestamp?: string | number | null;
  block_number?: number | null;
  log_index?: number | string | null;
  from?: BsAddressRef | null;
  to?: BsAddressRef | null;
  token?: BsToken | null;
  total?: { value?: string | null; decimals?: string | number | null; token_id?: string | null } | null;
  method?: string | null;
  type?: string | null;
}

interface BsInternalTx {
  transaction_hash?: string;
  timestamp?: string | number | null;
  block_number?: number | null;
  block?: number | null;
  from?: BsAddressRef | null;
  to?: BsAddressRef | null;
  created_contract?: BsAddressRef | null;
  value?: string | null;
  type?: string | null;
  success?: boolean | null;
  error?: string | null;
}

interface BsPaged<T> {
  items?: T[];
  next_page_params?: Record<string, string | number | boolean | null> | null;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

export function hasBlockscout(chain: ChainInfo): boolean {
  return typeof chain.blockscoutUrl === 'string' && chain.blockscoutUrl.length > 0;
}

function baseUrl(chain: ChainInfo): string {
  if (!hasBlockscout(chain)) throw new Error(`Blockscout not available for ${chain.name}`);
  return `${chain.blockscoutUrl!.replace(/\/$/, '')}/api/v2`;
}

async function get<T>(chain: ChainInfo, path: string, signal?: AbortSignal): Promise<T> {
  return fetchJson<T>(`${baseUrl(chain)}${path}`, { signal, timeoutMs: TIMEOUT_MS });
}

function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
}

/** Serialise `next_page_params` as the opaque page cursor. */
function cursorFrom(next: BsPaged<unknown>['next_page_params']): string | undefined {
  return next && typeof next === 'object' && Object.keys(next).length > 0 ? JSON.stringify(next) : undefined;
}

/** Turn a cursor back into the query string Blockscout expects. */
function cursorQuery(cursor: string | undefined): string {
  if (!cursor) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    throw new Error('Invalid Blockscout page cursor');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid Blockscout page cursor');
  const params: Record<string, string | number | boolean | undefined> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[k] = v;
    else params[k] = JSON.stringify(v);
  }
  return qs(params);
}

function withCursor(path: string, cursor: string | undefined, extra: Record<string, string> = {}): string {
  const c = cursorQuery(cursor);
  const e = qs(extra);
  if (c && e) return `${path}${c}&${e.slice(1)}`;
  return `${path}${c || e}`;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

export function parseTimestamp(ts: string | number | null | undefined): number | undefined {
  if (ts === null || ts === undefined || ts === '') return undefined;
  if (typeof ts === 'number') return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
  if (/^\d+$/.test(ts)) return parseTimestamp(Number(ts));
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

function toBigInt(v: string | number | null | undefined): bigint {
  if (v === null || v === undefined || v === '') return 0n;
  try {
    return BigInt(typeof v === 'number' ? Math.trunc(v) : v.trim());
  } catch {
    return 0n;
  }
}

function toNum(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function checksum(a: string | undefined | null): string | undefined {
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

export function direction(address: string, from: string | undefined, to: string | undefined): TxListItem['direction'] {
  const isFrom = eq(address, from);
  const isTo = eq(address, to);
  if (isFrom && isTo) return 'self';
  if (isFrom) return 'out';
  if (isTo) return 'in';
  return 'unknown';
}

function mapStatus(status: string | null | undefined): TxStatus {
  if (status === 'ok' || status === 'success' || status === '1') return 'success';
  if (status === 'error' || status === 'failed' || status === '0') return 'failed';
  return 'pending';
}

/** "transfer(address _to, uint256 _value)" → "transfer(address,uint256)". */
export function normalizeSignature(sig: string | null | undefined): string | undefined {
  if (!sig) return undefined;
  const m = /^([A-Za-z_$][\w$]*)\((.*)\)$/s.exec(sig.trim());
  if (!m) return undefined;
  const params = m[2].trim();
  if (!params) return `${m[1]}()`;
  return `${m[1]}(${splitTopLevel(params).map(normalizeParam).join(',')})`;
}

/** "<type> [<name>]" → "<type>", recursing into tuple components and keeping array suffixes. */
function normalizeParam(param: string): string {
  const t = param.trim();
  if (!t.startsWith('(')) return t.split(/\s+/)[0];
  let depth = 0;
  let close = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return t.replace(/\s+/g, '');
  const inner = t.slice(1, close);
  const arraySuffix = /^((?:\[\d*\])*)/.exec(t.slice(close + 1).trim())?.[1] ?? '';
  const components = inner.trim() ? splitTopLevel(inner).map(normalizeParam).join(',') : '';
  return `(${components})${arraySuffix}`;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Method label from a Blockscout tx: decoded signature when present, else the plain `method` name. */
function methodNameOf(tx: Pick<BsTx, 'method' | 'decoded_input'>): string | undefined {
  const decoded = normalizeSignature(tx.decoded_input?.method_call);
  if (decoded) return decoded;
  const m = tx.method ?? undefined;
  if (!m || /^0x[0-9a-fA-F]{8}$/.test(m)) return undefined;
  return m;
}

function mapTokenType(t: string | null | undefined): TokenInfo['type'] {
  switch ((t ?? '').toUpperCase()) {
    case 'ERC-20':
    case 'ERC20':
      return 'ERC-20';
    case 'ERC-721':
    case 'ERC721':
      return 'ERC-721';
    case 'ERC-1155':
    case 'ERC1155':
      return 'ERC-1155';
    default:
      return 'unknown';
  }
}

export function mapToken(chain: ChainInfo, t: BsToken | null | undefined): TokenInfo | undefined {
  const address = t?.address ?? t?.address_hash;
  if (!t || !address) return undefined;
  const type = mapTokenType(t.type);
  const decimals = type === 'ERC-721' || type === 'ERC-1155' ? 0 : (toNum(t.decimals) ?? 0);
  return {
    chain: chain.id,
    address: checksum(address) ?? address,
    name: t.name?.trim() || t.symbol?.trim() || 'Unknown token',
    symbol: t.symbol?.trim() || (t.name?.trim() ?? '').slice(0, 11) || `${address.slice(0, 6)}…${address.slice(-4)}`,
    decimals,
    type,
    logoUrl: t.icon_url ?? undefined,
  };
}

function mapTx(chain: ChainInfo, item: BsTx, address: string): TxListItem {
  const from = checksum(item.from?.hash);
  const to = checksum(item.to?.hash ?? item.created_contract?.hash);
  return {
    chain: chain.id,
    hash: item.hash ?? '',
    timestamp: parseTimestamp(item.timestamp),
    blockNumber: toNum(item.block_number ?? item.block),
    from: from ?? '',
    to,
    value: { raw: toBigInt(item.value), decimals: chain.native.decimals, symbol: chain.native.symbol },
    status: mapStatus(item.status),
    methodName: methodNameOf(item),
    direction: direction(address, from, to),
  };
}

function transferKind(type: TokenInfo['type'], tokenId: string | null | undefined): Transfer['kind'] {
  if (type === 'ERC-721') return 'ERC-721';
  if (type === 'ERC-1155') return 'ERC-1155';
  if (type === 'ERC-20') return 'ERC-20';
  return tokenId ? 'ERC-721' : 'ERC-20';
}

function tokenAmount(item: BsTokenTransfer, token: TokenInfo): { raw: bigint; decimals: number; symbol: string } {
  const total = item.total;
  const isNft = token.type === 'ERC-721' || token.type === 'ERC-1155';
  const raw = total?.value !== undefined && total?.value !== null ? toBigInt(total.value) : isNft ? 1n : 0n;
  const decimals = isNft ? 0 : (toNum(total?.decimals) ?? token.decimals);
  return { raw, decimals, symbol: token.symbol };
}

function mapTokenTransferRow(chain: ChainInfo, item: BsTokenTransfer, address: string): TxListItem {
  const from = checksum(item.from?.hash);
  const to = checksum(item.to?.hash);
  const tokenAddr = item.token?.address ?? item.token?.address_hash ?? '';
  const token = mapToken(chain, item.token) ?? {
    chain: chain.id,
    address: tokenAddr,
    name: 'Unknown token',
    symbol: tokenAddr ? `${tokenAddr.slice(0, 6)}…${tokenAddr.slice(-4)}` : '?',
    decimals: 0,
    type: 'unknown' as const,
  };
  const amount = tokenAmount(item, token);
  const kind = transferKind(token.type, item.total?.token_id);
  return {
    chain: chain.id,
    hash: item.tx_hash ?? item.transaction_hash ?? '',
    timestamp: parseTimestamp(item.timestamp),
    blockNumber: toNum(item.block_number),
    from: from ?? '',
    to,
    value: amount,
    status: 'success',
    methodName: item.method && !/^0x[0-9a-fA-F]{8}$/.test(item.method) ? item.method : undefined,
    direction: direction(address, from, to),
    token: { symbol: token.symbol, amount, tokenAddress: token.address, kind },
  };
}

function mapTransfer(chain: ChainInfo, item: BsTokenTransfer): Transfer | undefined {
  const token = mapToken(chain, item.token);
  if (!token) return undefined;
  const amount = tokenAmount(item, token);
  const kind = transferKind(token.type, item.total?.token_id);
  return {
    kind,
    from: checksum(item.from?.hash) ?? '',
    to: checksum(item.to?.hash) ?? '',
    amount,
    token,
    tokenId: item.total?.token_id ?? undefined,
    index: toNum(item.log_index),
  };
}

function mapInternalRow(chain: ChainInfo, item: BsInternalTx, address: string): TxListItem {
  const from = checksum(item.from?.hash);
  const to = checksum(item.to?.hash ?? item.created_contract?.hash);
  return {
    chain: chain.id,
    hash: item.transaction_hash ?? '',
    timestamp: parseTimestamp(item.timestamp),
    blockNumber: toNum(item.block_number ?? item.block),
    from: from ?? '',
    to,
    value: { raw: toBigInt(item.value), decimals: chain.native.decimals, symbol: chain.native.symbol },
    status: item.success === false || item.error ? 'failed' : 'success',
    methodName: item.type ?? undefined,
    direction: direction(address, from, to),
  };
}

function mapInternalCall(chain: ChainInfo, item: BsInternalTx): InternalCall {
  return {
    from: checksum(item.from?.hash) ?? '',
    to: checksum(item.to?.hash ?? item.created_contract?.hash) ?? '',
    value: { raw: toBigInt(item.value), decimals: chain.native.decimals, symbol: chain.native.symbol },
    type: item.type ?? 'call',
    error: item.error ?? (item.success === false ? 'failed' : undefined),
  };
}

function mapProxyType(t: string | null | undefined): ContractInfo['proxyType'] | undefined {
  if (!t) return undefined;
  const s = t.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s.includes('1967')) return 'EIP-1967';
  if (s.includes('1167') || s.includes('clone')) return 'EIP-1167';
  if (s.includes('1822')) return 'EIP-1822';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BlockscoutAddressInfo {
  isContract: boolean;
  name?: string;
  isVerified?: boolean;
  ensName?: string;
  creatorAddress?: string;
  creationTx?: string;
  implementation?: string;
  token?: TokenInfo;
  txCount?: number;
}

interface BsAddress {
  hash?: string;
  is_contract?: boolean;
  is_verified?: boolean;
  name?: string | null;
  ens_domain_name?: string | null;
  creator_address_hash?: string | null;
  creation_tx_hash?: string | null;
  creation_transaction_hash?: string | null;
  implementation_address?: string | null;
  implementations?: { address?: string; address_hash?: string; name?: string | null }[] | null;
  token?: BsToken | null;
}

/** `/addresses/{a}`; an address Blockscout has never seen (404) maps to a plain EOA. */
export async function addressInfo(chain: ChainInfo, address: string, signal?: AbortSignal): Promise<BlockscoutAddressInfo> {
  let a: BsAddress;
  try {
    a = await get<BsAddress>(chain, `/addresses/${address}`, signal);
  } catch (err) {
    if (isNotFound(err)) return { isContract: false };
    throw err;
  }
  const impl = a.implementation_address ?? a.implementations?.[0]?.address ?? a.implementations?.[0]?.address_hash ?? undefined;
  return {
    isContract: !!a.is_contract,
    name: a.name ?? undefined,
    isVerified: a.is_verified ?? undefined,
    ensName: a.ens_domain_name ?? undefined,
    creatorAddress: checksum(a.creator_address_hash),
    creationTx: a.creation_tx_hash ?? a.creation_transaction_hash ?? undefined,
    implementation: checksum(impl),
    token: mapToken(chain, a.token),
  };
}

export async function addressTransactions(chain: ChainInfo, address: string, cursor?: string, signal?: AbortSignal): Promise<PagedResult<TxListItem>> {
  const res = await get<BsPaged<BsTx>>(chain, withCursor(`/addresses/${address}/transactions`, cursor), signal);
  return { items: (res.items ?? []).map((i) => mapTx(chain, i, address)), nextCursor: cursorFrom(res.next_page_params), source: SOURCE };
}

export async function addressTokenTransfers(chain: ChainInfo, address: string, cursor?: string, signal?: AbortSignal): Promise<PagedResult<TxListItem>> {
  const res = await get<BsPaged<BsTokenTransfer>>(chain, withCursor(`/addresses/${address}/token-transfers`, cursor), signal);
  return { items: (res.items ?? []).map((i) => mapTokenTransferRow(chain, i, address)), nextCursor: cursorFrom(res.next_page_params), source: SOURCE };
}

const MAX_TOKEN_PAGES = 5;

/** `/addresses/{a}/tokens` for ERC-20/721/1155, following up to 5 pages. */
export async function addressTokenBalances(chain: ChainInfo, address: string, signal?: AbortSignal): Promise<TokenBalance[]> {
  const out: TokenBalance[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOKEN_PAGES; page++) {
    const res = await get<BsPaged<{ token?: BsToken | null; value?: string | null; token_id?: string | null }>>(
      chain,
      withCursor(`/addresses/${address}/tokens`, cursor, { type: 'ERC-20,ERC-721,ERC-1155' }),
      signal,
    );
    for (const item of res.items ?? []) {
      const token = mapToken(chain, item.token);
      if (!token) continue;
      out.push({ token, balance: toBigInt(item.value) });
    }
    cursor = cursorFrom(res.next_page_params);
    if (!cursor) break;
  }
  return out;
}

export async function addressInternalTxs(chain: ChainInfo, address: string, cursor?: string, signal?: AbortSignal): Promise<PagedResult<TxListItem>> {
  const res = await get<BsPaged<BsInternalTx>>(chain, withCursor(`/addresses/${address}/internal-transactions`, cursor), signal);
  return { items: (res.items ?? []).map((i) => mapInternalRow(chain, i, address)), nextCursor: cursorFrom(res.next_page_params), source: SOURCE };
}

export async function txInternal(chain: ChainInfo, hash: string, signal?: AbortSignal): Promise<InternalCall[]> {
  const res = await get<BsPaged<BsInternalTx>>(chain, `/transactions/${hash}/internal-transactions`, signal);
  return (res.items ?? []).map((i) => mapInternalCall(chain, i));
}

export async function txTokenTransfers(chain: ChainInfo, hash: string, signal?: AbortSignal): Promise<Transfer[]> {
  const res = await get<BsPaged<BsTokenTransfer>>(chain, `/transactions/${hash}/token-transfers`, signal);
  return (res.items ?? []).map((i) => mapTransfer(chain, i)).filter((t): t is Transfer => t !== undefined);
}

/** `/transactions/{h}`: method, fee, status, timestamp and the other top-level fields. */
export async function txSummary(chain: ChainInfo, hash: string, signal?: AbortSignal): Promise<Partial<Transaction>> {
  const tx = await get<BsTx>(chain, `/transactions/${hash}`, signal);
  const native = { decimals: chain.native.decimals, symbol: chain.native.symbol };
  const out: Partial<Transaction> = {
    chain: chain.id,
    hash: tx.hash ?? hash,
    status: mapStatus(tx.status),
    blockNumber: toNum(tx.block_number ?? tx.block),
    timestamp: parseTimestamp(tx.timestamp),
    from: checksum(tx.from?.hash),
    to: checksum(tx.to?.hash),
    methodName: methodNameOf(tx),
    contractCreated: checksum(tx.created_contract?.hash),
  };
  if (tx.value !== undefined && tx.value !== null) out.value = { raw: toBigInt(tx.value), ...native };
  if (tx.fee?.value !== undefined && tx.fee?.value !== null) out.fee = { raw: toBigInt(tx.fee.value), ...native };
  if (tx.gas_used) out.gasUsed = toBigInt(tx.gas_used);
  if (tx.gas_limit) out.gasLimit = toBigInt(tx.gas_limit);
  if (tx.gas_price) out.gasPrice = toBigInt(tx.gas_price);
  if (typeof tx.nonce === 'number') out.nonce = tx.nonce;
  if (tx.raw_input) out.input = tx.raw_input;
  if (tx.decoded_input?.method_id) out.methodId = tx.decoded_input.method_id.startsWith('0x') ? tx.decoded_input.method_id : `0x${tx.decoded_input.method_id}`;
  return out;
}

interface BsSmartContract {
  name?: string | null;
  compiler_version?: string | null;
  is_verified?: boolean | null;
  is_partially_verified?: boolean | null;
  source_code?: string | null;
  proxy_type?: string | null;
  implementations?: { address?: string; address_hash?: string; name?: string | null }[] | null;
  implementation_address?: string | null;
  creation_bytecode?: string | null;
}

/** `/smart-contracts/{a}`; 404 means "not verified / not a contract". */
export async function contractInfo(chain: ChainInfo, address: string, signal?: AbortSignal): Promise<ContractInfo> {
  let c: BsSmartContract;
  try {
    c = await get<BsSmartContract>(chain, `/smart-contracts/${address}`, signal);
  } catch (err) {
    if (isNotFound(err)) return { verified: false };
    throw err;
  }
  const verified = !!(c.is_verified ?? c.is_partially_verified ?? c.source_code);
  const impl = c.implementations?.[0]?.address ?? c.implementations?.[0]?.address_hash ?? c.implementation_address ?? undefined;
  const info: ContractInfo = {
    verified,
    name: c.name ?? undefined,
    compiler: c.compiler_version ?? undefined,
    implementation: checksum(impl),
    proxyType: mapProxyType(c.proxy_type),
  };
  if (verified) info.sourceUrl = `${chain.blockscoutUrl!.replace(/\/$/, '')}/address/${address}?tab=contract`;
  return info;
}

/** `/addresses/{a}/counters` (values come back as strings). */
export async function addressCounters(chain: ChainInfo, address: string, signal?: AbortSignal): Promise<{ txCount: number; tokenTransfers: number; gasUsed?: bigint }> {
  const c = await get<{ transactions_count?: string | number; token_transfers_count?: string | number; gas_usage_count?: string | number }>(
    chain,
    `/addresses/${address}/counters`,
    signal,
  );
  return {
    txCount: toNum(c.transactions_count) ?? 0,
    tokenTransfers: toNum(c.token_transfers_count) ?? 0,
    gasUsed: c.gas_usage_count !== undefined && c.gas_usage_count !== null ? toBigInt(c.gas_usage_count) : undefined,
  };
}
