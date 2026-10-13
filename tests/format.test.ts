import { describe, expect, it } from 'vitest';
import { formatAmount } from '@/lib/format';

describe('formatAmount', () => {
  it('formats integers and trims trailing fraction zeros', () => {
    expect(formatAmount(0n, 18)).toBe('0');
    expect(formatAmount(1_500_000n, 6)).toBe('1.5');
    expect(formatAmount(1234_000000n, 6)).toBe('1,234');
  });

  it('marks values below display precision only when the integer part is zero', () => {
    expect(formatAmount(1n, 18)).toBe('<0.000001');
    expect(formatAmount(1n, 18, 8)).toBe('<0.00000001');
    expect(formatAmount(1000000000000000001n, 18)).toBe('1');
    expect(formatAmount(1000000100000000000n, 18)).toBe('1');
    expect(formatAmount(1000000001000000000n, 18, 8)).toBe('1');
    expect(formatAmount(-1n, 18)).toBe('<-0.000001');
  });
});
