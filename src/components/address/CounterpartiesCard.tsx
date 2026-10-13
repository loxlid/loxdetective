import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { ChainInfo, TxListItem } from '@/lib/types';
import { formatAmount } from '@/lib/format';
import { usdValue } from '@/lib/providers/prices';
import { useHistoryRows } from '@/hooks/useHistoryRows';
import { useNativePrice } from '@/hooks/usePrices';
import AddressDisplay from '@/components/AddressDisplay';
import AmountCell from '@/components/AmountCell';
import Card from '@/components/Card';
import DataTable, { type Column } from '@/components/DataTable';
import { counterpartyOf } from './HistoryTable';

export interface CounterpartyAgg {
  /** Counterparty address as it appeared in the rows (first spelling wins). */
  address: string;
  /** Rows (native + token) involving the counterparty. */
  count: number;
  /** Native value received from the counterparty, in base units. */
  inRaw: bigint;
  /** Native value sent to the counterparty, in base units. */
  outRaw: bigint;
  /** Token transfer rows among `count`. */
  tokenCount: number;
  lastTs?: number;
}

/** Placeholders providers use where no real counterparty exists. */
const PLACEHOLDERS = new Set(['', 'unknown', 'coinbase', 'OP_RETURN']);

export const COUNTERPARTIES_TOP = 10;

/**
 * Aggregate the loaded history rows per counterparty: row count, native
 * value in / out, token rows. Rows with direction `self` / `unknown`, without
 * a counterparty, or whose counterparty is a placeholder are skipped. Comma
 * joined counterparties (legacy Bitcoin rows) count once per address but
 * carry no value, since the split is unknown. Sorted by count, then by
 * total native value; `limit` rows at most.
 */
export function aggregateCounterparties(rows: readonly TxListItem[], self: string, opts: { fold?: boolean; limit?: number } = {}): CounterpartyAgg[] {
  const fold = opts.fold ?? true;
  const limit = opts.limit ?? COUNTERPARTIES_TOP;
  const keyOf = (a: string) => (fold ? a.toLowerCase() : a);
  const me = keyOf(self.trim());
  const map = new Map<string, CounterpartyAgg>();

  const bump = (addr: string, row: TxListItem, withValue: boolean) => {
    const a = addr.trim();
    if (PLACEHOLDERS.has(a)) return;
    const key = keyOf(a);
    if (key === me) return;
    let agg = map.get(key);
    if (!agg) {
      agg = { address: a, count: 0, inRaw: 0n, outRaw: 0n, tokenCount: 0 };
      map.set(key, agg);
    }
    agg.count++;
    if (row.token) agg.tokenCount++;
    else if (withValue) {
      if (row.direction === 'in') agg.inRaw += row.value.raw;
      else agg.outRaw += row.value.raw;
    }
    if (row.timestamp && (!agg.lastTs || row.timestamp > agg.lastTs)) agg.lastTs = row.timestamp;
  };

  for (const row of rows) {
    if (row.direction !== 'in' && row.direction !== 'out') continue;
    const cp = counterpartyOf(row);
    if (!cp) continue;
    if (cp.includes(',')) {
      for (const part of cp.split(',')) bump(part, row, false);
    } else {
      bump(cp, row, true);
    }
  }

  return Array.from(map.values())
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      const ta = a.inRaw + a.outRaw;
      const tb = b.inRaw + b.outRaw;
      return tb === ta ? 0 : tb > ta ? 1 : -1;
    })
    .slice(0, limit);
}

/** Top counterparties of the address across the loaded transaction and token rows. */
export default function CounterpartiesCard({ chain, address }: { chain: ChainInfo; address: string }) {
  const rows = useHistoryRows(chain.id, address);
  const nativePrice = useNativePrice(chain.id);
  const all = useMemo(() => [...rows.tx, ...rows.token], [rows.tx, rows.token]);
  const top = useMemo(() => aggregateCounterparties(all, address, { fold: chain.family === 'evm' }), [all, address, chain.family]);
  const { decimals, symbol } = chain.native;
  const amount = (raw: bigint) => ({ raw, decimals, symbol });

  const columns: Column<CounterpartyAgg>[] = [
    { key: 'addr', header: 'Counterparty', className: 'cell-wrap', render: (c) => <AddressDisplay address={c.address} chain={chain.id} copy /> },
    {
      key: 'count',
      header: 'Rows',
      align: 'right',
      className: 'num',
      render: (c) => (
        <span title={c.tokenCount ? `${c.count - c.tokenCount} native, ${c.tokenCount} token` : undefined}>
          {c.count.toLocaleString('en-US')}
          {c.tokenCount > 0 && <span className="muted small"> ({c.tokenCount} token)</span>}
        </span>
      ),
    },
    { key: 'in', header: 'Received', align: 'right', render: (c) => (c.inRaw > 0n ? <AmountCell amount={amount(c.inRaw)} direction="in" usd={usdValue(c.inRaw, decimals, nativePrice)} /> : <span className="muted">—</span>) },
    { key: 'out', header: 'Sent', align: 'right', render: (c) => (c.outRaw > 0n ? <AmountCell amount={amount(c.outRaw)} direction="out" usd={usdValue(c.outRaw, decimals, nativePrice)} /> : <span className="muted">—</span>) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (c) => (
        <span className="btn-row btn-row--inline">
          <Link className="btn btn--sm btn--ghost" to={`/address/${chain.id}/${c.address}`} title="Open the counterparty profile">
            Profile
          </Link>
          <Link className="btn btn--sm btn--ghost" to={`/trace/${chain.id}/${c.address}`} title="Trace funds from the counterparty">
            Trace
          </Link>
        </span>
      ),
    },
  ];

  const loaded = all.length;
  const subtitle = `From loaded pages only (${loaded.toLocaleString('en-US')} row${loaded === 1 ? '' : 's'}): native value in / out, rows per counterparty`;

  return (
    <Card title="Top counterparties" subtitle={subtitle} flush>
      <DataTable
        columns={columns}
        rows={top}
        rowKey={(c) => c.address}
        loading={rows.loading || (loaded === 0 && !!rows.enrich?.loading)}
        error={rows.errors[0]}
        onRetry={() => {
          // Only the pager that failed: refetching the disabled, unsupported token pager would run its queryFn anyway.
          if (rows.txHistory.error) rows.txHistory.refetch();
          if (rows.tokenHistory.error) rows.tokenHistory.refetch();
        }}
        emptyTitle="No counterparties in the loaded rows"
        emptyHint={loaded ? 'Every loaded row is a self transfer or has no counterparty.' : 'Load the Transactions tab or wait for the history to arrive.'}
        caption={`Top counterparties of ${address} on ${chain.name}`}
        footer={
          top.length ? (
            <span className="muted small">
              Top {top.length} by row count. Amounts are {symbol} only; token rows count but add no value. {formatAmount(top.reduce((s, c) => s + c.inRaw, 0n), decimals, 4)} {symbol} received in total from them.
            </span>
          ) : undefined
        }
      />
    </Card>
  );
}
