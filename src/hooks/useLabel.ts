import { useMemo, useSyncExternalStore } from 'react';
import type { AddressLabel, ChainId } from '@/lib/types';
import { lookupLabel } from '@/lib/intel/labels';
import { useCases } from '@/lib/cases/store';

/*
 * The label registry is a plain module without change notifications. Writers
 * that register labels at runtime (sanctions feed, settings reset) bump this
 * revision so memoised lookups re-run; the cases store (which registers tag
 * labels) is subscribed once so tag edits bump it automatically.
 */
let revision = 0;
const listeners = new Set<() => void>();

/** Notify label consumers that the registry changed. */
export function bumpLabelsRevision(): void {
  revision++;
  for (const l of Array.from(listeners)) l();
}

useCases.subscribe(() => bumpLabelsRevision());

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getRevision = () => revision;

/** Current label registry revision (re-renders the caller when labels change). */
export function useLabelsRevision(): number {
  return useSyncExternalStore(subscribe, getRevision, getRevision);
}

/** Best known label for an address on a chain (built-in, OFAC feed or case tag). */
export function useLabel(address: string | undefined, chain?: ChainId): AddressLabel | undefined {
  const rev = useLabelsRevision();
  return useMemo(() => (address ? lookupLabel(address, chain) : undefined), [address, chain, rev]);
}
