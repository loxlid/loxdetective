import { useMemo } from 'react';
import type { AddressLabel, ApprovalInfo, ChainId, RiskReport, TxListItem } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { assessAddress, type RiskInput } from '@/lib/intel/risk';
import { lookupLabel } from '@/lib/intel/labels';
import { useAddressSummary } from './useAddressSummary';
import { useAddressHistory } from './useAddressHistory';
import { useApprovals } from './useApprovals';
import { useLabelsRevision } from './useLabel';
import { useNativePrice } from './usePrices';
import type { ChainAddressSummary } from './dispatch';

export interface RiskState {
  /** Undefined until at least the summary or a history page is available. */
  report?: RiskReport;
  /** True while any of the inputs is still loading (the report may already be a partial estimate). */
  loading: boolean;
  /** Which inputs were available when the report was computed. */
  inputs: { summary: boolean; history: boolean; tokenTransfers: boolean; approvals: boolean };
  errors: Error[];
}

/** Registry labels for every counterparty in the rows (lower-cased key, as `RiskInput` expects). */
export function counterpartyLabels(chain: ChainId, rows: TxListItem[], self: string): Map<string, AddressLabel> {
  const out = new Map<string, AddressLabel>();
  const me = self.toLowerCase();
  for (const r of rows) {
    for (const raw of [r.from, r.to]) {
      if (!raw) continue;
      // Bitcoin rows may join several input addresses with commas.
      for (const a of raw.split(',')) {
        const key = a.trim().toLowerCase();
        if (!key || key === me || out.has(key)) continue;
        const label = lookupLabel(a.trim(), chain);
        if (label) out.set(key, label);
      }
    }
  }
  return out;
}

/** Pure composition of the risk input from the pieces the hooks load (exported for tests / the tracer). */
export function buildRiskInput(
  chain: ChainId,
  address: string,
  parts: { summary?: ChainAddressSummary; history?: TxListItem[]; tokenTransfers?: TxListItem[]; approvals?: ApprovalInfo[]; nativePriceUsd?: number; now?: number },
): RiskInput {
  const rows = [...(parts.history ?? []), ...(parts.tokenTransfers ?? [])];
  return {
    chain,
    address,
    summary: parts.summary,
    history: parts.history,
    tokenTransfers: parts.tokenTransfers,
    approvals: parts.approvals,
    counterpartyLabels: counterpartyLabels(chain, rows, address),
    nativePriceUsd: parts.nativePriceUsd,
    now: parts.now,
  };
}

/**
 * Risk assessment composed from the summary, the first history and token
 * transfer pages, approvals (EVM) and registry labels of the counterparties.
 * All queries are shared with the address page tabs through react-query.
 */
export function useRisk(chain: ChainId, address: string): RiskState {
  const info = findChain(chain);
  const summaryQ = useAddressSummary(chain, address);
  const txH = useAddressHistory(chain, address, 'tx');
  const tokenH = useAddressHistory(chain, address, 'token');
  const approvalsQ = useApprovals(chain, address);
  const nativePriceUsd = useNativePrice(chain);
  const rev = useLabelsRevision();

  const summary = summaryQ.data;
  const history = txH.query.data?.pages[0]?.items;
  const tokenTransfers = tokenH.query.data?.pages[0]?.items;
  const approvals = approvalsQ.data;

  const report = useMemo(() => {
    if (!info) return undefined;
    if (!summary && !history) return undefined;
    return assessAddress(buildRiskInput(chain, summary?.address ?? address, { summary, history, tokenTransfers, approvals, nativePriceUsd }));
    // `rev` re-runs the assessment when labels change (feed load, case tags).
  }, [info, chain, address, summary, history, tokenTransfers, approvals, nativePriceUsd, rev]);

  const errors = [summaryQ.error, txH.error, tokenH.error, approvalsQ.error].filter((e): e is Error => !!e);
  const loading = summaryQ.isLoading || txH.isLoading || tokenH.isLoading || (approvalsQ.isLoading && info?.family === 'evm');

  return {
    report,
    loading,
    inputs: { summary: !!summary, history: !!history, tokenTransfers: !!tokenTransfers, approvals: !!approvals },
    errors,
  };
}
