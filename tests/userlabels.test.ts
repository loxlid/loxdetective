/**
 * User-importable labels: CSV parser, localStorage persistence and the
 * apply / clear registry wiring (real labels module, reset after each test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { labelsFor, lookupLabel, resetLabels } from '@/lib/intel/labels';
import {
  LABEL_CSV_HEADER,
  USER_LABELS_STORAGE_KEY,
  USER_LABEL_SOURCE,
  applyUserLabels,
  clearUserLabels,
  exportUserLabelsCsv,
  loadUserLabels,
  parseLabelCsv,
  saveUserLabels,
  splitCsvLine,
} from '@/lib/intel/userLabels';

const EVM = '0x1234567890123456789012345678901234567890'; // not in BUILTIN_LABELS
const BINANCE_14 = '0x28C6c06298d514Db089934071355E5743bf21d60';
const BECH32 = 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97';
const LEGACY = '1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF';
const P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
const SOL = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // builtin, scoped to ethereum

/** Minimal in-memory `localStorage` for the node environment. */
function installStorageShim(): Map<string, string> {
  const map = new Map<string, string>();
  const shim = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
  vi.stubGlobal('localStorage', shim);
  return map;
}

let store: Map<string, string>;

beforeEach(() => {
  store = installStorageShim();
  resetLabels();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetLabels();
});

describe('splitCsvLine', () => {
  it('splits on commas, trims and honours double quotes', () => {
    expect(splitCsvLine('a, b ,c')).toEqual(['a', 'b', 'c']);
    expect(splitCsvLine('x,"Name, with comma",wallet')).toEqual(['x', 'Name, with comma', 'wallet']);
    expect(splitCsvLine('x,"say ""hi""",,')).toEqual(['x', 'say "hi"', '', '']);
  });
});

describe('parseLabelCsv', () => {
  it('parses valid lines for every family, with an optional header and comments', () => {
    const text = [
      '# my labels',
      LABEL_CSV_HEADER,
      '',
      `${EVM},Suspect hot wallet,wallet,evm`,
      `${BECH32},My exchange deposit,exchange,bitcoin`,
      `   ${SOL} , Payout account , other , solana   `,
    ].join('\n');
    const { labels, errors } = parseLabelCsv(text);
    expect(errors).toEqual([]);
    expect(labels).toEqual([
      { address: EVM, chain: 'evm', name: 'Suspect hot wallet', category: 'wallet', source: USER_LABEL_SOURCE },
      { address: BECH32, chain: 'bitcoin', name: 'My exchange deposit', category: 'exchange', source: USER_LABEL_SOURCE },
      { address: SOL, chain: 'solana', name: 'Payout account', category: 'other', source: USER_LABEL_SOURCE },
    ]);
  });

  it('defaults chain by address shape and category to wallet', () => {
    const { labels, errors } = parseLabelCsv([`${EVM.toLowerCase()},A`, `${BECH32.toUpperCase()},B,,`, `${LEGACY},C,`, `${P2SH},D`, `${SOL},E`].join('\n'));
    expect(errors).toEqual([]);
    expect(labels.map((l) => [l.address, l.chain, l.category])).toEqual([
      [EVM, 'evm', 'wallet'], // checksummed through detectInput
      [BECH32, 'bitcoin', 'wallet'], // bech32 lower-cased
      [LEGACY, 'bitcoin', 'wallet'],
      [P2SH, 'bitcoin', 'wallet'],
      [SOL, 'solana', 'wallet'],
    ]);
  });

  it('accepts explicit registry chains and evm scope, case-insensitively', () => {
    const { labels, errors } = parseLabelCsv([`${EVM},A,Exchange,Base`, `${EVM},B,DEX,EVM`, `${EVM},C,token,ethereum`, `${LEGACY},D,wallet,solana`].join('\n'));
    expect(errors).toEqual([]);
    expect(labels.map((l) => [l.chain, l.category])).toEqual([
      ['base', 'exchange'],
      ['evm', 'dex'],
      ['ethereum', 'token'],
      ['solana', 'wallet'], // legacy base58 shapes may be Solana keys when the user says so
    ]);
  });

  it('reports bad addresses, categories, chains and names with their line number and keeps the good lines', () => {
    const text = [
      `${EVM},Good,wallet,evm`,
      'nope,Bad address',
      `${EVM},Bad category,casino`,
      `${EVM},Bad chain,wallet,dogecoin`,
      `${EVM},Wrong family,wallet,bitcoin`,
      `${BECH32},Wrong family 2,exchange,evm`,
      `${EVM},,wallet`,
      `${EVM},Too many,wallet,evm,extra`,
      `${SOL},Fine,other`,
    ].join('\n');
    const { labels, errors } = parseLabelCsv(text);
    expect(labels.map((l) => l.name)).toEqual(['Good', 'Fine']);
    expect(errors).toHaveLength(7);
    expect(errors[0]).toMatch(/^Line 2: "nope" is not a valid/);
    expect(errors[1]).toMatch(/^Line 3: unknown category "casino"/);
    expect(errors[1]).toContain('exchange, bridge, dex');
    expect(errors[2]).toMatch(/^Line 4: unknown chain "dogecoin"/);
    expect(errors[3]).toMatch(/^Line 5: chain "bitcoin" does not match/);
    expect(errors[4]).toMatch(/^Line 6: chain "evm" does not match/);
    expect(errors[5]).toMatch(/^Line 7: name is required/);
    expect(errors[6]).toMatch(/^Line 8: expected at most 4 columns/);
  });

  it('keeps the last of duplicate address+chain lines and treats different scopes separately', () => {
    const { labels } = parseLabelCsv([`${EVM},First,wallet,evm`, `${EVM.toLowerCase()},Second,exchange,evm`, `${EVM},On base,dex,base`].join('\n'));
    expect(labels.map((l) => [l.name, l.chain])).toEqual([
      ['Second', 'evm'],
      ['On base', 'base'],
    ]);
  });

  it('returns nothing for empty / comment-only input', () => {
    expect(parseLabelCsv('')).toEqual({ labels: [], errors: [] });
    expect(parseLabelCsv('# nothing\n\n   \n')).toEqual({ labels: [], errors: [] });
    expect(parseLabelCsv(LABEL_CSV_HEADER)).toEqual({ labels: [], errors: [] });
  });
});

describe('exportUserLabelsCsv', () => {
  it('writes a header plus one quoted-when-needed row per label and round-trips through the parser', () => {
    const labels = parseLabelCsv([`${EVM},"Exchange, deposit",exchange,evm`, `${SOL},Plain,other,solana`].join('\n')).labels;
    const csv = exportUserLabelsCsv(labels);
    expect(csv).toBe(`${LABEL_CSV_HEADER}\n${EVM},"Exchange, deposit",exchange,evm\n${SOL},Plain,other,solana\n`);
    expect(parseLabelCsv(csv).labels).toEqual(labels);
    expect(exportUserLabelsCsv([])).toBe(`${LABEL_CSV_HEADER}\n`);
  });
});

describe('persistence', () => {
  it('round-trips through localStorage under the versioned key', () => {
    const labels = parseLabelCsv(`${EVM},Suspect,wallet,evm\n${BECH32},Deposit,exchange,bitcoin`).labels;
    expect(saveUserLabels(labels)).toBe(true);
    expect(store.has(USER_LABELS_STORAGE_KEY)).toBe(true);
    expect(JSON.parse(store.get(USER_LABELS_STORAGE_KEY)!)).toHaveLength(2);
    expect(loadUserLabels()).toEqual(labels);
    // The textarea default is the export of what is stored.
    expect(exportUserLabelsCsv()).toContain(`${BECH32},Deposit,exchange,bitcoin`);
  });

  it('forces source=user on save and validates shape on read', () => {
    saveUserLabels([{ address: EVM, name: 'X', category: 'wallet', source: 'builtin', chain: 'evm' }]);
    expect(loadUserLabels()[0].source).toBe(USER_LABEL_SOURCE);

    store.set(
      USER_LABELS_STORAGE_KEY,
      JSON.stringify([
        { address: EVM, name: 'Ok', category: 'exchange', chain: 'evm' },
        { address: EVM, name: 'Bad category falls back', category: 'casino', chain: 'base' },
        { address: EVM, name: 'Unknown chain dropped', category: 'wallet', chain: 'dogecoin' },
        { address: '', name: 'No address' },
        { name: 'No address either', category: 'wallet' },
        { address: EVM, name: '', category: 'wallet' },
        'garbage',
        null,
      ]),
    );
    expect(loadUserLabels()).toEqual([
      { address: EVM, chain: 'evm', name: 'Ok', category: 'exchange', source: USER_LABEL_SOURCE },
      { address: EVM, chain: 'base', name: 'Bad category falls back', category: 'wallet', source: USER_LABEL_SOURCE },
    ]);
  });

  it('tolerates missing, malformed or throwing storage', () => {
    expect(loadUserLabels()).toEqual([]);
    store.set(USER_LABELS_STORAGE_KEY, '{not json');
    expect(loadUserLabels()).toEqual([]);
    store.set(USER_LABELS_STORAGE_KEY, JSON.stringify({ address: EVM }));
    expect(loadUserLabels()).toEqual([]);

    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadUserLabels()).toEqual([]);
    expect(saveUserLabels([{ address: EVM, name: 'X', category: 'wallet', source: 'user' }])).toBe(false);
    expect(() => clearUserLabels()).not.toThrow();

    vi.stubGlobal('localStorage', undefined);
    expect(loadUserLabels()).toEqual([]);
    expect(saveUserLabels([])).toBe(false);
    expect(applyUserLabels()).toBe(0);
  });
});

describe('apply / clear', () => {
  it('registers stored labels as source user, overriding built-in labels', () => {
    expect(lookupLabel(BINANCE_14, 'ethereum')?.source).toBe('builtin');
    saveUserLabels(parseLabelCsv(`${BINANCE_14},My Binance note,exchange,evm\n${EVM},Suspect,scam,base\n${SOL},Payout,other,solana`).labels);
    expect(applyUserLabels()).toBe(3);

    const mine = lookupLabel(BINANCE_14, 'ethereum');
    expect(mine?.source).toBe(USER_LABEL_SOURCE);
    expect(mine?.name).toBe('My Binance note');
    expect(lookupLabel(BINANCE_14, 'base')?.name).toBe('My Binance note');
    expect(lookupLabel(EVM, 'base')?.category).toBe('scam');
    expect(lookupLabel(EVM, 'ethereum')).toBeUndefined(); // scoped to base only
    expect(lookupLabel(SOL, 'solana')?.name).toBe('Payout');
    // Both labels remain known for the address; the user one is listed first.
    expect(labelsFor(BINANCE_14).map((l) => l.source)).toEqual([USER_LABEL_SOURCE, 'builtin']);
  });

  it('re-applying replaces the previous user labels instead of accumulating', () => {
    applyUserLabels(parseLabelCsv(`${EVM},One,wallet,evm`).labels);
    expect(lookupLabel(EVM, 'ethereum')?.name).toBe('One');
    applyUserLabels(parseLabelCsv(`${BECH32},Two,wallet,bitcoin`).labels);
    expect(lookupLabel(EVM, 'ethereum')).toBeUndefined();
    expect(lookupLabel(BECH32, 'bitcoin')?.name).toBe('Two');
    expect(labelsFor(BECH32)).toHaveLength(1);
  });

  it('restores a built-in label that a same-scope user label had displaced', () => {
    const before = lookupLabel(USDC, 'ethereum');
    expect(before?.source).toBe('builtin');
    applyUserLabels(parseLabelCsv(`${USDC},My stable,token,ethereum`).labels);
    expect(lookupLabel(USDC, 'ethereum')?.name).toBe('My stable');
    expect(labelsFor(USDC)).toHaveLength(1); // same scope: the user label replaced the built-in entry

    applyUserLabels(parseLabelCsv(`${EVM},Other,wallet,evm`).labels); // re-apply without USDC
    expect(lookupLabel(USDC, 'ethereum')).toEqual(before);
    applyUserLabels(parseLabelCsv(`${USDC},My stable,token,ethereum`).labels);
    clearUserLabels();
    expect(lookupLabel(USDC, 'ethereum')).toEqual(before);
    expect(lookupLabel(EVM, 'ethereum')).toBeUndefined();
  });

  it('clear unregisters only user labels and removes the storage key', () => {
    saveUserLabels(parseLabelCsv(`${BINANCE_14},Mine,exchange,evm\n${EVM},Suspect,wallet,evm`).labels);
    applyUserLabels();
    expect(lookupLabel(EVM, 'ethereum')?.name).toBe('Suspect');

    clearUserLabels();
    expect(store.has(USER_LABELS_STORAGE_KEY)).toBe(false);
    expect(loadUserLabels()).toEqual([]);
    expect(lookupLabel(EVM, 'ethereum')).toBeUndefined();
    const builtin = lookupLabel(BINANCE_14, 'ethereum');
    expect(builtin?.source).toBe('builtin');
    expect(builtin?.name).not.toBe('Mine');
  });
});
