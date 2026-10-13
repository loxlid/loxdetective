import { Link } from 'react-router-dom';
import type { ChainInfo, TokenBalance, TokenInfo } from '@/lib/types';
import { formatUsd } from '@/lib/format';
import { useTokenBalances } from '@/hooks/useTokenBalances';
import AddressDisplay from '@/components/AddressDisplay';
import AmountCell from '@/components/AmountCell';
import Card from '@/components/Card';
import DataTable, { type Column } from '@/components/DataTable';

/** Symbol + name, linking to the token contract's profile. */
export function TokenName({ token, chain }: { token: TokenInfo; chain: ChainInfo }) {
  return (
    <Link className="token-link" to={`/address/${chain.id}/${token.address}`} title={token.address}>
      <span className="token-cell">
        <span className="token-cell__symbol mono">{token.symbol || '?'}</span>
        {token.name && token.name !== token.symbol && <span className="token-cell__name">{token.name}</span>}
      </span>
    </Link>
  );
}

/** Token balances with USD values and a total. */
export default function TokensTab({ chain, address }: { chain: ChainInfo; address: string }) {
  const q = useTokenBalances(chain.id, address);
  const rows = q.data ?? [];
  const priced = rows.filter((b) => b.usd !== undefined);
  const total = priced.reduce((s, b) => s + (b.usd ?? 0), 0);

  const columns: Column<TokenBalance>[] = [
    { key: 'token', header: 'Token', render: (b) => <TokenName token={b.token} chain={chain} /> },
    { key: 'type', header: 'Standard', hideOnMobile: true, render: (b) => <span className="chip chip--token">{b.token.type}</span> },
    { key: 'balance', header: 'Balance', align: 'right', render: (b) => <AmountCell amount={{ raw: b.balance, decimals: b.token.decimals, symbol: b.token.symbol }} /> },
    { key: 'usd', header: 'Value', align: 'right', className: 'num', render: (b) => formatUsd(b.usd) },
    { key: 'addr', header: 'Contract', hideOnMobile: true, render: (b) => <AddressDisplay address={b.token.address} chain={chain.id} showLabel={false} copy /> },
  ];

  const subtitle = rows.length
    ? `${rows.length} token${rows.length === 1 ? '' : 's'} · ≈ ${formatUsd(total)} (${priced.length} priced${priced.length < rows.length ? `, ${rows.length - priced.length} without a known price` : ''})`
    : undefined;

  return (
    <Card title="Token balances" subtitle={subtitle} flush>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(b) => `${b.token.address}:${b.token.type}`}
        loading={q.isLoading}
        error={q.error ?? undefined}
        onRetry={() => void q.refetch()}
        emptyTitle="No token balances"
        emptyHint="No fungible or NFT balances were found for this address."
        caption={`Token balances of ${address} on ${chain.name}`}
        footer={rows.length ? <span className="muted small">Prices via DefiLlama; tokens without a known price are listed last.</span> : undefined}
      />
    </Card>
  );
}
