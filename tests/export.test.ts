import { describe, expect, it } from 'vitest';
import { csvCell, rowsToCsv, safeFilename } from '@/lib/export';

describe('export helpers', () => {
  it('escapes formula-injection and quotes', () => {
    expect(csvCell('=SUM(A1)')).toBe('"\'=SUM(A1)"');
    expect(csvCell('+1')).toBe('"\'+1"');
    expect(csvCell('-1')).toBe('"\'-1"');
    expect(csvCell('@x')).toBe('"\'@x"');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(12n)).toBe('12');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(null)).toBe('');
  });

  it('serialises rows with a header', () => {
    const csv = rowsToCsv(
      [
        { header: 'hash', value: (r: { h: string; v: bigint }) => r.h },
        { header: 'value', value: (r) => r.v },
      ],
      [{ h: '0xabc', v: 10n }, { h: '=evil', v: 0n }],
    );
    expect(csv).toBe('hash,value\r\n0xabc,10\r\n"\'=evil",0\r\n');
  });

  it('sanitises filenames', () => {
    expect(safeFilename('trace 0xAb/..\\c.csv')).toBe('trace-0xAb-..-c.csv');
    expect(safeFilename('///')).toBe('export');
  });
});
