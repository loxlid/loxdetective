/**
 * Fund-flow tracer (SPEC §5).
 *
 * `traceFunds` performs a breadth-first expansion from a root address: each
 * visited node's recent history (native transactions and, optionally, token
 * transfers) is turned into directed transfers, aggregated into edges keyed
 * `${from}->${to}:${chain}`, and the best-ranked counterparties (by USD, then
 * by transfer count) are queued for the next hop until `maxHops` / `maxFanOut`
 * are exhausted. The data source is abstracted behind `FlowProvider` so the
 * algorithm is unit-testable with an in-memory fake; `createDefaultFlowProvider`
 * wires the real EVM / Bitcoin / Solana providers, the label registry and
 * DefiLlama prices.
 *
 * Node ids are lower-cased for EVM chains and kept verbatim otherwise
 * (base58 is case-sensitive). Use `displayAddress` to render them.
 */
import { getAddress } from 'viem';
import { findChain } from '@/lib/chains/registry';
import { formatAmount, shorten, toNumber } from '@/lib/format';
import { lookupLabel } from '@/lib/intel/labels';
import { isSanctioned } from '@/lib/intel/sanctions';
import { btcHistoryDetailed } from '@/lib/providers/btc/esplora';
import { getAddressHistory } from '@/lib/providers/evm';
import { getCode } from '@/lib/providers/evm/rpc';
import { getPrices, priceKeyForToken } from '@/lib/providers/prices';
import { solAddressSummary, solEnrichHistory, solSignatures } from '@/lib/providers/sol/rpc';
import type {
  AddressLabel,
  Amount,
  ChainId,
  FlowEdge,
  FlowGraph,
  FlowNode,
  RiskLevel,
  TokenInfo,
  TraceOptions,
  Transfer,
  TxListItem,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export interface FlowProvider {
  /** First page(s) of history for an address: native rows (`tx`) or token rows (`token`). */
  history(chain: ChainId, address: string, kind: 'tx' | 'token', signal?: AbortSignal): Promise<TxListItem[]>;
  label(address: string, chain: ChainId): AddressLabel | undefined;
  isContract?(chain: ChainId, address: string, signal?: AbortSignal): Promise<boolean>;
  /** Synchronous USD price lookup; `tokenAddress` undefined means the native coin. */
  price?(chain: ChainId, tokenAddress?: string): number | undefined;
  /**
   * Optional: warm the price lookup for the native coin plus the given token
   * addresses. `traceFunds` calls it for every node before scoring its rows.
   */
  prefetchPrices?(chain: ChainId, tokenAddresses: string[], signal?: AbortSignal): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants & small helpers
// ---------------------------------------------------------------------------

/** Addresses that are sinks by definition and are never expanded. */
export const BURN_ADDRESSES: ReadonlySet<string> = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000001',
  '0x000000000000000000000000000000000000beef',
  '0xffffffffffffffffffffffffffffffffffffffff',
]);

/** Pseudo-addresses emitted by the Bitcoin provider that cannot be expanded. */
const PSEUDO_SOURCES: ReadonlySet<string> = new Set(['coinbase']);
/** Pseudo-destinations that carry no traceable counterparty at all. */
const UNTRACEABLE: ReadonlySet<string> = new Set(['', 'unknown', 'op_return']);

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_HOPS = 10;
/** Pages of history fetched per node by the default EVM provider. */
const DEFAULT_EVM_PAGES = 2;
/** Pages of Esplora history walked per node by the default Bitcoin provider. */
const DEFAULT_BTC_PAGES = 2;
/** Solana: signatures enriched with `getTransaction` per node. */
const SOL_ENRICH_LIMIT = 15;
const SOL_ENRICH_CONCURRENCY = 3;
const SOL_SIGNATURE_PAGE = 25;

function isEvmChain(chain: ChainId): boolean {
  return chain === 'evm' || findChain(chain)?.family === 'evm';
}

/** Canonical node id: lower-case for EVM addresses, verbatim otherwise. */
export function nodeIdFor(chain: ChainId, address: string): string {
  const a = (address ?? '').trim();
  return isEvmChain(chain) || EVM_ADDRESS_RE.test(a) ? a.toLowerCase() : a;
}

/** Display form of a node id: checksummed for EVM, verbatim otherwise. */
export function displayAddress(chain: ChainId, id: string): string {
  if (EVM_ADDRESS_RE.test(id) && (isEvmChain(chain) || !findChain(chain))) {
    try {
      return getAddress(id);
    } catch {
      return id;
    }
  }
  return id;
}

export function isBurnAddress(id: string): boolean {
  return BURN_ADDRESSES.has(id.toLowerCase()) || PSEUDO_SOURCES.has(id.toLowerCase());
}

/** Risk level implied by a label alone (the full heuristics live in intel/risk). */
export function riskFromLabel(label: AddressLabel | undefined): RiskLevel | undefined {
  switch (label?.category) {
    case 'sanctioned':
    case 'scam':
      return 'critical';
    case 'mixer':
      return 'high';
    default:
      return undefined;
  }
}

/** User case tags never stop a trace: the investigator wants to see past their own wallets. */
function isStopLabel(label: AddressLabel | undefined): boolean {
  return !!label && label.source !== 'case';
}

function cancelledError(): Error {
  const err = new Error('Trace cancelled');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError();
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && (err.name === 'AbortError' || /abort|cancel/i.test(err.message));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0)));
}

function isNftKind(kind: Transfer['kind']): boolean {
  return kind === 'ERC-721' || kind === 'ERC-1155';
}

function tokenTypeFromKind(kind: Transfer['kind']): TokenInfo['type'] {
  switch (kind) {
    case 'ERC-20':
    case 'ERC-721':
    case 'ERC-1155':
    case 'SPL':
    case 'native':
      return kind;
    default:
      return 'unknown';
  }
}

function usdOf(amount: Amount, price: number | undefined): number | undefined {
  if (price === undefined || !Number.isFinite(price)) return undefined;
  const qty = toNumber(amount.raw, amount.decimals);
  const usd = qty * price;
  return Number.isFinite(usd) ? usd : undefined;
}

// ---------------------------------------------------------------------------
// Row → transfer normalisation
// ---------------------------------------------------------------------------

interface NormalisedTransfer {
  from: string;
  to: string;
  hash: string;
  timestamp?: number;
  transfer: Transfer;
  /** Dedup key so a transfer seen from both of its endpoints is counted once. */
  sig: string;
}

/**
 * Turn a history row into a directed transfer relative to `node`, or
 * `undefined` when the row carries no traceable fund movement (failed tx,
 * zero-value call, self transfer, wrong direction, below `minUsd`, ...).
 */
function rowToTransfer(
  chain: ChainId,
  row: TxListItem,
  node: string,
  opts: Pick<TraceOptions, 'direction' | 'minUsd'>,
  provider: FlowProvider,
): NormalisedTransfer | undefined {
  if (!row || row.status === 'failed') return undefined;
  const from = nodeIdFor(chain, row.from ?? '');
  const to = row.to ? nodeIdFor(chain, row.to) : '';
  if (UNTRACEABLE.has(from.toLowerCase()) || UNTRACEABLE.has(to.toLowerCase())) return undefined;
  if (from === to) return undefined;
  if (from !== node && to !== node) return undefined;
  if (opts.direction === 'out' && from !== node) return undefined;
  if (opts.direction === 'in' && to !== node) return undefined;

  const tokenRow = row.token;
  const kind: Transfer['kind'] = tokenRow ? tokenRow.kind : 'native';
  const amount: Amount = tokenRow ? (tokenRow.amount ?? row.value) : row.value;
  if (!amount || typeof amount.raw !== 'bigint') return undefined;
  const nft = isNftKind(kind);
  if (amount.raw === 0n && !nft) return undefined;

  const tokenAddress = tokenRow?.tokenAddress;
  let price: number | undefined;
  if (!nft && provider.price) {
    price = tokenRow ? (tokenAddress ? provider.price(chain, tokenAddress) : undefined) : provider.price(chain);
  }
  const usd = usdOf(amount, price);
  if (opts.minUsd !== undefined && opts.minUsd > 0 && usd !== undefined && usd < opts.minUsd) return undefined;

  const transfer: Transfer = { kind, from, to, amount };
  if (tokenRow && tokenAddress) {
    transfer.token = {
      chain,
      address: tokenAddress,
      name: tokenRow.symbol,
      symbol: tokenRow.symbol,
      decimals: amount.decimals,
      type: tokenTypeFromKind(kind),
    };
  }
  if (usd !== undefined) transfer.usd = usd;

  const hash = row.hash ?? '';
  const sig = `${hash}|${from}|${to}|${kind}|${tokenAddress?.toLowerCase() ?? 'native'}|${amount.raw.toString()}`;
  return { from, to, hash, timestamp: row.timestamp, transfer, sig };
}

// ---------------------------------------------------------------------------
// traceFunds
// ---------------------------------------------------------------------------

interface Candidate {
  id: string;
  usd: number;
  count: number;
  order: number;
}

function snapshotGraph(g: FlowGraph): FlowGraph {
  return {
    root: g.root,
    chain: g.chain,
    nodes: g.nodes.map((n) => ({ ...n })),
    edges: g.edges.map((e) => ({ ...e, transfers: [...e.transfers], txHashes: [...e.txHashes] })),
    truncated: [...g.truncated],
    stats: { ...g.stats },
  };
}

/**
 * BFS fund-flow trace from `root`.
 *
 * - Every visited node's `tx` (and `token` when `includeTokens`) history is
 *   fetched through `provider.history`; rows are filtered by `direction`,
 *   zero-value calls / failed txs / self transfers are dropped and transfers
 *   below `minUsd` are ignored when a price is known.
 * - Transfers aggregate into one edge per (from, to); a transfer seen from
 *   both endpoints is counted once.
 * - Counterparties are ranked by USD (then transfer count); the top
 *   `maxFanOut` are expanded while their depth is below `maxHops`. Burn /
 *   pseudo addresses are never expanded, nor are labelled entities when
 *   `stopAtLabelled` (case tags excepted). Everything the tracer wanted to
 *   expand but could not is listed in `truncated`.
 * - `onProgress` fires once per visited node with a snapshot copy; an aborted
 *   `signal` rejects with `Error('Trace cancelled')` (name `AbortError`).
 * - A history failure on the root rejects; on any other node the node is
 *   recorded as truncated and the trace continues.
 */
export async function traceFunds(chain: ChainId, root: string, opts: TraceOptions, provider: FlowProvider): Promise<FlowGraph> {
  const started = Date.now();
  const signal = opts.signal;
  const maxHops = clamp(Math.floor(Number(opts.maxHops) || 1), 1, MAX_HOPS);
  const maxFanOut = Math.max(0, Math.floor(Number(opts.maxFanOut) || 0));
  const rootId = nodeIdFor(chain, root);
  if (!rootId) throw new Error('Trace root address is empty');
  if (isEvmChain(chain) && !EVM_ADDRESS_RE.test(rootId)) throw new Error(`Invalid EVM address: ${root}`);
  throwIfAborted(signal);

  const graph: FlowGraph = {
    root: rootId,
    chain,
    nodes: [],
    edges: [],
    truncated: [],
    stats: { hops: 0, txsScanned: 0, durationMs: 0, enrichedTxs: 0 },
  };
  const nodes = new Map<string, FlowNode>();
  const edges = new Map<string, FlowEdge>();
  const seenTransfers = new Set<string>();
  const enrichedHashes = new Set<string>();
  const expanded = new Set<string>();
  const failed = new Set<string>();
  const queued = new Set<string>();
  const truncated = new Set<string>();
  const queue: string[] = [];

  const ensureNode = (id: string, depth: number): FlowNode => {
    const existing = nodes.get(id);
    if (existing) {
      if (depth < existing.depth) existing.depth = depth;
      return existing;
    }
    const label = provider.label(displayAddress(chain, id), chain);
    const node: FlowNode = { id, chain, depth };
    if (label) node.label = label;
    const risk = riskFromLabel(label);
    if (risk) node.risk = risk;
    nodes.set(id, node);
    graph.nodes.push(node);
    return node;
  };

  const canExpand = (id: string): boolean => {
    if (isBurnAddress(id)) return false;
    if (opts.stopAtLabelled && isStopLabel(nodes.get(id)?.label)) return false;
    return true;
  };

  const finalise = (): void => {
    graph.truncated = Array.from(truncated).filter((id) => !expanded.has(id) || failed.has(id));
    graph.stats.hops = graph.nodes.reduce((m, n) => Math.max(m, n.depth), 0);
    graph.stats.durationMs = Date.now() - started;
  };

  const progress = (msg: string): void => {
    if (!opts.onProgress) return;
    finalise();
    opts.onProgress(msg, snapshotGraph(graph));
  };

  const fetchRows = async (address: string): Promise<TxListItem[]> => {
    const [native, tokens] = await Promise.all([
      provider.history(chain, address, 'tx', signal),
      opts.includeTokens ? provider.history(chain, address, 'token', signal) : Promise.resolve([] as TxListItem[]),
    ]);
    return [...(native ?? []), ...(tokens ?? [])];
  };

  ensureNode(rootId, 0);
  queue.push(rootId);
  queued.add(rootId);

  while (queue.length > 0) {
    throwIfAborted(signal);
    const id = queue.shift()!;
    const node = nodes.get(id)!;
    const address = displayAddress(chain, id);
    expanded.add(id);

    let rows: TxListItem[];
    try {
      rows = await fetchRows(address);
    } catch (err) {
      if (isAbort(err, signal)) throw cancelledError();
      if (id === rootId) throw err instanceof Error ? err : new Error(String(err));
      failed.add(id);
      truncated.add(id);
      progress(`Could not load history for ${shorten(address)}: ${errorMessage(err)}`);
      continue;
    }
    throwIfAborted(signal);
    graph.stats.txsScanned += rows.length;
    for (const row of rows) if (row?.enriched && row.hash) enrichedHashes.add(row.hash);
    graph.stats.enrichedTxs = enrichedHashes.size;

    if (provider.prefetchPrices) {
      try {
        await provider.prefetchPrices(chain, uniqueStrings(rows.map((r) => r.token?.tokenAddress)), signal);
      } catch (err) {
        if (isAbort(err, signal)) throw cancelledError();
        /* prices are optional */
      }
      throwIfAborted(signal);
    }

    if (provider.isContract && node.isContract === undefined) {
      try {
        node.isContract = await provider.isContract(chain, address, signal);
      } catch (err) {
        if (isAbort(err, signal)) throw cancelledError();
        /* unknown */
      }
      throwIfAborted(signal);
    }

    const candidates = new Map<string, Candidate>();
    for (const row of rows) {
      const t = rowToTransfer(chain, row, id, opts, provider);
      if (!t || seenTransfers.has(t.sig)) continue;
      seenTransfers.add(t.sig);

      const other = t.from === id ? t.to : t.from;
      ensureNode(other, node.depth + 1);

      const key = `${t.from}->${t.to}:${chain}`;
      let edge = edges.get(key);
      if (!edge) {
        edge = { id: key, source: t.from, target: t.to, chain, transfers: [], txHashes: [] };
        edges.set(key, edge);
        graph.edges.push(edge);
      }
      t.transfer.index = edge.transfers.length;
      edge.transfers.push(t.transfer);
      if (t.hash && !edge.txHashes.includes(t.hash)) edge.txHashes.push(t.hash);
      if (t.timestamp !== undefined) {
        edge.firstTs = edge.firstTs === undefined ? t.timestamp : Math.min(edge.firstTs, t.timestamp);
        edge.lastTs = edge.lastTs === undefined ? t.timestamp : Math.max(edge.lastTs, t.timestamp);
      }
      const usd = t.transfer.usd;
      if (usd !== undefined) {
        edge.totalUsd = (edge.totalUsd ?? 0) + usd;
        const src = nodes.get(t.from)!;
        const dst = nodes.get(t.to)!;
        src.totalOutUsd = (src.totalOutUsd ?? 0) + usd;
        dst.totalInUsd = (dst.totalInUsd ?? 0) + usd;
      }

      const c = candidates.get(other) ?? { id: other, usd: 0, count: 0, order: candidates.size };
      c.usd += usd ?? 0;
      c.count += 1;
      candidates.set(other, c);
    }

    const ranked = Array.from(candidates.values()).sort((a, b) => b.usd - a.usd || b.count - a.count || a.order - b.order);
    const expandable = ranked.filter((c) => !expanded.has(c.id) && !queued.has(c.id) && canExpand(c.id));
    const picked = node.depth + 1 < maxHops ? expandable.slice(0, maxFanOut) : [];
    for (const c of picked) {
      queue.push(c.id);
      queued.add(c.id);
    }
    for (const c of expandable.slice(picked.length)) truncated.add(c.id);

    progress(
      `Expanded ${node.label?.name ?? shorten(address)} (hop ${node.depth}): ${rows.length} rows, ${candidates.size} counterpart${candidates.size === 1 ? 'y' : 'ies'}, ${picked.length} queued`,
    );
  }

  finalise();
  return graph;
}

// ---------------------------------------------------------------------------
// Exports: CSV / JSON / summary
// ---------------------------------------------------------------------------

const CSV_COLUMNS = [
  'source',
  'source_label',
  'source_depth',
  'target',
  'target_label',
  'target_depth',
  'chain',
  'transfers',
  'tx_count',
  'total_usd',
  'first_seen',
  'last_seen',
  'assets',
  'tx_hashes',
] as const;

function csvCell(value: string | number | undefined): string {
  if (value === undefined) return '';
  let s = String(value);
  // Neutralise spreadsheet formula injection (CWE-1236): a text cell starting with
  // = + - @ TAB CR is evaluated by Excel / LibreOffice. Numeric columns are left as-is.
  const dangerous = typeof value === 'string' && /^[=+\-@\t\r]/.test(s);
  if (dangerous) s = `'${s}`;
  return dangerous || /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function isoDate(ts: number | undefined): string {
  return ts === undefined ? '' : new Date(ts * 1000).toISOString();
}

/** Aggregate an edge's transfers per asset: "1.5 ETH; 2,000 USDC; 2 BAYC". */
function describeAssets(transfers: readonly Transfer[]): string {
  const sums = new Map<string, { raw: bigint; decimals: number; symbol: string }>();
  for (const t of transfers) {
    const key = `${t.token?.address?.toLowerCase() ?? 'native'}:${t.amount.symbol}`;
    const cur = sums.get(key) ?? { raw: 0n, decimals: t.amount.decimals, symbol: t.amount.symbol };
    cur.raw += t.amount.raw;
    sums.set(key, cur);
  }
  return Array.from(sums.values())
    .map((s) => `${formatAmount(s.raw, s.decimals)} ${s.symbol}`)
    .join('; ');
}

/** One CSV row per edge (header + `edges.length` lines). */
export function graphToCsv(g: FlowGraph): string {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const lines: string[] = [CSV_COLUMNS.join(',')];
  for (const e of g.edges) {
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    const row: (string | number | undefined)[] = [
      displayAddress(g.chain, e.source),
      src?.label?.name,
      src?.depth,
      displayAddress(g.chain, e.target),
      dst?.label?.name,
      dst?.depth,
      e.chain,
      e.transfers.length,
      e.txHashes.length,
      e.totalUsd === undefined ? '' : e.totalUsd.toFixed(2),
      isoDate(e.firstTs),
      isoDate(e.lastTs),
      describeAssets(e.transfers),
      e.txHashes.join(';'),
    ];
    lines.push(row.map(csvCell).join(','));
  }
  return lines.join('\n');
}

export const FLOW_EXPORT_FORMAT = 'loxdetective-flow';
export const FLOW_EXPORT_VERSION = 1;

/** Pretty-printed JSON export; bigint amounts are serialised as decimal strings. */
export function graphToJson(g: FlowGraph): string {
  const payload = { format: FLOW_EXPORT_FORMAT, version: FLOW_EXPORT_VERSION, exportedAt: new Date().toISOString(), graph: g };
  return JSON.stringify(payload, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2);
}

export interface GraphSummary {
  topSinks: FlowNode[];
  topSources: FlowNode[];
  labelledEndpoints: FlowNode[];
  totalNodes: number;
  totalEdges: number;
}

/**
 * Top receivers / senders (excluding the root) ranked by USD, falling back to
 * transfer counts when no price was known, plus every labelled node.
 */
export function summarizeGraph(g: FlowGraph, limit = 5): GraphSummary {
  const inCount = new Map<string, number>();
  const outCount = new Map<string, number>();
  for (const e of g.edges) {
    inCount.set(e.target, (inCount.get(e.target) ?? 0) + e.transfers.length);
    outCount.set(e.source, (outCount.get(e.source) ?? 0) + e.transfers.length);
  }
  const others = g.nodes.filter((n) => n.id !== g.root);
  const rank = (usd: (n: FlowNode) => number, count: Map<string, number>) => (a: FlowNode, b: FlowNode) =>
    usd(b) - usd(a) || (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0) || a.depth - b.depth;

  const topSinks = others
    .filter((n) => (n.totalInUsd ?? 0) > 0 || (inCount.get(n.id) ?? 0) > 0)
    .sort(rank((n) => n.totalInUsd ?? 0, inCount))
    .slice(0, Math.max(0, limit));
  const topSources = others
    .filter((n) => (n.totalOutUsd ?? 0) > 0 || (outCount.get(n.id) ?? 0) > 0)
    .sort(rank((n) => n.totalOutUsd ?? 0, outCount))
    .slice(0, Math.max(0, limit));
  const total = (n: FlowNode) => (n.totalInUsd ?? 0) + (n.totalOutUsd ?? 0);
  const totalCount = new Map<string, number>();
  for (const n of others) totalCount.set(n.id, (inCount.get(n.id) ?? 0) + (outCount.get(n.id) ?? 0));
  const labelledEndpoints = others.filter((n) => !!n.label).sort(rank(total, totalCount));

  return { topSinks, topSources, labelledEndpoints, totalNodes: g.nodes.length, totalEdges: g.edges.length };
}

// ---------------------------------------------------------------------------
// Default provider (real data sources, lazily imported)
// ---------------------------------------------------------------------------

export interface DefaultFlowProvider extends FlowProvider {
  isContract(chain: ChainId, address: string, signal?: AbortSignal): Promise<boolean>;
  price(chain: ChainId, tokenAddress?: string): number | undefined;
  prefetchPrices(chain: ChainId, tokenAddresses: string[], signal?: AbortSignal): Promise<void>;
}

/**
 * Wires the real providers: EVM history via the evm façade (up to two pages
 * of `tx` and `token` rows), Bitcoin via `btcHistoryDetailed` (up to two
 * Esplora pages, one row per counterparty so a batch payout becomes N edges),
 * Solana via `getSignaturesForAddress` enriched with `solEnrichHistory` for
 * the newest signatures; labels from the registry (+ sanctions); contract
 * detection via `eth_getCode` (cached); prices from DefiLlama through
 * `prefetchPrices`.
 */
export function createDefaultFlowProvider(): DefaultFlowProvider {
  const priceMap = new Map<string, number>();
  const contractCache = new Map<string, Promise<boolean>>();
  const solRowsCache = new Map<string, Promise<TxListItem[]>>();

  const priceMapKey = (chain: ChainId, token?: string): string => {
    const t = (token ?? '').trim();
    if (!t || t.toLowerCase() === 'native') return `${chain}:native`;
    return `${chain}:${isEvmChain(chain) ? t.toLowerCase() : t}`;
  };

  async function evmHistory(chain: ChainId, address: string, kind: 'tx' | 'token', signal?: AbortSignal): Promise<TxListItem[]> {
    const info = findChain(chain);
    if (!info) throw new Error(`Unknown chain: ${chain}`);
    const out: TxListItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < DEFAULT_EVM_PAGES; page++) {
      try {
        const res = await getAddressHistory(info, address, { cursor, kind }, signal);
        out.push(...res.items);
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      } catch (err) {
        if (isAbort(err, signal)) throw err;
        // The first page of native history is essential (its error carries the
        // "add an API key" hint for the UI); token rows and later pages are optional.
        if (page === 0 && kind === 'tx') throw err;
        console.warn(`[trace] ${kind} history page ${page + 1} unavailable for ${shorten(address)} on ${chain}:`, errorMessage(err));
        break;
      }
    }
    return out;
  }

  async function btcHistory(address: string, kind: 'tx' | 'token', signal?: AbortSignal): Promise<TxListItem[]> {
    if (kind === 'token') return [];
    return btcHistoryDetailed(address, { pages: DEFAULT_BTC_PAGES, signal });
  }

  /** Signature page + enrichment, shared by the `tx` and `token` kinds of one node. */
  function solEnrichedRows(address: string, signal?: AbortSignal): Promise<TxListItem[]> {
    const cached = solRowsCache.get(address);
    if (cached) return cached;
    const p = (async () => {
      const page = await solSignatures(address, undefined, SOL_SIGNATURE_PAGE, signal);
      return solEnrichHistory(address, page.items, { limit: SOL_ENRICH_LIMIT, concurrency: SOL_ENRICH_CONCURRENCY, signal });
    })();
    solRowsCache.set(address, p);
    p.catch(() => solRowsCache.delete(address));
    return p;
  }

  async function solHistory(address: string, kind: 'tx' | 'token', signal?: AbortSignal): Promise<TxListItem[]> {
    const rows = await solEnrichedRows(address, signal);
    // Signature-only rows (not enriched) carry no counterparty and are dropped by the tracer anyway.
    return rows.filter((r) => r.enriched && (kind === 'token' ? !!r.token : !r.token));
  }

  return {
    async history(chain, address, kind, signal) {
      const family = findChain(chain)?.family;
      if (family === 'bitcoin') return btcHistory(address, kind, signal);
      if (family === 'solana') return solHistory(address, kind, signal);
      return evmHistory(chain, address, kind, signal);
    },

    label(address, chain) {
      return lookupLabel(address, chain) ?? isSanctioned(address);
    },

    isContract(chain, address, signal) {
      const info = findChain(chain);
      if (!info) return Promise.resolve(false);
      const key = `${chain}:${nodeIdFor(chain, address)}`;
      const cached = contractCache.get(key);
      if (cached) return cached;
      const p = (async () => {
        if (info.family === 'evm') {
          return (await getCode(info, address, signal)) !== '0x';
        }
        if (info.family === 'solana') {
          return (await solAddressSummary(address, signal)).executable;
        }
        return false;
      })();
      contractCache.set(key, p);
      p.catch(() => contractCache.delete(key));
      return p;
    },

    price(chain, tokenAddress) {
      return priceMap.get(priceMapKey(chain, tokenAddress));
    },

    async prefetchPrices(chain, tokenAddresses, signal) {
      const info = findChain(chain);
      if (!info) return;
      const wanted: { mapKey: string; llamaKey: string }[] = [];
      const nativeKey = priceMapKey(chain);
      if (!priceMap.has(nativeKey)) wanted.push({ mapKey: nativeKey, llamaKey: priceKeyForToken(info, '') });
      for (const token of uniqueStrings(tokenAddresses)) {
        const mapKey = priceMapKey(chain, token);
        if (!priceMap.has(mapKey)) wanted.push({ mapKey, llamaKey: priceKeyForToken(info, token) });
      }
      if (wanted.length === 0) return;
      // getPrices never throws (except on abort) and caches misses for 5 minutes,
      // so unresolved keys are cheap to re-request on the next node.
      const got = await getPrices(
        wanted.map((w) => w.llamaKey),
        signal,
      );
      for (const w of wanted) {
        const p = got[w.llamaKey];
        if (p !== undefined) priceMap.set(w.mapKey, p);
      }
    },
  };
}
