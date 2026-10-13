import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { ChainInfo, Transfer } from '@/lib/types';
import { formatUsd, shorten } from '@/lib/format';
import { priceKeyForToken, usdValue, type PriceKey } from '@/lib/providers/prices';
import { usePrices } from '@/hooks/usePrices';
import AddressDisplay from '@/components/AddressDisplay';
import AmountCell from '@/components/AmountCell';
import DataTable, { type Column } from '@/components/DataTable';

const PRICED_KINDS = new Set<Transfer['kind']>(['ERC-20', 'SPL']);

const KIND_CLASS: Record<Transfer['kind'], string> = {
  native: 'chip--other',
  'ERC-20': 'chip--token',
  'ERC-721': 'chip--nft',
  'ERC-1155': 'chip--nft',
  SPL: 'chip--token',
  internal: 'chip--infrastructure',
};

/** DefiLlama price key of a transfer's asset, or undefined for NFTs / unknown tokens. */
export function transferPriceKey(chain: ChainInfo, t: Transfer): PriceKey | undefined {
  if (t.kind === 'native' || t.kind === 'internal') return chain.native.priceKey;
  if (PRICED_KINDS.has(t.kind) && t.token?.address) return priceKeyForToken(chain, t.token.address);
  return undefined;
}

function AssetCell({ t, chain }: { t: Transfer; chain: ChainInfo }) {
  if (t.kind === 'native' || t.kind === 'internal' || !t.token) return <span className="mono token-cell__symbol">{t.amount.symbol}</span>;
  const body = (
    <span className="token-cell">
      <span className="token-cell__symbol mono">{t.amount.symbol || t.token.symbol || shorten(t.token.address)}</span>
      {t.token.name && t.token.name !== t.amount.symbol && <span className="token-cell__name">{t.token.name}</span>}
    </span>
  );
  return (
    <Link className="token-link" to={`/address/${chain.id}/${t.token.address}`} title={t.token.address}>
      {body}
    </Link>
  );
}

/**
 * Decoded native / token transfers of a transaction with USD values. The
 * wrapper carries `data-testid="tx-transfers"` and renders an empty state
 * when nothing was decoded.
 */
export default function TransfersTable({ tx, chain }: { tx: { transfers: Transfer[] }; chain: ChainInfo }) {
  const keys = useMemo(() => {
    const set = new Set<PriceKey>();
    for (const t of tx.transfers) {
      const k = transferPriceKey(chain, t);
      if (k) set.add(k);
    }
    return Array.from(set);
  }, [tx.transfers, chain]);
  const prices = usePrices(keys).data ?? {};

  const usdOf = (t: Transfer): number | undefined => {
    if (t.usd !== undefined) return t.usd;
    const key = transferPriceKey(chain, t);
    return key ? usdValue(t.amount.raw, t.amount.decimals, prices[key]) : undefined;
  };

  const columns: Column<Transfer>[] = [
    { key: 'kind', header: 'Kind', width: '1%', render: (t) => <span className={`chip ${KIND_CLASS[t.kind] ?? 'chip--other'}`}>{t.kind}</span> },
    { key: 'asset', header: 'Asset', render: (t) => <AssetCell t={t} chain={chain} /> },
    { key: 'from', header: 'From', className: 'cell-wrap', render: (t) => <AddressDisplay address={t.from} chain={chain.id} /> },
    { key: 'to', header: 'To', className: 'cell-wrap', render: (t) => <AddressDisplay address={t.to} chain={chain.id} /> },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (t) => (
        <span className="token-cell token-cell--end">
          <AmountCell amount={t.amount} />
          {t.tokenId !== undefined && (
            <span className="token-cell__name mono" title={`Token id ${t.tokenId}`}>
              #{shorten(t.tokenId, 8, 4)}
            </span>
          )}
        </span>
      ),
    },
    { key: 'usd', header: 'USD', align: 'right', className: 'num', render: (t) => formatUsd(usdOf(t)) },
  ];

  const total = tx.transfers.reduce((s, t) => s + (usdOf(t) ?? 0), 0);
  return (
    <DataTable
      testId="tx-transfers"
      columns={columns}
      rows={tx.transfers}
      rowKey={(t, i) => `${t.index ?? i}:${t.kind}:${t.from}:${t.to}`}
      emptyTitle="No transfers decoded"
      emptyHint="This transaction moved no native value and emitted no recognised token transfer events."
      caption="Transfers decoded from this transaction"
      compact
      footer={tx.transfers.length > 0 && total > 0 ? <span className="muted small">≈ {formatUsd(total)} in total (priced assets only)</span> : undefined}
    />
  );
}
