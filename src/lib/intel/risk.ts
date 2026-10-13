/**
 * Pure, deterministic risk heuristics for an address. Every flag is derived
 * only from the `RiskInput` (plus the label registry for addresses the caller
 * did not pre-label). No network, no clocks unless `now` is omitted.
 *
 * Scoring: each flag contributes `RISK_WEIGHTS[flag.level]`; the sum is
 * clipped to 0..100 and mapped to a level with `levelFromScore`.
 */
import type {
  AddressLabel,
  AddressSummary,
  ApprovalInfo,
  ChainId,
  RiskFlag,
  RiskLevel,
  RiskReport,
  TxListItem,
} from '../types';
import { formatAmount, formatDate, toNumber } from '../format';
import { lookupLabel, normalizeAddress } from './labels';
import { isSanctioned } from './sanctions';

export interface RiskInput {
  chain: ChainId;
  address: string;
  summary?: AddressSummary;
  /** Native / top-level transaction rows (direction relative to `address`). */
  history?: TxListItem[];
  /** Token transfer rows (direction relative to `address`). */
  tokenTransfers?: TxListItem[];
  /** Pre-resolved labels, lower-cased address → label. Falls back to the label registry. */
  counterpartyLabels?: Map<string, AddressLabel>;
  approvals?: ApprovalInfo[];
  /** Reference time in unix seconds (milliseconds are tolerated). Defaults to Date.now(). */
  now?: number;
  /**
   * Optional second-hop data: lower-cased direct counterparty → the addresses
   * it transacted with. Enables the `mixer-1hop` flag; ignored when absent.
   */
  secondHopCounterparties?: Map<string, string[]>;
  /** Native coin price in USD, if known; enables the USD-based `large-value` threshold. */
  nativePriceUsd?: number;
  /**
   * True when the caller knows `history` and `tokenTransfers` are the full
   * history, i.e. no further pages exist; false when they are a partial page.
   * When omitted, `fresh-wallet` falls back to a conservative row-count guess.
   */
  historyComplete?: boolean;
}

export type RiskFlagId =
  | 'sanctioned'
  | 'scam-label'
  | 'sanctioned-counterparty'
  | 'mixer-direct'
  | 'mixer-1hop'
  | 'high-velocity'
  | 'pass-through'
  | 'unlimited-approvals'
  | 'fresh-wallet'
  | 'dust-pattern'
  | 'contract-unverified'
  | 'exchange-deposit'
  | 'large-value';

/** Score contribution of a flag, by its level. */
export const RISK_WEIGHTS: Record<RiskLevel, number> = { none: 0, low: 10, medium: 25, high: 50, critical: 100 };

/** Lower bound of each level (score 0 is `none`). */
export const RISK_THRESHOLDS = { low: 1, medium: 25, high: 50, critical: 75 } as const;

/** Tunable heuristic parameters, exported for the UI copy and tests. */
export const RISK_PARAMS = {
  freshWalletSec: 7 * 86_400,
  /**
   * Without `historyComplete`, `fresh-wallet` is derived from history only when
   * both row lists are shorter than this. Must be <= the smallest provider page
   * size (Solana 25, EVM 50) so a full page can never pass as complete.
   */
  freshWalletMaxRows: 25,
  velocityWindowSec: 86_400,
  velocityMaxTxs: 50,
  dustMinSenders: 5,
  passThroughWindowSec: 3_600,
  /** Forwarded value must be >= 90% of the incoming value (and of total received for the ratio rule). */
  passThroughRatio: [9n, 10n] as const,
  passThroughMinPairs: 2,
  unlimitedApprovalsHigh: 5,
  largeValueUsd: 100_000,
  maxEvidence: 10,
} as const;

/** Native-unit `large-value` thresholds when no USD price is available, by symbol. */
const LARGE_VALUE_NATIVE: Record<string, number> = {
  BTC: 10,
  ETH: 50,
  BNB: 200,
  SOL: 2_000,
  AVAX: 5_000,
  POL: 200_000,
  MATIC: 200_000,
  xDAI: 100_000,
  FTM: 200_000,
  CRO: 1_000_000,
  GLMR: 500_000,
  CELO: 200_000,
  MNT: 200_000,
};
const LARGE_VALUE_DEFAULT = 100_000;

const LEVEL_ORDER: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
const MIXER_NAME_RE = /tornado|mixer|blender|sinbad|railgun|chipmixer|coinjoin|wasabi/i;

export function levelFromScore(score: number): RiskLevel {
  const s = clipScore(score);
  if (s >= RISK_THRESHOLDS.critical) return 'critical';
  if (s >= RISK_THRESHOLDS.high) return 'high';
  if (s >= RISK_THRESHOLDS.medium) return 'medium';
  if (s >= RISK_THRESHOLDS.low) return 'low';
  return 'none';
}

export function clipScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, Math.round(score)));
}

export function scoreFromFlags(flags: RiskFlag[]): number {
  return clipScore(flags.reduce((sum, f) => sum + (RISK_WEIGHTS[f.level] ?? 0), 0));
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

interface Ctx {
  chain: ChainId;
  self: string;
  now: number;
  summary?: AddressSummary;
  history: TxListItem[];
  tokenTransfers: TxListItem[];
  /** history + tokenTransfers */
  rows: TxListItem[];
  approvals: ApprovalInfo[];
  labelOf: (address: string) => AddressLabel | undefined;
  secondHop?: Map<string, string[]>;
  nativePriceUsd?: number;
  historyComplete?: boolean;
}

function normalizeNow(now: number | undefined): number {
  if (now === undefined || !Number.isFinite(now)) return Math.floor(Date.now() / 1000);
  return now > 1e12 ? Math.floor(now / 1000) : Math.floor(now);
}

function buildCtx(input: RiskInput): Ctx {
  const map = input.counterpartyLabels;
  const chain = input.chain;
  const labelOf = (address: string): AddressLabel | undefined => {
    if (!address) return undefined;
    const key = normalizeAddress(address);
    return map?.get(key) ?? map?.get(address) ?? lookupLabel(address, chain);
  };
  const history = input.history ?? [];
  const tokenTransfers = input.tokenTransfers ?? [];
  return {
    chain,
    self: normalizeAddress(input.address),
    now: normalizeNow(input.now),
    summary: input.summary,
    history,
    tokenTransfers,
    rows: [...history, ...tokenTransfers],
    approvals: input.approvals ?? [],
    labelOf,
    secondHop: input.secondHopCounterparties,
    nativePriceUsd: input.nativePriceUsd,
    historyComplete: input.historyComplete,
  };
}

/** The other party of a row relative to the queried address, normalised; undefined for self-transfers. */
function counterpartyOf(row: TxListItem, self: string): string | undefined {
  const from = row.from ? normalizeAddress(row.from) : undefined;
  const to = row.to ? normalizeAddress(row.to) : undefined;
  let cp: string | undefined;
  switch (row.direction) {
    case 'out':
      cp = to;
      break;
    case 'in':
      cp = from;
      break;
    case 'self':
      cp = undefined;
      break;
    default:
      // 'unknown' = the provider found the address on neither side (e.g. a
      // third-party transfer listed on a token contract page): no counterparty.
      cp = undefined;
  }
  return cp && cp !== self ? cp : undefined;
}

/** False for a reverted transaction: it moved nothing, whatever `value` says. */
const moved = (r: TxListItem): boolean => r.status !== 'failed';

function isMixerLabel(l: AddressLabel | undefined): boolean {
  return !!l && (l.category === 'mixer' || MIXER_NAME_RE.test(l.name));
}

function sanctionHit(ctx: Ctx, address: string): AddressLabel | undefined {
  const l = ctx.labelOf(address);
  if (l?.category === 'sanctioned') return l;
  return isSanctioned(address);
}

function cap<T>(list: T[]): T[] {
  return list.slice(0, RISK_PARAMS.maxEvidence);
}

function dir(row: TxListItem): string {
  return row.direction === 'in' ? 'received from' : row.direction === 'out' ? 'sent to' : 'interacted with';
}

function flag(id: RiskFlagId, level: RiskLevel, title: string, detail: string, evidence?: string[]): RiskFlag {
  return evidence && evidence.length ? { id, level, title, detail, evidence } : { id, level, title, detail };
}

/** Unique counterparties with the rows that touched them, in first-seen order. */
function counterpartyRows(rows: TxListItem[], self: string): Map<string, TxListItem[]> {
  const out = new Map<string, TxListItem[]>();
  for (const row of rows) {
    const cp = counterpartyOf(row, self);
    if (!cp) continue;
    const list = out.get(cp);
    if (list) list.push(row);
    else out.set(cp, [row]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Heuristics — each returns a flag or undefined
// ---------------------------------------------------------------------------

/** `sanctioned` (critical): the address itself carries a sanctioned label (builtin, feed or caller-provided). */
function checkSanctioned(ctx: Ctx): RiskFlag | undefined {
  const l = sanctionHit(ctx, ctx.self);
  if (!l) return undefined;
  return flag('sanctioned', 'critical', 'Sanctioned address', `This address is on a sanctions list: ${l.name}.`, [l.name, l.source, ...(l.url ? [l.url] : [])]);
}

/** `scam-label` (critical): the address itself is labelled as a scam / phishing entity. */
function checkScamLabel(ctx: Ctx): RiskFlag | undefined {
  const l = ctx.labelOf(ctx.self);
  if (l?.category !== 'scam') return undefined;
  return flag('scam-label', 'critical', 'Labelled as scam', `This address is labelled "${l.name}" (${l.source}).`, [l.name, l.source]);
}

/**
 * Direct counterparties: a row with a mixer counterparty fires `mixer-direct`
 * (high); a sanctioned, non-mixer counterparty fires `sanctioned-counterparty`
 * (high). A counterparty counts once even if it is both.
 */
function checkCounterparties(ctx: Ctx): RiskFlag[] {
  const mixerEv: string[] = [];
  const sanctionedEv: string[] = [];
  const mixers = new Set<string>();
  const sanctionedSet = new Set<string>();
  for (const [cp, rows] of counterpartyRows(ctx.rows, ctx.self)) {
    const l = ctx.labelOf(cp);
    const s = sanctionHit(ctx, cp);
    if (isMixerLabel(l) || isMixerLabel(s)) {
      mixers.add(cp);
      for (const r of rows) mixerEv.push(`${r.hash} · ${dir(r)} ${(l ?? s)?.name ?? cp}`);
    } else if (s) {
      sanctionedSet.add(cp);
      for (const r of rows) sanctionedEv.push(`${r.hash} · ${dir(r)} ${s.name} (${cp})`);
    }
  }
  const out: RiskFlag[] = [];
  if (sanctionedSet.size) {
    out.push(
      flag(
        'sanctioned-counterparty',
        'high',
        'Direct exposure to sanctioned address',
        `Transacted directly with ${sanctionedSet.size} sanctioned address${sanctionedSet.size > 1 ? 'es' : ''} (${sanctionedEv.length} tx).`,
        cap(sanctionedEv),
      ),
    );
  }
  if (mixers.size) {
    out.push(
      flag(
        'mixer-direct',
        'high',
        'Direct mixer interaction',
        `Sent to or received from ${mixers.size} mixer contract${mixers.size > 1 ? 's' : ''} (${mixerEv.length} tx).`,
        cap(mixerEv),
      ),
    );
  }
  return out;
}

/**
 * `mixer-1hop` (medium): a direct counterparty (that is not itself a mixer)
 * has a mixer among its own counterparties. Requires `secondHopCounterparties`.
 */
function checkMixerOneHop(ctx: Ctx): RiskFlag | undefined {
  if (!ctx.secondHop || ctx.secondHop.size === 0) return undefined;
  const direct = counterpartyRows(ctx.rows, ctx.self);
  const evidence: string[] = [];
  const hops = new Set<string>();
  for (const [cp] of direct) {
    if (isMixerLabel(ctx.labelOf(cp))) continue; // already covered by mixer-direct
    const second = ctx.secondHop.get(cp) ?? ctx.secondHop.get(normalizeAddress(cp)) ?? [];
    for (const addr of second) {
      const l = ctx.labelOf(addr);
      if (!isMixerLabel(l)) continue;
      hops.add(cp);
      evidence.push(`${cp} → ${l?.name ?? addr}`);
    }
  }
  if (!hops.size) return undefined;
  return flag(
    'mixer-1hop',
    'medium',
    'Mixer exposure one hop away',
    `${hops.size} direct counterpart${hops.size > 1 ? 'ies' : 'y'} interacted with a mixer.`,
    cap(evidence),
  );
}

/**
 * `fresh-wallet` (low): first activity less than 7 days before `now`. Uses
 * `summary.firstSeen` when present; otherwise the earliest row timestamp, but
 * only when the rows are known (`historyComplete`) or, when the caller did not
 * say, plausibly complete: both lists shorter than any provider page and the
 * history not shorter than the nonce. A partial page (`historyComplete: false`)
 * is never used: its oldest row is just the oldest row of the latest page.
 */
function checkFreshWallet(ctx: Ctx): RiskFlag | undefined {
  let firstSeen = ctx.summary?.firstSeen;
  if (firstSeen === undefined) {
    const ts = ctx.rows.map((r) => r.timestamp).filter((t): t is number => typeof t === 'number' && t > 0);
    const complete =
      ts.length > 0 &&
      (ctx.historyComplete === true ||
        (ctx.historyComplete === undefined &&
          ctx.history.length < RISK_PARAMS.freshWalletMaxRows &&
          ctx.tokenTransfers.length < RISK_PARAMS.freshWalletMaxRows &&
          (ctx.summary?.txCount === undefined || ctx.history.length >= ctx.summary.txCount)));
    if (complete) firstSeen = Math.min(...ts);
  }
  if (firstSeen === undefined || firstSeen <= 0) return undefined;
  const age = ctx.now - firstSeen;
  if (age < 0 || age >= RISK_PARAMS.freshWalletSec) return undefined;
  const days = Math.floor(age / 86_400);
  return flag('fresh-wallet', 'low', 'Fresh wallet', `First seen ${days === 0 ? 'less than a day' : `${days} day${days > 1 ? 's' : ''}`} ago (${formatDate(firstSeen)}).`, [
    `first seen ${formatDate(firstSeen)}`,
  ]);
}

/** `high-velocity` (medium): more than 50 distinct transactions inside any sliding 24h window. */
function checkHighVelocity(ctx: Ctx): RiskFlag | undefined {
  const seen = new Set<string>();
  const ts: number[] = [];
  for (const r of ctx.rows) {
    if (typeof r.timestamp !== 'number' || seen.has(r.hash)) continue;
    seen.add(r.hash);
    ts.push(r.timestamp);
  }
  if (ts.length <= RISK_PARAMS.velocityMaxTxs) return undefined;
  ts.sort((a, b) => a - b);
  let best = 0;
  let bestStart = 0;
  let lo = 0;
  for (let hi = 0; hi < ts.length; hi++) {
    while (ts[hi] - ts[lo] > RISK_PARAMS.velocityWindowSec) lo++;
    const n = hi - lo + 1;
    if (n > best) {
      best = n;
      bestStart = lo;
    }
  }
  if (best <= RISK_PARAMS.velocityMaxTxs) return undefined;
  return flag('high-velocity', 'medium', 'High transaction velocity', `${best} transactions within 24 hours (window starting ${formatDate(ts[bestStart])}).`, [
    `${best} txs between ${formatDate(ts[bestStart])} and ${formatDate(ts[bestStart + best - 1])}`,
  ]);
}

/** Native dust threshold in base units: 0.0001 native, or 1,000 sats on Bitcoin. */
function dustThreshold(chain: ChainId, decimals: number): bigint {
  if (chain === 'bitcoin') return 1_000n;
  return 10n ** BigInt(Math.max(0, decimals - 4));
}

/** `dust-pattern` (low): at least 5 tiny incoming native transfers from 5 distinct senders (dusting / address poisoning). */
function checkDustPattern(ctx: Ctx): RiskFlag | undefined {
  const senders = new Map<string, number>();
  let count = 0;
  for (const r of ctx.history) {
    if (r.direction !== 'in' || r.token || !moved(r)) continue;
    const raw = r.value?.raw ?? 0n;
    if (raw <= 0n || raw >= dustThreshold(ctx.chain, r.value.decimals)) continue;
    const cp = counterpartyOf(r, ctx.self);
    if (!cp) continue;
    count++;
    senders.set(cp, (senders.get(cp) ?? 0) + 1);
  }
  if (senders.size < RISK_PARAMS.dustMinSenders) return undefined;
  return flag('dust-pattern', 'low', 'Dusting pattern', `${count} tiny incoming native transfers from ${senders.size} distinct senders.`, cap([...senders.keys()]));
}

/**
 * `pass-through` (medium): for each incoming native tx, the first unused
 * outgoing tx within 1h whose value is >= 90% of it is a "forward". Flags when
 * there are >= 2 forwards, or when >= 90% of all received value was forwarded.
 */
function checkPassThrough(ctx: Ctx): RiskFlag | undefined {
  const native = ctx.history.filter((r) => !r.token && moved(r) && typeof r.timestamp === 'number' && (r.value?.raw ?? 0n) > 0n);
  const incoming = native.filter((r) => r.direction === 'in').sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const outgoing = native.filter((r) => r.direction === 'out').sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  if (!incoming.length || !outgoing.length) return undefined;
  const [num, den] = RISK_PARAMS.passThroughRatio;
  const used = new Set<number>();
  const pairs: string[] = [];
  let totalIn = 0n;
  let matchedIn = 0n;
  for (const inc of incoming) {
    totalIn += inc.value.raw;
    const t0 = inc.timestamp as number;
    for (let i = 0; i < outgoing.length; i++) {
      if (used.has(i)) continue;
      const out = outgoing[i];
      const t1 = out.timestamp as number;
      if (t1 < t0) continue;
      if (t1 - t0 > RISK_PARAMS.passThroughWindowSec) break;
      if (out.value.raw * den >= inc.value.raw * num) {
        used.add(i);
        matchedIn += inc.value.raw;
        pairs.push(`${inc.hash} → ${out.hash} (${formatAmount(inc.value.raw, inc.value.decimals)} ${inc.value.symbol} forwarded within ${Math.round((t1 - t0) / 60)} min)`);
        break;
      }
    }
  }
  if (!pairs.length) return undefined;
  const ratioHit = totalIn > 0n && matchedIn * den >= totalIn * num;
  if (pairs.length < RISK_PARAMS.passThroughMinPairs && !ratioHit) return undefined;
  const pctForwarded = totalIn > 0n ? Number((matchedIn * 1000n) / totalIn) / 10 : 0;
  return flag('pass-through', 'medium', 'Pass-through wallet', `${pairs.length} incoming transfer${pairs.length > 1 ? 's were' : ' was'} forwarded within 1 hour (${pctForwarded}% of received value).`, cap(pairs));
}

/** `unlimited-approvals` (medium, high at >= 5): infinite allowances granted to spenders that carry no label. */
function checkUnlimitedApprovals(ctx: Ctx): RiskFlag | undefined {
  const evidence: string[] = [];
  const spenders = new Set<string>();
  for (const a of ctx.approvals) {
    if (!a?.unlimited || !a.spender) continue;
    if (a.spenderLabel || ctx.labelOf(a.spender)) continue;
    spenders.add(normalizeAddress(a.spender));
    evidence.push(`${a.token?.symbol || a.token?.address || 'token'} → ${a.spender}${a.txHash ? ` (${a.txHash})` : ''}`);
  }
  if (!evidence.length) return undefined;
  const high = evidence.length >= RISK_PARAMS.unlimitedApprovalsHigh;
  return flag(
    'unlimited-approvals',
    high ? 'high' : 'medium',
    'Unlimited approvals to unknown spenders',
    `${evidence.length} unlimited token allowance${evidence.length > 1 ? 's' : ''} granted to ${spenders.size} unlabelled spender${spenders.size > 1 ? 's' : ''}.`,
    cap(evidence),
  );
}

/** `contract-unverified` (low): the address is a contract whose source is known to be unverified. */
function checkContractUnverified(ctx: Ctx): RiskFlag | undefined {
  const s = ctx.summary;
  if (!s?.isContract || !s.contract || s.contract.verified !== false) return undefined;
  return flag('contract-unverified', 'low', 'Unverified contract', 'The contract source code is not verified on the explorer.');
}

/**
 * `exchange-deposit` (info): every outgoing transfer goes to a labelled
 * exchange and there is at least one. Typical of CEX deposit addresses; the
 * address must not be a contract or an exchange itself.
 */
function checkExchangeDeposit(ctx: Ctx): RiskFlag | undefined {
  if (ctx.summary?.isContract) return undefined;
  if (ctx.labelOf(ctx.self)?.category === 'exchange') return undefined;
  const outs = counterpartyRows(
    ctx.rows.filter((r) => r.direction === 'out'),
    ctx.self,
  );
  if (!outs.size) return undefined;
  const names = new Set<string>();
  let txs = 0;
  for (const [cp, rows] of outs) {
    const l = ctx.labelOf(cp);
    if (l?.category !== 'exchange') return undefined;
    names.add(l.name);
    txs += rows.length;
  }
  return flag('exchange-deposit', 'none', 'Likely exchange deposit address', `All ${txs} outgoing transfer${txs > 1 ? 's go' : ' goes'} to ${[...names].join(', ')}.`, [...names]);
}

function largeNativeThreshold(symbol: string, decimals: number): bigint {
  const units = LARGE_VALUE_NATIVE[symbol] ?? LARGE_VALUE_DEFAULT;
  return BigInt(units) * 10n ** BigInt(decimals);
}

function isLargeNative(ctx: Ctx, raw: bigint, decimals: number, symbol: string, usd?: number): boolean {
  if (usd !== undefined) return usd >= RISK_PARAMS.largeValueUsd;
  if (ctx.nativePriceUsd !== undefined && ctx.nativePriceUsd > 0) return toNumber(raw, decimals) * ctx.nativePriceUsd >= RISK_PARAMS.largeValueUsd;
  return raw >= largeNativeThreshold(symbol, decimals);
}

/** `large-value` (info): a native transfer or the balance worth >= $100k (or a per-coin native threshold when no price is known). */
function checkLargeValue(ctx: Ctx): RiskFlag | undefined {
  const evidence: string[] = [];
  const nb = ctx.summary?.nativeBalance;
  if (nb && !nb.error && isLargeNative(ctx, nb.balance, nb.decimals, nb.symbol, nb.usd)) {
    evidence.push(`balance ${formatAmount(nb.balance, nb.decimals)} ${nb.symbol}`);
  }
  const big = ctx.history
    .filter((r) => !r.token && moved(r) && r.value && isLargeNative(ctx, r.value.raw, r.value.decimals, r.value.symbol))
    .sort((a, b) => (a.value.raw > b.value.raw ? -1 : a.value.raw < b.value.raw ? 1 : 0));
  for (const r of big) evidence.push(`${r.hash} · ${dir(r)} ${formatAmount(r.value.raw, r.value.decimals)} ${r.value.symbol}`);
  if (!evidence.length) return undefined;
  return flag('large-value', 'none', 'Large value', `${big.length ? `${big.length} large native transfer${big.length > 1 ? 's' : ''}` : 'Large balance'} observed.`, cap(evidence));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function assessAddress(input: RiskInput): RiskReport {
  const ctx = buildCtx(input);
  const flags: RiskFlag[] = [];
  const push = (f: RiskFlag | undefined) => {
    if (f) flags.push(f);
  };
  push(checkSanctioned(ctx));
  push(checkScamLabel(ctx));
  for (const f of checkCounterparties(ctx)) push(f);
  push(checkMixerOneHop(ctx));
  push(checkPassThrough(ctx));
  push(checkHighVelocity(ctx));
  push(checkUnlimitedApprovals(ctx));
  push(checkFreshWallet(ctx));
  push(checkDustPattern(ctx));
  push(checkContractUnverified(ctx));
  push(checkExchangeDeposit(ctx));
  push(checkLargeValue(ctx));
  // Stable order: most severe first, insertion order within a level.
  flags.sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]);
  const score = scoreFromFlags(flags);
  return { score, level: levelFromScore(score), flags };
}
