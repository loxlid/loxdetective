// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { getAddress } from 'viem';
import { registerLabels } from '@/lib/intel/labels';
import { BUILTIN_SANCTIONED } from '@/lib/intel/sanctions';
import {
  createDefaultFlowProvider,
  displayAddress,
  graphToCsv,
  graphToJson,
  nodeIdFor,
  summarizeGraph,
  traceFunds,
  type FlowProvider,
} from '@/lib/trace/flow';
import FlowGraph from '@/components/FlowGraph';
import type { AddressLabel, ChainId, FlowGraph as FlowGraphData, TraceOptions, Transfer, TxListItem, TxStatus } from '@/lib/types';

// ---------------------------------------------------------------------------
// In-memory fake provider
// ---------------------------------------------------------------------------

const addr = (c: string) => `0x${c.repeat(40)}`;
const A = addr('a');
const B = addr('b');
const C = addr('c');
const D = addr('d');
const E = addr('e');
const F = addr('f');
const X = addr('1');
const Y = addr('2');
const Z = addr('3');
const X2 = addr('4');
const Y2 = addr('5');
const Z2 = addr('6');
const ZERO = addr('0');
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const ETH = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

interface Row {
  hash: string;
  from: string;
  to?: string;
  value?: bigint;
  token?: { symbol: string; amount: bigint; decimals: number; address?: string; kind: Transfer['kind'] };
  ts?: number;
  status?: TxStatus;
}

interface FakeProvider extends FlowProvider {
  historyCalls: string[];
  prefetchCalls: string[][];
  priceMap: Record<string, number>;
}

function toItem(chain: ChainId, r: Row, address: string): TxListItem {
  const lc = address.toLowerCase();
  const from = r.from;
  const to = r.to;
  const direction: TxListItem['direction'] =
    from.toLowerCase() === lc && to?.toLowerCase() === lc ? 'self' : from.toLowerCase() === lc ? 'out' : to?.toLowerCase() === lc ? 'in' : 'unknown';
  const value = r.token ? { raw: r.token.amount, decimals: r.token.decimals, symbol: r.token.symbol } : { raw: r.value ?? 0n, decimals: 18, symbol: 'ETH' };
  return {
    chain,
    hash: r.hash,
    timestamp: r.ts,
    blockNumber: 1,
    from,
    to,
    value,
    status: r.status ?? 'success',
    direction,
    token: r.token ? { symbol: r.token.symbol, amount: value, tokenAddress: r.token.address, kind: r.token.kind } : undefined,
  };
}

function makeProvider(
  rows: Row[],
  opts: {
    labels?: Record<string, Partial<AddressLabel>>;
    prices?: Record<string, number>;
    contracts?: string[];
    failFor?: string[];
    withPrefetch?: boolean;
  } = {},
): FakeProvider {
  const labels = new Map(Object.entries(opts.labels ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const contracts = new Set((opts.contracts ?? []).map((a) => a.toLowerCase()));
  const failFor = new Set((opts.failFor ?? []).map((a) => a.toLowerCase()));
  const p: FakeProvider = {
    historyCalls: [],
    prefetchCalls: [],
    priceMap: { ...(opts.prices ?? {}) },
    async history(chain, address, kind) {
      p.historyCalls.push(`${address.toLowerCase()}:${kind}`);
      if (failFor.has(address.toLowerCase())) throw new Error(`No history provider for ${chain}; add an Etherscan API key in Settings`);
      const lc = address.toLowerCase();
      return rows
        .filter((r) => (kind === 'token' ? !!r.token : !r.token))
        .filter((r) => r.from.toLowerCase() === lc || r.to?.toLowerCase() === lc)
        .map((r) => toItem(chain, r, address));
    },
    label(address) {
      const l = labels.get(address.toLowerCase());
      return l ? { address, name: 'Label', category: 'other', source: 'test', ...l } : undefined;
    },
    price(_chain, token) {
      return token ? p.priceMap[token.toLowerCase()] : p.priceMap.native;
    },
  };
  if (opts.contracts) {
    p.isContract = async (_chain, address) => contracts.has(address.toLowerCase());
  }
  if (opts.withPrefetch) {
    p.prefetchPrices = async (_chain, tokens) => {
      p.prefetchCalls.push(tokens);
      for (const t of tokens) if (t.toLowerCase() === USDC.toLowerCase()) p.priceMap[USDC.toLowerCase()] = 1;
    };
  }
  return p;
}

const baseOpts: TraceOptions = { maxHops: 2, maxFanOut: 5, direction: 'out', stopAtLabelled: true, includeTokens: true };
const trace = (rows: Row[], opts: Partial<TraceOptions> = {}, provider?: FakeProvider) =>
  traceFunds('ethereum', A, { ...baseOpts, ...opts }, provider ?? makeProvider(rows, { prices: { native: 2000 } }));

const ids = (g: FlowGraphData) => g.nodes.map((n) => n.id).sort();
const node = (g: FlowGraphData, id: string) => g.nodes.find((n) => n.id === id.toLowerCase());
const edge = (g: FlowGraphData, from: string, to: string) => g.edges.find((e) => e.id === `${from.toLowerCase()}->${to.toLowerCase()}:ethereum`);

// ---------------------------------------------------------------------------
// traceFunds
// ---------------------------------------------------------------------------

describe('traceFunds', () => {
  it('builds nodes and edges from the root outgoing transfers with USD totals', async () => {
    const g = await trace([
      { hash: hash(1), from: A, to: B, value: ETH(1), ts: 100 },
      { hash: hash(2), from: A, to: C, value: ETH(2), ts: 200 },
    ], { maxHops: 1 });
    expect(g.root).toBe(A);
    expect(g.chain).toBe('ethereum');
    expect(ids(g)).toEqual([A, B, C].sort());
    expect(node(g, A)?.depth).toBe(0);
    expect(node(g, B)?.depth).toBe(1);
    expect(g.edges).toHaveLength(2);
    expect(edge(g, A, B)?.totalUsd).toBeCloseTo(2000);
    expect(edge(g, A, B)?.txHashes).toEqual([hash(1)]);
    expect(edge(g, A, B)?.firstTs).toBe(100);
    expect(node(g, A)?.totalOutUsd).toBeCloseTo(6000);
    expect(node(g, C)?.totalInUsd).toBeCloseTo(4000);
    expect(g.stats.txsScanned).toBe(2);
    expect(g.stats.hops).toBe(1);
    // With one hop the counterparties would have been expanded but were not.
    expect(g.truncated.sort()).toEqual([B, C].sort());
  });

  it('respects maxHops', async () => {
    const rows: Row[] = [
      { hash: hash(1), from: A, to: B, value: ETH(1) },
      { hash: hash(2), from: B, to: C, value: ETH(1) },
      { hash: hash(3), from: C, to: D, value: ETH(1) },
    ];
    const one = await trace(rows, { maxHops: 1 });
    expect(ids(one)).toEqual([A, B].sort());
    const two = await trace(rows, { maxHops: 2 });
    expect(ids(two)).toEqual([A, B, C].sort());
    expect(two.stats.hops).toBe(2);
    expect(two.truncated).toEqual([C]);
    const four = await trace(rows, { maxHops: 4 });
    expect(ids(four)).toEqual([A, B, C, D].sort());
    expect(four.truncated).toEqual([]);
  });

  it('expands only the top maxFanOut counterparties ranked by USD', async () => {
    const rows: Row[] = [
      { hash: hash(1), from: A, to: Z, value: ETH(0.1) },
      { hash: hash(2), from: A, to: X, value: ETH(2.5) },
      { hash: hash(3), from: A, to: Y, value: ETH(0.5) },
      { hash: hash(4), from: X, to: X2, value: ETH(1) },
      { hash: hash(5), from: Y, to: Y2, value: ETH(1) },
      { hash: hash(6), from: Z, to: Z2, value: ETH(1) },
    ];
    const g = await trace(rows, { maxFanOut: 1, maxHops: 2 });
    expect(ids(g)).toEqual([A, X, Y, Z, X2].sort());
    // Y and Z lost the fan-out race; X2 sits at the hop limit.
    expect(g.truncated.sort()).toEqual([Y, Z, X2].sort());
    expect(node(g, X2)?.depth).toBe(2);
  });

  it('ranks by transfer count when no price is known', async () => {
    const rows: Row[] = [
      { hash: hash(1), from: A, to: X, value: ETH(10) },
      { hash: hash(2), from: A, to: Y, value: ETH(1) },
      { hash: hash(3), from: A, to: Y, value: ETH(1) },
      { hash: hash(4), from: X, to: X2, value: ETH(1) },
      { hash: hash(5), from: Y, to: Y2, value: ETH(1) },
    ];
    const g = await trace(rows, { maxFanOut: 1 }, makeProvider(rows));
    expect(ids(g)).toEqual([A, X, Y, Y2].sort());
    expect(edge(g, A, Y)?.totalUsd).toBeUndefined();
    expect(node(g, Y)?.totalInUsd).toBeUndefined();
  });

  it('honours direction in / out / both', async () => {
    const rows: Row[] = [
      { hash: hash(1), from: A, to: B, value: ETH(1) },
      { hash: hash(2), from: C, to: A, value: ETH(1) },
    ];
    const out = await trace(rows, { direction: 'out', maxHops: 1 });
    expect(ids(out)).toEqual([A, B].sort());
    const inn = await trace(rows, { direction: 'in', maxHops: 1 });
    expect(ids(inn)).toEqual([A, C].sort());
    expect(inn.edges[0].source).toBe(C);
    expect(inn.edges[0].target).toBe(A);
    const both = await trace(rows, { direction: 'both', maxHops: 1 });
    expect(ids(both)).toEqual([A, B, C].sort());
    expect(node(both, A)?.totalInUsd).toBeCloseTo(2000);
    expect(node(both, A)?.totalOutUsd).toBeCloseTo(2000);
  });

  it('stops at labelled entities as leaves when stopAtLabelled, except case tags', async () => {
    const rows: Row[] = [
      { hash: hash(1), from: A, to: B, value: ETH(1) },
      { hash: hash(2), from: B, to: C, value: ETH(1) },
      { hash: hash(3), from: A, to: D, value: ETH(1) },
      { hash: hash(4), from: D, to: E, value: ETH(1) },
    ];
    const labels = { [B]: { name: 'Binance 14', category: 'exchange' as const }, [D]: { name: 'Suspect wallet', category: 'wallet' as const, source: 'case' } };
    const stopped = await trace(rows, { maxHops: 3 }, makeProvider(rows, { labels, prices: { native: 2000 } }));
    expect(ids(stopped)).toEqual([A, B, D, E].sort());
    expect(node(stopped, B)?.label?.name).toBe('Binance 14');
    expect(stopped.truncated).toEqual([]);
    expect(stopped.edges.some((e) => e.source === B)).toBe(false);

    const open = await trace(rows, { maxHops: 3, stopAtLabelled: false }, makeProvider(rows, { labels, prices: { native: 2000 } }));
    expect(ids(open)).toEqual([A, B, C, D, E].sort());
  });

  it('never expands burn / null addresses', async () => {
    const rows: Row[] = [{ hash: hash(1), from: A, to: ZERO, value: ETH(1) }];
    const provider = makeProvider(rows, { prices: { native: 2000 } });
    const g = await trace(rows, { maxHops: 3 }, provider);
    expect(ids(g)).toEqual([A, ZERO].sort());
    expect(g.truncated).toEqual([]);
    expect(provider.historyCalls.filter((c) => c.startsWith(ZERO))).toHaveLength(0);
  });

  it('terminates on cycles and visits each address once', async () => {
    const rows: Row[] = [
      { hash: hash(1), from: A, to: B, value: ETH(1) },
      { hash: hash(2), from: B, to: A, value: ETH(1) },
      { hash: hash(3), from: B, to: C, value: ETH(1) },
      { hash: hash(4), from: C, to: A, value: ETH(1) },
    ];
    const provider = makeProvider(rows, { prices: { native: 2000 } });
    const g = await trace(rows, { maxHops: 4, direction: 'both' }, provider);
    expect(ids(g)).toEqual([A, B, C].sort());
    expect(g.edges.map((e) => e.id).sort()).toEqual([`${A}->${B}:ethereum`, `${B}->${A}:ethereum`, `${B}->${C}:ethereum`, `${C}->${A}:ethereum`].sort());
    const txCalls = provider.historyCalls.filter((c) => c.endsWith(':tx'));
    expect(new Set(txCalls).size).toBe(txCalls.length);
    expect(txCalls).toHaveLength(3);
  });

  it('aggregates several transfers (native + token) on one edge', async () => {
    const rows: Row[] = [
      { hash: hash(1), from: A, to: B, value: ETH(1), ts: 10 },
      { hash: hash(2), from: A, to: B, value: ETH(2), ts: 30 },
      { hash: hash(2), from: A, to: B, token: { symbol: 'USDC', amount: 100_000_000n, decimals: 6, address: USDC, kind: 'ERC-20' }, ts: 30 },
    ];
    const provider = makeProvider(rows, { prices: { native: 2000, [USDC.toLowerCase()]: 1 } });
    const g = await trace(rows, { maxHops: 1 }, provider);
    const e = edge(g, A, B)!;
    expect(e.transfers).toHaveLength(3);
    expect(e.transfers.map((t) => t.kind)).toEqual(['native', 'native', 'ERC-20']);
    expect(e.transfers[2].token?.address).toBe(USDC);
    expect(e.txHashes).toEqual([hash(1), hash(2)]);
    expect(e.totalUsd).toBeCloseTo(2000 + 4000 + 100);
    expect(e.firstTs).toBe(10);
    expect(e.lastTs).toBe(30);
    expect(g.edges).toHaveLength(1);
  });

  it('counts a transfer seen from both endpoints once', async () => {
    const rows: Row[] = [
      { hash: hash(1), from: A, to: B, value: ETH(1) },
      { hash: hash(2), from: B, to: C, value: ETH(1) },
    ];
    const g = await trace(rows, { maxHops: 3, direction: 'both' });
    expect(edge(g, A, B)?.transfers).toHaveLength(1);
    expect(edge(g, B, C)?.transfers).toHaveLength(1);
    expect(node(g, B)?.totalInUsd).toBeCloseTo(2000);
    expect(node(g, B)?.totalOutUsd).toBeCloseTo(2000);
  });

  it('applies minUsd only when a price is known', async () => {
    const rows: Row[] = [
      { hash: hash(1), from: A, to: B, value: ETH(0.001) },
      { hash: hash(2), from: A, to: C, value: ETH(1) },
      { hash: hash(3), from: A, to: D, token: { symbol: 'MEME', amount: 5n, decimals: 0, address: addr('9'), kind: 'ERC-20' } },
    ];
    const g = await trace(rows, { maxHops: 1, minUsd: 10 });
    expect(ids(g)).toEqual([A, C, D].sort());
  });

  it('skips zero-value calls, failed transactions and self transfers', async () => {
    const rows: Row[] = [
      { hash: hash(1), from: A, to: B, value: 0n },
      { hash: hash(2), from: A, to: C, value: ETH(1), status: 'failed' },
      { hash: hash(3), from: A, to: A, value: ETH(1) },
      { hash: hash(4), from: A, to: D, value: ETH(1) },
      { hash: hash(5), from: A, to: E, token: { symbol: 'BAYC', amount: 1n, decimals: 0, address: addr('8'), kind: 'ERC-721' } },
    ];
    const g = await trace(rows, { maxHops: 1 });
    expect(ids(g)).toEqual([A, D, E].sort());
    expect(edge(g, A, E)?.transfers[0].usd).toBeUndefined();
  });

  it('does not fetch token history when includeTokens is false', async () => {
    const rows: Row[] = [
      { hash: hash(1), from: A, to: B, value: ETH(1) },
      { hash: hash(2), from: A, to: C, token: { symbol: 'USDC', amount: 1_000_000n, decimals: 6, address: USDC, kind: 'ERC-20' } },
    ];
    const provider = makeProvider(rows, { prices: { native: 2000 } });
    const g = await trace(rows, { maxHops: 1, includeTokens: false }, provider);
    expect(ids(g)).toEqual([A, B].sort());
    expect(provider.historyCalls.some((c) => c.endsWith(':token'))).toBe(false);
  });

  it('rejects with "Trace cancelled" when the signal aborts', async () => {
    const ctrl = new AbortController();
    const provider = makeProvider([], {});
    provider.history = () =>
      new Promise((_resolve, reject) => {
        ctrl.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')), { once: true });
      });
    const run = trace([], { signal: ctrl.signal }, provider);
    ctrl.abort();
    await expect(run).rejects.toThrow('Trace cancelled');
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects immediately on a pre-aborted signal without calling the provider', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const provider = makeProvider([], {});
    await expect(trace([], { signal: ctrl.signal }, provider)).rejects.toThrow('Trace cancelled');
    expect(provider.historyCalls).toHaveLength(0);
  });

  it('calls onProgress once per visited node with an independent snapshot', async () => {
    const rows: Row[] = [
      { hash: hash(1), from: A, to: B, value: ETH(1) },
      { hash: hash(2), from: B, to: C, value: ETH(1) },
    ];
    const seen: { msg: string; nodes: number }[] = [];
    const onProgress = vi.fn((msg: string, snapshot: FlowGraphData) => {
      seen.push({ msg, nodes: snapshot.nodes.length });
      snapshot.nodes.length = 0; // mutating the snapshot must not affect the trace
      snapshot.edges[0]?.transfers.splice(0);
    });
    const g = await trace(rows, { maxHops: 2, onProgress });
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(seen[0].msg).toMatch(/^Expanded/);
    expect(seen[0].nodes).toBe(2);
    expect(seen[1].nodes).toBe(3);
    expect(g.nodes).toHaveLength(3);
    expect(g.edges[0].transfers).toHaveLength(1);
  });

  it('throws when the root history fails but tolerates failures on deeper nodes', async () => {
    const rows: Row[] = [
      { hash: hash(1), from: A, to: B, value: ETH(1) },
      { hash: hash(2), from: A, to: C, value: ETH(1) },
      { hash: hash(3), from: C, to: D, value: ETH(1) },
    ];
    await expect(trace(rows, {}, makeProvider(rows, { failFor: [A] }))).rejects.toThrow(/No history provider/);
    const g = await trace(rows, { maxHops: 2 }, makeProvider(rows, { failFor: [B], prices: { native: 2000 } }));
    expect(ids(g)).toEqual([A, B, C, D].sort());
    // B failed to load; D sits at the hop limit.
    expect(g.truncated).toEqual([B, D]);
  });

  it('prefetches prices for the token addresses of each node before scoring', async () => {
    const rows: Row[] = [{ hash: hash(1), from: A, to: B, token: { symbol: 'USDC', amount: 250_000_000n, decimals: 6, address: USDC, kind: 'ERC-20' } }];
    const provider = makeProvider(rows, { withPrefetch: true });
    const g = await trace(rows, { maxHops: 1 }, provider);
    expect(provider.prefetchCalls).toEqual([[USDC]]);
    expect(edge(g, A, B)?.totalUsd).toBeCloseTo(250);
  });

  it('marks contracts via provider.isContract and tolerates its failures', async () => {
    const rows: Row[] = [{ hash: hash(1), from: A, to: X, value: ETH(1) }];
    const provider = makeProvider(rows, { contracts: [X], prices: { native: 2000 } });
    const g = await trace(rows, { maxHops: 2 }, provider);
    expect(node(g, A)?.isContract).toBe(false);
    expect(node(g, X)?.isContract).toBe(true);

    const flaky = makeProvider(rows, { contracts: [X] });
    flaky.isContract = async () => {
      throw new Error('rpc down');
    };
    const g2 = await trace(rows, { maxHops: 2 }, flaky);
    expect(node(g2, A)?.isContract).toBeUndefined();
  });

  it('derives a node risk from sanctioned / mixer labels', async () => {
    const rows: Row[] = [
      { hash: hash(1), from: A, to: B, value: ETH(1) },
      { hash: hash(2), from: A, to: C, value: ETH(1) },
    ];
    const labels = { [B]: { name: 'Lazarus Group', category: 'sanctioned' as const }, [C]: { name: 'Tornado Cash', category: 'mixer' as const } };
    const g = await trace(rows, { maxHops: 1 }, makeProvider(rows, { labels }));
    expect(node(g, B)?.risk).toBe('critical');
    expect(node(g, C)?.risk).toBe('high');
    expect(node(g, A)?.risk).toBeUndefined();
  });

  it('lower-cases EVM ids and keeps base58 ids verbatim', async () => {
    const upper = A.toUpperCase().replace('0X', '0x');
    const rows: Row[] = [{ hash: hash(1), from: upper, to: B.toUpperCase().replace('0X', '0x'), value: ETH(1) }];
    const g = await traceFunds('ethereum', upper, { ...baseOpts, maxHops: 1 }, makeProvider(rows));
    expect(g.root).toBe(A);
    expect(ids(g)).toEqual([A, B].sort());
    expect(g.edges[0].transfers[0].from).toBe(A);

    const SOL_A = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
    const SOL_B = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS';
    const solProvider = makeProvider([], {});
    solProvider.history = async (chain, address) =>
      address === SOL_A
        ? [{ chain, hash: 'sig1', from: SOL_A, to: SOL_B, value: { raw: 10n ** 9n, decimals: 9, symbol: 'SOL' }, status: 'success', direction: 'out' }]
        : [];
    const sg = await traceFunds('solana', SOL_A, { ...baseOpts, maxHops: 1 }, solProvider);
    expect(sg.root).toBe(SOL_A);
    expect(sg.nodes.map((n) => n.id)).toEqual([SOL_A, SOL_B]);
    expect(nodeIdFor('solana', SOL_B)).toBe(SOL_B);
    expect(displayAddress('solana', SOL_B)).toBe(SOL_B);
    expect(displayAddress('ethereum', A)).toBe(getAddress(A));
    expect(displayAddress('ethereum', USDC.toLowerCase())).toBe(USDC);
  });

  it('rejects an invalid EVM root', async () => {
    await expect(traceFunds('ethereum', 'not-an-address', baseOpts, makeProvider([]))).rejects.toThrow(/Invalid EVM address/);
    await expect(traceFunds('ethereum', '  ', baseOpts, makeProvider([]))).rejects.toThrow(/empty/);
  });
});

// ---------------------------------------------------------------------------
// Exports & summary
// ---------------------------------------------------------------------------

describe('graphToCsv / graphToJson / summarizeGraph', () => {
  const rows: Row[] = [
    { hash: hash(1), from: A, to: B, value: ETH(1), ts: 1_700_000_000 },
    { hash: hash(2), from: A, to: C, value: ETH(3), ts: 1_700_000_100 },
    { hash: hash(3), from: A, to: C, token: { symbol: 'USDC', amount: 50_000_000n, decimals: 6, address: USDC, kind: 'ERC-20' }, ts: 1_700_000_200 },
    { hash: hash(4), from: C, to: D, value: ETH(2) },
    { hash: hash(5), from: F, to: A, value: ETH(5) },
  ];
  const labels = { [C]: { name: 'Acme, Inc. "hot" wallet', category: 'exchange' as const }, [D]: { name: 'Burner', category: 'wallet' as const, source: 'case' } };
  const provider = () => makeProvider(rows, { labels, prices: { native: 2000, [USDC.toLowerCase()]: 1 } });

  it('graphToCsv emits a header and one row per edge with CSV escaping', async () => {
    const g = await trace(rows, { maxHops: 3, direction: 'both', stopAtLabelled: false }, provider());
    const csv = graphToCsv(g);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('source,source_label,source_depth,target,target_label,target_depth,chain,transfers,tx_count,total_usd,first_seen,last_seen,assets,tx_hashes');
    expect(lines).toHaveLength(1 + g.edges.length);
    const acme = lines.find((l) => l.includes('Acme'))!;
    expect(acme).toContain('"Acme, Inc. ""hot"" wallet"');
    const ac = lines.find((l) => l.startsWith(`${displayAddress('ethereum', A)},,0,${displayAddress('ethereum', C)}`))!;
    expect(ac).toContain(',2,2,6050.00,2023-11-14T22:15:00.000Z,2023-11-14T22:16:40.000Z,3 ETH; 50 USDC,');
    expect(ac).toContain(`${hash(2)};${hash(3)}`);
  });

  it('graphToCsv neutralises spreadsheet formula injection in text cells only', async () => {
    const injected = { [C]: { name: '=1+1', category: 'exchange' as const }, [D]: { name: '-foo', category: 'wallet' as const, source: 'case' }, [B]: { name: '@cmd', category: 'other' as const } };
    const g = await trace(rows, { maxHops: 3, direction: 'both', stopAtLabelled: false }, makeProvider(rows, { labels: injected, prices: { native: 2000, [USDC.toLowerCase()]: 1 } }));
    const csv = graphToCsv(g);
    expect(csv).toContain('"\'=1+1"');
    expect(csv).toContain('"\'-foo"');
    expect(csv).toContain('"\'@cmd"');
    expect(csv).not.toMatch(/(^|,)[=+\-@]/m);
    const ac = csv.split('\n').find((l) => l.startsWith(`${displayAddress('ethereum', A)},,0,${displayAddress('ethereum', C)}`))!;
    expect(ac).toContain(',2,2,6050.00,');
  });

  it('graphToJson serialises bigints as strings in a versioned envelope', async () => {
    const g = await trace(rows, { maxHops: 1 }, provider());
    const parsed = JSON.parse(graphToJson(g)) as { format: string; version: number; graph: { edges: { transfers: { amount: { raw: string } }[] }[]; root: string } };
    expect(parsed.format).toBe('loxdetective-flow');
    expect(parsed.version).toBe(1);
    expect(parsed.graph.root).toBe(A);
    expect(parsed.graph.edges[0].transfers[0].amount.raw).toBe(ETH(1).toString());
  });

  it('summarizeGraph ranks sinks and sources by USD and lists labelled endpoints', async () => {
    const g = await trace(rows, { maxHops: 3, direction: 'both', stopAtLabelled: false }, provider());
    const s = summarizeGraph(g);
    expect(s.totalNodes).toBe(g.nodes.length);
    expect(s.totalEdges).toBe(g.edges.length);
    expect(s.topSinks.map((n) => n.id)).toEqual([C, D, B]);
    expect(s.topSources.map((n) => n.id)).toEqual([F, C]);
    expect(s.labelledEndpoints.map((n) => n.id)).toEqual([C, D]);
    expect(s.topSinks.some((n) => n.id === A)).toBe(false);
    expect(summarizeGraph(g, 1).topSinks.map((n) => n.id)).toEqual([C]);
  });

  it('summarizeGraph falls back to transfer counts without prices', async () => {
    const g = await trace(rows, { maxHops: 1, direction: 'both' }, makeProvider(rows));
    const s = summarizeGraph(g);
    expect(s.topSinks.map((n) => n.id)).toEqual([C, B]);
    expect(s.topSources.map((n) => n.id)).toEqual([F]);
  });
});

// ---------------------------------------------------------------------------
// Default provider over mocked HTTP
// ---------------------------------------------------------------------------

interface RpcBody {
  method: string;
  params: unknown[];
}
type Route = (url: URL, body: RpcBody | undefined) => { status?: number; body: unknown } | undefined;

function installFetch(route: Route) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as RpcBody & { id?: number }) : undefined;
    const out = route(url, body) ?? { status: 404, body: { message: 'Not found' } };
    const status = out.status ?? 200;
    const payload = body && status === 200 && !(out.body as { jsonrpc?: string })?.jsonrpc ? { jsonrpc: '2.0', id: body.id, result: out.body } : out.body;
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const BTC_ADDR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const BTC_OTHER = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const SOL_PAYER = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
const SOL_RECIPIENT = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS';
const SOL_SIG_OK = '5'.repeat(87);
const SOL_SIG_FAIL = '4'.repeat(87);

function bsTx(h: string, from: string, to: string, value: string) {
  return { hash: h, timestamp: '2024-05-01T12:00:00.000000Z', block_number: 19_000_000, from: { hash: from }, to: { hash: to }, value, status: 'ok', method: null };
}

describe('createDefaultFlowProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('concatenates two Blockscout pages of native and token history on EVM chains', async () => {
    let txPage = 0;
    installFetch((url) => {
      const path = url.pathname.toLowerCase();
      if (url.hostname === 'eth.blockscout.com' && path.endsWith(`/addresses/${OWNER}/transactions`)) {
        txPage++;
        if (txPage === 1) return { body: { items: [bsTx(hash(1), OWNER, OTHER, '1000000000000000000')], next_page_params: { block_number: 18_999_999, index: 0, items_count: 50 } } };
        return { body: { items: [bsTx(hash(2), OTHER, OWNER, '500000000000000000')], next_page_params: null } };
      }
      if (url.hostname === 'eth.blockscout.com' && path.endsWith(`/addresses/${OWNER}/token-transfers`)) {
        return {
          body: {
            items: [
              {
                tx_hash: hash(3),
                timestamp: '2024-05-01T12:05:00.000000Z',
                block_number: 19_000_001,
                from: { hash: OWNER },
                to: { hash: OTHER },
                token: { address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: '6', type: 'ERC-20' },
                total: { value: '2500000', decimals: '6' },
              },
            ],
            next_page_params: null,
          },
        };
      }
      return undefined;
    });
    const p = createDefaultFlowProvider();
    const tx = await p.history('ethereum', OWNER, 'tx');
    expect(tx).toHaveLength(2);
    expect(tx[0].hash).toBe(hash(1));
    expect(tx[0].direction).toBe('out');
    expect(tx[1].direction).toBe('in');
    expect(txPage).toBe(2);
    const tokens = await p.history('ethereum', OWNER, 'token');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).toMatchObject({ symbol: 'USDC', kind: 'ERC-20', tokenAddress: USDC });
    expect(tokens[0].token?.amount.raw).toBe(2_500_000n);
  });

  it('propagates a first-page native history failure but degrades token history to []', async () => {
    installFetch(() => ({ status: 500, body: { message: 'boom' } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = createDefaultFlowProvider();
    await expect(p.history('ethereum', OWNER, 'tx')).rejects.toThrow();
    await expect(p.history('ethereum', OWNER, 'token')).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('serves Bitcoin history from Esplora and no token rows', async () => {
    const fetchMock = installFetch((url) => {
      if (url.hostname === 'mempool.space' && url.pathname === `/api/address/${BTC_ADDR}/txs`) {
        return {
          body: [
            {
              txid: 'f'.repeat(64),
              vin: [{ txid: 'e'.repeat(64), vout: 0, prevout: { scriptpubkey_address: BTC_OTHER, value: 150_000, scriptpubkey_type: 'v0_p2wpkh' } }],
              vout: [
                { scriptpubkey_address: BTC_ADDR, value: 100_000, scriptpubkey_type: 'v0_p2wpkh' },
                { scriptpubkey_address: BTC_OTHER, value: 49_000, scriptpubkey_type: 'v0_p2wpkh' },
              ],
              fee: 1000,
              status: { confirmed: true, block_height: 840_000, block_time: 1_713_571_767 },
            },
          ],
        };
      }
      return undefined;
    });
    const p = createDefaultFlowProvider();
    const rows = await p.history('bitcoin', BTC_ADDR, 'tx');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chain: 'bitcoin', direction: 'in', from: BTC_OTHER, to: BTC_ADDR });
    expect(rows[0].value.raw).toBe(100_000n);
    const calls = fetchMock.mock.calls.length;
    await expect(p.history('bitcoin', BTC_ADDR, 'token')).resolves.toEqual([]);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('enriches Solana signatures into native and SPL rows and caches the transactions', async () => {
    const getTx = vi.fn();
    installFetch((url, body) => {
      if (url.hostname !== 'api.mainnet-beta.solana.com' || !body) return undefined;
      if (body.method === 'getSignaturesForAddress') {
        return {
          body: [
            { signature: SOL_SIG_OK, slot: 250_000_000, err: null, blockTime: 1_713_571_767 },
            { signature: SOL_SIG_FAIL, slot: 249_999_999, err: { InstructionError: [0, 'Custom'] }, blockTime: 1_713_571_700 },
          ],
        };
      }
      if (body.method === 'getTransaction') {
        getTx(body.params[0]);
        return {
          body: {
            slot: 250_000_000,
            blockTime: 1_713_571_767,
            meta: {
              err: null,
              fee: 5000,
              preBalances: [10_000_000_000, 0, 1],
              postBalances: [8_999_995_000, 1_000_000_000, 1],
              preTokenBalances: [{ accountIndex: 1, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner: SOL_PAYER, uiTokenAmount: { amount: '3000000', decimals: 6 } }],
              postTokenBalances: [
                { accountIndex: 1, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner: SOL_PAYER, uiTokenAmount: { amount: '1000000', decimals: 6 } },
                { accountIndex: 2, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner: SOL_RECIPIENT, uiTokenAmount: { amount: '2000000', decimals: 6 } },
              ],
              logMessages: ['Program 11111111111111111111111111111111 invoke [1]'],
              computeUnitsConsumed: 450,
            },
            transaction: {
              message: {
                accountKeys: [{ pubkey: SOL_PAYER, signer: true }, { pubkey: SOL_RECIPIENT }, { pubkey: '11111111111111111111111111111111' }],
                instructions: [{ programId: '11111111111111111111111111111111', program: 'system', parsed: { type: 'transfer', info: {} } }],
              },
              signatures: [SOL_SIG_OK],
            },
          },
        };
      }
      return undefined;
    });
    const p = createDefaultFlowProvider();
    const native = await p.history('solana', SOL_PAYER, 'tx');
    expect(native).toHaveLength(1);
    expect(native[0]).toMatchObject({ chain: 'solana', hash: SOL_SIG_OK, from: SOL_PAYER, to: SOL_RECIPIENT, direction: 'out', status: 'success' });
    expect(native[0].value.raw).toBe(1_000_000_000n);
    const spl = await p.history('solana', SOL_PAYER, 'token');
    expect(spl).toHaveLength(1);
    expect(spl[0].token).toMatchObject({ symbol: 'USDC', kind: 'SPL', tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
    expect(spl[0].token?.amount.raw).toBe(2_000_000n);
    // Only the successful signature is fetched, and only once for both kinds.
    expect(getTx).toHaveBeenCalledTimes(1);
    expect(getTx).toHaveBeenCalledWith(SOL_SIG_OK);
  });

  it('resolves labels from the registry and the sanctions list', () => {
    registerLabels([{ address: OTHER, chain: 'ethereum', name: 'Case wallet', category: 'wallet', source: 'case' }]);
    const p = createDefaultFlowProvider();
    expect(p.label(OTHER, 'ethereum')?.name).toBe('Case wallet');
    expect(p.label(OWNER, 'ethereum')).toBeUndefined();
    expect(p.label(BUILTIN_SANCTIONED[0].address, 'ethereum')?.category).toBe('sanctioned');
  });

  it('prefetches DefiLlama prices and answers price() synchronously', async () => {
    const llama = vi.fn();
    installFetch((url) => {
      if (url.hostname === 'coins.llama.fi') {
        llama(decodeURIComponent(url.pathname));
        return {
          body: {
            coins: {
              'coingecko:ethereum': { price: 2500, symbol: 'ETH', decimals: 18, timestamp: 1_713_571_767, confidence: 0.99 },
              [`ethereum:${USDC.toLowerCase()}`]: { price: 1, symbol: 'USDC', decimals: 6, timestamp: 1_713_571_767, confidence: 0.99 },
            },
          },
        };
      }
      return undefined;
    });
    const p = createDefaultFlowProvider();
    expect(p.price('ethereum')).toBeUndefined();
    await p.prefetchPrices('ethereum', [USDC, OTHER]);
    expect(llama).toHaveBeenCalledTimes(1);
    expect(llama.mock.calls[0][0]).toContain('coingecko:ethereum');
    expect(llama.mock.calls[0][0]).toContain(`ethereum:${USDC.toLowerCase()}`);
    expect(p.price('ethereum')).toBe(2500);
    expect(p.price('ethereum', USDC)).toBe(1);
    expect(p.price('ethereum', OTHER)).toBeUndefined();
    await p.prefetchPrices('ethereum', [USDC]);
    expect(llama).toHaveBeenCalledTimes(1); // everything already known, no new request
  });

  it('detects contracts via eth_getCode and caches the answer', async () => {
    const codes = vi.fn();
    installFetch((_url, body) => {
      if (body?.method === 'eth_getCode') {
        codes(body.params[0]);
        return { body: String(body.params[0]).toLowerCase() === OTHER ? '0x6080604052' : '0x' };
      }
      return undefined;
    });
    const p = createDefaultFlowProvider();
    expect(await p.isContract('ethereum', OWNER)).toBe(false);
    expect(await p.isContract('ethereum', OTHER)).toBe(true);
    expect(await p.isContract('ethereum', OTHER.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(codes).toHaveBeenCalledTimes(2);
    expect(await p.isContract('bitcoin', BTC_ADDR)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FlowGraph component (jsdom smoke test)
// ---------------------------------------------------------------------------

describe('FlowGraph component', () => {
  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('renders one SVG node per graph node, calls onSelect on click and cleans up on unmount', async () => {
    const rows: Row[] = [
      { hash: hash(1), from: A, to: B, value: ETH(1) },
      { hash: hash(2), from: B, to: A, value: ETH(0.5) },
      { hash: hash(3), from: A, to: C, value: ETH(2) },
    ];
    const labels = { [B]: { name: 'Binance 14', category: 'exchange' as const } };
    const graph = await trace(rows, { maxHops: 2, direction: 'both' }, makeProvider(rows, { labels, prices: { native: 2000 }, contracts: [C] }));

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSelect = vi.fn();
    await act(async () => {
      root.render(createElement(FlowGraph, { graph, onSelect, selected: B, height: 400 }));
    });

    const wrapper = container.querySelector('[data-testid="flow-graph"]');
    expect(wrapper).not.toBeNull();
    expect(container.querySelectorAll('g.flowgraph__node')).toHaveLength(graph.nodes.length);
    expect(container.querySelectorAll('path.flowgraph__link')).toHaveLength(graph.edges.length);
    expect(container.querySelector('g.flowgraph__node.is-root')).not.toBeNull();
    expect(container.querySelector('g.flowgraph__node.is-selected')).not.toBeNull();
    expect(container.textContent).toContain('Binance 14');
    expect(container.textContent).toContain(`${graph.nodes.length} nodes`);
    expect(container.querySelectorAll('.flowgraph__legend li').length).toBeGreaterThan(1);

    const nodeEl = Array.from(container.querySelectorAll('g.flowgraph__node')).find((g) => !g.classList.contains('is-root'))!;
    await act(async () => {
      nodeEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect([B, C]).toContain(onSelect.mock.calls[0][0]);

    // Buttons are wired and harmless.
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent)).toEqual(['Fit', 'Reset']);
    await act(async () => {
      buttons.forEach((b) => b.click());
    });

    // Re-render with a new graph identity keeps working and an empty graph shows the empty state.
    await act(async () => {
      root.render(createElement(FlowGraph, { graph: { ...graph, nodes: [], edges: [], truncated: [] }, onSelect }));
    });
    expect(container.querySelector('.flowgraph__empty')).not.toBeNull();
    expect(container.querySelectorAll('g.flowgraph__node')).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
    expect(container.innerHTML).toBe('');
    container.remove();
  });

  it('exposes nodes as keyboard-operable buttons with a single roving tab stop', async () => {
    const rows: Row[] = [
      { hash: hash(1), from: A, to: B, value: ETH(1) },
      { hash: hash(2), from: A, to: C, value: ETH(2) },
    ];
    const graph = await trace(rows, { maxHops: 1, direction: 'out' }, makeProvider(rows, { prices: { native: 2000 } }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSelect = vi.fn();
    await act(async () => {
      root.render(createElement(FlowGraph, { graph, onSelect, height: 400 }));
    });

    expect(container.querySelector('svg.flowgraph__svg')?.getAttribute('role')).toBe('group');
    const nodes = Array.from(container.querySelectorAll<SVGGElement>('g.flowgraph__node'));
    expect(nodes).toHaveLength(graph.nodes.length);
    for (const n of nodes) {
      expect(n.getAttribute('role')).toBe('button');
      expect(n.getAttribute('aria-label')).toBeTruthy();
    }
    const stops = nodes.filter((n) => n.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(stops[0].classList.contains('is-root')).toBe(true);
    expect(nodes.filter((n) => n.getAttribute('tabindex') === '-1')).toHaveLength(nodes.length - 1);

    const rootNode = stops[0];
    await act(async () => {
      rootNode.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onSelect).toHaveBeenCalledWith(graph.root);

    // Arrow keys move the tab stop to the next node without selecting it.
    await act(async () => {
      rootNode.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    const after = Array.from(container.querySelectorAll<SVGGElement>('g.flowgraph__node'));
    expect(after.filter((n) => n.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(rootNode.getAttribute('tabindex')).toBe('-1');
    expect(onSelect).toHaveBeenCalledTimes(1);

    // Selecting a node from outside makes it the tab stop.
    await act(async () => {
      root.render(createElement(FlowGraph, { graph, onSelect, selected: B, height: 400 }));
    });
    const selectedStops = Array.from(container.querySelectorAll<SVGGElement>('g.flowgraph__node')).filter((n) => n.getAttribute('tabindex') === '0');
    expect(selectedStops).toHaveLength(1);
    expect(selectedStops[0].classList.contains('is-selected')).toBe(true);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
