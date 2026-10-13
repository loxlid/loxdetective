import { beforeEach, describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import type { AddressLabel, AddressSummary, ApprovalInfo, RiskFlag, TokenInfo, TxListItem } from '@/lib/types';
import { resetLabels } from '@/lib/intel/labels';
import { clearSanctionsCache } from '@/lib/intel/sanctions';
import {
  RISK_PARAMS,
  RISK_THRESHOLDS,
  RISK_WEIGHTS,
  assessAddress,
  clipScore,
  levelFromScore,
  scoreFromFlags,
  type RiskInput,
} from '@/lib/intel/risk';

const NOW = 1_700_000_000; // fixed reference time (unix seconds)
const SELF = '0x1111111111111111111111111111111111111111';
const A = '0x2222222222222222222222222222222222222222';
const B = '0x3333333333333333333333333333333333333333';
const C = '0x4444444444444444444444444444444444444444';
const BINANCE_14 = '0x28C6c06298d514Db089934071355E5743bf21d60';
const KRAKEN_4 = '0x2910543Af39abA0Cd09dBb2D50200b3E800A63D2';
const UNISWAP_V2 = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const TORNADO_10_ETH = '0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF';
const RONIN_EXPLOITER = '0x098B716B8Aaf21512996dC57EB0615e2383E2f96';

let hashSeq = 0;
function tx(o: {
  direction: TxListItem['direction'];
  from?: string;
  to?: string;
  value?: bigint;
  ts?: number;
  hash?: string;
  chain?: string;
  symbol?: string;
  decimals?: number;
  token?: TxListItem['token'];
  status?: TxListItem['status'];
}): TxListItem {
  const from = o.from ?? (o.direction === 'in' ? A : SELF);
  const to = o.to ?? (o.direction === 'in' ? SELF : A);
  return {
    chain: o.chain ?? 'ethereum',
    hash: o.hash ?? `0x${(++hashSeq).toString(16).padStart(64, '0')}`,
    timestamp: o.ts ?? NOW - 30 * 86_400, // old by default so `fresh-wallet` is opt-in
    from,
    to,
    value: { raw: o.value ?? 0n, decimals: o.decimals ?? 18, symbol: o.symbol ?? 'ETH' },
    status: o.status ?? 'success',
    direction: o.direction,
    token: o.token,
  };
}

const USDC: TokenInfo = { chain: 'ethereum', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', name: 'USD Coin', symbol: 'USDC', decimals: 6, type: 'ERC-20' };

function approval(spender: string, unlimited = true, spenderLabel?: string): ApprovalInfo {
  return { token: USDC, spender, amount: unlimited ? 2n ** 256n - 1n : 1_000_000n, unlimited, txHash: `0x${'ab'.repeat(32)}`, spenderLabel };
}

function label(address: string, category: AddressLabel['category'], name: string = category): [string, AddressLabel] {
  return [address.toLowerCase(), { address, chain: 'evm', name, category, source: 'test' }];
}

function assess(partial: Partial<RiskInput>) {
  return assessAddress({ chain: 'ethereum', address: SELF, now: NOW, ...partial });
}

function ids(flags: RiskFlag[]): string[] {
  return flags.map((f) => f.id);
}

beforeEach(() => {
  hashSeq = 0;
  resetLabels();
  clearSanctionsCache();
});

describe('levelFromScore / clipScore / scoreFromFlags', () => {
  it('maps scores to the spec thresholds', () => {
    expect(levelFromScore(0)).toBe('none');
    expect(levelFromScore(1)).toBe('low');
    expect(levelFromScore(24)).toBe('low');
    expect(levelFromScore(25)).toBe('medium');
    expect(levelFromScore(49)).toBe('medium');
    expect(levelFromScore(50)).toBe('high');
    expect(levelFromScore(74)).toBe('high');
    expect(levelFromScore(75)).toBe('critical');
    expect(levelFromScore(100)).toBe('critical');
    expect(RISK_THRESHOLDS).toEqual({ low: 1, medium: 25, high: 50, critical: 75 });
  });

  it('clips out-of-range and non-finite scores', () => {
    expect(clipScore(-5)).toBe(0);
    expect(clipScore(250)).toBe(100);
    expect(clipScore(Number.NaN)).toBe(0);
    expect(clipScore(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clipScore(0.4)).toBe(0);
    expect(levelFromScore(-1)).toBe('none');
    expect(levelFromScore(1e9)).toBe('critical');
  });

  it('sums level weights and clips at 100', () => {
    const f = (level: RiskFlag['level']): RiskFlag => ({ id: 'x', level, title: '', detail: '' });
    expect(scoreFromFlags([])).toBe(0);
    expect(scoreFromFlags([f('low')])).toBe(RISK_WEIGHTS.low);
    expect(scoreFromFlags([f('medium'), f('medium')])).toBe(50);
    expect(scoreFromFlags([f('critical'), f('high'), f('low')])).toBe(100);
    expect(RISK_WEIGHTS).toEqual({ none: 0, low: 10, medium: 25, high: 50, critical: 100 });
  });
});

describe('assessAddress — baseline', () => {
  it('returns no flags and level none for an empty input', () => {
    const r = assess({});
    expect(r).toEqual({ score: 0, level: 'none', flags: [] });
  });

  it('is deterministic for the same input', () => {
    const input: Partial<RiskInput> = {
      history: [tx({ direction: 'out', to: TORNADO_10_ETH, value: parseEther('10') })],
      summary: { chain: 'ethereum', address: SELF, isContract: false, firstSeen: NOW - 3600 },
    };
    expect(assess(input)).toEqual(assess(input));
  });

  it('stays clean for an ordinary wallet trading on a DEX and depositing to several places', () => {
    const r = assess({
      summary: { chain: 'ethereum', address: SELF, isContract: false, firstSeen: NOW - 400 * 86_400, txCount: 3 },
      history: [
        tx({ direction: 'in', from: BINANCE_14, value: parseEther('1'), ts: NOW - 300 * 86_400 }),
        tx({ direction: 'out', to: UNISWAP_V2, value: parseEther('0.5'), ts: NOW - 200 * 86_400 }),
        tx({ direction: 'out', to: B, value: parseEther('0.1'), ts: NOW - 100 * 86_400 }),
      ],
      approvals: [approval(UNISWAP_V2)],
    });
    expect(r.flags).toEqual([]);
    expect(r.level).toBe('none');
  });

  it('tolerates `now` given in milliseconds', () => {
    const r = assessAddress({ chain: 'ethereum', address: SELF, now: NOW * 1000, summary: { chain: 'ethereum', address: SELF, isContract: false, firstSeen: NOW - 3600 } });
    expect(ids(r.flags)).toContain('fresh-wallet');
  });
});

describe('sanctioned / scam-label', () => {
  it('fires `sanctioned` for a builtin OFAC address (case-insensitive)', () => {
    const r = assessAddress({ chain: 'ethereum', address: RONIN_EXPLOITER.toLowerCase(), now: NOW });
    expect(ids(r.flags)).toEqual(['sanctioned']);
    expect(r.flags[0].level).toBe('critical');
    expect(r.score).toBe(100);
    expect(r.level).toBe('critical');
    expect(r.flags[0].evidence?.[0]).toMatch(/Lazarus/);
  });

  it('fires `sanctioned` for a caller-provided sanctioned label and not otherwise', () => {
    expect(ids(assess({ counterpartyLabels: new Map([label(SELF, 'sanctioned', 'OFAC listed')]) }).flags)).toEqual(['sanctioned']);
    expect(ids(assess({ counterpartyLabels: new Map([label(SELF, 'exchange')]) }).flags)).toEqual([]);
    expect(ids(assess({}).flags)).toEqual([]);
  });

  it('fires `scam-label` only for a scam label on the address itself', () => {
    const r = assess({ counterpartyLabels: new Map([label(SELF, 'scam', 'Fake airdrop')]) });
    expect(ids(r.flags)).toEqual(['scam-label']);
    expect(r.level).toBe('critical');
    const other = assess({ counterpartyLabels: new Map([label(A, 'scam')]), history: [tx({ direction: 'in', from: A, value: 1n })] });
    expect(ids(other.flags)).not.toContain('scam-label');
  });

  it('clips the score at 100 when several critical flags fire', () => {
    const r = assess({
      counterpartyLabels: new Map([label(SELF, 'scam')]),
      history: [tx({ direction: 'out', to: TORNADO_10_ETH, value: parseEther('1') }), tx({ direction: 'out', to: RONIN_EXPLOITER, value: parseEther('1') })],
    });
    expect(r.score).toBe(100);
    expect(r.level).toBe('critical');
    expect(ids(r.flags)).toEqual(['scam-label', 'sanctioned-counterparty', 'mixer-direct']);
  });
});

describe('mixer-direct / sanctioned-counterparty', () => {
  it('fires `mixer-direct` when sending to a builtin mixer (Tornado, even though it is also sanctioned)', () => {
    const r = assess({ history: [tx({ direction: 'out', to: TORNADO_10_ETH, value: parseEther('10'), hash: '0xaa' })] });
    expect(ids(r.flags)).toEqual(['mixer-direct']);
    expect(r.flags[0].level).toBe('high');
    expect(r.level).toBe('high');
    expect(r.flags[0].evidence?.[0]).toMatch(/^0xaa · sent to Tornado Cash/);
  });

  it('fires `mixer-direct` when receiving from a caller-labelled mixer and via token transfers', () => {
    const labels = new Map([label(A, 'mixer', 'Some mixer')]);
    expect(ids(assess({ counterpartyLabels: labels, history: [tx({ direction: 'in', from: A, value: 1n })] }).flags)).toEqual(['mixer-direct']);
    const tok = tx({ direction: 'out', to: A, token: { symbol: 'USDC', amount: { raw: 1n, decimals: 6, symbol: 'USDC' }, kind: 'ERC-20' } });
    expect(ids(assess({ counterpartyLabels: labels, tokenTransfers: [tok] }).flags)).toEqual(['mixer-direct']);
  });

  it('does not fire for ordinary counterparties', () => {
    const r = assess({ history: [tx({ direction: 'out', to: UNISWAP_V2, value: parseEther('1') }), tx({ direction: 'in', from: B, value: parseEther('1') })] });
    expect(ids(r.flags)).not.toContain('mixer-direct');
    expect(ids(r.flags)).not.toContain('sanctioned-counterparty');
  });

  it('fires `sanctioned-counterparty` for a non-mixer sanctioned counterparty', () => {
    const r = assess({ history: [tx({ direction: 'in', from: RONIN_EXPLOITER, value: parseEther('1'), hash: '0xbb' })] });
    expect(ids(r.flags)).toEqual(['sanctioned-counterparty']);
    expect(r.flags[0].level).toBe('high');
    expect(r.flags[0].evidence?.[0]).toMatch(/^0xbb · received from Lazarus/);
  });

  it('counts a counterparty once and caps evidence', () => {
    const history = Array.from({ length: 15 }, () => tx({ direction: 'out', to: TORNADO_10_ETH, value: parseEther('1') }));
    const r = assess({ history });
    expect(ids(r.flags)).toEqual(['mixer-direct']);
    expect(r.flags[0].detail).toMatch(/1 mixer contract \(15 tx\)/);
    expect(r.flags[0].evidence).toHaveLength(RISK_PARAMS.maxEvidence);
  });

  it("ignores rows with direction 'unknown' (the address is on neither side)", () => {
    // Third-party transfers (e.g. the token-transfers tab of a token contract) list the
    // queried address on neither side; they must not become a counterparty.
    const thirdParty = [
      tx({ direction: 'unknown', from: TORNADO_10_ETH, to: B, value: parseEther('10'), hash: '0xt1' }),
      tx({ direction: 'unknown', from: RONIN_EXPLOITER, to: B, value: parseEther('1'), hash: '0xt2' }),
      tx({ direction: 'unknown', from: B, to: TORNADO_10_ETH, value: parseEther('1'), hash: '0xt3' }),
    ];
    const r = assess({ history: thirdParty, tokenTransfers: thirdParty });
    expect(ids(r.flags)).not.toContain('mixer-direct');
    expect(ids(r.flags)).not.toContain('sanctioned-counterparty');
    expect(ids(r.flags)).not.toContain('exchange-deposit');
    const hop = assess({
      history: [tx({ direction: 'unknown', from: A, to: B, value: parseEther('1') })],
      counterpartyLabels: new Map([label(C, 'mixer', 'Mixer C')]),
      secondHopCounterparties: new Map([[A.toLowerCase(), [C]], [B.toLowerCase(), [C]]]),
    });
    expect(ids(hop.flags)).not.toContain('mixer-1hop');
    // Rows that do name the address keep working.
    expect(ids(assess({ history: [tx({ direction: 'in', from: TORNADO_10_ETH, value: 1n })] }).flags)).toEqual(['mixer-direct']);
  });
});

describe('mixer-1hop', () => {
  const labels = new Map([label(C, 'mixer', 'Mixer C')]);

  it('fires when a direct counterparty interacted with a mixer', () => {
    const r = assess({
      history: [tx({ direction: 'in', from: A, value: parseEther('1') })],
      counterpartyLabels: labels,
      secondHopCounterparties: new Map([[A.toLowerCase(), [B, C]]]),
    });
    expect(ids(r.flags)).toEqual(['mixer-1hop']);
    expect(r.flags[0].level).toBe('medium');
    expect(r.flags[0].evidence?.[0]).toMatch(/Mixer C/);
    expect(r.level).toBe('medium');
  });

  it('does not fire without second-hop data or without a mixer in it', () => {
    const history = [tx({ direction: 'in', from: A, value: parseEther('1') })];
    expect(ids(assess({ history, counterpartyLabels: labels }).flags)).toEqual([]);
    expect(ids(assess({ history, counterpartyLabels: labels, secondHopCounterparties: new Map([[A.toLowerCase(), [B]]]) }).flags)).toEqual([]);
    expect(ids(assess({ history, counterpartyLabels: labels, secondHopCounterparties: new Map() }).flags)).toEqual([]);
  });

  it('does not double count a direct mixer as a one-hop exposure', () => {
    const r = assess({
      history: [tx({ direction: 'out', to: C, value: parseEther('1') })],
      counterpartyLabels: labels,
      secondHopCounterparties: new Map([[C.toLowerCase(), [TORNADO_10_ETH]]]),
    });
    expect(ids(r.flags)).toEqual(['mixer-direct']);
  });
});

describe('fresh-wallet', () => {
  const summary = (firstSeen?: number, txCount?: number): AddressSummary => ({ chain: 'ethereum', address: SELF, isContract: false, firstSeen, txCount });

  it('fires when first seen less than 7 days ago and not otherwise', () => {
    const fresh = assess({ summary: summary(NOW - 2 * 86_400) });
    expect(ids(fresh.flags)).toEqual(['fresh-wallet']);
    expect(fresh.flags[0].level).toBe('low');
    expect(fresh.level).toBe('low');
    expect(fresh.score).toBe(10);
    expect(ids(assess({ summary: summary(NOW - 7 * 86_400) }).flags)).toEqual([]);
    expect(ids(assess({ summary: summary(NOW - 7 * 86_400 + 1) }).flags)).toEqual(['fresh-wallet']);
    expect(ids(assess({ summary: summary(undefined) }).flags)).toEqual([]);
  });

  it('derives first-seen from a short, complete history', () => {
    const history = [tx({ direction: 'in', from: A, value: 100n, ts: NOW - 3600 }), tx({ direction: 'out', to: B, value: 1n, ts: NOW - 1800 })];
    expect(ids(assess({ history }).flags)).toEqual(['fresh-wallet']);
    expect(ids(assess({ history, historyComplete: true }).flags)).toEqual(['fresh-wallet']);
    expect(ids(assess({ history, summary: summary(undefined, 2) }).flags)).toEqual(['fresh-wallet']);
    expect(ids(assess({ history, summary: summary(undefined, 2), historyComplete: true }).flags)).toEqual(['fresh-wallet']);
    // nonce says there are more txs than we were given: history is a partial page, do not guess.
    expect(ids(assess({ history, summary: summary(undefined, 500) }).flags)).toEqual([]);
    // old activity → not fresh.
    expect(ids(assess({ history: [tx({ direction: 'in', from: A, value: 1n, ts: NOW - 30 * 86_400 })] }).flags)).toEqual([]);
  });

  it('honours an explicit historyComplete flag over the row-count guess', () => {
    const history = [tx({ direction: 'in', from: A, value: 100n, ts: NOW - 3600 }), tx({ direction: 'out', to: B, value: 1n, ts: NOW - 1800 })];
    // The caller knows more pages exist: even two recent rows are just the latest page.
    expect(ids(assess({ history, historyComplete: false }).flags)).toEqual([]);
    expect(ids(assess({ history, summary: summary(undefined, 2), historyComplete: false }).flags)).toEqual([]);
    // The caller knows the lists are complete: a page-sized history is fine.
    const full = Array.from({ length: 50 }, (_, i) => tx({ direction: 'in', from: A, value: parseEther('1'), ts: NOW - 60 * i }));
    expect(ids(assess({ history: full, historyComplete: true }).flags)).toEqual(['fresh-wallet']);
    // ... but the summary's firstSeen still wins when present.
    expect(ids(assess({ history, summary: summary(NOW - 30 * 86_400), historyComplete: true }).flags)).toEqual([]);
  });

  it('does not derive first-seen from a long (probably paged) history', () => {
    const history = Array.from({ length: RISK_PARAMS.freshWalletMaxRows }, (_, i) => tx({ direction: 'in', from: A, value: parseEther('1'), ts: NOW - 60 * i }));
    expect(ids(assess({ history }).flags)).toEqual([]);
    const forty = Array.from({ length: 40 }, (_, i) => tx({ direction: 'in', from: A, value: parseEther('1'), ts: NOW - 60 * i }));
    expect(ids(assess({ history: forty }).flags)).toEqual([]);
  });

  it('does not treat a full Solana signature page as the whole history', () => {
    // Solana pages are 25 rows and carry no txCount / firstSeen; the oldest row of the
    // latest page is not the wallet's first activity.
    const page = Array.from({ length: 25 }, (_, i) => tx({ chain: 'solana', direction: 'unknown', from: 'self', to: undefined, ts: NOW - 60 * i, symbol: 'SOL', decimals: 9 }));
    const base = { chain: 'solana', address: 'self', now: NOW, summary: { chain: 'solana', address: 'self', isContract: false } } as const;
    expect(ids(assessAddress({ ...base, history: page }).flags)).toEqual([]);
    expect(ids(assessAddress({ ...base, history: page, historyComplete: false }).flags)).toEqual([]);
    expect(ids(assessAddress({ ...base, history: page.slice(0, 10) }).flags)).toEqual(['fresh-wallet']);
  });

  it('does not derive first-seen from a token-only page when the native history is empty', () => {
    const tokens = Array.from({ length: 50 }, (_, i) => tx({ direction: 'in', from: A, ts: NOW - 60 * i, token: { symbol: 'USDC', amount: { raw: 1n, decimals: 6, symbol: 'USDC' }, kind: 'ERC-20' } }));
    expect(ids(assess({ history: [], tokenTransfers: tokens, summary: summary(undefined, 0) }).flags)).toEqual([]);
    expect(ids(assess({ history: [], tokenTransfers: tokens, summary: summary(undefined, 0), historyComplete: false }).flags)).toEqual([]);
    // A short, complete token list is still usable.
    expect(ids(assess({ history: [], tokenTransfers: tokens.slice(0, 3), summary: summary(undefined, 0) }).flags)).toEqual(['fresh-wallet']);
  });
});

describe('high-velocity', () => {
  it('fires for more than 50 txs in a sliding 24h window', () => {
    const history = Array.from({ length: 51 }, (_, i) => tx({ direction: 'in', from: A, value: parseEther('1'), ts: NOW - 30 * 86_400 + i * 60 }));
    const r = assess({ history });
    expect(ids(r.flags)).toEqual(['high-velocity']);
    expect(r.flags[0].level).toBe('medium');
    expect(r.flags[0].detail).toMatch(/51 transactions/);
  });

  it('does not fire for exactly 50 txs, for spread-out activity, or for duplicate hashes', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => tx({ direction: 'in', from: A, value: parseEther('1'), ts: NOW - 30 * 86_400 + i * 60 }));
    expect(ids(assess({ history: fifty }).flags)).toEqual([]);
    const spread = Array.from({ length: 60 }, (_, i) => tx({ direction: 'in', from: A, value: parseEther('1'), ts: NOW - 90 * 86_400 + i * 86_400 }));
    expect(ids(assess({ history: spread }).flags)).toEqual([]);
    const dupes = Array.from({ length: 60 }, (_, i) => tx({ direction: 'in', from: A, value: parseEther('1'), ts: NOW - 30 * 86_400 + i * 60, hash: '0xsame' }));
    expect(ids(assess({ history: dupes }).flags)).toEqual([]);
  });

  it('counts native and token rows together', () => {
    const ts = (i: number) => NOW - 30 * 86_400 + i * 60;
    const history = Array.from({ length: 30 }, (_, i) => tx({ direction: 'in', from: A, value: parseEther('1'), ts: ts(i) }));
    const tokenTransfers = Array.from({ length: 21 }, (_, i) => tx({ direction: 'out', to: B, ts: ts(i), token: { symbol: 'USDC', amount: { raw: 1n, decimals: 6, symbol: 'USDC' }, kind: 'ERC-20' } }));
    expect(ids(assess({ history, tokenTransfers }).flags)).toEqual(['high-velocity']);
  });
});

describe('dust-pattern', () => {
  const sender = (i: number) => `0x${(i + 10).toString(16).padStart(40, '0')}`;

  it('fires for tiny incoming native transfers from 5 distinct senders', () => {
    const history = Array.from({ length: 5 }, (_, i) => tx({ direction: 'in', from: sender(i), value: 1_000_000n, ts: NOW - 30 * 86_400 }));
    const r = assess({ history });
    expect(ids(r.flags)).toEqual(['dust-pattern']);
    expect(r.flags[0].level).toBe('low');
    expect(r.flags[0].evidence).toHaveLength(5);
  });

  it('does not fire for repeated senders, meaningful amounts, outgoing dust or token rows', () => {
    const old = NOW - 30 * 86_400;
    expect(ids(assess({ history: Array.from({ length: 8 }, () => tx({ direction: 'in', from: A, value: 1n, ts: old })) }).flags)).toEqual([]);
    expect(ids(assess({ history: Array.from({ length: 5 }, (_, i) => tx({ direction: 'in', from: sender(i), value: parseEther('0.0001'), ts: old })) }).flags)).toEqual([]);
    expect(ids(assess({ history: Array.from({ length: 5 }, (_, i) => tx({ direction: 'out', to: sender(i), value: 1n, ts: old })) }).flags)).toEqual([]);
    const tokenDust = Array.from({ length: 5 }, (_, i) => tx({ direction: 'in', from: sender(i), value: 1n, ts: old, token: { symbol: 'X', amount: { raw: 1n, decimals: 18, symbol: 'X' }, kind: 'ERC-20' } }));
    expect(ids(assess({ history: tokenDust }).flags)).toEqual([]);
    const failedDust = Array.from({ length: 5 }, (_, i) => tx({ direction: 'in', from: sender(i), value: 1n, ts: old, status: 'failed' }));
    expect(ids(assess({ history: failedDust }).flags)).toEqual([]);
  });

  it('uses a 1,000 sat threshold on bitcoin', () => {
    const old = NOW - 30 * 86_400;
    const btc = (value: bigint) => Array.from({ length: 5 }, (_, i) => tx({ chain: 'bitcoin', direction: 'in', from: `sender${i}`, to: 'self', value, ts: old, symbol: 'BTC', decimals: 8 }));
    expect(ids(assessAddress({ chain: 'bitcoin', address: 'self', now: NOW, history: btc(546n) }).flags)).toEqual(['dust-pattern']);
    expect(ids(assessAddress({ chain: 'bitcoin', address: 'self', now: NOW, history: btc(5_000n) }).flags)).toEqual([]);
  });
});

describe('pass-through', () => {
  const t0 = NOW - 30 * 86_400;

  it('fires when two incoming transfers are forwarded within an hour', () => {
    const history = [
      tx({ direction: 'in', from: A, value: parseEther('10'), ts: t0, hash: '0xin1' }),
      tx({ direction: 'out', to: B, value: parseEther('9.5'), ts: t0 + 600, hash: '0xout1' }),
      tx({ direction: 'in', from: A, value: parseEther('5'), ts: t0 + 7200, hash: '0xin2' }),
      tx({ direction: 'out', to: B, value: parseEther('5'), ts: t0 + 7200 + 3600, hash: '0xout2' }),
    ];
    const r = assess({ history });
    expect(ids(r.flags)).toEqual(['pass-through']);
    expect(r.flags[0].level).toBe('medium');
    expect(r.flags[0].evidence).toEqual([expect.stringMatching(/^0xin1 → 0xout1/), expect.stringMatching(/^0xin2 → 0xout2/)]);
    expect(r.flags[0].detail).toMatch(/100% of received value/);
  });

  it('ignores failed (reverted) transactions, which moved nothing', () => {
    const history = [
      tx({ direction: 'in', from: A, value: parseEther('10'), ts: t0, hash: '0xin1' }),
      tx({ direction: 'out', to: B, value: parseEther('10'), ts: t0 + 600, hash: '0xout1', status: 'failed' }),
      tx({ direction: 'in', from: A, value: parseEther('5'), ts: t0 + 7200, hash: '0xin2' }),
      tx({ direction: 'out', to: B, value: parseEther('5'), ts: t0 + 7200 + 600, hash: '0xout2', status: 'failed' }),
    ];
    expect(ids(assess({ history }).flags)).toEqual([]);
    // A failed deposit does not count as received value either.
    const failedIn = [
      tx({ direction: 'in', from: A, value: parseEther('10'), ts: t0, hash: '0xin1', status: 'failed' }),
      tx({ direction: 'out', to: B, value: parseEther('10'), ts: t0 + 600, hash: '0xout1' }),
    ];
    expect(ids(assess({ history: failedIn }).flags)).toEqual([]);
  });

  it('fires on a single forward when it covers >= 90% of all received value', () => {
    const history = [
      tx({ direction: 'in', from: A, value: parseEther('10'), ts: t0 }),
      tx({ direction: 'in', from: C, value: parseEther('1'), ts: t0 + 100 }),
      tx({ direction: 'out', to: B, value: parseEther('10'), ts: t0 + 300 }),
    ];
    expect(ids(assess({ history }).flags)).toEqual(['pass-through']);
  });

  it('does not fire for one forward that is a small share of received value', () => {
    const history = [
      tx({ direction: 'in', from: A, value: parseEther('10'), ts: t0 }),
      tx({ direction: 'out', to: B, value: parseEther('10'), ts: t0 + 300 }),
      tx({ direction: 'in', from: C, value: parseEther('30'), ts: t0 + 86_400 }),
    ];
    expect(ids(assess({ history }).flags)).toEqual([]);
  });

  it('does not fire when the outgoing is too late, too small, or before the incoming', () => {
    const late = [tx({ direction: 'in', from: A, value: parseEther('10'), ts: t0 }), tx({ direction: 'out', to: B, value: parseEther('10'), ts: t0 + 3601 })];
    const small = [tx({ direction: 'in', from: A, value: parseEther('10'), ts: t0 }), tx({ direction: 'out', to: B, value: parseEther('8.9'), ts: t0 + 60 })];
    const before = [tx({ direction: 'out', to: B, value: parseEther('10'), ts: t0 - 60 }), tx({ direction: 'in', from: A, value: parseEther('10'), ts: t0 })];
    for (const history of [late, small, before]) expect(ids(assess({ history }).flags)).toEqual([]);
  });

  it('uses each outgoing transfer at most once and ignores token rows', () => {
    const history = [
      tx({ direction: 'in', from: A, value: parseEther('1'), ts: t0 }),
      tx({ direction: 'in', from: C, value: parseEther('1'), ts: t0 + 10 }),
      tx({ direction: 'in', from: B, value: parseEther('40'), ts: t0 + 20 }),
      tx({ direction: 'out', to: B, value: parseEther('1'), ts: t0 + 30 }),
    ];
    // One pair, 1/42 of received value → no flag.
    expect(ids(assess({ history }).flags)).toEqual([]);
    const token = { symbol: 'USDC', amount: { raw: 1n, decimals: 6, symbol: 'USDC' }, kind: 'ERC-20' as const };
    const tokenOnly = [
      tx({ direction: 'in', from: A, value: parseEther('10'), ts: t0, token }),
      tx({ direction: 'out', to: B, value: parseEther('10'), ts: t0 + 60, token }),
      tx({ direction: 'in', from: A, value: parseEther('10'), ts: t0 + 7200, token }),
      tx({ direction: 'out', to: B, value: parseEther('10'), ts: t0 + 7260, token }),
    ];
    expect(ids(assess({ history: tokenOnly }).flags)).toEqual([]);
  });
});

describe('unlimited-approvals', () => {
  it('fires medium for an unlimited approval to an unlabelled spender', () => {
    const r = assess({ approvals: [approval(A)] });
    expect(ids(r.flags)).toEqual(['unlimited-approvals']);
    expect(r.flags[0].level).toBe('medium');
    expect(r.flags[0].evidence?.[0]).toMatch(/^USDC → 0x2222/);
    expect(r.level).toBe('medium');
  });

  it('escalates to high at 5 or more', () => {
    const r = assess({ approvals: [approval(A), approval(A), approval(B), approval(C), approval(A)] });
    expect(r.flags[0].id).toBe('unlimited-approvals');
    expect(r.flags[0].level).toBe('high');
    expect(r.flags[0].detail).toMatch(/5 unlimited token allowances granted to 3 unlabelled spenders/);
    expect(r.score).toBe(RISK_WEIGHTS.high);
    expect(ids(assess({ approvals: [approval(A), approval(A), approval(B), approval(C)] }).flags.filter((f) => f.level === 'high'))).toEqual([]);
  });

  it('ignores labelled spenders and finite allowances', () => {
    expect(ids(assess({ approvals: [approval(UNISWAP_V2)] }).flags)).toEqual([]);
    expect(ids(assess({ approvals: [approval(A, true, 'Known DEX')] }).flags)).toEqual([]);
    expect(ids(assess({ approvals: [approval(A, true)], counterpartyLabels: new Map([label(A, 'dex')]) }).flags)).toEqual([]);
    expect(ids(assess({ approvals: [approval(A, false)] }).flags)).toEqual([]);
    expect(ids(assess({ approvals: [] }).flags)).toEqual([]);
  });
});

describe('contract-unverified', () => {
  const summary = (isContract: boolean, verified?: boolean): AddressSummary => ({
    chain: 'ethereum',
    address: SELF,
    isContract,
    contract: verified === undefined ? undefined : { verified },
  });

  it('fires only for a contract known to be unverified', () => {
    const r = assess({ summary: summary(true, false) });
    expect(ids(r.flags)).toEqual(['contract-unverified']);
    expect(r.flags[0].level).toBe('low');
    expect(ids(assess({ summary: summary(true, true) }).flags)).toEqual([]);
    expect(ids(assess({ summary: summary(true) }).flags)).toEqual([]);
    expect(ids(assess({ summary: summary(false, false) }).flags)).toEqual([]);
  });
});

describe('exchange-deposit', () => {
  it('fires (info, score 0) when every outgoing transfer goes to a labelled exchange', () => {
    const r = assess({
      history: [
        tx({ direction: 'in', from: A, value: parseEther('1'), ts: NOW - 30 * 86_400 }),
        tx({ direction: 'out', to: BINANCE_14, value: parseEther('0.5'), ts: NOW - 20 * 86_400 }),
        tx({ direction: 'out', to: KRAKEN_4, value: parseEther('0.5'), ts: NOW - 10 * 86_400 }),
      ],
    });
    expect(ids(r.flags)).toEqual(['exchange-deposit']);
    expect(r.flags[0].level).toBe('none');
    expect(r.flags[0].evidence).toEqual(['Binance 14 (hot wallet)', 'Kraken 4 (hot wallet)']);
    expect(r.score).toBe(0);
    expect(r.level).toBe('none');
  });

  it('does not fire with other outgoing counterparties, with no outgoing, for contracts or for exchanges', () => {
    const toExchange = tx({ direction: 'out', to: BINANCE_14, value: parseEther('1') });
    expect(ids(assess({ history: [toExchange, tx({ direction: 'out', to: B, value: parseEther('1') })] }).flags)).toEqual([]);
    expect(ids(assess({ history: [tx({ direction: 'in', from: BINANCE_14, value: parseEther('1') })] }).flags)).toEqual([]);
    expect(ids(assess({ history: [toExchange], summary: { chain: 'ethereum', address: SELF, isContract: true } }).flags)).toEqual([]);
    expect(ids(assess({ history: [toExchange], counterpartyLabels: new Map([label(SELF, 'exchange')]) }).flags)).toEqual([]);
    const tokenOut = tx({ direction: 'out', to: C, token: { symbol: 'USDC', amount: { raw: 1n, decimals: 6, symbol: 'USDC' }, kind: 'ERC-20' } });
    expect(ids(assess({ history: [toExchange], tokenTransfers: [tokenOut] }).flags)).toEqual([]);
  });
});

describe('large-value', () => {
  it('fires (info) for a large native transfer using the per-coin threshold', () => {
    const r = assess({ history: [tx({ direction: 'in', from: A, value: parseEther('100'), hash: '0xbig' })] });
    expect(ids(r.flags)).toEqual(['large-value']);
    expect(r.flags[0].level).toBe('none');
    expect(r.flags[0].evidence?.[0]).toMatch(/^0xbig · received from 100 ETH/);
    expect(r.score).toBe(0);
    expect(ids(assess({ history: [tx({ direction: 'in', from: A, value: parseEther('49') })] }).flags)).toEqual([]);
  });

  it('ignores a failed (reverted) large transfer', () => {
    expect(ids(assess({ history: [tx({ direction: 'out', to: A, value: parseEther('100'), status: 'failed' })] }).flags)).toEqual([]);
    expect(ids(assess({ history: [tx({ direction: 'out', to: A, value: parseEther('100'), status: 'pending' })] }).flags)).toEqual(['large-value']);
  });

  it('uses the USD threshold when a native price is supplied', () => {
    const history = [tx({ direction: 'in', from: A, value: parseEther('60') })];
    expect(ids(assess({ history, nativePriceUsd: 2000 }).flags)).toEqual(['large-value']);
    expect(ids(assess({ history, nativePriceUsd: 1000 }).flags)).toEqual([]);
    expect(ids(assess({ history: [tx({ direction: 'in', from: A, value: parseEther('10') })], nativePriceUsd: 20_000 }).flags)).toEqual(['large-value']);
  });

  it('fires for a large balance (USD when known, native threshold otherwise)', () => {
    const summary = (balance: bigint, usd?: number): AddressSummary => ({ chain: 'ethereum', address: SELF, isContract: false, nativeBalance: { chain: 'ethereum', balance, decimals: 18, symbol: 'ETH', usd } });
    expect(ids(assess({ summary: summary(parseEther('1'), 150_000) }).flags)).toEqual(['large-value']);
    expect(ids(assess({ summary: summary(parseEther('1'), 500) }).flags)).toEqual([]);
    expect(ids(assess({ summary: summary(parseEther('500')) }).flags)).toEqual(['large-value']);
    expect(ids(assess({ summary: summary(parseEther('5')) }).flags)).toEqual([]);
  });

  it('applies the bitcoin and solana thresholds', () => {
    const row = (chain: string, value: bigint, symbol: string, decimals: number) => tx({ chain, direction: 'in', from: 'a', to: 'self', value, symbol, decimals });
    expect(ids(assessAddress({ chain: 'bitcoin', address: 'self', now: NOW, history: [row('bitcoin', 10n * 10n ** 8n, 'BTC', 8)] }).flags)).toEqual(['large-value']);
    expect(ids(assessAddress({ chain: 'bitcoin', address: 'self', now: NOW, history: [row('bitcoin', 10n ** 8n, 'BTC', 8)] }).flags)).toEqual([]);
    expect(ids(assessAddress({ chain: 'solana', address: 'self', now: NOW, history: [row('solana', 2_000n * 10n ** 9n, 'SOL', 9)] }).flags)).toEqual(['large-value']);
  });
});

describe('ordering and combined scoring', () => {
  it('orders flags by severity and sums weights', () => {
    const r = assess({
      summary: { chain: 'ethereum', address: SELF, isContract: false, firstSeen: NOW - 3600 },
      history: [
        tx({ direction: 'in', from: A, value: parseEther('100'), ts: NOW - 3000 }),
        tx({ direction: 'out', to: TORNADO_10_ETH, value: parseEther('100'), ts: NOW - 2000 }),
      ],
      approvals: [approval(B)],
    });
    expect(ids(r.flags)).toEqual(['mixer-direct', 'pass-through', 'unlimited-approvals', 'fresh-wallet', 'large-value']);
    expect(r.score).toBe(100); // 50 + 25 + 25 + 10 = 110, clipped
    expect(r.level).toBe('critical');
  });

  it('two medium flags make a high report', () => {
    const t0 = NOW - 30 * 86_400;
    const r = assess({
      history: [tx({ direction: 'in', from: A, value: parseEther('10'), ts: t0 }), tx({ direction: 'out', to: B, value: parseEther('10'), ts: t0 + 60 })],
      approvals: [approval(C)],
    });
    expect(ids(r.flags)).toEqual(['pass-through', 'unlimited-approvals']);
    expect(r.score).toBe(50);
    expect(r.level).toBe('high');
  });
});
