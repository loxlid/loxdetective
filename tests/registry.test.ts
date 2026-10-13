import { describe, expect, it } from 'vitest';
import {
  allChains,
  CHAINS,
  chainsByFamily,
  DEFAULT_EVM_CHAIN,
  evmChains,
  findChain,
  getChain,
  getChainByEvmId,
  historyNeedsKey,
  historySource,
} from '@/lib/chains/registry';

const ADDR = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'ab'.repeat(32)}`;

describe('chain registry', () => {
  it('has unique ids and unique EVM chain ids', () => {
    const ids = CHAINS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const evmIds = CHAINS.filter((c) => c.evmChainId !== undefined).map((c) => c.evmChainId);
    expect(new Set(evmIds).size).toBe(evmIds.length);
    for (const c of CHAINS) {
      if (c.family === 'evm') expect(Number.isInteger(c.evmChainId)).toBe(true);
      else expect(c.evmChainId).toBeUndefined();
    }
  });

  it('gives every chain a non-empty list of https RPC URLs and a native currency', () => {
    for (const c of CHAINS) {
      expect(c.rpcUrls.length, c.id).toBeGreaterThan(0);
      for (const u of c.rpcUrls) expect(u, `${c.id}: ${u}`).toMatch(/^https:\/\/[^\s]+$/);
      expect(new Set(c.rpcUrls).size, c.id).toBe(c.rpcUrls.length);
      expect(c.native.symbol).toBeTruthy();
      expect(c.native.decimals).toBeGreaterThan(0);
      expect(c.native.priceKey).toMatch(/^coingecko:/);
      expect(c.blockscoutUrl === undefined || /^https:\/\/[^/]+$/.test(c.blockscoutUrl), `${c.id}: ${c.blockscoutUrl}`).toBe(true);
    }
  });

  it('builds explorer tx / address URLs for every chain', () => {
    for (const c of CHAINS) {
      expect(c.explorer.url).toMatch(/^https:\/\//);
      expect(c.explorer.url.endsWith('/')).toBe(false);
      const tx = c.explorer.tx(HASH);
      const address = c.explorer.address(ADDR);
      expect(tx.startsWith(c.explorer.url), c.id).toBe(true);
      expect(address.startsWith(c.explorer.url), c.id).toBe(true);
      expect(tx).toContain(HASH);
      expect(address).toContain(ADDR);
      expect(tx).not.toBe(address);
    }
    expect(getChain('ethereum').explorer.tx(HASH)).toBe(`https://etherscan.io/tx/${HASH}`);
    expect(getChain('bitcoin').explorer.address('bc1qxyz')).toBe('https://mempool.space/address/bc1qxyz');
    expect(getChain('solana').explorer.address('So111')).toBe('https://solscan.io/account/So111');
  });

  it('labels Fantom as legacy while keeping its id and chain id', () => {
    const ftm = getChain('fantom');
    expect(ftm.name).toBe('Fantom Opera (legacy)');
    expect(ftm.evmChainId).toBe(250);
    expect(ftm.shortName).toBe('FTM');
    expect(getChainByEvmId(250)?.id).toBe('fantom');
  });

  it('looks chains up by id, numeric id and EVM chain id', () => {
    expect(getChain('ethereum').evmChainId).toBe(1);
    expect(() => getChain('nope')).toThrow(/Unknown chain/);
    expect(findChain('base')?.id).toBe('base');
    expect(findChain('42161')?.id).toBe('arbitrum');
    expect(findChain('999999')).toBeUndefined();
    expect(findChain(undefined)).toBeUndefined();
    expect(getChainByEvmId(10)?.id).toBe('optimism');
    expect(DEFAULT_EVM_CHAIN).toBe('ethereum');
  });

  it('filters by family and hides testnets unless asked', () => {
    expect(evmChains().every((c) => c.family === 'evm' && !c.testnet)).toBe(true);
    expect(evmChains().some((c) => c.id === 'sepolia')).toBe(false);
    expect(evmChains(true).some((c) => c.id === 'sepolia')).toBe(true);
    expect(chainsByFamily('bitcoin').map((c) => c.id)).toEqual(['bitcoin']);
    expect(chainsByFamily('solana').map((c) => c.id)).toEqual(['solana']);
    expect(allChains().length).toBe(CHAINS.filter((c) => !c.testnet).length);
    expect(allChains(true).length).toBe(CHAINS.length);
  });
});

describe('history helpers', () => {
  it.each([
    ['ethereum', 'blockscout'],
    ['base', 'blockscout'],
    ['sepolia', 'blockscout'],
    ['bsc', 'etherscan-key'],
    ['cronos', 'etherscan-key'],
    ['moonbeam', 'etherscan-key'],
    ['avalanche', 'routescan'],
    ['fantom', 'routescan'],
    ['bitcoin', 'esplora'],
    ['solana', 'solana-rpc'],
  ])('historySource(%s) is %s', (id, source) => {
    expect(historySource(getChain(id))).toBe(source);
  });

  it('historyNeedsKey is true only for chains whose sole provider is key-gated Etherscan', () => {
    expect(historyNeedsKey(getChain('bsc'))).toBe(true);
    expect(historyNeedsKey(getChain('cronos'))).toBe(true);
    expect(historyNeedsKey(getChain('ethereum'))).toBe(false);
    expect(historyNeedsKey(getChain('avalanche'))).toBe(false);
    expect(historyNeedsKey(getChain('bitcoin'))).toBe(false);
    expect(historyNeedsKey(getChain('solana'))).toBe(false);
    for (const c of CHAINS) expect(historyNeedsKey(c), c.id).toBe(historySource(c) === 'etherscan-key');
  });
});
