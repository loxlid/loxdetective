import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { ChainInfo, TxListItem } from '@/lib/types';
import type { CsvColumn } from '@/lib/export';
import { formatAmount } from '@/lib/format';
import { priceKeyForToken, usdValue } from '@/lib/providers/prices';
import type { HistoryKind } from '@/hooks/dispatch';
import { useAddressHistory } from '@/hooks/useAddressHistory';
import { useNativePrice, usePrices } from '@/hooks/usePrices';
import { enrichHint, splitEnrichedRows, useSolEnrichedHistory } from '@/hooks/useSolEnrichedHistory';
import AddressDisplay from '@/components/AddressDisplay';
import AmountCell from '@/components/AmountCell';
import DataTable, { type Column } from '@/components/DataTable';
import EmptyState from '@/components/EmptyState';
import HashDisplay from '@/components/HashDisplay';
import LoadMore from '@/components/LoadMore';
import Timestamp from '@/components/Timestamp';
import StatusPill from '@/components/tx/StatusPill';

interface Props {
  chain: ChainInfo;
  /** Canonical (checksummed / lower-cased bech32) address. */
  address: string;
  kind: HistoryKind;
}

const LABELS: Record<HistoryKind, { noun: string; emptyTitle: string; emptyHint: string }> = {
  tx: { noun: 'Transactions', emptyTitle: 'No transactions found', emptyHint: 'The history provider returned no transactions for this address.' },
  token: { noun: 'Token transfers', emptyTitle: 'No token transfers', emptyHint: 'No ERC-20 / ERC-721 / ERC-1155 transfers were found for this address.' },
  internal: { noun: 'Internal transactions', emptyTitle: 'No internal transactions', emptyHint: 'No internal (trace) calls involve this address, or the explorer does not expose them.' },
};

const SOL_TOKEN_EMPTY = { noun: 'Token transfers', emptyTitle: 'No SPL transfers', emptyHint: 'None of the loaded signatures moved an SPL token for this address. Load more signatures to look further back.' };

const PRICED_KINDS = new Set(['ERC-20', 'SPL']);

/** The counterparty of a history row relative to the queried address. */
export function counterpartyOf(row: TxListItem): string | undefined {
  if (row.direction === 'in') return row.from;
  if (row.direction === 'out') return row.to;
  return row.to ?? row.from;
}

/** In / Out / Self tag for a history row. */
export function DirectionTag({ direction }: { direction: TxListItem['direction'] }) {
  const text = direction === 'in' ? 'In' : direction === 'out' ? 'Out' : direction === 'self' ? 'Self' : '—';
  return (
    <span className={`dir dir--${direction}`} title={`Direction relative to this address: ${direction}`}>
      {text}
    </span>
  );
}

/** Method name shortened to its identifier ("transfer(address,uint256)" → "transfer"). */
export function MethodChip({ name }: { name?: string }) {
  if (!name) return <span className="muted">—</span>;
  const paren = name.indexOf('(');
  const short = paren > 0 ? name.slice(0, paren) : name;
  return (
    <span className="method-chip" title={name}>
      {short}
    </span>
  );
}

function TokenCell({ row, chain }: { row: TxListItem; chain: ChainInfo }) {
  const t = row.token;
  if (!t) return <span className="muted">—</span>;
  const body = (
    <>
      <span className="mono token-cell__symbol">{t.symbol || '?'}</span>
      {!PRICED_KINDS.has(t.kind) && <span className="chip chip--nft">{t.kind}</span>}
    </>
  );
  return t.tokenAddress ? (
    <Link className="token-link" to={`/address/${chain.id}/${t.tokenAddress}`} title={t.tokenAddress}>
      {body}
    </Link>
  ) : (
    <span className="token-link">{body}</span>
  );
}

/** CSV columns of a history row list (what "Export CSV" writes). */
export function historyCsvColumns(chain: ChainInfo, kind: HistoryKind): CsvColumn<TxListItem>[] {
  const iso = (ts?: number) => (ts ? new Date(ts * 1000).toISOString() : '');
  const cols: CsvColumn<TxListItem>[] = [
    { header: 'chain', value: () => chain.id },
    { header: chain.family === 'solana' ? 'signature' : 'hash', value: (r) => r.hash },
    { header: 'timestamp', value: (r) => iso(r.timestamp) },
    { header: chain.family === 'solana' ? 'slot' : 'block', value: (r) => r.blockNumber },
    { header: 'direction', value: (r) => r.direction },
    { header: 'from', value: (r) => r.from },
    { header: 'to', value: (r) => r.to },
    { header: 'amount', value: (r) => formatAmount(r.value.raw, r.value.decimals, 18) },
    { header: 'amount_raw', value: (r) => r.value.raw },
    { header: 'symbol', value: (r) => r.value.symbol },
  ];
  if (kind === 'token' || chain.family === 'solana') {
    cols.push({ header: 'token_address', value: (r) => r.token?.tokenAddress }, { header: 'token_kind', value: (r) => r.token?.kind });
  }
  cols.push({ header: 'method', value: (r) => r.methodName }, { header: 'status', value: (r) => r.status });
  return cols;
}

/**
 * Paged history table for one history kind. Columns depend on the chain
 * family: Solana rows are enriched with `getTransaction` details (direction,
 * counterparty, value; SPL rows feed the Token transfers tab), Bitcoin rows
 * carry the net change for the address, EVM rows the native or token amount.
 */
export default function HistoryTable({ chain, address, kind }: Props) {
  const own = useAddressHistory(chain.id, address, kind);
  // Inert on other families; on Solana both the tx and the token kinds read the enriched signature pages.
  const sol = useSolEnrichedHistory(chain.id, address);
  const isSol = sol.enabled && kind !== 'internal';
  const h = isSol ? sol.history : own;
  const items = useMemo(() => (isSol ? splitEnrichedRows(sol.items, kind) : own.items), [isSol, sol.items, own.items, kind]);
  const supported = isSol || own.supported;
  const nativePrice = useNativePrice(chain.id);

  const priceKeys = useMemo(() => {
    if (kind !== 'token') return [];
    const keys = new Set<string>();
    for (const r of items) {
      const t = r.token;
      if (t?.tokenAddress && PRICED_KINDS.has(t.kind)) keys.add(priceKeyForToken(chain, t.tokenAddress));
    }
    return Array.from(keys);
  }, [items, kind, chain]);
  const prices = usePrices(priceKeys).data ?? {};

  const usdOf = (row: TxListItem): number | undefined => {
    const t = row.token;
    if (t) {
      if (!t.tokenAddress || !PRICED_KINDS.has(t.kind)) return undefined;
      return usdValue(row.value.raw, row.value.decimals, prices[priceKeyForToken(chain, t.tokenAddress)]);
    }
    return usdValue(row.value.raw, row.value.decimals, nativePrice);
  };

  const self = address.toLowerCase();
  const hashCol: Column<TxListItem> = {
    key: 'hash',
    header: chain.family === 'solana' ? 'Signature' : 'Hash',
    render: (r) => <HashDisplay hash={r.hash} chain={chain.id} />,
  };
  const methodCol: Column<TxListItem> = { key: 'method', header: 'Method', render: (r) => <MethodChip name={r.methodName} />, hideOnMobile: true };
  const dirCol: Column<TxListItem> = { key: 'dir', header: '', render: (r) => <DirectionTag direction={r.direction} />, align: 'center', width: '1%' };
  const cpCol: Column<TxListItem> = {
    key: 'cp',
    header: 'Counterparty',
    className: 'cell-wrap',
    render: (r) => {
      const cp = counterpartyOf(r);
      return cp ? <AddressDisplay address={cp} chain={chain.id} self={cp.toLowerCase() === self} /> : <span className="muted">—</span>;
    },
  };
  const valueCol: Column<TxListItem> = {
    key: 'value',
    header: kind === 'token' ? 'Amount' : 'Value',
    align: 'right',
    render: (r) => <AmountCell amount={r.value} direction={r.direction} usd={usdOf(r)} />,
  };
  const ageCol: Column<TxListItem> = { key: 'age', header: 'Age', render: (r) => <Timestamp ts={r.timestamp} /> };
  const statusCol: Column<TxListItem> = { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} size="sm" /> };
  const tokenCol: Column<TxListItem> = { key: 'token', header: 'Token', render: (r) => <TokenCell row={r} chain={chain} /> };

  let columns: Column<TxListItem>[];
  if (kind === 'token') columns = [hashCol, tokenCol, dirCol, cpCol, valueCol, ageCol];
  else if (chain.family === 'solana') columns = [hashCol, { ...methodCol, header: 'Program' }, dirCol, cpCol, valueCol, ageCol, statusCol];
  else if (chain.family === 'bitcoin') columns = [hashCol, dirCol, cpCol, valueCol, ageCol, statusCol];
  else columns = [hashCol, methodCol, dirCol, cpCol, valueCol, ageCol, statusCol];

  const exportColumns = useMemo(() => historyCsvColumns(chain, kind), [chain, kind]);
  const labels = isSol && kind === 'token' ? SOL_TOKEN_EMPTY : LABELS[kind];
  if (!supported) {
    return <EmptyState compact title={`${labels.noun} are not available on ${chain.name}`} hint="Only EVM chains expose token transfer and internal transaction lists." />;
  }

  const hint = isSol ? enrichHint(sol.progress) : undefined;
  const loaded = isSol ? sol.history.items.length : items.length;
  const showFooter = loaded > 0 || h.hasMore;
  return (
    <DataTable
      columns={columns}
      rows={items}
      rowKey={(r, i) => `${r.hash}:${i}`}
      // Solana: keep the spinner (not the "No SPL transfers" empty state) until at least one page has been enriched.
      loading={h.isLoading || (isSol && items.length === 0 && sol.progress.loading)}
      error={h.error ?? undefined}
      onRetry={h.refetch}
      emptyTitle={labels.emptyTitle}
      emptyHint={labels.emptyHint}
      caption={`${labels.noun} of ${address} on ${chain.name}`}
      exportName={`${chain.id}-${address}-${kind}`}
      exportColumns={exportColumns}
      footer={
        showFooter ? (
          <LoadMore hasMore={h.hasMore} loading={h.isLoadingMore} onLoadMore={h.loadMore} count={isSol ? items.length : loaded} source={h.source} hint={hint} label={isSol ? 'Load more signatures' : undefined} />
        ) : undefined
      }
    />
  );
}
