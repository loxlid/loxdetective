import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { ApprovalInfo, ChainInfo } from '@/lib/types';
import type { CsvColumn } from '@/lib/export';
import { formatAmount } from '@/lib/format';
import { lookupLabel } from '@/lib/intel/labels';
import { scannedSpan, useApprovalScan } from '@/hooks/useApprovals';
import { useLabelsRevision } from '@/hooks/useLabel';
import AddressDisplay from '@/components/AddressDisplay';
import AmountCell from '@/components/AmountCell';
import Card from '@/components/Card';
import DataTable, { type Column } from '@/components/DataTable';
import HashDisplay from '@/components/HashDisplay';
import Timestamp from '@/components/Timestamp';
import { TokenName } from './TokensTab';

const RISKY_CATEGORIES = new Set(['sanctioned', 'scam', 'mixer']);

function RiskHint({ approval, chain }: { approval: ApprovalInfo; chain: ChainInfo }) {
  const label = lookupLabel(approval.spender, chain.id);
  if (label && RISKY_CATEGORIES.has(label.category)) return <span className="chip chip--danger">Spender is labelled {label.category}</span>;
  if (approval.unlimited && !label && !approval.spenderLabel) return <span className="chip chip--warn">Unlimited allowance to an unlabelled spender</span>;
  if (approval.unlimited) return <span className="chip chip--info">Unlimited to a known protocol</span>;
  return <span className="muted">—</span>;
}

/** CSV columns of the approvals table. */
export function approvalsCsvColumns(): CsvColumn<ApprovalInfo>[] {
  return [
    { header: 'token_symbol', value: (a) => a.token.symbol },
    { header: 'token_address', value: (a) => a.token.address },
    { header: 'token_type', value: (a) => a.token.type },
    { header: 'spender', value: (a) => a.spender },
    { header: 'spender_label', value: (a) => a.spenderLabel },
    { header: 'allowance', value: (a) => (a.unlimited ? 'unlimited' : formatAmount(a.amount, a.token.decimals, 18)) },
    { header: 'allowance_raw', value: (a) => a.amount },
    { header: 'unlimited', value: (a) => a.unlimited },
    { header: 'tx_hash', value: (a) => a.txHash },
    { header: 'timestamp', value: (a) => (a.timestamp ? new Date(a.timestamp * 1000).toISOString() : '') },
    { header: 'block', value: (a) => a.blockNumber },
  ];
}

/** Live token allowances granted by the address (EVM), with the scan coverage. */
export default function ApprovalsTab({ chain, address }: { chain: ChainInfo; address: string }) {
  const q = useApprovalScan(chain.id, address);
  // Re-render when labels change (feed load, case tags) so the hints stay current.
  useLabelsRevision();
  const scan = q.data;
  const rows = scan?.approvals ?? [];
  const risky = rows.filter((a) => a.unlimited && !a.spenderLabel && !lookupLabel(a.spender, chain.id)).length;
  const exportColumns = useMemo(() => approvalsCsvColumns(), []);

  const columns: Column<ApprovalInfo>[] = [
    { key: 'token', header: 'Token', render: (a) => <TokenName token={a.token} chain={chain} /> },
    { key: 'spender', header: 'Spender', className: 'cell-wrap', render: (a) => <AddressDisplay address={a.spender} chain={chain.id} copy /> },
    {
      key: 'amount',
      header: 'Allowance',
      align: 'right',
      render: (a) =>
        a.unlimited ? (
          <span className="chip chip--warn" title={a.token.type === 'ERC-20' ? 'Allowance ≥ 2^255 (effectively infinite)' : 'Operator approved for all tokens (setApprovalForAll)'}>
            {a.token.type === 'ERC-20' ? 'Unlimited' : 'All tokens'}
          </span>
        ) : (
          <AmountCell amount={{ raw: a.amount, decimals: a.token.decimals, symbol: a.token.symbol }} />
        ),
    },
    {
      key: 'tx',
      header: 'Granted',
      render: (a) => (
        <span className="token-cell">
          <HashDisplay hash={a.txHash} chain={chain.id} />
          <span className="token-cell__name">
            <Timestamp ts={a.timestamp} />
          </span>
        </span>
      ),
    },
    { key: 'risk', header: 'Risk', render: (a) => <RiskHint approval={a} chain={chain} /> },
  ];

  const subtitle = rows.length
    ? `${rows.length} active allowance${rows.length === 1 ? '' : 's'}${risky ? ` · ${risky} unlimited to unlabelled spender${risky === 1 ? '' : 's'}` : ''}`
    : scan?.scanIncomplete
      ? 'Scan incomplete'
      : undefined;
  const span = scannedSpan(scan);

  return (
    <Card title="Token approvals" subtitle={subtitle} flush>
      {scan?.scanIncomplete && (
        <div className="banner banner--warn" role="alert" data-testid="approvals-incomplete">
          <strong>Approval scan incomplete.</strong> {scan.reason ?? 'The RPC refused part of the log query.'}{' '}
          {rows.length ? 'The allowances below come from the part that was scanned; others may exist.' : 'No allowance can be ruled out.'}{' '}
          <Link to="/settings">Add a custom RPC in Settings</Link> (an archive node or a provider with a larger eth_getLogs range) and retry.
        </div>
      )}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(a) => `${a.token.address}:${a.spender}:${a.txHash}`}
        loading={q.isLoading}
        error={q.error ?? undefined}
        onRetry={() => void q.refetch()}
        emptyTitle={scan?.scanIncomplete ? 'No approvals in the scanned part' : 'No active approvals found'}
        emptyHint={
          scan?.scanIncomplete
            ? 'Part of the block range was not scanned (see the warning above), so this is not a clean result.'
            : 'No Approval / ApprovalForAll events were found for this address in the scanned block range, or every allowance was revoked.'
        }
        caption={`Token approvals granted by ${address} on ${chain.name}`}
        exportName={`${chain.id}-${address}-approvals`}
        exportColumns={exportColumns}
        footer={
          <span className="muted small">
            {span ? <span className="approvals-span">{span}. </span> : null}
            Scanned from Approval / ApprovalForAll logs of the last ~2,000,000 blocks via RPC; revoked (zero) allowances are omitted. Use a revoke tool to remove risky allowances.
          </span>
        }
      />
    </Card>
  );
}
