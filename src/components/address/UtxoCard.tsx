import { useMemo } from 'react';
import { formatAmount, formatUsd } from '@/lib/format';
import { usdValue } from '@/lib/providers/prices';
import { summarizeUtxos, useBtcUtxos, UTXO_TOP_DEFAULT, type BtcUtxo } from '@/hooks/useBtcUtxos';
import AmountCell from '@/components/AmountCell';
import Card from '@/components/Card';
import DataTable, { type Column } from '@/components/DataTable';
import HashDisplay from '@/components/HashDisplay';
import StatGrid, { type Stat } from '@/components/StatGrid';

interface Props {
  address: string;
  /** BTC price for USD hints. */
  nativePrice?: number;
  /** Load lazily: the query runs only while this is true (default true). */
  enabled?: boolean;
}

/** Unspent outputs of a Bitcoin address: count, total and the largest outputs. */
export default function UtxoCard({ address, nativePrice, enabled = true }: Props) {
  const q = useBtcUtxos(address, enabled);
  const summary = useMemo(() => summarizeUtxos(q.data ?? [], UTXO_TOP_DEFAULT), [q.data]);
  const loaded = !!q.data;

  const stats: Stat[] = [
    { label: 'Unspent outputs', value: loaded ? summary.count.toLocaleString('en-US') : q.isLoading ? '…' : '—', mono: true, hint: loaded ? `${summary.confirmed.toLocaleString('en-US')} confirmed` : undefined },
    {
      label: 'Total unspent',
      value: loaded ? `${formatAmount(summary.total, 8, 8)} BTC` : q.isLoading ? '…' : '—',
      mono: true,
      hint: loaded ? formatUsd(usdValue(summary.total, 8, nativePrice)) : undefined,
    },
  ];

  const columns: Column<BtcUtxo>[] = [
    { key: 'txid', header: 'Transaction', render: (u) => <HashDisplay hash={u.txid} chain="bitcoin" /> },
    { key: 'vout', header: 'Output', align: 'right', className: 'num', render: (u) => `#${u.vout}` },
    { key: 'value', header: 'Value', align: 'right', render: (u) => <AmountCell amount={{ raw: u.value, decimals: 8, symbol: 'BTC' }} usd={usdValue(u.value, 8, nativePrice)} maxFraction={8} /> },
    { key: 'status', header: 'Status', render: (u) => (u.confirmed ? <span className="chip chip--ok">Confirmed</span> : <span className="chip chip--warn">In mempool</span>) },
  ];

  const footer = loaded
    ? summary.count > summary.top.length
      ? `Showing the ${summary.top.length} largest of ${summary.count.toLocaleString('en-US')} unspent outputs.`
      : `All ${summary.count.toLocaleString('en-US')} unspent output${summary.count === 1 ? '' : 's'} shown.`
    : undefined;

  return (
    <Card title="UTXOs" subtitle="Unspent outputs the address can still spend (mempool included)" testId="address-utxos">
      <StatGrid stats={stats} />
      <div className="mt-sm">
        <DataTable
          columns={columns}
          rows={summary.top}
          rowKey={(u) => `${u.txid}:${u.vout}`}
          loading={q.isLoading}
          error={q.error ?? undefined}
          onRetry={() => void q.refetch()}
          emptyTitle="No unspent outputs"
          emptyHint="Every output received by this address has been spent."
          caption={`Largest unspent outputs of ${address}`}
          compact
          footer={footer ? <span className="muted small">{footer}</span> : undefined}
        />
      </div>
    </Card>
  );
}
