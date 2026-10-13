import { describe, expect, it } from 'vitest';
import { detectInput } from '@/lib/detect';

describe('detectInput', () => {
  it('checksums 0x-prefixed EVM addresses', () => {
    expect(detectInput('0xdac17f958d2ee523a2206206994597c13d831ec7')).toMatchObject({ kind: 'evm-address', value: '0xdAC17F958D2ee523a2206206994597C13D831ec7' });
  });

  it('accepts a 40-hex EVM address pasted without its 0x prefix', () => {
    const r = detectInput('dAC17F958D2ee523a2206206994597C13D831ec7');
    expect(r.kind).toBe('evm-address');
    expect(r.value).toBe('0xdAC17F958D2ee523a2206206994597C13D831ec7');
    expect(r.families).toEqual(['evm']);
  });

  it('no longer classifies a zero-free bare 40-hex address as a Solana account', () => {
    const r = detectInput('a'.repeat(20) + 'b'.repeat(20));
    expect(r.kind).toBe('evm-address');
    expect(r.value).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('still treats a 64-hex string as a tx hash and base58 as Solana', () => {
    expect(detectInput(`0x${'ab'.repeat(32)}`).kind).toBe('evm-tx');
    expect(detectInput('ab'.repeat(32)).kind).toBe('btc-tx');
    expect(detectInput('So11111111111111111111111111111111111111112').kind).toBe('sol-address');
  });
});
