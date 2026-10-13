/**
 * Address profile (SPEC §6): header with chain, labels, risk badge and
 * actions; family-aware tabs (Overview, Transactions, Token transfers,
 * Internal, Tokens, Approvals, Contract). The active tab lives in the URL
 * query (`?tab=`) so it survives reloads and can be linked to.
 */
import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { ChainFamily, ChainInfo } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { isEvmAddress } from '@/lib/detect';
import { shorten } from '@/lib/format';
import { isSanctioned } from '@/lib/intel/sanctions';
import { canonicalAddress } from '@/hooks/dispatch';
import { useAddressSummary } from '@/hooks/useAddressSummary';
import { useApprovals } from '@/hooks/useApprovals';
import { useLabel, useLabelsRevision } from '@/hooks/useLabel';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useRisk } from '@/hooks/useRisk';
import AddToCaseButton from '@/components/AddToCaseButton';
import Card from '@/components/Card';
import ChainBadge from '@/components/ChainBadge';
import CopyButton from '@/components/CopyButton';
import ErrorBox from '@/components/ErrorBox';
import LabelChip from '@/components/LabelChip';
import RiskBadge from '@/components/RiskBadge';
import Tabs, { type TabDef } from '@/components/Tabs';
import ApprovalsTab from '@/components/address/ApprovalsTab';
import ContractTab from '@/components/address/ContractTab';
import HistoryTable from '@/components/address/HistoryTable';
import OverviewTab from '@/components/address/OverviewTab';
import RiskFlags from '@/components/address/RiskFlags';
import TokensTab from '@/components/address/TokensTab';
import '@/styles/pages.css';

export type AddressTabId = 'overview' | 'transactions' | 'transfers' | 'internal' | 'tokens' | 'approvals' | 'contract';

/** Tabs available per chain family. The test ids are part of the e2e contract (docs/UI_TESTIDS.md). */
export function tabsFor(family: ChainFamily): TabDef[] {
  const tabs: TabDef[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'transactions', label: 'Transactions', testId: 'address-tab-transactions' },
  ];
  if (family === 'evm') tabs.push({ id: 'transfers', label: 'Token transfers' }, { id: 'internal', label: 'Internal' });
  if (family !== 'bitcoin') tabs.push({ id: 'tokens', label: 'Tokens', testId: 'address-tab-tokens' });
  if (family === 'evm') {
    tabs.push({ id: 'approvals', label: 'Approvals', testId: 'address-tab-approvals' }, { id: 'contract', label: 'Contract', testId: 'address-tab-contract' });
  }
  return tabs;
}

/** Validates the route params and canonicalises the address; `error` is set when the page cannot be shown. */
export function validateAddressRoute(chain: string, address: string): { info?: ChainInfo; address: string; error?: string } {
  const info = findChain(chain);
  const display = canonicalAddress(info, address);
  if (!info) return { address: display, error: `Unknown chain "${chain}".` };
  if (!display) return { info, address: display, error: 'No address given.' };
  if (info.family === 'evm' && !isEvmAddress(display)) return { info, address: display, error: `"${address}" is not a valid EVM address.` };
  return { info, address: display };
}

export default function AddressPage() {
  const params = useParams();
  const route = validateAddressRoute(params.chain ?? '', params.address ?? '');
  usePageTitle(route.info ? `${shorten(route.address, 8, 6)} · ${route.info.name}` : 'Address');
  return (
    <div className="address-page" data-testid="address-page">
      {route.error || !route.info ? (
        <ErrorBox title="Cannot open this address" message={route.error ?? 'Unknown chain'} hint={<Link to="/">Back to search</Link>} />
      ) : (
        <AddressProfile info={route.info} address={route.address} />
      )}
    </div>
  );
}

function AddressProfile({ info, address }: { info: ChainInfo; address: string }) {
  const chain = info.id;
  const summaryQ = useAddressSummary(chain, address);
  const risk = useRisk(chain, address);
  // Shares the react-query cache with the Approvals tab and the risk hook; only used for the tab counter.
  const approvalsQ = useApprovals(chain, address);
  const label = useLabel(address, chain);
  const rev = useLabelsRevision();
  const sanctioned = useMemo(() => isSanctioned(address), [address, rev]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [showFlags, setShowFlags] = useState(false);

  const tabs = useMemo(() => {
    const list = tabsFor(info.family);
    const count = approvalsQ.data?.length;
    return count ? list.map((t) => (t.id === 'approvals' ? { ...t, count } : t)) : list;
  }, [info.family, approvalsQ.data]);
  const requested = searchParams.get('tab') ?? 'overview';
  const active = (tabs.some((t) => t.id === requested) ? requested : 'overview') as AddressTabId;
  const setTab = (id: string) => {
    const next = new URLSearchParams(searchParams);
    if (id === 'overview') next.delete('tab');
    else next.set('tab', id);
    setSearchParams(next, { replace: true });
  };

  const summary = summaryQ.data;
  const retry = () => void summaryQ.refetch();
  const flagCount = risk.report?.flags.length ?? 0;
  const typeChip = summary ? (info.family === 'solana' ? (summary.executable ? 'Program' : 'Account') : summary.isContract ? 'Contract' : info.family === 'evm' ? 'EOA' : undefined) : undefined;

  return (
    <>
      <header className="page-header">
        <div className="page-header__top">
          <ChainBadge chain={info} showName size="lg" />
          <div className="page-header__title">
            <h1 title={address}>{address}</h1>
            <CopyButton value={address} label="Copy address" />
          </div>
        </div>
        <div className="page-header__chips">
          {summary?.ensName && (
            <span className="chip chip--infrastructure" title="ENS reverse record">
              {summary.ensName}
            </span>
          )}
          {label && <LabelChip label={label} />}
          {sanctioned && sanctioned !== label && <LabelChip label={sanctioned} />}
          {typeChip && <span className="chip chip--other">{typeChip}</span>}
          <button type="button" className="risk-toggle" onClick={() => setShowFlags((v) => !v)} aria-expanded={showFlags} title="Show the risk indicators">
            <RiskBadge report={risk.report} loading={risk.loading} />
            <span className="small">
              {flagCount} flag{flagCount === 1 ? '' : 's'}
            </span>
            <span className="risk-toggle__caret" aria-hidden="true">
              ▼
            </span>
          </button>
        </div>
        <div className="page-header__actions">
          <Link className="btn btn--primary btn--sm" to={`/trace/${chain}/${address}`}>
            Trace funds
          </Link>
          <AddToCaseButton chain={chain} kind="address" value={address} size="sm" />
          <a className="btn btn--sm" href={info.explorer.address(address)} target="_blank" rel="noreferrer noopener">
            Open in {info.explorer.name} ↗
          </a>
        </div>
      </header>

      {showFlags && (
        <Card
          title="Risk indicators"
          subtitle={risk.report ? `Score ${risk.report.score}/100 · ${risk.report.level}${risk.loading ? ' · still loading inputs' : ''}` : undefined}
          actions={
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setShowFlags(false)}>
              Hide
            </button>
          }
        >
          <RiskFlags report={risk.report} loading={risk.loading} />
        </Card>
      )}

      <Tabs tabs={tabs} active={active} onChange={setTab} ariaLabel="Address sections" />
      <div className="tab-panel" role="tabpanel">
        {active === 'overview' && <OverviewTab chain={info} address={address} summary={summary} loading={summaryQ.isLoading} error={summaryQ.error} onRetry={retry} />}
        {active === 'transactions' && (
          <Card title="Transactions" flush>
            <HistoryTable chain={info} address={address} kind="tx" />
          </Card>
        )}
        {active === 'transfers' && (
          <Card title="Token transfers" flush>
            <HistoryTable chain={info} address={address} kind="token" />
          </Card>
        )}
        {active === 'internal' && (
          <Card title="Internal transactions" flush>
            <HistoryTable chain={info} address={address} kind="internal" />
          </Card>
        )}
        {active === 'tokens' && <TokensTab chain={info} address={address} />}
        {active === 'approvals' && <ApprovalsTab chain={info} address={address} />}
        {active === 'contract' && (
          <ContractTab chain={info} address={address} summary={summary} summaryLoading={summaryQ.isLoading} summaryError={summaryQ.error} onRetrySummary={retry} />
        )}
      </div>
    </>
  );
}
