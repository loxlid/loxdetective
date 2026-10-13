import type { ChainInfo, ContractInfo } from '@/lib/types';
import type { ChainAddressSummary } from '@/hooks/dispatch';
import { useContractInfo } from '@/hooks/useContractInfo';
import AddressDisplay from '@/components/AddressDisplay';
import Card from '@/components/Card';
import EmptyState from '@/components/EmptyState';
import ErrorBox from '@/components/ErrorBox';
import HashDisplay from '@/components/HashDisplay';
import Spinner from '@/components/Spinner';
import TokenMeta from './TokenMeta';

interface Props {
  chain: ChainInfo;
  address: string;
  summary?: ChainAddressSummary;
  summaryLoading: boolean;
  summaryError: Error | null;
  onRetrySummary(): void;
}

const PROXY_TEXT: Record<NonNullable<ContractInfo['proxyType']>, string> = {
  'EIP-1967': 'EIP-1967 transparent / beacon proxy',
  'EIP-1167': 'EIP-1167 minimal proxy (clone)',
  'EIP-1822': 'EIP-1822 UUPS proxy',
  unknown: 'Proxy (pattern not recognised)',
};

/** Verification, proxy, creator and token metadata of a contract (EVM). */
export default function ContractTab({ chain, address, summary, summaryLoading, summaryError, onRetrySummary }: Props) {
  const isContract = summary?.isContract ?? false;
  const q = useContractInfo(chain.id, address, isContract);

  if (!summary) {
    if (summaryLoading) return <Spinner block label="Loading address…" />;
    return <ErrorBox error={summaryError ?? 'Address summary unavailable'} onRetry={onRetrySummary} />;
  }
  if (!isContract) {
    return <EmptyState title="Not a contract" hint="This address has no bytecode: it is an externally owned account (EOA)." />;
  }
  if (q.isLoading) return <Spinner block label="Loading contract details…" />;
  if (q.error && !q.data) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;

  const c: ContractInfo = q.data ?? summary.contract ?? { verified: false };
  const sourceUrl = c.sourceUrl ?? `${chain.explorer.address(address)}#code`;

  return (
    <>
      <Card
        title="Contract"
        subtitle={c.name ?? undefined}
        actions={
          <a className="btn btn--sm" href={sourceUrl} target="_blank" rel="noreferrer noopener">
            View source ↗
          </a>
        }
      >
        <dl className="kv">
          <dt>Verification</dt>
          <dd>{c.verified ? <span className="chip chip--ok">Verified</span> : <span className="chip chip--warn">Not verified</span>}</dd>
          <dt>Name</dt>
          <dd>{c.name ?? '—'}</dd>
          <dt>Compiler</dt>
          <dd className="mono">{c.compiler ?? '—'}</dd>
          <dt>Proxy</dt>
          <dd>{c.proxyType ? PROXY_TEXT[c.proxyType] : 'No proxy pattern detected'}</dd>
          {c.implementation && (
            <>
              <dt>Implementation</dt>
              <dd>
                <AddressDisplay address={c.implementation} chain={chain.id} short={false} copy />
              </dd>
            </>
          )}
          <dt>Creator</dt>
          <dd>{c.creator ? <AddressDisplay address={c.creator} chain={chain.id} copy /> : '—'}</dd>
          <dt>Creation tx</dt>
          <dd>{c.creationTx ? <HashDisplay hash={c.creationTx} chain={chain.id} copy /> : '—'}</dd>
        </dl>
      </Card>
      {c.token && (
        <Card title="Token" subtitle="This contract is a token">
          <TokenMeta token={c.token} chain={chain.id} />
        </Card>
      )}
    </>
  );
}
