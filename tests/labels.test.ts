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
const DEAD_ADDR = '0x000000000000000000000000000000000000dEaD';
const UNI_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const CELER = '0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820';
const ZKEVM_BRIDGE = '0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe';
const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const TORN = '0x77777FeDdddFfC19Ff86DB637967013e6C6A116C';
const EVM_CHAINS = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc', 'avalanche', 'gnosis', 'zksync', 'linea', 'scroll', 'polygon-zkevm', 'blast', 'mantle', 'celo', 'fantom', 'cronos', 'moonbeam', 'sepolia'];
const SOL_BINANCE = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const BTC_BITFINEX = 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97';
const BTC_MTGOX = '1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF';
const UNLABELLED = '0x1234567890123456789012345678901234567890';

const CATEGORIES: LabelCategory[] = [
  'exchange', 'bridge', 'dex', 'lending', 'mixer', 'sanctioned', 'scam', 'token', 'burn', 'infrastructure', 'nft', 'wallet', 'other',
];

beforeEach(() => resetLabels());

describe('BUILTIN_LABELS', () => {
  it('has at least 150 well-formed, builtin-sourced entries', () => {
    expect(BUILTIN_LABELS.length).toBeGreaterThanOrEqual(150);
    // ... covering at least 100 distinct addresses.
    expect(new Set(BUILTIN_LABELS.map((l) => normalizeAddress(l.address))).size).toBeGreaterThanOrEqual(100);
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
    expect(lookupLabel(MULTICALL3, 'ethereum')?.name).toMatch(/Multicall3/);
    expect(lookupLabel('0x000000000022D473030F116dDEE9F6B43aC78BA3', 'ethereum')?.name).toMatch(/Permit2/);
    expect(lookupLabel('34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo', 'bitcoin')?.category).toBe('exchange');
    expect(lookupLabel(BTC_MTGOX, 'bitcoin')?.name).toMatch(/Mt\. ?Gox/);
    expect(lookupLabel(BTC_MTGOX, 'bitcoin')?.category).toBe('other'); // thief-controlled, not the exchange
    expect(lookupLabel(SOL_BINANCE, 'solana')?.category).toBe('exchange');
    expect(lookupLabel('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'solana')?.name).toMatch(/Jupiter/);
    expect(lookupLabel('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 'solana')?.name).toMatch(/Raydium/);
    expect(lookupLabel('0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF', 'ethereum')?.category).toBe('mixer');
    expect(lookupLabel('0x10ED43C718714eb63d5aA57B78B54704E256024E', 'bsc')?.category).toBe('dex');
    expect(lookupLabel('0x00000000219ab540356cBB839Cbe05303d7705Fa', 'ethereum')?.name).toMatch(/Beacon Chain Deposit/);
    expect(lookupLabel('0x3f5CE5FBFe3E9af3971dD833D26bA9b5C936f0bE', 'ethereum')?.name).toMatch(/^Binance 1 /);
  });

  it('names the Tornado stablecoin pools by their real denominations', () => {
    expect(lookupLabel('0xd96f2B1c14Db8458374d9Aca76E26c3D18364307', 'ethereum')?.name).toBe('Tornado Cash: 100 USDC pool');
    expect(lookupLabel('0x4736dCf1b7A3d580672CcE6E7c65cd5cc9cFBa19', 'ethereum')?.name).toBe('Tornado Cash: 1,000 USDC pool');
    expect(lookupLabel('0x169AD27A470D064DEDE56a2D3ff727986b15D52B', 'ethereum')?.name).toBe('Tornado Cash: 100 USDT pool');
    expect(lookupLabel('0x0836222F2B2B24A3F36f98668Ed8F0B38D1a872f', 'ethereum')?.name).toBe('Tornado Cash: 1,000 USDT pool');
    expect(BUILTIN_LABELS.some((l) => /10,000 USDC/.test(l.name))).toBe(false);
  });

  it('does not categorise non-pool Tornado contracts, issuers or theft wallets as mixer / exchange', () => {
    expect(lookupLabel(TORN, 'ethereum')?.category).toBe('token');
    expect(lookupLabel('0x5efda50f22d34F262c29268506C5Fa42cB56A1Ce', 'ethereum')?.category).toBe('infrastructure');
    expect(lookupLabel('0x5754284f345afc66a98fbB0a0Afe71e0F007B949', 'ethereum')?.category).toBe('other');
    expect(lookupLabel('0x0000000000A39bb272e79075ade125fd351887Ac', 'ethereum')?.name).toBe('Blur: Pool');
    // Exchange attributions we could not verify to the wallet number are unnumbered.
    expect(lookupLabel('0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'ethereum')?.name).toBe('Bitfinex');
    expect(lookupLabel('0x53d284357ec70cE289D6D64134DfAc8E511c8a3D', 'ethereum')?.name).toBe('Kraken (hot wallet)');
    // Dropped: the Solana "Coinbase" wallet could not be verified.
    expect(lookupLabel('H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', 'solana')).toBeUndefined();
  });

  it('scopes contracts that share an address on only some chains to exactly those chains', () => {
    for (const chain of ['ethereum', 'arbitrum', 'optimism', 'polygon']) {
      expect(lookupLabel(UNI_V3_FACTORY, chain)?.name, chain).toBe('Uniswap V3: Factory');
      expect(lookupLabel('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', chain)?.name, chain).toMatch(/Positions NFT/);
      expect(lookupLabel('0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', chain)?.name, chain).toMatch(/Universal Router/);
    }
    for (const chain of ['base', 'bsc', 'avalanche', 'zksync', 'celo']) {
      expect(lookupLabel(UNI_V3_FACTORY, chain), chain).toBeUndefined();
      expect(lookupLabel('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', chain), chain).toBeUndefined();
    }
    expect(lookupLabel('0x33128a8fC17869897dcE68Ed026d694621f6FDfD', 'base')?.name).toBe('Uniswap V3: Factory');
    expect(lookupLabel('0x33128a8fC17869897dcE68Ed026d694621f6FDfD', 'ethereum')).toBeUndefined();
    expect(lookupLabel('0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', 'base')?.name).toMatch(/Universal Router/);
    expect(lookupLabel('0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', 'bsc')).toBeUndefined();

    expect(lookupLabel(CELER, 'ethereum')?.name).toMatch(/cBridge/);
    expect(lookupLabel(CELER, 'polygon')).toBeUndefined();
    expect(lookupLabel(ZKEVM_BRIDGE, 'ethereum')?.name).toMatch(/zkEVM/);
    expect(lookupLabel(ZKEVM_BRIDGE, 'polygon-zkevm')?.name).toMatch(/zkEVM/);
    expect(lookupLabel(ZKEVM_BRIDGE, 'bsc')).toBeUndefined();
    expect(lookupLabel(CBBTC, 'ethereum')?.name).toMatch(/cbBTC/);
    expect(lookupLabel(CBBTC, 'base')?.name).toMatch(/cbBTC/);
    expect(lookupLabel(CBBTC, 'polygon')).toBeUndefined();
  });

  it('keeps canonical infrastructure off zkSync Era, where it lives at other addresses', () => {
    for (const addr of [MULTICALL3, '0x000000000022D473030F116dDEE9F6B43aC78BA3', '0x4e59b44847b379578588920cA78FbF26c0B4956C', '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2', '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552']) {
      expect(lookupLabel(addr, 'zksync'), addr).toBeUndefined();
      for (const chain of EVM_CHAINS.filter((c) => c !== 'zksync')) expect(lookupLabel(addr, chain), `${addr} on ${chain}`).toBeDefined();
      expect(lookupLabel(addr, 'bitcoin'), addr).toBeUndefined();
      expect(lookupLabel(addr, 'solana'), addr).toBeUndefined();
      expect(lookupLabel(addr), addr).toBeDefined();
    }
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
    for (const chain of [...EVM_CHAINS, 'evm']) {
      expect(lookupLabel(DEAD_ADDR, chain)?.name, chain).toMatch(/0xdead/);
      expect(lookupLabel(NULL_ADDR, chain)?.category, chain).toBe('burn');
    }
    expect(lookupLabel(DEAD_ADDR, 'bitcoin')).toBeUndefined();
    expect(lookupLabel(DEAD_ADDR, 'solana')).toBeUndefined();
    expect(lookupLabel(DEAD_ADDR, 'not-a-chain')).toBeUndefined();
    expect(lookupLabel(DEAD_ADDR)).toBeDefined();
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
    // builtin 0xdead is 'evm'-scoped; a chain-specific case tag wins on that chain.
    registerLabels([caseLabel(DEAD_ADDR, 'My tag', 'base')]);
    expect(lookupLabel(DEAD_ADDR, 'base')?.name).toBe('My tag');
    expect(lookupLabel(DEAD_ADDR, 'ethereum')?.name).toMatch(/0xdead/);
    expect(lookupLabel(DEAD_ADDR)?.name).toBe('My tag');
    // builtin Multicall3 has one entry per chain; a case tag on one chain beats it there only.
    registerLabels([caseLabel(MULTICALL3, 'Chain tag', 'base')]);
    expect(lookupLabel(MULTICALL3, 'base')?.name).toBe('Chain tag');
    expect(lookupLabel(MULTICALL3, 'ethereum')?.name).toMatch(/Multicall3/);
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
