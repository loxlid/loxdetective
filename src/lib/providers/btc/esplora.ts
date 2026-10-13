/**
 * Bitcoin provider over the Esplora REST API (mempool.space and Blockstream
 * expose the same surface). Endpoints come from `rpcUrlsFor(getChain('bitcoin'))`
 * and are tried in order via `withFallback`.
 *
 * All satoshi amounts are converted to `bigint` at the boundary.
 */
import { getChain } from '@/lib/chains/registry';
import { fetchJson, HttpError, withFallback } from '@/lib/http';
import { rpcUrlsFor } from '@/lib/settings/store';
import type { AddressSummary, Amount, PagedResult, Transaction, Transfer, TxListItem } from '@/lib/types';

const CHAIN_ID = 'bitcoin';
const SOURCE = 'esplora';
/** Esplora returns 25 confirmed transactions per page for `/txs` and `/txs/chain/{txid}`. */
export const ESPLORA_PAGE_SIZE = 25;
const BTC_DECIMALS = 8;
const BTC_SYMBOL = 'BTC';

export interface BtcIo {
  address?: string;
  value: bigint;
  scriptType?: string;
  txid?: string;
  vout?: number;
}

/* ---------- Raw Esplora shapes (subset; everything optional on purpose) ---------- */

interface EsploraStats {
  funded_txo_count?: number;
  funded_txo_sum?: number;
  spent_txo_count?: number;
  spent_txo_sum?: number;
  tx_count?: number;
}

interface EsploraAddress {
  address?: string;
  chain_stats?: EsploraStats;
  mempool_stats?: EsploraStats;
}

interface EsploraPrevout {
  scriptpubkey?: string;
  scriptpubkey_address?: string;
  scriptpubkey_type?: string;
  value?: number;
}

interface EsploraVin {
  txid?: string;
  vout?: number;
  prevout?: EsploraPrevout | null;
  is_coinbase?: boolean;
  sequence?: number;
}

interface EsploraVout {
  scriptpubkey?: string;
  scriptpubkey_address?: string;
  scriptpubkey_type?: string;
  value?: number;
}

interface EsploraStatus {
  confirmed?: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

export interface EsploraTx {
  txid: string;
  version?: number;
  locktime?: number;
  vin?: EsploraVin[];
  vout?: EsploraVout[];
  size?: number;
  weight?: number;
  fee?: number;
  status?: EsploraStatus;
}

interface EsploraUtxo {
  txid: string;
  vout: number;
  status?: EsploraStatus;
  value?: number;
}

/* ---------- Small pure helpers ---------- */

/** Satoshi field → bigint; tolerates missing / string values. */
function sats(v: unknown): bigint {
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return 0n;
}

function btc(raw: bigint): Amount {
  return { raw, decimals: BTC_DECIMALS, symbol: BTC_SYMBOL };
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function sumValues(ios: readonly BtcIo[]): bigint {
  return ios.reduce((acc, io) => acc + io.value, 0n);
}

/** Largest entry by value, or undefined for an empty list. */
function largest(ios: readonly BtcIo[]): BtcIo | undefined {
  let best: BtcIo | undefined;
  for (const io of ios) if (!best || io.value > best.value) best = io;
  return best;
}

function uniq(values: readonly (string | undefined)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v)));
}

/** Bech32 addresses are case-insensitive and Esplora expects them lower-cased; base58 is case-sensitive. */
function normalizeAddress(address: string): string {
  const a = address.trim();
  if (!a) throw new Error('Bitcoin address is empty');
  return /^bc1/i.test(a) ? a.toLowerCase() : a;
}

function vinToIo(vin: EsploraVin): BtcIo {
  const p = vin.prevout ?? undefined;
  return {
    address: vin.is_coinbase ? 'coinbase' : p?.scriptpubkey_address,
    value: sats(p?.value),
    scriptType: vin.is_coinbase ? 'coinbase' : p?.scriptpubkey_type,
    txid: vin.txid,
    vout: vin.vout,
  };
}

function voutToIo(vout: EsploraVout, index: number): BtcIo {
  return {
    address: vout.scriptpubkey_address,
    value: sats(vout.value),
    scriptType: vout.scriptpubkey_type,
    vout: index,
  };
}

function isCoinbaseTx(tx: EsploraTx): boolean {
  return (tx.vin ?? []).some((v) => v.is_coinbase === true);
}

/** Human-readable destination for an output; OP_RETURN and exotic scripts have no address. */
function outputTarget(io: BtcIo): string {
  if (io.address) return io.address;
  return io.scriptType === 'op_return' ? 'OP_RETURN' : 'unknown';
}

/* ---------- Transport ---------- */

function isClientError(err: unknown): err is HttpError {
  return err instanceof HttpError && err.status !== undefined && err.status >= 400 && err.status < 500 && err.status !== 429;
}

/** Readable `HttpError` that keeps the original status / url / body, so `isEndpointFailure` still sees a 4xx and no endpoint is cooled down. */
function readableError(err: HttpError, path: string): HttpError {
  const body = typeof err.body === 'string' ? err.body.trim() : '';
  const message = err.status === 404 ? `Esplora: ${body || 'not found'} (${path})` : `Esplora rejected ${path}: ${body || `HTTP ${err.status}`}`;
  return new HttpError(message, err.status, err.url, err.body);
}

/**
 * GET an Esplora path against the ordered endpoint list. A 4xx answer (other
 * than 429) is definitive — an invalid address or unknown txid — so it is not
 * retried on the next endpoint.
 */
async function esploraGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const urls = rpcUrlsFor(getChain(CHAIN_ID));
  let fatal: HttpError | undefined;
  return withFallback(
    urls,
    async (base) => {
      if (fatal) throw fatal;
      try {
        return await fetchJson<T>(`${base.replace(/\/+$/, '')}${path}`, { signal });
      } catch (err) {
        if (isClientError(err)) fatal = readableError(err, path);
        throw fatal ?? err;
      }
    },
    { signal },
  );
}

/* ---------- Pure mappers (exported for reuse / tests) ---------- */

/**
 * Direction of a transaction relative to `address`:
 * net > 0 → 'in', net < 0 → 'out', net == 0 with the address on both sides → 'self'.
 * A transaction whose every input and output belongs to the address (a
 * consolidation, net = -fee) is also 'self'.
 */
export function btcDirection(
  inputs: readonly BtcIo[],
  outputs: readonly BtcIo[],
  address: string,
): { direction: TxListItem['direction']; net: bigint } {
  const spent = sumValues(inputs.filter((i) => i.address === address));
  const received = sumValues(outputs.filter((o) => o.address === address));
  const net = received - spent;
  const inInputs = inputs.some((i) => i.address === address);
  const inOutputs = outputs.some((o) => o.address === address);
  const externalIn = inputs.some((i) => i.address !== address);
  // An OP_RETURN output carries no value destination, so it does not make a
  // consolidation external; any other address-less script (p2pk, bare multisig,
  // non-standard) is a real spend to someone else.
  const externalOut = outputs.some((o) => o.address !== address && o.scriptType !== 'op_return');

  if (inInputs && !externalIn && !externalOut) return { direction: 'self', net };
  if (net > 0n) return { direction: 'in', net };
  if (net < 0n) return { direction: 'out', net };
  if (inInputs && inOutputs) return { direction: 'self', net };
  if (inOutputs) return { direction: 'in', net };
  if (inInputs) return { direction: 'out', net };
  return { direction: 'unknown', net };
}

/** Map a raw Esplora transaction to a history row for `address`. */
export function btcTxToListItem(tx: EsploraTx, address: string): TxListItem {
  const inputs = (tx.vin ?? []).map(vinToIo);
  const outputs = (tx.vout ?? []).map(voutToIo);
  const coinbase = isCoinbaseTx(tx);
  const { direction, net } = btcDirection(inputs, outputs, address);

  let from = address;
  let to: string | undefined = address;
  if (direction === 'in') {
    const external = largest(inputs.filter((i) => i.address && i.address !== address));
    from = coinbase ? 'coinbase' : (external?.address ?? inputs[0]?.address ?? 'unknown');
  } else if (direction === 'out') {
    const external = largest(outputs.filter((o) => o.address !== address && o.scriptType !== 'op_return'));
    to = external ? outputTarget(external) : 'unknown';
  }

  const confirmed = tx.status?.confirmed === true;
  return {
    chain: CHAIN_ID,
    hash: tx.txid,
    timestamp: confirmed ? tx.status?.block_time : undefined,
    blockNumber: confirmed ? tx.status?.block_height : undefined,
    from,
    to,
    value: btc(abs(net)),
    status: confirmed ? 'success' : 'pending',
    methodName: coinbase ? 'coinbase' : undefined,
    direction,
  };
}

/**
 * Proportional split of `total` across `shares` (integer, exact: the rounding
 * remainder goes to the largest share so the parts always sum to `total`).
 */
function splitProportionally(total: bigint, shares: readonly bigint[]): bigint[] {
  const sum = shares.reduce((a, b) => a + b, 0n);
  if (shares.length === 0) return [];
  if (sum <= 0n) {
    // No weights (e.g. prevouts without values): give everything to the first entry.
    return shares.map((_, i) => (i === 0 ? total : 0n));
  }
  const parts = shares.map((w) => (total * w) / sum);
  const remainder = total - parts.reduce((a, b) => a + b, 0n);
  if (remainder !== 0n) {
    let best = 0;
    for (let i = 1; i < shares.length; i++) if (shares[i] > shares[best]) best = i;
    parts[best] += remainder;
  }
  return parts;
}

/**
 * Map a raw Esplora transaction to one history row **per external
 * counterparty** of `address` (the singular `btcTxToListItem` collapses a
 * transaction into one row with the largest counterparty).
 *
 * - `address` among the inputs (a spend): one `'out'` row per output that
 *   does not go back to any input address (change heuristic: an output paid
 *   to an address that also funded the transaction is change and skipped;
 *   OP_RETURN outputs are skipped too). When several input addresses fund
 *   the spend, each output is attributed to `address` proportionally to its
 *   share of the input value.
 * - `address` only among the outputs (a receive): one `'in'` row per distinct
 *   input address, each carrying the share of the value received by `address`
 *   proportional to that input's value; a coinbase transaction yields a single
 *   row from `'coinbase'`.
 * - A consolidation (no external counterparty) or a transaction that does not
 *   touch the address falls back to the singular row so the transaction stays
 *   visible.
 *
 * **Approximation**: Bitcoin has no sender→receiver mapping inside a
 * transaction. Splitting proportionally by input value assumes every input
 * funds every output pro rata, which is exact for single-input-address
 * transactions and a best-effort attribution for CoinJoin / batched spends.
 */
export function btcTxToListItems(address: string, tx: EsploraTx): TxListItem[] {
  const addr = address.trim();
  const inputs = (tx.vin ?? []).map(vinToIo);
  const outputs = (tx.vout ?? []).map(voutToIo);
  const coinbase = isCoinbaseTx(tx);
  const confirmed = tx.status?.confirmed === true;

  const base = (direction: TxListItem['direction'], from: string, to: string, value: bigint): TxListItem => ({
    chain: CHAIN_ID,
    hash: tx.txid,
    timestamp: confirmed ? tx.status?.block_time : undefined,
    blockNumber: confirmed ? tx.status?.block_height : undefined,
    from,
    to,
    value: btc(value),
    status: confirmed ? 'success' : 'pending',
    methodName: coinbase ? 'coinbase' : undefined,
    direction,
    enriched: true,
  });

  const inputAddresses = new Set(inputs.map((i) => i.address).filter((a): a is string => !!a && a !== 'coinbase'));
  const spends = !coinbase && inputAddresses.has(addr);
  const receives = outputs.some((o) => o.address === addr);

  if (spends) {
    const external = outputs.filter((o) => !(o.address && inputAddresses.has(o.address)) && o.scriptType !== 'op_return');
    if (external.length === 0) return [btcTxToListItem(tx, addr)];
    const totalIn = sumValues(inputs);
    const ownIn = sumValues(inputs.filter((i) => i.address === addr));
    const shareOf = (value: bigint): bigint => (totalIn > 0n && ownIn < totalIn ? (value * ownIn) / totalIn : value);
    const rows: TxListItem[] = [];
    for (const o of external) {
      const value = shareOf(o.value);
      if (value <= 0n && o.value > 0n) continue; // rounded away; nothing attributable
      rows.push(base('out', addr, outputTarget(o), value));
    }
    return rows.length > 0 ? rows : [btcTxToListItem(tx, addr)];
  }

  if (receives) {
    const received = sumValues(outputs.filter((o) => o.address === addr));
    if (coinbase) return [base('in', 'coinbase', addr, received)];
    // Distinct input addresses in first-seen order; address-less prevouts are grouped as 'unknown'.
    const byAddress = new Map<string, bigint>();
    for (const i of inputs) {
      const key = i.address ?? 'unknown';
      byAddress.set(key, (byAddress.get(key) ?? 0n) + i.value);
    }
    if (byAddress.size === 0) return [base('in', 'unknown', addr, received)];
    const senders = Array.from(byAddress.entries());
    const parts = splitProportionally(received, senders.map(([, v]) => v));
    const rows: TxListItem[] = [];
    senders.forEach(([from], n) => {
      if (parts[n] <= 0n && received > 0n) return;
      rows.push(base('in', from, addr, parts[n]));
    });
    return rows.length > 0 ? rows : [btcTxToListItem(tx, addr)];
  }

  return [];
}

/* ---------- Public API ---------- */

/**
 * `/address/{a}` chain + mempool stats. The first history page is fetched in
 * parallel (tolerant) only to derive first/last seen timestamps.
 */
export async function btcAddressSummary(
  address: string,
  signal?: AbortSignal,
): Promise<AddressSummary & { utxoCount: number; received: bigint; sent: bigint }> {
  const addr = normalizeAddress(address);
  const [info, firstPage] = await Promise.all([
    esploraGet<EsploraAddress>(`/address/${addr}`, signal),
    esploraGet<EsploraTx[]>(`/address/${addr}/txs`, signal).catch(() => undefined),
  ]);
  if (!info || typeof info !== 'object') throw new Error('Unexpected Esplora response for address');

  const chain = info.chain_stats ?? {};
  const mem = info.mempool_stats ?? {};
  const received = sats(chain.funded_txo_sum) + sats(mem.funded_txo_sum);
  const sent = sats(chain.spent_txo_sum) + sats(mem.spent_txo_sum);
  const utxoCount =
    (chain.funded_txo_count ?? 0) + (mem.funded_txo_count ?? 0) - (chain.spent_txo_count ?? 0) - (mem.spent_txo_count ?? 0);
  const txCount = (chain.tx_count ?? 0) + (mem.tx_count ?? 0);

  let firstSeen: number | undefined;
  let lastSeen: number | undefined;
  if (Array.isArray(firstPage)) {
    const times = firstPage
      .map((t) => t.status?.block_time)
      .filter((t): t is number => typeof t === 'number' && t > 0);
    if (times.length) {
      lastSeen = Math.max(...times);
      // Only when every confirmed tx fits in the first page do we know the oldest one.
      if (times.length >= (chain.tx_count ?? Number.POSITIVE_INFINITY)) firstSeen = Math.min(...times);
    }
  }

  return {
    chain: CHAIN_ID,
    address: addr,
    isContract: false,
    txCount,
    nativeBalance: { chain: CHAIN_ID, balance: received - sent, decimals: BTC_DECIMALS, symbol: BTC_SYMBOL },
    firstSeen,
    lastSeen,
    utxoCount,
    received,
    sent,
  };
}

/**
 * `/address/{a}/txs` (mempool + newest 25 confirmed) or
 * `/address/{a}/txs/chain/{lastSeenTxid}` (next 25 confirmed). The cursor is
 * the last confirmed txid of a full page.
 */
export async function btcAddressTxs(
  address: string,
  lastSeenTxid?: string,
  signal?: AbortSignal,
): Promise<PagedResult<TxListItem>> {
  const addr = normalizeAddress(address);
  const { txs, nextCursor } = await addressTxPage(addr, lastSeenTxid, signal);
  const items = txs.map((tx) => btcTxToListItem(tx, addr));
  return { items, nextCursor, source: SOURCE };
}

/** One raw page of `/address/{a}/txs[/chain/{txid}]` plus the cursor for the next one. */
async function addressTxPage(
  addr: string,
  lastSeenTxid: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ txs: EsploraTx[]; nextCursor?: string }> {
  const path = lastSeenTxid ? `/address/${addr}/txs/chain/${lastSeenTxid}` : `/address/${addr}/txs`;
  const txs = await esploraGet<EsploraTx[]>(path, signal);
  if (!Array.isArray(txs)) throw new Error('Unexpected Esplora response for address transactions');
  const confirmed = txs.filter((t) => t.status?.confirmed === true);
  const nextCursor = confirmed.length >= ESPLORA_PAGE_SIZE ? confirmed[confirmed.length - 1].txid : undefined;
  return { txs, nextCursor };
}

/** Default number of Esplora pages walked by `btcHistoryDetailed`. */
export const BTC_DETAILED_DEFAULT_PAGES = 2;

/**
 * Walk up to `opts.pages` (default 2) pages of `/address/{a}/txs` and flatten
 * every transaction with `btcTxToListItems`, so a batch payout to N addresses
 * becomes N rows. The first page must succeed; a later page that fails (other
 * than by abort) ends the walk with what was collected so far.
 */
export async function btcHistoryDetailed(
  address: string,
  opts: { pages?: number; signal?: AbortSignal } = {},
): Promise<TxListItem[]> {
  const addr = normalizeAddress(address);
  const pages = Math.max(1, Math.floor(opts.pages ?? BTC_DETAILED_DEFAULT_PAGES));
  const { signal } = opts;
  const out: TxListItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < pages; page++) {
    let res: { txs: EsploraTx[]; nextCursor?: string };
    try {
      res = await addressTxPage(addr, cursor, signal);
    } catch (err) {
      if (page === 0 || signal?.aborted) throw err;
      console.warn(`[esplora] history page ${page + 1} unavailable for ${addr}:`, err instanceof Error ? err.message : String(err));
      break;
    }
    for (const tx of res.txs) out.push(...btcTxToListItems(addr, tx));
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return out;
}

/**
 * `/tx/{txid}` plus `/blocks/tip/height` for confirmations. Each output becomes
 * a native `Transfer` whose `from` is the joined set of input addresses (or
 * 'coinbase'). `Transaction.from`/`to` are the largest input / output.
 */
export async function btcTransaction(
  txid: string,
  signal?: AbortSignal,
): Promise<Transaction & { inputs: BtcIo[]; outputs: BtcIo[] }> {
  const id = txid.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid Bitcoin transaction id');

  const [tx, tip] = await Promise.all([
    esploraGet<EsploraTx>(`/tx/${id}`, signal),
    esploraGet<number | string>('/blocks/tip/height', signal).catch(() => undefined),
  ]);
  if (!tx || typeof tx !== 'object' || !tx.txid) throw new Error('Unexpected Esplora response for transaction');

  // `/tx/{txid}` already embeds `status`; fall back to the dedicated endpoint if a server omits it.
  const status: EsploraStatus = tx.status ?? (await esploraGet<EsploraStatus>(`/tx/${id}/status`, signal).catch(() => ({})));

  const inputs = (tx.vin ?? []).map(vinToIo);
  const outputs = (tx.vout ?? []).map(voutToIo);
  const coinbase = isCoinbaseTx(tx);
  const totalOut = sumValues(outputs);
  const totalIn = coinbase ? totalOut : sumValues(inputs);
  if (coinbase) for (const io of inputs) io.value = totalOut; // the block reward "input"

  const feeRaw = tx.fee !== undefined ? sats(tx.fee) : coinbase ? 0n : totalIn - totalOut;
  const fromJoined = coinbase ? 'coinbase' : uniq(inputs.map((i) => i.address)).join(',') || 'unknown';
  const transfers: Transfer[] = outputs.map((o, i) => ({
    kind: 'native',
    from: fromJoined,
    to: outputTarget(o),
    amount: btc(o.value),
    index: i,
  }));

  const confirmed = status.confirmed === true;
  const tipHeight = typeof tip === 'number' ? tip : typeof tip === 'string' && /^\d+$/.test(tip.trim()) ? Number(tip) : undefined;
  const confirmations =
    confirmed && typeof status.block_height === 'number' && tipHeight !== undefined
      ? Math.max(1, tipHeight - status.block_height + 1)
      : confirmed
        ? null
        : 0;

  const weight = typeof tx.weight === 'number' ? tx.weight : undefined;
  const vsize = weight !== undefined ? Math.ceil(weight / 4) : undefined;
  const rbf = (tx.vin ?? []).some((v) => typeof v.sequence === 'number' && v.sequence < 0xfffffffe);

  return {
    chain: CHAIN_ID,
    hash: tx.txid,
    status: confirmed ? 'success' : 'pending',
    blockNumber: confirmed ? status.block_height : undefined,
    timestamp: confirmed ? status.block_time : undefined,
    from: coinbase ? 'coinbase' : (largest(inputs.filter((i) => i.address))?.address ?? 'unknown'),
    to: largest(outputs.filter((o) => o.address))?.address,
    value: btc(totalOut),
    fee: btc(feeRaw),
    transfers,
    inputs,
    outputs,
    extra: {
      size: tx.size ?? null,
      weight: weight ?? null,
      vsize: vsize ?? null,
      feeRateSatPerVb: vsize ? Math.round((Number(feeRaw) / vsize) * 10) / 10 : null,
      confirmations,
      blockHash: status.block_hash ?? null,
      version: tx.version ?? null,
      locktime: tx.locktime ?? null,
      inputCount: inputs.length,
      outputCount: outputs.length,
      totalInputSats: Number(totalIn),
      totalOutputSats: Number(totalOut),
      coinbase,
      rbfSignalled: rbf,
    },
  };
}

/** `/address/{a}/utxo` — unspent outputs including unconfirmed ones. */
export async function btcUtxos(
  address: string,
  signal?: AbortSignal,
): Promise<{ txid: string; vout: number; value: bigint; confirmed: boolean }[]> {
  const addr = normalizeAddress(address);
  const utxos = await esploraGet<EsploraUtxo[]>(`/address/${addr}/utxo`, signal);
  if (!Array.isArray(utxos)) throw new Error('Unexpected Esplora response for UTXOs');
  return utxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: sats(u.value),
    confirmed: u.status?.confirmed === true,
  }));
}
