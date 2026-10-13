import { Fragment } from 'react';
import type { ChainFamily, ChainId, RiskReport } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import AddressDisplay from '@/components/AddressDisplay';
import EmptyState from '@/components/EmptyState';
import HashDisplay from '@/components/HashDisplay';
import Spinner from '@/components/Spinner';

const MAX_EVIDENCE = 5;

export type EvidencePart = { kind: 'text' | 'tx' | 'address'; text: string };

/*
 * Per-family patterns for the identifiers a risk heuristic may quote in its
 * evidence. Transaction ids come first so a 64-hex / long base58 token is
 * never split into an address prefix.
 */
const PATTERNS: Record<ChainFamily, { tx: RegExp; address: RegExp }> = {
  evm: { tx: /^0x[0-9a-fA-F]{64}$/, address: /^0x[0-9a-fA-F]{40}$/ },
  bitcoin: { tx: /^[0-9a-fA-F]{64}$/, address: /^(?:bc1[ac-hj-np-z02-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/ },
  solana: { tx: /^[1-9A-HJ-NP-Za-km-z]{64,90}$/, address: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ },
};

/** Runs of letters and digits: each whole word is tested against the family patterns. */
const WORD = /[0-9A-Za-z]+/g;

/**
 * Split an evidence string into plain text and linkable identifiers: 64-hex
 * (tx) and 40-hex (address) with `0x` on EVM, bech32 / base58 addresses and
 * 64-hex txids on Bitcoin, base58 accounts and signatures on Solana.
 */
export function tokenizeEvidence(text: string, family: ChainFamily): EvidencePart[] {
  const p = PATTERNS[family];
  const parts: EvidencePart[] = [];
  let last = 0;
  for (const m of text.matchAll(WORD)) {
    const start = m.index ?? 0;
    const tok = m[0];
    const kind: EvidencePart['kind'] | undefined = p.tx.test(tok) ? 'tx' : p.address.test(tok) ? 'address' : undefined;
    if (!kind) continue;
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    parts.push({ kind, text: tok });
    last = start + tok.length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

/** Evidence line with tx hashes and addresses turned into in-app links. */
export function Evidence({ text, chain }: { text: string; chain?: ChainId }) {
  const info = chain ? findChain(chain) : undefined;
  if (!info) return <>{text}</>;
  return (
    <>
      {tokenizeEvidence(text, info.family).map((p, i) => (
        <Fragment key={i}>
          {p.kind === 'tx' ? <HashDisplay hash={p.text} chain={info.id} /> : p.kind === 'address' ? <AddressDisplay address={p.text} chain={info.id} /> : p.text}
        </Fragment>
      ))}
    </>
  );
}

interface Props {
  report?: RiskReport;
  loading: boolean;
  /** Chain of the assessed address, for evidence links. */
  chain?: ChainId;
  /** Input caveats (e.g. "approvals not scanned"), shown under the flags. */
  notes?: string[];
}

/** Expandable list of the heuristics that fired for an address. */
export default function RiskFlags({ report, loading, chain, notes }: Props) {
  const noteList =
    notes && notes.length > 0 ? (
      <ul className="flag-notes" aria-label="Assessment caveats">
        {notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    ) : null;

  if (!report) {
    return loading ? <Spinner label="Assessing risk…" /> : <p className="muted">No assessment available: the address summary and history could not be loaded.</p>;
  }
  if (report.flags.length === 0) {
    return (
      <>
        <EmptyState
          compact
          title="No risk indicators found"
          hint={loading ? 'Some inputs are still loading; the assessment may change.' : 'No sanctions, mixer, velocity, approval or pattern heuristics fired on the available data.'}
        />
        {noteList}
      </>
    );
  }
  return (
    <>
      <ul className="flag-list">
        {report.flags.map((f) => (
          <li key={f.id} className={`flag flag--${f.level}`}>
            <span className="flag__level">{f.level}</span>
            <span className="flag__title">{f.title}</span>
            <span className="flag__detail">{f.detail}</span>
            {f.evidence && f.evidence.length > 0 && (
              <ul className="flag__evidence">
                {f.evidence.slice(0, MAX_EVIDENCE).map((e, i) => (
                  <li key={i}>
                    <Evidence text={e} chain={chain} />
                  </li>
                ))}
                {f.evidence.length > MAX_EVIDENCE && <li>+{f.evidence.length - MAX_EVIDENCE} more</li>}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {noteList}
    </>
  );
}
