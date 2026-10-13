import { beforeEach, describe, expect, it } from 'vitest';
import type { AddressLabel, LabelCategory } from '@/lib/types';
import {
  BUILTIN_LABELS,
  labelMap,
  labelsFor,
  lookupLabel,
  normalizeAddress,
  registerLabels,
  resetLabels,
} from '@/lib/intel/labels';

const BINANCE_14 = '0x28C6c06298d514Db089934071355E5743bf21d60';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const NULL_ADDR = '0x0000000000000000000000000000000000000000';
const SOL_BINANCE = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const BTC_BITFINEX = 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97';
const BTC_MTGOX = '1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF';
const UNLABELLED = '0x1234567890123456789012345678901234567890';

const CATEGORIES: LabelCategory[] = [
  'exchange', 'bridge', 'dex', 'lending', 'mixer', 'sanctioned', 'scam', 'token', 'burn', 'infrastructure', 'nft', 'wallet', 'other',
];

beforeEach(() => resetLabels());

describe('BUILTIN_LABELS', () => {
  it('has at least 80 well-formed, builtin-sourced entries', () => {
    expect(BUILTIN_LABELS.length).toBeGreaterThanOrEqual(80);
    for (const l of BUILTIN_LABELS) {
      expect(l.source).toBe('builtin');
      expect(l.name.length).toBeGreaterThan(2);
      expect(CATEGORIES).toContain(l.category);
      expect(l.chain).toBeDefined();
      if (l.address.startsWith('0x')) {
        expect(l.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(l.chain).not.toBe('bitcoin');
        expect(l.chain).not.toBe('solana');
      }
    }
  });

  it('has no duplicate (address, chain) pairs', () => {
    const seen = new Set<string>();
    for (const l of BUILTIN_LABELS) {
      const key = `${l.chain}:${normalizeAddress(l.address)}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('covers the mandatory examples from the spec', () => {
    expect(lookupLabel(MULTICALL3)?.name).toMatch(/Multicall3/);
    expect(lookupLabel('0x000000000022D473030F116dDEE9F6B43aC78BA3')?.name).toMatch(/Permit2/);
    expect(lookupLabel('34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo', 'bitcoin')?.category).toBe('exchange');
    expect(lookupLabel(BTC_MTGOX, 'bitcoin')?.name).toMatch(/Mt\. ?Gox/);
    expect(lookupLabel(SOL_BINANCE, 'solana')?.category).toBe('exchange');
    expect(lookupLabel('H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', 'solana')?.name).toMatch(/Coinbase/);
    expect(lookupLabel('0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF', 'ethereum')?.category).toBe('mixer');
    expect(lookupLabel('0x10ED43C718714eb63d5aA57B78B54704E256024E', 'bsc')?.category).toBe('dex');
  });
});

describe('normalizeAddress', () => {
  it('lower-cases EVM and bech32, keeps base58 verbatim', () => {
    expect(normalizeAddress(BINANCE_14)).toBe(BINANCE_14.toLowerCase());
    expect(normalizeAddress(`  ${BINANCE_14}  `)).toBe(BINANCE_14.toLowerCase());
    expect(normalizeAddress(BTC_BITFINEX.toUpperCase())).toBe(BTC_BITFINEX);
    expect(normalizeAddress(SOL_BINANCE)).toBe(SOL_BINANCE);
    expect(normalizeAddress(BTC_MTGOX)).toBe(BTC_MTGOX);
  });
});

describe('lookupLabel', () => {
  it('is case-insensitive for EVM addresses', () => {
    const expected = lookupLabel(BINANCE_14);
    expect(expected?.name).toMatch(/Binance 14/);
    expect(lookupLabel(BINANCE_14.toLowerCase())).toBe(expected);
    expect(lookupLabel(BINANCE_14.toUpperCase().replace('0X', '0x'))).toBe(expected);
    expect(lookupLabel(BINANCE_14.toLowerCase(), 'ethereum')).toBe(expected);
  });

  it('is case-insensitive for bech32 but case-sensitive for base58', () => {
    expect(lookupLabel(BTC_BITFINEX.toUpperCase(), 'bitcoin')?.name).toMatch(/Bitfinex/);
    expect(lookupLabel(SOL_BINANCE.toLowerCase(), 'solana')).toBeUndefined();
    expect(lookupLabel(BTC_MTGOX.toLowerCase(), 'bitcoin')).toBeUndefined();
  });

  it('returns undefined for unknown or empty input', () => {
    expect(lookupLabel(UNLABELLED)).toBeUndefined();
    expect(lookupLabel('')).toBeUndefined();
    expect(lookupLabel(UNLABELLED, 'ethereum')).toBeUndefined();
  });

  it('scopes mainnet-only labels to their chain', () => {
    expect(lookupLabel(BINANCE_14, 'ethereum')).toBeDefined();
    expect(lookupLabel(BINANCE_14)).toBeDefined();
    expect(lookupLabel(BINANCE_14, 'bsc')).toBeUndefined();
    expect(lookupLabel(BINANCE_14, 'base')).toBeUndefined();
    expect(lookupLabel(BINANCE_14, 'bitcoin')).toBeUndefined();
  });

  it("matches 'evm'-scoped labels on every EVM chain but not on bitcoin/solana", () => {
    for (const chain of ['ethereum', 'base', 'arbitrum', 'bsc', 'polygon', 'sepolia', 'evm']) {
      expect(lookupLabel(MULTICALL3, chain)?.name, chain).toMatch(/Multicall3/);
      expect(lookupLabel(NULL_ADDR, chain)?.category, chain).toBe('burn');
    }
    expect(lookupLabel(MULTICALL3, 'bitcoin')).toBeUndefined();
    expect(lookupLabel(MULTICALL3, 'solana')).toBeUndefined();
    expect(lookupLabel(MULTICALL3, 'not-a-chain')).toBeUndefined();
    expect(lookupLabel(MULTICALL3)).toBeDefined();
  });

  it("matches 'any'-scoped labels everywhere", () => {
    registerLabels([{ address: UNLABELLED, chain: 'any', name: 'Everywhere', category: 'wallet', source: 'case' }]);
    for (const chain of ['ethereum', 'bitcoin', 'solana', 'whatever']) expect(lookupLabel(UNLABELLED, chain)?.name).toBe('Everywhere');
    registerLabels([{ address: UNLABELLED, name: 'Undefined scope', category: 'wallet', source: 'case' }]);
    expect(lookupLabel(UNLABELLED, 'solana')?.name).toBe('Undefined scope');
  });

  it('keeps non-EVM family labels off EVM chains', () => {
    expect(lookupLabel(SOL_BINANCE, 'ethereum')).toBeUndefined();
    expect(lookupLabel(SOL_BINANCE, 'solana')).toBeDefined();
    expect(lookupLabel(BTC_MTGOX, 'ethereum')).toBeUndefined();
  });

  it('resolves the same address on different chains to the chain-specific label', () => {
    const op = lookupLabel('0x4200000000000000000000000000000000000010', 'optimism');
    const base = lookupLabel('0x4200000000000000000000000000000000000010', 'base');
    expect(op?.chain).toBe('optimism');
    expect(base?.chain).toBe('base');
    expect(lookupLabel('0x4200000000000000000000000000000000000010', 'arbitrum')).toBeUndefined();
  });
});

describe('registerLabels override order', () => {
  const caseLabel = (address: string, name: string, chain?: AddressLabel['chain']): AddressLabel => ({
    address,
    chain,
    name,
    category: 'wallet',
    source: 'case',
  });

  it('lets a case label override a builtin label with the same scope', () => {
    registerLabels([caseLabel(BINANCE_14.toLowerCase(), 'Suspect hot wallet', 'ethereum')]);
    const l = lookupLabel(BINANCE_14, 'ethereum');
    expect(l?.name).toBe('Suspect hot wallet');
    expect(l?.source).toBe('case');
    expect(lookupLabel(BINANCE_14)?.source).toBe('case');
  });

  it('lets a case label override a builtin label with a different scope', () => {
    // builtin Multicall3 is 'evm'-scoped; a chain-specific case tag wins on that chain.
    registerLabels([caseLabel(MULTICALL3, 'My tag', 'base')]);
    expect(lookupLabel(MULTICALL3, 'base')?.name).toBe('My tag');
    expect(lookupLabel(MULTICALL3, 'ethereum')?.name).toMatch(/Multicall3/);
    expect(lookupLabel(MULTICALL3)?.name).toBe('My tag');
    // builtin ethereum-scoped Binance 14 vs an 'evm'-scoped case tag: case still wins.
    registerLabels([caseLabel(BINANCE_14, 'Broad tag', 'evm')]);
    expect(lookupLabel(BINANCE_14, 'ethereum')?.name).toBe('Broad tag');
  });

  it('replaces an earlier registration with the same address and scope (last wins)', () => {
    registerLabels([caseLabel(UNLABELLED, 'first', 'ethereum')]);
    registerLabels([caseLabel(UNLABELLED, 'second', 'ethereum')]);
    expect(lookupLabel(UNLABELLED, 'ethereum')?.name).toBe('second');
    expect(labelsFor(UNLABELLED)).toHaveLength(1);
  });

  it('prefers the most specific scope among non-builtin labels', () => {
    registerLabels([caseLabel(UNLABELLED, 'generic', 'evm'), caseLabel(UNLABELLED, 'specific', 'ethereum')]);
    expect(lookupLabel(UNLABELLED, 'ethereum')?.name).toBe('specific');
    expect(lookupLabel(UNLABELLED, 'base')?.name).toBe('generic');
    expect(labelsFor(UNLABELLED).map((l) => l.name)).toEqual(['specific', 'generic']);
  });

  it('ignores malformed entries and tolerates empty input', () => {
    const before = labelMap().size;
    registerLabels([]);
    registerLabels([{ address: '', name: 'x', category: 'wallet', source: 'case' }, { address: '   ', name: 'y', category: 'wallet', source: 'case' }]);
    registerLabels([{ address: UNLABELLED, name: undefined as unknown as string, category: 'wallet', source: 'case' }]);
    expect(labelMap().size).toBe(before);
  });

  it('resetLabels restores the builtin list only', () => {
    registerLabels([caseLabel(UNLABELLED, 'temp', 'ethereum'), caseLabel(BINANCE_14, 'override', 'ethereum')]);
    expect(lookupLabel(UNLABELLED)).toBeDefined();
    resetLabels();
    expect(lookupLabel(UNLABELLED)).toBeUndefined();
    expect(lookupLabel(BINANCE_14)?.source).toBe('builtin');
  });
});

describe('labelMap', () => {
  it('is keyed by normalised address and contains every builtin entry', () => {
    const m = labelMap();
    const distinct = new Set(BUILTIN_LABELS.map((l) => normalizeAddress(l.address)));
    expect(m.size).toBe(distinct.size);
    for (const key of m.keys()) expect(key).toBe(normalizeAddress(key));
    expect(m.get(BINANCE_14.toLowerCase())?.name).toMatch(/Binance 14/);
    expect(m.has(BINANCE_14)).toBe(false);
    expect(m.get(SOL_BINANCE)?.chain).toBe('solana');
  });

  it('reflects runtime registrations and overrides', () => {
    registerLabels([{ address: UNLABELLED, chain: 'ethereum', name: 'new', category: 'wallet', source: 'case' }]);
    registerLabels([{ address: BINANCE_14, chain: 'ethereum', name: 'override', category: 'wallet', source: 'case' }]);
    const m = labelMap();
    expect(m.get(UNLABELLED.toLowerCase())?.name).toBe('new');
    expect(m.get(BINANCE_14.toLowerCase())?.name).toBe('override');
  });

  it('returns a snapshot that does not mutate the registry', () => {
    const m = labelMap();
    m.delete(BINANCE_14.toLowerCase());
    expect(lookupLabel(BINANCE_14)).toBeDefined();
  });
});
