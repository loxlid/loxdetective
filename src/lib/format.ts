import { formatUnits } from 'viem';
import type { Amount } from './types';

/** Shorten a hash/address: 0x1234…abcd */
export function shorten(value: string, lead = 6, tail = 4): string {
  if (!value) return '';
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

/** Format a base-unit bigint using its decimals, trimming noise. */
export function formatAmount(raw: bigint, decimals: number, maxFraction = 6): string {
  const s = formatUnits(raw, decimals);
  const [int, frac = ''] = s.split('.');
  const intFmt = Number.isSafeInteger(Number(int)) ? Number(int).toLocaleString('en-US') : int;
  if (!frac || Number(frac) === 0) return intFmt;
  const trimmed = frac.slice(0, maxFraction).replace(/0+$/, '');
  if (!trimmed) {
    // Only a zero integer part is genuinely "below display precision"; otherwise show the truncated integer.
    if (/^-?0$/.test(int)) return `<${intFmt}.${'0'.repeat(Math.max(0, maxFraction - 1))}1`;
    return intFmt;
  }
  return `${intFmt}.${trimmed}`;
}

export function formatAmountWithSymbol(a: Amount, maxFraction = 6): string {
  return `${formatAmount(a.raw, a.decimals, maxFraction)} ${a.symbol}`;
}

/** Convert a base-unit amount to a JS number (lossy; for USD maths and charts only). */
export function toNumber(raw: bigint, decimals: number): number {
  return Number(formatUnits(raw, decimals));
}

export function formatUsd(v: number | undefined, opts: { compact?: boolean } = {}): string {
  if (v === undefined || Number.isNaN(v)) return '—';
  if (opts.compact && Math.abs(v) >= 1_000_000) {
    return `$${(v / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(v) >= 1) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  if (v === 0) return '$0.00';
  return `$${v.toLocaleString('en-US', { maximumSignificantDigits: 3 })}`;
}

export function formatDate(unixSec: number | undefined): string {
  if (!unixSec) return '—';
  return new Date(unixSec * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

export function timeAgo(unixSec: number | undefined, now = Date.now()): string {
  if (!unixSec) return '—';
  const diff = Math.max(0, Math.floor(now / 1000) - unixSec);
  const units: [number, string][] = [
    [60, 's'],
    [60, 'm'],
    [24, 'h'],
    [7, 'd'],
    [4.345, 'w'],
    [12, 'mo'],
    [Number.POSITIVE_INFINITY, 'y'],
  ];
  let v = diff;
  for (const [size, label] of units) {
    if (v < size) return `${Math.floor(v)}${label} ago`;
    v /= size;
  }
  return `${Math.floor(v)}y ago`;
}

export function formatGwei(wei: bigint | undefined): string {
  if (wei === undefined) return '—';
  return `${formatAmount(wei, 9, 3)} gwei`;
}

export function pct(n: number, d: number): string {
  if (!d) return '0%';
  return `${((n / d) * 100).toFixed(1)}%`;
}

export function lower(s: string): string {
  return s.toLowerCase();
}
