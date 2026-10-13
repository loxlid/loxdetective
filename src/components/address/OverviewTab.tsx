import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { ChainId, ChainInfo, NativeBalance, TxListItem } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { formatAmount, formatDate, formatUsd } from '@/lib/format';
import { usdValue } from '@/lib/providers/prices';
import type { ChainAddressSummary } from '@/hooks/dispatch';
import { useAddressHistory } from '@/hooks/useAddressHistory';
import { useMultiChainBalances } from '@/hooks/useMultiChainBalances';
import { useNativePrice } from '@/hooks/usePrices';
import AddressDisplay from '@/components/AddressDisplay';
import Card from '@/components/Card';
import ChainBadge from '@/components/ChainBadge';
import EmptyState from '@/components/EmptyState';
import ErrorBox from '@/components/ErrorBox';
import Spinner from '@/components/Spinner';
import StatGrid, { type Stat } from '@/components/StatGrid';
import Timestamp from '@/components/Timestamp';
import TokenMeta from './TokenMeta';

interface Props {
  chain: ChainInfo;
  address: string;
  summary?: ChainAddressSummary;
  loading: boolean;
  error: Error | null;
  onRetry(): void;
}

interface SeenRange {
  first?: number;
  last?: number;
  /** True when a bound was derived from the first history page rather than reported by the provider. */
  derived: boolean;
}

/** First / last activity: provider values first, otherwise derived from the loaded history page. */
export function seenRange(summary: ChainAddressSummary | undefined, items: readonly TxListItem[], hasMore: boolean): SeenRange {
  let first = summary?.firstSeen;
  let last = summary?.lastSeen;
  let derived = false;
  if ((first === undefined || last === undefined) && items.length) {
    const ts = items.map((i) => i.timestamp).filter((t): t is number => typeof t === 'number' && t > 0);
    if (ts.length) {
      if (last === undefined) {
        last = Math.max(...ts);
        derived = true;
      }
      // The oldest row of the first page is only the first activity when there is no further page.
      if (first === undefined && !hasMore) {
        first = Math.min(...ts);
        derived = true;
      }
    }
  }
  return { first, last, derived };
}

function btcAddressType(address: string): string {
  const a = address.toLowerCase();
  if (a.startsWith('bc1p')) return 'Taproot (P2TR)';
  if (a.startsWith('bc1q')) return a.length > 50 ? 'SegWit script (P2WSH)' : 'SegWit (P2WPKH)';
  if (a.startsWith('3')) return 'Script hash (P2SH)';
  if (a.startsWith('1')) return 'Legacy (P2PKH)';
  return 'Bitcoin address';
}

/** Non-zero balances first (by USD, then by amount), zero balances next, RPC failures last. */
export function orderBalances(list: readonly NativeBalance[]): NativeBalance[] {
  const rank = (b: NativeBalance) => (b.error ? 2 : b.balance > 0n ? 0 : 1);
  return [...list].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    const u = (b.usd ?? 0) - (a.usd ?? 0);
    if (u) return u;
    return Number(b.balance) / 10 ** b.decimals - Number(a.balance) / 10 ** a.decimals;
  });
}

/** Native balance of an EVM address on every supported EVM chain, each tile linking to that chain's profile. */
export function MultiChainBalances({ address, current }: { address: string; current: ChainId }) {
  const q = useMultiChainBalances(address);
  const list = useMemo(() => orderBalances(q.data ?? []), [q.data]);
  if (q.isLoading) return <Spinner label="Querying every EVM chain…" />;
  if (q.error && !q.data) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} compact />;
  if (list.length === 0) return <EmptyState compact title="No balances" />;
  const funded = list.filter((b) => !b.error && b.balance > 0n);
  const total = funded.reduce((s, b) => s + (b.usd ?? 0), 0);
  return (
    <>
      <p className="inline-note">
        {funded.length === 0 ? 'No native balance on any EVM chain.' : `${funded.length} chain${funded.length === 1 ? '' : 's'} with a balance · ≈ ${formatUsd(total)} in total.`}
      </p>
      <div className="balances-strip">
        {list.map((b) => {
          const info = findChain(b.chain);
          const zero = !b.error && b.balance === 0n;
          const cls = `balance-tile${b.chain === current ? ' is-current' : ''}${zero ? ' is-zero' : ''}`;
          const title = b.error ? `${info?.name ?? b.chain}: RPC error — ${b.error}` : `Open this address on ${info?.name ?? b.chain}`;
          return (
            <Link key={b.chain} to={`/address/${b.chain}/${address}`} className={cls} title={title}>
              <ChainBadge chain={info ?? b.chain} size="sm" />
              <span className="balance-tile__amount">{b.error ? <span className="muted">n/a</span> : `${formatAmount(b.balance, b.decimals, 4)} ${b.symbol}`}</span>
              <span className="balance-tile__usd">{b.error ? 'RPC unavailable' : formatUsd(b.usd)}</span>
            </Link>
          );
        })}
      </div>
    </>
  );
}

/** Overview tab: key figures, family-specific extras, multi-chain balances (EVM) and token metadata. */
export default function OverviewTab({ chain, address, summary, loading, error, onRetry }: Props) {
  const nativePrice = useNativePrice(chain.id);
  // Shares the react-query cache with the Transactions tab and the risk hook.
  const history = useAddressHistory(chain.id, address, 'tx');
  const seen = useMemo(() => seenRange(summary, history.items, history.hasMore), [summary, history.items, history.hasMore]);

  const bal = summary?.nativeBalance;
  const pending = loading ? '…' : '—';
  const balanceValue = bal ? (bal.error ? 'n/a' : `${formatAmount(bal.balance, bal.decimals)} ${bal.symbol}`) : pending;
  const balanceUsd = bal && !bal.error ? (bal.usd ?? usdValue(bal.balance, bal.decimals, nativePrice)) : undefined;

  let typeText: string = pending;
  let typeHint: string | undefined;
  if (chain.family === 'bitcoin') {
    typeText = 'Bitcoin address';
    typeHint = btcAddressType(address);
  } else if (chain.family === 'solana') {
    if (summary) {
      typeText = summary.executable ? 'Program' : 'Account';
      typeHint = summary.executable ? 'Executable account' : summary.accountType ? `Parsed as ${summary.accountType}` : 'System account';
    }
  } else if (summary) {
    typeText = summary.isContract ? 'Contract' : 'EOA';
    typeHint = summary.isContract ? (summary.contract?.name ?? (summary.contract?.verified ? 'Verified contract' : 'Bytecode present')) : 'Externally owned account';
  }

  const stats: Stat[] = [
    {
      label: 'Native balance',
      value: balanceValue,
      hint: bal?.error ? <span title={bal.error}>RPC error — balance unavailable</span> : balanceUsd !== undefined ? formatUsd(balanceUsd) : undefined,
      mono: true,
      accent: true,
      testId: 'address-native-balance',
    },
    {
      label: 'Transactions',
      value: summary?.txCount !== undefined ? summary.txCount.toLocaleString('en-US') : pending,
      hint: chain.family === 'evm' && summary && !summary.isContract && summary.txCount !== undefined ? 'outgoing count (nonce) unless the explorer reports totals' : undefined,
      mono: true,
    },
    { label: 'Type', value: typeText, hint: typeHint },
    {
      label: 'First seen',
      value: <Timestamp ts={seen.first} />,
      hint: seen.first ? formatDate(seen.first) : summary && history.items.length ? 'unknown — history is paged' : undefined,
    },
    {
      label: 'Last seen',
      value: <Timestamp ts={seen.last} />,
      hint: seen.last ? `${formatDate(seen.last)}${seen.derived ? ' (from recent history)' : ''}` : undefined,
    },
  ];
  if (summary?.ensName) stats.push({ label: 'ENS name', value: summary.ensName, mono: true });
  if (chain.family === 'bitcoin' && summary) {
    const btc = (v: bigint | undefined) => (v === undefined ? '—' : `${formatAmount(v, 8, 8)} BTC`);
    stats.push(
      { label: 'Total received', value: btc(summary.received), mono: true, hint: summary.received !== undefined ? formatUsd(usdValue(summary.received, 8, nativePrice)) : undefined },
      { label: 'Total sent', value: btc(summary.sent), mono: true, hint: summary.sent !== undefined ? formatUsd(usdValue(summary.sent, 8, nativePrice)) : undefined },
      { label: 'Unspent outputs', value: summary.utxoCount !== undefined ? summary.utxoCount.toLocaleString('en-US') : '—', mono: true, hint: 'confirmed + mempool' },
    );
  }
  if (chain.family === 'solana' && summary) {
    stats.push(
      { label: 'Owner program', value: summary.owner ? <AddressDisplay address={summary.owner} chain="solana" /> : '—' },
      { label: 'Lamports', value: summary.lamports !== undefined ? summary.lamports.toLocaleString('en-US') : '—', mono: true },
    );
  }
  if (summary?.contract) {
    stats.push({
      label: 'Verification',
      value: summary.contract.verified ? <span className="chip chip--ok">Verified</span> : <span className="chip chip--warn">Not verified</span>,
      hint: summary.contract.implementation ? 'proxy — see the Contract tab' : undefined,
    });
  }

  return (
    <>
      {error && !summary && <ErrorBox error={error} onRetry={onRetry} title="Address summary unavailable" />}
      <Card title="Overview" subtitle={loading && !summary ? 'Loading summary…' : undefined}>
        <StatGrid stats={stats} />
      </Card>
      {chain.family === 'evm' && (
        <Card title="Balances across EVM chains" subtitle="Native balance of the same address on every supported EVM network">
          <MultiChainBalances address={address} current={chain.id} />
        </Card>
      )}
      {summary?.contract?.token && (
        <Card title="Token contract" subtitle="This address is a token contract">
          <TokenMeta token={summary.contract.token} chain={chain.id} />
        </Card>
      )}
    </>
  );
}
