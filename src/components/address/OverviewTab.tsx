import { Fragment, useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { ChainActivity, ChainId, ChainInfo, NativeBalance, TxListItem } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { formatAmount, formatDate, formatUsd } from '@/lib/format';
import { usdValue } from '@/lib/providers/prices';
import type { ChainAddressSummary } from '@/hooks/dispatch';
import { useAddressHistory } from '@/hooks/useAddressHistory';
import { chainName, isActiveChain, orderActivity, otherActiveChains, summaryLooksInactive, useMultiChainActivity } from '@/hooks/useMultiChainActivity';
import { useNativePrice } from '@/hooks/usePrices';
import AddressDisplay from '@/components/AddressDisplay';
import Card from '@/components/Card';
import ChainBadge from '@/components/ChainBadge';
import EmptyState from '@/components/EmptyState';
import ErrorBox from '@/components/ErrorBox';
import Spinner from '@/components/Spinner';
import StatGrid, { type Stat } from '@/components/StatGrid';
import Timestamp from '@/components/Timestamp';
import CounterpartiesCard from './CounterpartiesCard';
import TokenMeta from './TokenMeta';
import UtxoCard from './UtxoCard';

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

/** "Active on X of Y chains" header line of the activity strip. */
export function activityHeadline(list: readonly ChainActivity[]): string {
  const active = list.filter(isActiveChain);
  const total = active.reduce((s, a) => s + (a.balance && !a.balance.error ? (a.balance.usd ?? 0) : 0), 0);
  const base = `Active on ${active.length} of ${list.length} chain${list.length === 1 ? '' : 's'}`;
  return active.length ? `${base} · ≈ ${formatUsd(total)} in native balances` : `${base}.`;
}

/** "n txs" label of an activity tile. */
export function txCountLabel(a: ChainActivity): string {
  if (a.txCount === undefined) return 'n/a';
  return `${a.txCount.toLocaleString('en-US')} tx${a.txCount === 1 ? '' : 's'}`;
}

/** Activity (balance + transaction count) of an EVM address on every supported EVM chain, each tile linking to that chain's profile. */
export function MultiChainActivityStrip({ address, current, query }: { address: string; current: ChainId; query: ReturnType<typeof useMultiChainActivity> }) {
  const q = query;
  const list = useMemo(() => orderActivity(q.data ?? []), [q.data]);
  if (q.isLoading) return <Spinner label="Querying every EVM chain…" />;
  if (q.error && !q.data) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} compact />;
  if (list.length === 0) return <EmptyState compact title="No chains probed" />;
  return (
    <>
      <p className="inline-note">{activityHeadline(list)}</p>
      <div className="balances-strip">
        {list.map((a) => {
          const info = findChain(a.chain);
          const b = a.balance && !a.balance.error ? a.balance : undefined;
          const failed = !b && a.txCount === undefined;
          const active = isActiveChain(a);
          const cls = `balance-tile activity-tile${a.chain === current ? ' is-current' : ''}${!active && !failed ? ' is-zero' : ''}${failed ? ' is-failed' : ''}`;
          const title = failed ? `${info?.name ?? a.chain}: RPC error — ${a.error ?? 'unavailable'}` : `Open this address on ${info?.name ?? a.chain}${a.error ? ` (partial: ${a.error})` : ''}`;
          return (
            <Link key={a.chain} to={`/address/${a.chain}/${address}`} className={cls} title={title}>
              <ChainBadge chain={info ?? a.chain} size="sm" />
              <span className="balance-tile__amount">{b ? `${formatAmount(b.balance, b.decimals, 4)} ${b.symbol}` : <span className="muted">n/a</span>}</span>
              <span className="balance-tile__usd">{b ? formatUsd(b.usd) : failed ? 'RPC unavailable' : '—'}</span>
              <span className={`activity-tile__txs${a.txCount === undefined ? ' muted' : ''}`}>{txCountLabel(a)}</span>
            </Link>
          );
        })}
      </div>
    </>
  );
}

/** Previous name of the strip (kept for callers). */
export { MultiChainActivityStrip as MultiChainBalances };

/** One-line callout when the address is idle on the current chain but active elsewhere. */
export function ActiveElsewhereCallout({ current, others, address }: { current: ChainId; others: readonly ChainActivity[]; address: string }) {
  if (!others.length) return null;
  return (
    <p className="callout callout--info" role="status" data-testid="address-active-elsewhere">
      No activity on {chainName(current)} — this address is active on{' '}
      {others.map((a, i) => (
        <Fragment key={a.chain}>
          {i > 0 && ', '}
          <Link to={`/address/${a.chain}/${address}`}>{chainName(a.chain)}</Link> ({txCountLabel(a)})
        </Fragment>
      ))}
      .
    </p>
  );
}

/** Overview tab: key figures, family-specific extras, multi-chain activity (EVM), counterparties, UTXOs (BTC) and token metadata. */
export default function OverviewTab({ chain, address, summary, loading, error, onRetry }: Props) {
  const nativePrice = useNativePrice(chain.id);
  // Shares the react-query cache with the Transactions tab and the risk hook.
  const history = useAddressHistory(chain.id, address, 'tx');
  const seen = useMemo(() => seenRange(summary, history.items, history.hasMore), [summary, history.items, history.hasMore]);
  // Disabled (no network) for non-EVM addresses.
  const activityQ = useMultiChainActivity(chain.family === 'evm' ? address : '');
  const elsewhere = useMemo(
    () => (chain.family === 'evm' && summaryLooksInactive(summary) ? otherActiveChains(activityQ.data ?? [], chain.id) : []),
    [chain.family, chain.id, summary, activityQ.data],
  );

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
      <ActiveElsewhereCallout current={chain.id} others={elsewhere} address={address} />
      <Card title="Overview" subtitle={loading && !summary ? 'Loading summary…' : undefined}>
        <StatGrid stats={stats} />
      </Card>
      {chain.family === 'evm' && (
        <Card title="Activity across EVM chains" subtitle="Native balance and outgoing transaction count of the same address on every supported EVM network" testId="address-activity-strip">
          <MultiChainActivityStrip address={address} current={chain.id} query={activityQ} />
        </Card>
      )}
      {chain.family === 'bitcoin' && <UtxoCard address={address} nativePrice={nativePrice} />}
      <CounterpartiesCard chain={chain} address={address} />
      {summary?.contract?.token && (
        <Card title="Token contract" subtitle="This address is a token contract">
          <TokenMeta token={summary.contract.token} chain={chain.id} />
        </Card>
      )}
    </>
  );
}
