import type { ChainInfo, InternalCall } from '@/lib/types';
import AddressDisplay from '@/components/AddressDisplay';
import AmountCell from '@/components/AmountCell';
import DataTable, { type Column } from '@/components/DataTable';

/** Internal (trace) calls of a transaction as exposed by the explorer. */
export default function InternalCallsTable({ calls, chain }: { calls: InternalCall[]; chain: ChainInfo }) {
  const columns: Column<InternalCall>[] = [
    {
      key: 'type',
      header: 'Type',
      width: '1%',
      render: (c) => (
        <span className="method-chip" title={c.depth !== undefined ? `depth ${c.depth}` : undefined}>
          {c.type}
        </span>
      ),
    },
    { key: 'from', header: 'From', className: 'cell-wrap', render: (c) => <AddressDisplay address={c.from} chain={chain.id} /> },
    { key: 'to', header: 'To', className: 'cell-wrap', render: (c) => (c.to ? <AddressDisplay address={c.to} chain={chain.id} /> : <span className="muted">—</span>) },
    { key: 'value', header: 'Value', align: 'right', render: (c) => <AmountCell amount={c.value} /> },
    {
      key: 'error',
      header: 'Result',
      render: (c) => (c.error ? <span className="status status--failed status--sm">{c.error}</span> : <span className="status status--success status--sm">ok</span>),
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={calls}
      rowKey={(c, i) => `${i}:${c.from}:${c.to}`}
      emptyTitle="No internal calls"
      caption="Internal calls of this transaction"
      compact
    />
  );
}
