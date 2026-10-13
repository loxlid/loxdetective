import type { ChainInfo } from '@/lib/types';
import type { BtcIo } from '@/lib/providers/btc/esplora';
import { formatAmount } from '@/lib/format';
import AddressDisplay from '@/components/AddressDisplay';
import Card from '@/components/Card';
import DataTable, { type Column } from '@/components/DataTable';
import HashDisplay from '@/components/HashDisplay';

interface Props {
  inputs: BtcIo[];
  outputs: BtcIo[];
  chain: ChainInfo;
  coinbase: boolean;
}

const sats = (v: bigint) => `${formatAmount(v, 8, 8)} BTC`;

function IoAddress({ io, chain, coinbase }: { io: BtcIo; chain: ChainInfo; coinbase: boolean }) {
  if (coinbase) return <AddressDisplay address="coinbase" chain={chain.id} />;
  if (io.address) return <AddressDisplay address={io.address} chain={chain.id} />;
  if (io.scriptType === 'op_return') return <AddressDisplay address="OP_RETURN" chain={chain.id} />;
  return <span className="muted">non-standard script{io.scriptType ? ` (${io.scriptType})` : ''}</span>;
}

/** Bitcoin inputs (with their previous outpoints) and outputs side by side. */
export default function BtcIoTables({ inputs, outputs, chain, coinbase }: Props) {
  const inputCols: Column<BtcIo & { i: number }>[] = [
    { key: 'i', header: '#', width: '1%', className: 'num', render: (r) => r.i },
    { key: 'addr', header: 'Address', className: 'cell-wrap', render: (r) => <IoAddress io={r} chain={chain} coinbase={coinbase} /> },
    { key: 'value', header: 'Value', align: 'right', className: 'num', render: (r) => sats(r.value) },
    {
      key: 'prev',
      header: 'Spends',
      hideOnMobile: true,
      render: (r) =>
        r.txid ? (
          <span className="mono">
            <HashDisplay hash={r.txid} chain={chain.id} lead={6} tail={4} />:{r.vout ?? 0}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ];
  const outputCols: Column<BtcIo & { i: number }>[] = [
    { key: 'i', header: '#', width: '1%', className: 'num', render: (r) => r.i },
    { key: 'addr', header: 'Address', className: 'cell-wrap', render: (r) => <IoAddress io={r} chain={chain} coinbase={false} /> },
    { key: 'value', header: 'Value', align: 'right', className: 'num', render: (r) => sats(r.value) },
    { key: 'type', header: 'Script', hideOnMobile: true, render: (r) => <span className="method-chip">{r.scriptType ?? '?'}</span> },
  ];
  const withIndex = (list: BtcIo[]) => list.map((io, i) => ({ ...io, i }));
  const sum = (list: BtcIo[]) => list.reduce((s, io) => s + io.value, 0n);

  return (
    <div className="io-grid">
      <Card title={`Inputs (${inputs.length})`} subtitle={coinbase ? 'Block reward (coinbase)' : `${sats(sum(inputs))} in`} flush>
        <DataTable columns={inputCols} rows={withIndex(inputs)} rowKey={(r) => String(r.i)} emptyTitle="No inputs" caption="Transaction inputs" compact />
      </Card>
      <Card title={`Outputs (${outputs.length})`} subtitle={`${sats(sum(outputs))} out`} flush>
        <DataTable columns={outputCols} rows={withIndex(outputs)} rowKey={(r) => String(r.i)} emptyTitle="No outputs" caption="Transaction outputs" compact />
      </Card>
    </div>
  );
}
