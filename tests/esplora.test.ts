import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearEndpointCooldowns, HttpError, isEndpointCooling } from '@/lib/http';
import {
  BTC_DETAILED_DEFAULT_PAGES,
  btcAddressSummary,
  btcAddressTxs,
  btcDirection,
  btcHistoryDetailed,
  btcTransaction,
  btcTxToListItem,
  btcTxToListItems,
  btcUtxos,
  ESPLORA_PAGE_SIZE,
  type EsploraTx,
} from '@/lib/providers/btc/esplora';

const ADDR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const OTHER = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const THIRD = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const MEMPOOL = 'https://mempool.space/api';
const BLOCKSTREAM = 'https://blockstream.info/api';

type Route = { status?: number; body: unknown } | undefined;

/** Install a fetch stub that routes by full URL; returns the recorded calls. */
function mockFetch(route: (url: string) => Route): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const r = route(url);
      if (!r) return new Response('not found', { status: 404 });
      const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      return new Response(body, { status: r.status ?? 200 });
    }),
  );
  return calls;
}

interface IoSpec {
  addr?: string;
  value: number;
  coinbase?: boolean;
  type?: string;
}

function mkTx(txid: string, vin: IoSpec[], vout: IoSpec[], status: EsploraTx['status'] = { confirmed: true, block_height: 800_000, block_time: 1_700_000_000 }): EsploraTx {
  return {
    txid,
    version: 2,
    locktime: 0,
    vin: vin.map((i, n) =>
      i.coinbase
        ? { is_coinbase: true, sequence: 0xffffffff }
        : {
            txid: `prev${n}`.padEnd(64, '0'),
            vout: n,
            prevout: { scriptpubkey: '00', scriptpubkey_address: i.addr, scriptpubkey_type: i.type ?? 'v0_p2wpkh', value: i.value },
            is_coinbase: false,
            sequence: 0xfffffffd,
          },
    ),
    vout: vout.map((o) => ({
      scriptpubkey: '00',
      scriptpubkey_address: o.addr,
      scriptpubkey_type: o.type ?? 'v0_p2wpkh',
      value: o.value,
    })),
    size: 222,
    weight: 561,
    fee: Math.max(0, vin.reduce((a, i) => a + i.value, 0) - vout.reduce((a, o) => a + o.value, 0)),
    status,
  };
}

const txid = (n: number) => n.toString(16).padStart(64, '0');

beforeEach(() => {
  vi.restoreAllMocks();
  clearEndpointCooldowns();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('btcDirection', () => {
  const io = (addr: string, value: number) => ({ address: addr, value: BigInt(value) });

  it('classifies incoming, outgoing, pass-through and consolidation', () => {
    expect(btcDirection([io(OTHER, 100)], [io(ADDR, 90), io(OTHER, 9)], ADDR)).toEqual({ direction: 'in', net: 90n });
    expect(btcDirection([io(ADDR, 100)], [io(OTHER, 60), io(ADDR, 39)], ADDR)).toEqual({ direction: 'out', net: -61n });
    // Zero net with the address on both sides.
    expect(btcDirection([io(ADDR, 50), io(OTHER, 50)], [io(ADDR, 50), io(OTHER, 49)], ADDR)).toEqual({ direction: 'self', net: 0n });
    // Consolidation: only our own inputs/outputs; net is the fee.
    expect(btcDirection([io(ADDR, 50), io(ADDR, 50)], [io(ADDR, 99)], ADDR)).toEqual({ direction: 'self', net: -1n });
    expect(btcDirection([io(OTHER, 50)], [io(THIRD, 49)], ADDR).direction).toBe('unknown');
  });

  it('treats an address-less non-OP_RETURN output as an external spend, but OP_RETURN as part of a consolidation', () => {
    // Esplora omits scriptpubkey_address for p2pk / bare multisig / non-standard scripts.
    expect(btcDirection([io(ADDR, 100)], [{ address: undefined, value: 60n, scriptType: 'p2pk' }, io(ADDR, 39)], ADDR)).toEqual({ direction: 'out', net: -61n });
    expect(btcDirection([io(ADDR, 100)], [{ address: undefined, value: 60n, scriptType: 'multisig' }, io(ADDR, 39)], ADDR)).toEqual({ direction: 'out', net: -61n });
    expect(btcDirection([io(ADDR, 100)], [{ address: undefined, value: 99n }, io(ADDR, 0)], ADDR).direction).toBe('out');
    // Consolidation with an OP_RETURN marker stays 'self'.
    expect(btcDirection([io(ADDR, 100)], [{ address: undefined, value: 0n, scriptType: 'op_return' }, io(ADDR, 99)], ADDR)).toEqual({ direction: 'self', net: -1n });
  });
});

describe('btcTxToListItem', () => {
  it('picks the largest external counterparty and the net value', () => {
    const incoming = btcTxToListItem(mkTx(txid(1), [{ addr: THIRD, value: 1_000 }, { addr: OTHER, value: 5_000 }], [{ addr: ADDR, value: 5_500 }, { addr: OTHER, value: 400 }]), ADDR);
    expect(incoming.direction).toBe('in');
    expect(incoming.from).toBe(OTHER);
    expect(incoming.to).toBe(ADDR);
    expect(incoming.value).toEqual({ raw: 5_500n, decimals: 8, symbol: 'BTC' });
    expect(incoming.status).toBe('success');
    expect(incoming.blockNumber).toBe(800_000);
    expect(incoming.timestamp).toBe(1_700_000_000);

    const outgoing = btcTxToListItem(mkTx(txid(2), [{ addr: ADDR, value: 10_000 }], [{ addr: THIRD, value: 2_000 }, { addr: OTHER, value: 7_000 }, { addr: ADDR, value: 900 }]), ADDR);
    expect(outgoing.direction).toBe('out');
    expect(outgoing.from).toBe(ADDR);
    expect(outgoing.to).toBe(OTHER);
    expect(outgoing.value.raw).toBe(9_100n); // 10_000 spent - 900 change
  });

  it('labels a spend to an address-less output as outgoing with an unknown destination', () => {
    const p2pk = btcTxToListItem(mkTx(txid(4), [{ addr: ADDR, value: 10_000 }], [{ value: 6_000, type: 'p2pk' }, { addr: ADDR, value: 3_900 }]), ADDR);
    expect(p2pk.direction).toBe('out');
    expect(p2pk.from).toBe(ADDR);
    expect(p2pk.to).toBe('unknown');
    expect(p2pk.value.raw).toBe(6_100n);

    // A consolidation carrying only an OP_RETURN marker is still a self-transfer.
    const consolidation = btcTxToListItem(mkTx(txid(5), [{ addr: ADDR, value: 10_000 }], [{ value: 0, type: 'op_return' }, { addr: ADDR, value: 9_900 }]), ADDR);
    expect(consolidation.direction).toBe('self');
    expect(consolidation.to).toBe(ADDR);
    expect(consolidation.value.raw).toBe(100n);
  });

  it('handles coinbase and unconfirmed transactions', () => {
    const cb = btcTxToListItem(mkTx(txid(3), [{ coinbase: true, value: 0 }], [{ addr: ADDR, value: 625_000_000 }], { confirmed: false }), ADDR);
    expect(cb.direction).toBe('in');
    expect(cb.from).toBe('coinbase');
    expect(cb.methodName).toBe('coinbase');
    expect(cb.status).toBe('pending');
    expect(cb.timestamp).toBeUndefined();
    expect(cb.blockNumber).toBeUndefined();
  });
});

describe('btcTxToListItems', () => {
  const FOURTH = 'bc1qc7slrfxkknqcq2jevvvkdgvrt8080852dfjewde450xdlk4ugp7szw5tk9';

  it('expands a batch payout into one out row per external output, skipping change', () => {
    const tx = mkTx(txid(10), [{ addr: ADDR, value: 100_000 }], [
      { addr: OTHER, value: 40_000 },
      { addr: THIRD, value: 30_000 },
      { addr: FOURTH, value: 20_000 },
      { addr: ADDR, value: 9_000 }, // change
    ]);
    const rows = btcTxToListItems(ADDR, tx);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.to)).toEqual([OTHER, THIRD, FOURTH]);
    expect(rows.map((r) => r.value.raw)).toEqual([40_000n, 30_000n, 20_000n]);
    for (const r of rows) {
      expect(r).toMatchObject({ chain: 'bitcoin', hash: txid(10), from: ADDR, direction: 'out', status: 'success', enriched: true });
      expect(r.value).toMatchObject({ decimals: 8, symbol: 'BTC' });
      expect(r.timestamp).toBe(1_700_000_000);
      expect(r.blockNumber).toBe(800_000);
    }
    // The singular mapper still collapses the same transaction into one row.
    const single = btcTxToListItem(tx, ADDR);
    expect(single.to).toBe(OTHER);
    expect(single.value.raw).toBe(91_000n);
  });

  it('treats outputs back to any input address as change and skips OP_RETURN', () => {
    // Two-input spend (ADDR + OTHER) paying THIRD, with change to both inputs and a marker output.
    const tx = mkTx(txid(11), [{ addr: ADDR, value: 60_000 }, { addr: OTHER, value: 40_000 }], [
      { addr: THIRD, value: 50_000 },
      { addr: OTHER, value: 25_000 },
      { addr: ADDR, value: 24_000 },
      { value: 0, type: 'op_return' },
    ]);
    const rows = btcTxToListItems(ADDR, tx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from: ADDR, to: THIRD, direction: 'out' });
    // ADDR funded 60% of the inputs, so it is attributed 60% of the external output.
    expect(rows[0].value.raw).toBe(30_000n);
    // Seen from OTHER, the same output is attributed the remaining 40%.
    expect(btcTxToListItems(OTHER, tx)[0].value.raw).toBe(20_000n);
  });

  it('splits a receive from several input addresses proportionally by input value', () => {
    const tx = mkTx(txid(12), [{ addr: OTHER, value: 75_000 }, { addr: THIRD, value: 25_000 }], [
      { addr: ADDR, value: 90_000 },
      { addr: OTHER, value: 9_000 },
    ]);
    const rows = btcTxToListItems(ADDR, tx);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ from: OTHER, to: ADDR, direction: 'in', enriched: true });
    expect(rows[1]).toMatchObject({ from: THIRD, to: ADDR, direction: 'in' });
    expect(rows[0].value.raw).toBe(67_500n);
    expect(rows[1].value.raw).toBe(22_500n);
    expect(rows[0].value.raw + rows[1].value.raw).toBe(90_000n);
  });

  it('keeps the parts summing exactly to the received amount when the split does not divide evenly', () => {
    // A consolidation has no external counterparty and falls back to the singular 'self' row.
    const self = btcTxToListItems(ADDR, mkTx(txid(13), [{ addr: ADDR, value: 50 }, { addr: ADDR, value: 50 }], [{ addr: ADDR, value: 99 }]));
    expect(self).toHaveLength(1);
    expect(self[0]).toMatchObject({ direction: 'self', from: ADDR, to: ADDR, value: { raw: 1n } });

    const recv = mkTx(txid(14), [{ addr: OTHER, value: 2 }, { addr: THIRD, value: 1 }], [{ addr: ADDR, value: 100 }]);
    const rows = btcTxToListItems(ADDR, recv);
    expect(rows.map((r) => r.value.raw)).toEqual([67n, 33n]);
    // Two inputs from the same address merge into one row.
    const merged = btcTxToListItems(ADDR, mkTx(txid(15), [{ addr: OTHER, value: 5 }, { addr: OTHER, value: 5 }], [{ addr: ADDR, value: 9 }]));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ from: OTHER, value: { raw: 9n } });
  });

  it('maps coinbase, address-less inputs and unrelated transactions', () => {
    const cb = btcTxToListItems(ADDR, mkTx(txid(16), [{ coinbase: true, value: 0 }], [{ addr: ADDR, value: 625_000_000 }, { addr: OTHER, value: 1 }], { confirmed: false }));
    expect(cb).toHaveLength(1);
    expect(cb[0]).toMatchObject({ from: 'coinbase', to: ADDR, direction: 'in', methodName: 'coinbase', status: 'pending' });
    expect(cb[0].value.raw).toBe(625_000_000n);
    expect(cb[0].timestamp).toBeUndefined();

    const p2pk = btcTxToListItems(ADDR, mkTx(txid(17), [{ value: 10_000, type: 'p2pk' }], [{ addr: ADDR, value: 9_000 }]));
    expect(p2pk).toHaveLength(1);
    expect(p2pk[0]).toMatchObject({ from: 'unknown', direction: 'in', value: { raw: 9_000n } });

    // Spend to an address-less output: destination 'unknown'.
    const toP2pk = btcTxToListItems(ADDR, mkTx(txid(18), [{ addr: ADDR, value: 10_000 }], [{ value: 6_000, type: 'p2pk' }, { addr: ADDR, value: 3_900 }]));
    expect(toP2pk).toHaveLength(1);
    expect(toP2pk[0]).toMatchObject({ to: 'unknown', direction: 'out', value: { raw: 6_000n } });

    expect(btcTxToListItems(ADDR, mkTx(txid(19), [{ addr: OTHER, value: 10 }], [{ addr: THIRD, value: 9 }]))).toEqual([]);
  });
});

describe('btcHistoryDetailed', () => {
  const page = (n: number, from: number, confirmed = true) =>
    Array.from({ length: n }, (_, i) =>
      mkTx(txid(from + i), [{ addr: ADDR, value: 10_000 }], [{ addr: OTHER, value: 4_000 }, { addr: THIRD, value: 3_000 }, { addr: ADDR, value: 2_900 }], confirmed ? { confirmed: true, block_height: 800_000 - i, block_time: 1_700_000_000 - i } : { confirmed: false }),
    );

  it('walks two pages by default and flattens every transaction into counterparty rows', async () => {
    const first = page(ESPLORA_PAGE_SIZE, 100);
    const second = page(3, 200);
    const calls = mockFetch((url) => {
      if (url === `${MEMPOOL}/address/${ADDR}/txs`) return { body: first };
      if (url === `${MEMPOOL}/address/${ADDR}/txs/chain/${first[first.length - 1].txid}`) return { body: second };
      return undefined;
    });
    const rows = await btcHistoryDetailed(ADDR);
    expect(BTC_DETAILED_DEFAULT_PAGES).toBe(2);
    expect(calls).toHaveLength(2);
    expect(rows).toHaveLength((ESPLORA_PAGE_SIZE + 3) * 2);
    expect(rows[0]).toMatchObject({ hash: txid(100), to: OTHER, direction: 'out', enriched: true });
    expect(rows[1]).toMatchObject({ hash: txid(100), to: THIRD });
    expect(rows[rows.length - 1]).toMatchObject({ hash: txid(202), to: THIRD });
  });

  it('honours the pages option and stops early on a short page', async () => {
    const first = page(ESPLORA_PAGE_SIZE, 100);
    const second = page(ESPLORA_PAGE_SIZE, 200);
    const third = page(1, 300);
    const calls = mockFetch((url) => {
      if (url === `${MEMPOOL}/address/${ADDR}/txs`) return { body: first };
      if (url === `${MEMPOOL}/address/${ADDR}/txs/chain/${first[first.length - 1].txid}`) return { body: second };
      if (url === `${MEMPOOL}/address/${ADDR}/txs/chain/${second[second.length - 1].txid}`) return { body: third };
      return undefined;
    });
    const rows = await btcHistoryDetailed(ADDR, { pages: 5 });
    expect(calls).toHaveLength(3);
    expect(rows).toHaveLength((ESPLORA_PAGE_SIZE * 2 + 1) * 2);
    const one = await btcHistoryDetailed(ADDR, { pages: 1 });
    expect(one).toHaveLength(ESPLORA_PAGE_SIZE * 2);
    expect(calls).toHaveLength(4);
  });

  it('throws when the first page fails but keeps earlier pages when a later one fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = page(ESPLORA_PAGE_SIZE, 100);
    mockFetch((url) => {
      if (url === `${MEMPOOL}/address/${ADDR}/txs`) return { body: first };
      return { status: 400, body: 'Bad request' };
    });
    const rows = await btcHistoryDetailed(ADDR);
    expect(rows).toHaveLength(ESPLORA_PAGE_SIZE * 2);
    expect(warn).toHaveBeenCalledTimes(1);

    mockFetch(() => ({ status: 400, body: 'Invalid Bitcoin address' }));
    await expect(btcHistoryDetailed('bc1qnotvalid')).rejects.toThrow(/Invalid Bitcoin address/);
  });

  it('lower-cases bech32 and rejects an aborted signal', async () => {
    const calls = mockFetch(() => ({ body: [] }));
    await expect(btcHistoryDetailed(ADDR.toUpperCase())).resolves.toEqual([]);
    expect(calls[0]).toBe(`${MEMPOOL}/address/${ADDR}/txs`);
    const ctl = new AbortController();
    ctl.abort();
    await expect(btcHistoryDetailed(ADDR, { signal: ctl.signal })).rejects.toThrow();
  });
});

describe('btcAddressSummary', () => {
  it('combines chain and mempool stats and derives first/last seen from the first page', async () => {
    const page = [
      mkTx(txid(10), [{ addr: OTHER, value: 100 }], [{ addr: ADDR, value: 90 }], { confirmed: false }),
      mkTx(txid(11), [{ addr: OTHER, value: 100 }], [{ addr: ADDR, value: 90 }], { confirmed: true, block_height: 800_002, block_time: 1_700_000_200 }),
      mkTx(txid(12), [{ addr: OTHER, value: 100 }], [{ addr: ADDR, value: 90 }], { confirmed: true, block_height: 800_000, block_time: 1_700_000_000 }),
    ];
    const calls = mockFetch((url) => {
      if (url === `${MEMPOOL}/address/${ADDR}`) {
        return {
          body: {
            address: ADDR,
            chain_stats: { funded_txo_count: 3, funded_txo_sum: 1_000_000, spent_txo_count: 1, spent_txo_sum: 250_000, tx_count: 2 },
            mempool_stats: { funded_txo_count: 1, funded_txo_sum: 90, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 1 },
          },
        };
      }
      if (url === `${MEMPOOL}/address/${ADDR}/txs`) return { body: page };
      return undefined;
    });

    const s = await btcAddressSummary(ADDR);
    expect(s.chain).toBe('bitcoin');
    expect(s.isContract).toBe(false);
    expect(s.received).toBe(1_000_090n);
    expect(s.sent).toBe(250_000n);
    expect(s.nativeBalance).toEqual({ chain: 'bitcoin', balance: 750_090n, decimals: 8, symbol: 'BTC' });
    expect(s.utxoCount).toBe(3);
    expect(s.txCount).toBe(3);
    expect(s.lastSeen).toBe(1_700_000_200);
    expect(s.firstSeen).toBe(1_700_000_000);
    expect(calls).toHaveLength(2);
    expect(calls.every((u) => u.startsWith(MEMPOOL))).toBe(true);
  });

  it('leaves firstSeen undefined when history does not fit in one page, and tolerates a failing page fetch', async () => {
    mockFetch((url) => {
      if (url.endsWith(`/address/${ADDR}`)) {
        return { body: { chain_stats: { funded_txo_count: 1, funded_txo_sum: 5, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 500 }, mempool_stats: {} } };
      }
      return { status: 500, body: 'boom' };
    });
    const s = await btcAddressSummary(ADDR);
    expect(s.firstSeen).toBeUndefined();
    expect(s.lastSeen).toBeUndefined();
    expect(s.txCount).toBe(500);
    expect(s.nativeBalance?.balance).toBe(5n);
  });

  it('lower-cases bech32 addresses before calling Esplora', async () => {
    const calls = mockFetch((url) => (url.includes('/txs') ? { body: [] } : { body: { chain_stats: {}, mempool_stats: {} } }));
    const s = await btcAddressSummary(ADDR.toUpperCase());
    expect(s.address).toBe(ADDR);
    expect(calls[0]).toBe(`${MEMPOOL}/address/${ADDR}`);
  });
});

describe('btcAddressTxs', () => {
  it('returns a cursor only for a full page of confirmed txs and pages via /txs/chain/{txid}', async () => {
    const first: EsploraTx[] = [
      mkTx(txid(100), [{ addr: OTHER, value: 10 }], [{ addr: ADDR, value: 9 }], { confirmed: false }),
      ...Array.from({ length: ESPLORA_PAGE_SIZE }, (_, i) => mkTx(txid(200 + i), [{ addr: OTHER, value: 10 }], [{ addr: ADDR, value: 9 }])),
    ];
    const lastConfirmed = txid(200 + ESPLORA_PAGE_SIZE - 1);
    const second: EsploraTx[] = [mkTx(txid(300), [{ addr: ADDR, value: 50 }], [{ addr: OTHER, value: 49 }])];
    const calls = mockFetch((url) => {
      if (url === `${MEMPOOL}/address/${ADDR}/txs`) return { body: first };
      if (url === `${MEMPOOL}/address/${ADDR}/txs/chain/${lastConfirmed}`) return { body: second };
      return undefined;
    });

    const p1 = await btcAddressTxs(ADDR);
    expect(p1.source).toBe('esplora');
    expect(p1.items).toHaveLength(ESPLORA_PAGE_SIZE + 1);
    expect(p1.items[0].status).toBe('pending');
    expect(p1.nextCursor).toBe(lastConfirmed);

    const p2 = await btcAddressTxs(ADDR, p1.nextCursor);
    expect(calls[1]).toBe(`${MEMPOOL}/address/${ADDR}/txs/chain/${lastConfirmed}`);
    expect(p2.items).toHaveLength(1);
    expect(p2.items[0].direction).toBe('out');
    expect(p2.items[0].value.raw).toBe(50n);
    expect(p2.nextCursor).toBeUndefined();
  });

  it('falls back to the next Esplora endpoint on a network / 5xx error', async () => {
    const calls = mockFetch((url) => {
      if (url.startsWith(MEMPOOL)) return { status: 503, body: 'overloaded' };
      if (url === `${BLOCKSTREAM}/address/${ADDR}/txs`) return { body: [] };
      return undefined;
    });
    const p = await btcAddressTxs(ADDR);
    expect(p.items).toEqual([]);
    expect(calls).toEqual([`${MEMPOOL}/address/${ADDR}/txs`, `${BLOCKSTREAM}/address/${ADDR}/txs`]);
  });

  it('does not retry a 4xx on the next endpoint and surfaces a readable message', async () => {
    const calls = mockFetch(() => ({ status: 400, body: 'Invalid Bitcoin address' }));
    const err = await btcAddressTxs('bc1qnotvalid').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toMatch(/Esplora rejected .*Invalid Bitcoin address/);
    expect(calls).toHaveLength(1);
    // A deterministic 4xx marks no endpoint as unhealthy.
    expect(isEndpointCooling(MEMPOOL)).toBe(false);
    expect(isEndpointCooling(BLOCKSTREAM)).toBe(false);
  });
});

describe('esplora 4xx handling', () => {
  it('keeps a 404 as an HttpError with the readable message and cools no endpoint down', async () => {
    clearEndpointCooldowns();
    const calls = mockFetch(() => ({ status: 404, body: 'Transaction not found' }));
    const err = await btcTransaction(txid(9)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).message).toBe(`Esplora: Transaction not found (/tx/${txid(9)})`);
    await expect(btcTransaction(txid(9))).rejects.toThrow(/not found/);
    expect(isEndpointCooling(MEMPOOL)).toBe(false);
    expect(isEndpointCooling(BLOCKSTREAM)).toBe(false);
    // The second endpoint is never contacted for a definitive answer.
    expect(calls.every((u) => u.startsWith(MEMPOOL))).toBe(true);
    expect(calls.filter((u) => u.endsWith(`/tx/${txid(9)}`))).toHaveLength(2);
  });
});

describe('btcTransaction', () => {
  it('maps outputs to native transfers with joined inputs, fee and confirmations', async () => {
    const tx = mkTx(
      txid(7),
      [{ addr: OTHER, value: 60_000 }, { addr: THIRD, value: 40_000 }],
      [{ addr: ADDR, value: 70_000 }, { addr: OTHER, value: 29_000 }, { value: 0, type: 'op_return' }],
      { confirmed: true, block_height: 812_300, block_hash: 'abc', block_time: 1_700_100_000 },
    );
    const calls = mockFetch((url) => {
      if (url === `${MEMPOOL}/tx/${txid(7)}`) return { body: tx };
      if (url === `${MEMPOOL}/blocks/tip/height`) return { body: '812345' };
      return undefined;
    });

    const t = await btcTransaction(txid(7).toUpperCase());
    expect(calls).toContain(`${MEMPOOL}/blocks/tip/height`);
    expect(t.hash).toBe(txid(7));
    expect(t.status).toBe('success');
    expect(t.blockNumber).toBe(812_300);
    expect(t.timestamp).toBe(1_700_100_000);
    expect(t.from).toBe(OTHER); // largest input
    expect(t.to).toBe(ADDR); // largest output
    expect(t.value.raw).toBe(99_000n);
    expect(t.fee).toEqual({ raw: 1_000n, decimals: 8, symbol: 'BTC' });
    expect(t.inputs).toHaveLength(2);
    expect(t.inputs[0]).toMatchObject({ address: OTHER, value: 60_000n, scriptType: 'v0_p2wpkh', vout: 0 });
    expect(t.outputs).toHaveLength(3);
    expect(t.outputs[2]).toMatchObject({ address: undefined, value: 0n, scriptType: 'op_return', vout: 2 });
    expect(t.transfers).toHaveLength(3);
    expect(t.transfers[0]).toEqual({ kind: 'native', from: `${OTHER},${THIRD}`, to: ADDR, amount: { raw: 70_000n, decimals: 8, symbol: 'BTC' }, index: 0 });
    expect(t.transfers[2].to).toBe('OP_RETURN');
    expect(t.extra).toMatchObject({ size: 222, weight: 561, vsize: 141, confirmations: 46, inputCount: 2, outputCount: 3, coinbase: false, rbfSignalled: true, blockHash: 'abc' });
  });

  it('handles coinbase and unconfirmed transactions', async () => {
    const tx = mkTx(txid(8), [{ coinbase: true, value: 0 }], [{ addr: ADDR, value: 312_500_000 }], { confirmed: false });
    tx.fee = 0;
    mockFetch((url) => {
      if (url.endsWith(`/tx/${txid(8)}`)) return { body: tx };
      if (url.endsWith('/blocks/tip/height')) return { body: '812345' };
      return undefined;
    });
    const t = await btcTransaction(txid(8));
    expect(t.status).toBe('pending');
    expect(t.from).toBe('coinbase');
    expect(t.transfers[0].from).toBe('coinbase');
    expect(t.inputs[0]).toMatchObject({ address: 'coinbase', value: 312_500_000n });
    expect(t.fee?.raw).toBe(0n);
    expect(t.extra?.confirmations).toBe(0);
    expect(t.extra?.coinbase).toBe(true);
  });

  it('rejects malformed ids locally and reports unknown txids clearly', async () => {
    const calls = mockFetch(() => ({ status: 404, body: 'Transaction not found' }));
    await expect(btcTransaction('nope')).rejects.toThrow(/Invalid Bitcoin transaction id/);
    expect(calls).toHaveLength(0);
    await expect(btcTransaction(txid(9))).rejects.toThrow(/Transaction not found/);
  });
});

describe('btcUtxos', () => {
  it('maps utxos with confirmation state', async () => {
    mockFetch((url) =>
      url === `${MEMPOOL}/address/${ADDR}/utxo`
        ? { body: [{ txid: txid(1), vout: 0, status: { confirmed: true, block_height: 1 }, value: 1234 }, { txid: txid(2), vout: 3, status: { confirmed: false }, value: 5 }] }
        : undefined,
    );
    const u = await btcUtxos(ADDR);
    expect(u).toEqual([
      { txid: txid(1), vout: 0, value: 1234n, confirmed: true },
      { txid: txid(2), vout: 3, value: 5n, confirmed: false },
    ]);
  });
});
