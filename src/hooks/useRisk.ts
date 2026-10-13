import { useMemo } from 'react';
import type { AddressLabel, ApprovalInfo, ChainId, RiskReport, TxListItem } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { assessAddress, type RiskInput } from '@/lib/intel/risk';
import { lookupLabel } from '@/lib/intel/labels';
import { useAddressSummary } from './useAddressSummary';
import { useHistoryRows } from './useHistoryRows';
import { useApprovalScan } from './useApprovals';
import { useLabelsRevision } from './useLabel';
import { useNativePrice } from './usePrices';
import type { ChainAddressSummary } from './dispatch';

export const APPROVALS_NOT_SCANNED = 'approvals not scanned';

export interface RiskState {
  /** Undefined until at least the summary or a history page is available. */
  report?: RiskReport;
  /** True while any of the inputs is still loading (the report may already be a partial estimate). */
  loading: boolean;
  /** Which inputs were available when the report was computed. `approvals` is false when the scan was incomplete. */
  inputs: { summary: boolean; history: boolean; tokenTransfers: boolean; approvals: boolean };
  errors: Error[];
  /**
   * Caveats about the inputs, e.g. "approvals not scanned: <reason>" when the
   * approval log scan was refused, so the absence of an approval flag is not
   * read as a clean result.
   */
  notes: string[];
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
  parts: {
    summary?: ChainAddressSummary;
    history?: TxListItem[];
    tokenTransfers?: TxListItem[];
    approvals?: ApprovalInfo[];
    /** True when the loaded history and token rows are the wallet's whole history (no further pages). */
    historyComplete?: boolean;
    nativePriceUsd?: number;
    now?: number;
  },
): RiskInput {
  const rows = [...(parts.history ?? []), ...(parts.tokenTransfers ?? [])];
  return {
    chain,
    address,
    summary: parts.summary,
    history: parts.history,
    tokenTransfers: parts.tokenTransfers,
    approvals: parts.approvals,
    historyComplete: parts.historyComplete,
    counterpartyLabels: counterpartyLabels(chain, rows, address),
    nativePriceUsd: parts.nativePriceUsd,
    now: parts.now,
  };
}

/**
 * Risk assessment composed from the summary, the first history and token
 * transfer pages (Solana: enriched rows), the approval scan (EVM) and
 * registry labels of the counterparties. All queries are shared with the
 * address page tabs through react-query. An incomplete approval scan is
 * passed as "unknown" (no approvals input) and reported in `notes`.
 */
export function useRisk(chain: ChainId, address: string): RiskState {
  const info = findChain(chain);
  const summaryQ = useAddressSummary(chain, address);
  const rows = useHistoryRows(chain, address);
  const scanQ = useApprovalScan(chain, address);
  const nativePriceUsd = useNativePrice(chain);
  const rev = useLabelsRevision();

  const summary = summaryQ.data;
  const history = rows.firstPage.tx;
  const tokenTransfers = rows.firstPage.token;
  const scan = scanQ.data;
  const approvalsScanned = !!scan && !scan.scanIncomplete;
  const approvals = approvalsScanned ? scan.approvals : undefined;
  const historyComplete = rows.historyComplete;

  const report = useMemo(() => {
    if (!info) return undefined;
    if (!summary && !history) return undefined;
    return assessAddress(buildRiskInput(chain, summary?.address ?? address, { summary, history, tokenTransfers, approvals, historyComplete, nativePriceUsd }));
    // `rev` re-runs the assessment when labels change (feed load, case tags).
  }, [info, chain, address, summary, history, tokenTransfers, approvals, historyComplete, nativePriceUsd, rev]);

  const errors = [summaryQ.error, ...rows.errors, scanQ.error].filter((e): e is Error => !!e);
  const loading = summaryQ.isLoading || rows.loading || (scanQ.isLoading && info?.family === 'evm') || !!rows.enrich?.loading;

  const notes: string[] = [];
  if (info?.family === 'evm') {
    if (scan?.scanIncomplete) notes.push(`${APPROVALS_NOT_SCANNED}: ${scan.reason ?? 'the RPC refused part of the log query'}`);
    else if (scanQ.error) notes.push(`${APPROVALS_NOT_SCANNED}: ${scanQ.error.message}`);
  }

  return {
    report,
    loading,
    inputs: { summary: !!summary, history: !!history, tokenTransfers: !!tokenTransfers, approvals: approvalsScanned },
    errors,
    notes,
  };
}
