/**
 * Universal search resolution (SPEC §6, route `/search/:query`).
 *
 * `resolveSearch` is a pure async function over the providers so it can be
 * unit-tested with a mocked `fetch`; `SearchPage` runs it inside an effect
 * and navigates on `redirect`.
 */
import { useEffect, useState } from 'react';
import { detectInput } from '@/lib/detect';
import { CHAINS, evmChains, getChain } from '@/lib/chains/registry';
import type { ChainId, DetectedInput, InputKind } from '@/lib/types';
import { findTxChain, resolveEns } from '@/lib/providers/evm';
import { btcAddressSummary, btcTransaction } from '@/lib/providers/btc/esplora';
import { solAddressSummary } from '@/lib/providers/sol/rpc';
import { useSettings } from '@/lib/settings/store';

export interface SearchChoice {
  chain: ChainId;
  title: string;
  detail: string;
  /** In-app route. */
  path?: string;
  /** External URL (block explorers for inputs the app has no page for). */
  href?: string;
  /** Probe result: true = exists, false = not found, undefined = not probed / failed. */
  found?: boolean;
}

export type ResolveOutcome =
  | { status: 'redirect'; kind: InputKind; chain: ChainId; path: string }
  | { status: 'choices'; kind: InputKind; message: string; choices: SearchChoice[] }
  | { status: 'error'; kind: InputKind; message: string; hint?: string };

export interface ResolveOptions {
  includeTestnets?: boolean;
  signal?: AbortSignal;
}

export const addressPath = (chain: ChainId, address: string): string => `/address/${chain}/${address}`;
export const txPath = (chain: ChainId, hash: string): string => `/tx/${chain}/${hash}`;

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (err instanceof Error && err.name === 'AbortError');
}

/** Run a probe, mapping failures to "not found" (abort still propagates). */
async function probe(fn: () => Promise<boolean>, signal?: AbortSignal): Promise<boolean | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    return undefined;
  }
}

function explorerChoices(kind: 'block', value: string): SearchChoice[] {
  return CHAINS.filter((c) => !c.testnet && c.family === 'evm').map((c) => ({
    chain: c.id,
    title: c.name,
    detail: `Open block ${value} on ${c.explorer.name}`,
    href: `${c.explorer.url}/block/${value}`,
    found: kind === 'block' ? undefined : false,
  }));
}

/** Resolve free-form input into a route, a set of choices or an error. */
export async function resolveSearch(query: string, opts: ResolveOptions = {}): Promise<ResolveOutcome> {
  const detected: DetectedInput = detectInput(query);
  const { signal } = opts;
  const { kind, value } = detected;

  switch (kind) {
    case 'evm-address':
      return { status: 'redirect', kind, chain: 'ethereum', path: addressPath('ethereum', value) };

    case 'ens-name': {
      const addr = await resolveEns(value, signal);
      if (!addr) return { status: 'error', kind, message: `"${value}" does not resolve to an address.`, hint: 'The name may be unregistered, expired or use an off-chain (CCIP-read) resolver.' };
      return { status: 'redirect', kind, chain: 'ethereum', path: addressPath('ethereum', addr) };
    }

    case 'evm-tx': {
      const chains = evmChains(!!opts.includeTestnets);
      const chain = await findTxChain(chains, value, signal);
      if (chain) return { status: 'redirect', kind, chain: chain.id, path: txPath(chain.id, value) };
      return {
        status: 'choices',
        kind,
        message: 'No supported EVM chain knows this transaction hash. It may be pending, very recent, or on a chain that is not supported. Pick a chain to open the page anyway.',
        choices: chains.map((c) => ({ chain: c.id, title: c.name, detail: 'Open transaction page', path: txPath(c.id, value), found: false })),
      };
    }

    case 'sol-address':
      return { status: 'redirect', kind, chain: 'solana', path: addressPath('solana', value) };

    case 'sol-tx':
      return { status: 'redirect', kind, chain: 'solana', path: txPath('solana', value) };

    case 'btc-address': {
      if (!detected.families.includes('solana')) return { status: 'redirect', kind, chain: 'bitcoin', path: addressPath('bitcoin', value) };
      // Legacy base58 address: could be Bitcoin P2PKH/P2SH or a Solana account.
      const [btc, sol] = await Promise.all([
        probe(async () => (await btcAddressSummary(value, signal)).txCount !== 0, signal),
        probe(async () => {
          const s = await solAddressSummary(value, signal);
          return s.lamports > 0n || s.executable || !!s.owner;
        }, signal),
      ]);
      const choices: SearchChoice[] = [
        { chain: 'bitcoin', title: 'Bitcoin', detail: describeProbe(btc, 'address'), path: addressPath('bitcoin', value), found: btc },
        { chain: 'solana', title: 'Solana', detail: describeProbe(sol, 'account'), path: addressPath('solana', value), found: sol },
      ];
      if (btc === true && sol !== true) return { status: 'redirect', kind, chain: 'bitcoin', path: addressPath('bitcoin', value) };
      if (sol === true && btc !== true) return { status: 'redirect', kind, chain: 'solana', path: addressPath('solana', value) };
      return { status: 'choices', kind, message: btc && sol ? 'This address exists on both Bitcoin and Solana.' : 'Could not confirm this address on Bitcoin or Solana. Pick a chain to open it anyway.', choices };
    }

    case 'btc-tx': {
      // Bare 64-hex: Bitcoin txid or an EVM hash without its 0x prefix.
      const chains = evmChains(!!opts.includeTestnets);
      const evmHash = `0x${value}`;
      const [btc, evm] = await Promise.all([
        probe(async () => !!(await btcTransaction(value, signal)).hash, signal),
        findTxChain(chains, evmHash, signal).catch((err: unknown) => {
          if (isAbort(err, signal)) throw err;
          return null;
        }),
      ]);
      if (btc === true && !evm) return { status: 'redirect', kind, chain: 'bitcoin', path: txPath('bitcoin', value) };
      if (evm && btc !== true) return { status: 'redirect', kind: 'evm-tx', chain: evm.id, path: txPath(evm.id, evmHash) };
      const choices: SearchChoice[] = [
        { chain: 'bitcoin', title: 'Bitcoin', detail: describeProbe(btc, 'transaction'), path: txPath('bitcoin', value), found: btc },
        ...(evm
          ? [{ chain: evm.id, title: evm.name, detail: 'Transaction found', path: txPath(evm.id, evmHash), found: true }]
          : chains.map((c) => ({ chain: c.id, title: c.name, detail: 'Not found (open anyway)', path: txPath(c.id, evmHash), found: false }))),
      ];
      return { status: 'choices', kind, message: btc && evm ? 'This hash exists on Bitcoin and on an EVM chain.' : 'Could not find this hash on Bitcoin or any supported EVM chain.', choices };
    }

    case 'block-number':
      return {
        status: 'choices',
        kind,
        message: `Block pages are not part of LoxDetective yet. Open block ${value} in an explorer:`,
        choices: explorerChoices('block', value),
      };

    case 'unknown':
    default:
      return {
        status: 'error',
        kind: 'unknown',
        message: value ? `"${value}" is not recognised.` : 'Nothing to search for.',
        hint: detected.hint,
      };
  }
}

function describeProbe(found: boolean | undefined, noun: string): string {
  if (found === true) return `${noun[0].toUpperCase()}${noun.slice(1)} found`;
  if (found === false) return `No activity found (${noun} may still exist)`;
  return 'Could not check (provider unavailable)';
}

/** Chain for a resolved solana / bitcoin / evm choice, for badges. */
export function chainOfChoice(c: SearchChoice): string {
  try {
    return getChain(c.chain).name;
  } catch {
    return c.chain;
  }
}

export interface SearchResolverState {
  resolving: boolean;
  outcome?: ResolveOutcome;
  detected: DetectedInput;
}

/**
 * Runs `resolveSearch` for `query`; calls `onRedirect` (inside the effect, so
 * the caller can use `navigate(..., { replace: true })`) and exposes choices /
 * errors for rendering.
 */
export function useSearchResolver(query: string, onRedirect: (outcome: Extract<ResolveOutcome, { status: 'redirect' }>) => void): SearchResolverState {
  const includeTestnets = useSettings((s) => s.showTestnets);
  const [state, setState] = useState<{ query: string; outcome?: ResolveOutcome }>({ query });
  const detected = detectInput(query);

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ query });
    resolveSearch(query, { includeTestnets, signal: ctrl.signal })
      .then((outcome) => {
        if (ctrl.signal.aborted) return;
        if (outcome.status === 'redirect') onRedirect(outcome);
        else setState({ query, outcome });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({ query, outcome: { status: 'error', kind: detectInput(query).kind, message: err instanceof Error ? err.message : String(err) } });
      });
    return () => ctrl.abort();
  }, [query, includeTestnets, onRedirect]);

  const current = state.query === query ? state.outcome : undefined;
  return { resolving: !current, outcome: current, detected };
}
