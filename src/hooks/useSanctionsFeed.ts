import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SANCTIONS_CACHE_TTL_MS, clearSanctionsCache, loadSanctionsFeed, sanctionsFeedInfo, type SanctionsFeedResult } from '@/lib/intel/sanctions';
import { useSettings } from '@/lib/settings/store';
import { bumpLabelsRevision } from './useLabel';

export const SANCTIONS_QUERY_KEY = ['sanctions-feed'] as const;

export interface SanctionsFeedState {
  enabled: boolean;
  loading: boolean;
  /** Builtin + feed address lists (present once loaded). */
  data?: SanctionsFeedResult;
  /** Last successful feed fetch in ms epoch (0 = builtin only). */
  fetchedAt: number;
  ethCount: number;
  btcCount: number;
}

/**
 * Loads the OFAC mirror once per session when the setting is on, registers
 * the labels and notifies label consumers. Disabling the feed in Settings
 * drops the cached list and its labels.
 */
export function useSanctionsFeed(): SanctionsFeedState {
  const enabled = useSettings((s) => s.enableSanctionsFeed);
  const client = useQueryClient();
  const q = useQuery<SanctionsFeedResult, Error>({
    queryKey: SANCTIONS_QUERY_KEY,
    queryFn: ({ signal }) => loadSanctionsFeed(signal),
    enabled,
    staleTime: SANCTIONS_CACHE_TTL_MS,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  useEffect(() => {
    if (enabled) return;
    clearSanctionsCache();
    client.removeQueries({ queryKey: SANCTIONS_QUERY_KEY });
    bumpLabelsRevision();
  }, [enabled, client]);

  useEffect(() => {
    if (q.data) bumpLabelsRevision();
  }, [q.data]);

  const info = q.data ? { fetchedAt: q.data.fetchedAt, eth: q.data.eth.length, btc: q.data.btc.length } : sanctionsFeedInfo();
  return {
    enabled,
    loading: enabled && q.isLoading,
    data: q.data,
    fetchedAt: info?.fetchedAt ?? 0,
    ethCount: info?.eth ?? 0,
    btcCount: info?.btc ?? 0,
  };
}
