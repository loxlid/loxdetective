/**
 * Transaction detail (SPEC §6). One component for every chain family: the
 * normalised `Transaction` drives the common sections (status, parties,
 * value, fee, transfers) and family-specific extras are rendered when the
 * provider attached them (EVM logs / calldata, Bitcoin inputs & outputs,
 * Solana program log).
 */
import { Fragment, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ChainInfo, Transaction } from '@/lib/types';
import type { BtcIo } from '@/lib/providers/btc/esplora';
import { findChain } from '@/lib/chains/registry';
import { formatAmount, formatGwei, formatUsd, pct, shorten } from '@/lib/format';
import { usdValue } from '@/lib/providers/prices';
import { canonicalAddress } from '@/hooks/dispatch';
import { useNativePrice } from '@/hooks/usePrices';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useTransaction } from '@/hooks/useTransaction';
import AddressDisplay from '@/components/AddressDisplay';
import AddToCaseButton from '@/components/AddToCaseButton';
import Card from '@/components/Card';
import ChainBadge from '@/components/ChainBadge';
import CopyButton from '@/components/CopyButton';
import ErrorBox from '@/components/ErrorBox';
import Spinner from '@/components/Spinner';
import StatGrid, { type Stat } from '@/components/StatGrid';
import Timestamp from '@/components/Timestamp';
import BtcIoTables from '@/components/tx/BtcIoTables';
import InternalCallsTable from '@/components/tx/InternalCallsTable';
import LogsPanel from '@/components/tx/LogsPanel';
import StatusPill from '@/components/tx/StatusPill';
import TransfersTable from '@/components/tx/TransfersTable';
import '@/styles/pages.css';

type BtcTransaction = Transaction & { inputs: BtcIo[]; outputs: BtcIo[] };

function isBtcTransaction(tx: Transaction): tx is BtcTransaction {
  const t = tx as Partial<BtcTransaction>;
  return Array.isArray(t.inputs) && Array.isArray(t.outputs);
}

const PSEUDO_ADDRESSES = new Set(['coinbase', 'unknown', 'OP_RETURN', '']);

const fmtInt = (n: bigint | number | undefined): string => (n === undefined ? '—' : Number(n).toLocaleString('en-US'));

const EXTRA_LABELS: Record<string, string> = {
  type: 'Transaction type',
  transactionIndex: 'Index in block',
  maxFeePerGas: 'Max fee per gas',
  maxPriorityFeePerGas: 'Max priority fee',
  l1Fee: 'L1 data fee',
  logCount: 'Logs',
  size: 'Size (bytes)',
  weight: 'Weight (WU)',
  vsize: 'Virtual size (vB)',
  feeRateSatPerVb: 'Fee rate (sat/vB)',
  confirmations: 'Confirmations',
  blockHash: 'Block hash',
  version: 'Version',
  locktime: 'Locktime',
  inputCount: 'Inputs',
  outputCount: 'Outputs',
  totalInputSats: 'Total input (sat)',
  totalOutputSats: 'Total output (sat)',
  coinbase: 'Coinbase',
  rbfSignalled: 'RBF signalled',
  slot: 'Slot',
  recentBlockhash: 'Recent blockhash',
  computeUnitsConsumed: 'Compute units',
  instructionCount: 'Instructions',
  accountCount: 'Accounts',
  programs: 'Programs',
  error: 'Error',
};
/** Extras that get their own section (or none) instead of a key/value row. */
const HIDDEN_EXTRAS = new Set(['logMessages', 'logTruncated', 'error']);

/** Human label for an `extra` key: known names first, else "camelCase" → "Camel case". */
export function extraLabel(key: string): string {
  return EXTRA_LABELS[key] ?? key.replace(/([A-Z])/g, (c) => ` ${c.toLowerCase()}`).replace(/^./, (c) => c.toUpperCase());
}

/** Display form of an `extra` value (gwei / native formatting for the known fee fields). */
export function extraValue(key: string, value: string | number | boolean, chain: ChainInfo): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const s = String(value);
  if ((key === 'maxFeePerGas' || key === 'maxPriorityFeePerGas') && /^\d+$/.test(s)) return formatGwei(BigInt(s));
  if (key === 'l1Fee' && /^\d+$/.test(s)) return `${formatAmount(BigInt(s), chain.native.decimals, 8)} ${chain.native.symbol}`;
  if (typeof value === 'number' && Number.isInteger(value)) return value.toLocaleString('en-US');
  return s;
}

/** Stat tiles for the "Details" card, by chain family. */
export function buildTxStats(tx: Transaction, info: ChainInfo, nativePrice: number | undefined): Stat[] {
  const chain = info.id;
  const ex = tx.extra ?? {};
  const stats: Stat[] = [];
  const fromPseudo = PSEUDO_ADDRESSES.has(tx.from);
  stats.push({
    label: 'From',
    value: <AddressDisplay address={tx.from} chain={chain} short={false} copy={!fromPseudo} />,
    hint: info.family === 'bitcoin' && !fromPseudo ? 'largest input' : info.family === 'solana' ? 'fee payer' : undefined,
  });
  if (tx.contractCreated) {
    stats.push({ label: 'To', value: 'Contract creation', hint: <AddressDisplay address={tx.contractCreated} chain={chain} copy /> });
  } else {
    stats.push({
      label: 'To',
      value: tx.to ? <AddressDisplay address={tx.to} chain={chain} short={false} copy={!PSEUDO_ADDRESSES.has(tx.to)} /> : '—',
      hint: info.family === 'solana' ? 'main program' : info.family === 'bitcoin' ? 'largest output' : undefined,
    });
  }
  const valueUsd = usdValue(tx.value.raw, tx.value.decimals, nativePrice);
  stats.push({
    label: info.family === 'bitcoin' ? 'Total output' : 'Value',
    value: `${formatAmount(tx.value.raw, tx.value.decimals, 8)} ${tx.value.symbol}`,
    hint: valueUsd !== undefined ? formatUsd(valueUsd) : undefined,
    mono: true,
    accent: tx.value.raw > 0n,
  });
  if (tx.fee) {
    const feeUsd = usdValue(tx.fee.raw, tx.fee.decimals, nativePrice);
    const feeRate = typeof ex.feeRateSatPerVb === 'number' ? `${ex.feeRateSatPerVb} sat/vB` : undefined;
    stats.push({
      label: 'Fee',
      value: `${formatAmount(tx.fee.raw, tx.fee.decimals, 8)} ${tx.fee.symbol}`,
      hint: feeUsd !== undefined ? `${formatUsd(feeUsd)}${feeRate ? ` · ${feeRate}` : ''}` : feeRate,
      mono: true,
    });
  }
  if (info.family === 'evm') {
    if (tx.gasUsed !== undefined || tx.gasLimit !== undefined) {
      stats.push({
        label: 'Gas used / limit',
        value: `${fmtInt(tx.gasUsed)} / ${fmtInt(tx.gasLimit)}`,
        hint: tx.gasUsed !== undefined && tx.gasLimit ? `${pct(Number(tx.gasUsed), Number(tx.gasLimit))} of the limit` : undefined,
        mono: true,
      });
    }
    if (tx.gasPrice !== undefined) stats.push({ label: 'Gas price', value: formatGwei(tx.gasPrice), mono: true });
    if (tx.nonce !== undefined) stats.push({ label: 'Nonce', value: fmtInt(tx.nonce), mono: true });
    stats.push({
      label: 'Method',
      value: tx.methodName ? <span className="mono">{tx.methodName}</span> : tx.methodId ? <span className="mono">{tx.methodId}</span> : <span className="muted">— (plain value transfer)</span>,
      hint: tx.methodName && tx.methodId ? `selector ${tx.methodId}` : undefined,
    });
  }
  if (info.family === 'solana') {
    if (tx.gasUsed !== undefined) stats.push({ label: 'Compute units', value: fmtInt(tx.gasUsed), mono: true });
    stats.push({ label: 'Program', value: tx.methodName ?? (tx.methodId ? shorten(tx.methodId, 6, 6) : '—'), hint: tx.methodId ? <span className="mono">{tx.methodId}</span> : undefined });
    if (typeof ex.programs === 'string' && ex.programs) stats.push({ label: 'Programs invoked', value: ex.programs, wide: true });
  }
  if (info.family === 'bitcoin') {
    if (typeof ex.vsize === 'number') {
      stats.push({ label: 'Size', value: `${fmtInt(ex.vsize)} vB`, hint: typeof ex.size === 'number' ? `${fmtInt(ex.size)} bytes · ${fmtInt(typeof ex.weight === 'number' ? ex.weight : undefined)} WU` : undefined, mono: true });
    }
    if (typeof ex.confirmations === 'number') stats.push({ label: 'Confirmations', value: fmtInt(ex.confirmations), mono: true });
    if (ex.rbfSignalled === true) stats.push({ label: 'Replace-by-fee', value: 'Signalled', hint: 'inputs opt in to RBF' });
  }
  return stats;
}

export default function TxPage() {
  const { chain = '', hash = '' } = useParams();
  const info = findChain(chain);
  const h = hash.trim();
  usePageTitle(info ? `Tx ${shorten(h, 10, 6)} · ${info.name}` : 'Transaction');
  return (
    <div className="tx-page" data-testid="tx-page">
      {!info ? (
        <ErrorBox title="Cannot open this transaction" message={`Unknown chain "${chain}".`} hint={<Link to="/">Back to search</Link>} />
      ) : !h ? (
        <ErrorBox title="Cannot open this transaction" message="No transaction hash given." hint={<Link to="/">Back to search</Link>} />
      ) : (
        <TxDetail info={info} hash={h} />
      )}
    </div>
  );
}

function TxDetail({ info, hash }: { info: ChainInfo; hash: string }) {
  const q = useTransaction(info.id, hash);
  const tx = q.data;
  const confirmations = tx?.extra?.confirmations;
  const sender = tx && !PSEUDO_ADDRESSES.has(tx.from) ? canonicalAddress(info, tx.from) : undefined;
  return (
    <>
      <header className="page-header">
        <div className="page-header__top">
          <ChainBadge chain={info} showName size="lg" />
          {tx && <StatusPill status={tx.status} testId="tx-status" />}
          {q.isLoading && <Spinner size="sm" label="Loading transaction…" />}
        </div>
        <div className="page-header__title">
          <h1 title={hash}>{hash}</h1>
          <CopyButton value={hash} label="Copy hash" />
        </div>
        {tx && (
          <div className="page-header__meta">
            {tx.timestamp !== undefined && <Timestamp ts={tx.timestamp} mode="both" />}
            {tx.blockNumber !== undefined && (
              <span>
                {info.family === 'solana' ? 'Slot' : 'Block'} <span className="mono">{fmtInt(tx.blockNumber)}</span>
              </span>
            )}
            {typeof confirmations === 'number' && (
              <span>
                {fmtInt(confirmations)} confirmation{confirmations === 1 ? '' : 's'}
              </span>
            )}
            {tx.status === 'pending' && <span className="status status--pending status--sm">Not yet included in a block</span>}
          </div>
        )}
        <div className="page-header__actions">
          <AddToCaseButton chain={info.id} kind="tx" value={hash} size="sm" />
          <a className="btn btn--sm" href={info.explorer.tx(hash)} target="_blank" rel="noreferrer noopener">
            Open in {info.explorer.name} ↗
          </a>
          {sender && (
            <Link className="btn btn--sm btn--ghost" to={`/trace/${info.id}/${sender}`}>
              Trace sender
            </Link>
          )}
        </div>
      </header>
      {q.error && <ErrorBox error={q.error} onRetry={() => void q.refetch()} title="Transaction unavailable" />}
      {tx && <TxBody tx={tx} info={info} />}
    </>
  );
}

function TxBody({ tx, info }: { tx: Transaction; info: ChainInfo }) {
  const nativePrice = useNativePrice(info.id);
  const stats = useMemo(() => buildTxStats(tx, info, nativePrice), [tx, info, nativePrice]);
  const btc = isBtcTransaction(tx) ? tx : undefined;
  const ex = tx.extra ?? {};
  const extras = Object.entries(ex).filter(([k, v]) => !HIDDEN_EXTRAS.has(k) && v !== null && v !== undefined && v !== '');
  const logMessages = typeof ex.logMessages === 'string' ? ex.logMessages : '';
  const failure = typeof ex.error === 'string' ? ex.error : undefined;
  const inputBytes = tx.input && tx.input !== '0x' ? Math.floor((tx.input.length - 2) / 2) : 0;

  return (
    <>
      {tx.status === 'failed' && <ErrorBox compact title="Transaction failed" message={failure ?? 'The transaction was included in a block but its execution reverted.'} />}
      <Card title="Details">
        <StatGrid stats={stats} minWidth={200} />
      </Card>
      {btc && <BtcIoTables inputs={btc.inputs} outputs={btc.outputs} chain={info} coinbase={ex.coinbase === true} />}
      <Card title="Transfers" subtitle={tx.transfers.length ? `${tx.transfers.length} transfer${tx.transfers.length === 1 ? '' : 's'} decoded` : undefined} flush>
        <TransfersTable tx={tx} chain={info} />
      </Card>
      {tx.internal && tx.internal.length > 0 && (
        <Card title="Internal calls" subtitle={`${tx.internal.length} call${tx.internal.length === 1 ? '' : 's'} reported by the explorer`} flush>
          <InternalCallsTable calls={tx.internal} chain={info} />
        </Card>
      )}
      {tx.logs && tx.logs.length > 0 && <LogsPanel logs={tx.logs} chain={info} />}
      {logMessages && (
        <Card title="Program log" subtitle={ex.logTruncated === true ? 'First 20 lines' : undefined}>
          <pre className="code code--tall code--wrap">{logMessages}</pre>
        </Card>
      )}
      {inputBytes > 0 && (
        <Card title="Input data" subtitle={`${inputBytes.toLocaleString('en-US')} bytes${tx.methodId ? ` · selector ${tx.methodId}` : ''}`}>
          <details className="details">
            <summary>Show raw calldata</summary>
            <pre className="code code--wrap code--tall">{tx.input}</pre>
          </details>
        </Card>
      )}
      {extras.length > 0 && (
        <Card title="More details">
          <dl className="kv">
            {extras.map(([k, v]) => (
              <Fragment key={k}>
                <dt>{extraLabel(k)}</dt>
                <dd className="mono">{extraValue(k, v as string | number | boolean, info)}</dd>
              </Fragment>
            ))}
          </dl>
        </Card>
      )}
    </>
  );
}
