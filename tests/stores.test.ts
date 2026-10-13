import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The persist middleware grabs `localStorage` when the store module is first
// evaluated, so the in-memory shim has to exist before any import runs.
vi.hoisted(() => {
  const mem = new Map<string, string>();
  const shim = {
    get length() {
      return mem.size;
    },
    clear: () => mem.clear(),
    getItem: (k: string) => mem.get(k) ?? null,
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => void mem.delete(k),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true });
});

vi.mock('@/lib/intel/labels', () => ({ registerLabels: vi.fn(), unregisterLabels: vi.fn() }));

import { registerLabels, unregisterLabels } from '@/lib/intel/labels';
import { getChain } from '@/lib/chains/registry';
import {
  CASES_STORAGE_KEY,
  CASE_EXPORT_FORMAT,
  casesContaining,
  entityId,
  getActiveCase,
  isInCase,
  newId,
  useCases,
} from '@/lib/cases/store';
import { DEFAULT_SETTINGS, getSettings, rpcUrlsFor, SETTINGS_STORAGE_KEY, useSettings } from '@/lib/settings/store';
import type { InvestigationCase } from '@/lib/types';

const registerLabelsMock = vi.mocked(registerLabels);
const unregisterLabelsMock = vi.mocked(unregisterLabels);

const EVM_ADDR = '0xd8dA6BF26964aF9D7eEd9e03E51415D37aA96045'; // checksummed
const EVM_TX = '0xAB2f1e5d5f4C3b9a8E7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4';
const BTC_LEGACY = '1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF';
const SOL_ADDR = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';

function stored(key: string): { state: Record<string, unknown>; version: number } | null {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
  localStorage.clear();
  useCases.setState({ cases: [], activeCaseId: undefined });
  useSettings.getState().reset();
  registerLabelsMock.mockClear();
  unregisterLabelsMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Cases store
// ---------------------------------------------------------------------------

describe('cases: create / rename / delete / active', () => {
  it('creates a case with id, timestamps and empty collections and makes it active when none is', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    const c = useCases.getState().createCase('  Rug pull #1  ');
    expect(c.id).toMatch(/\S/);
    expect(c.title).toBe('Rug pull #1');
    expect(c.createdAt).toBe(Date.now());
    expect(c.updatedAt).toBe(Date.now());
    expect(c.entities).toEqual([]);
    expect(c.notes).toEqual([]);
    expect(useCases.getState().cases).toEqual([c]);
    expect(useCases.getState().activeCaseId).toBe(c.id);
    expect(getActiveCase()).toEqual(c);
  });

  it('keeps the existing active case when another one is created and falls back to a default title', () => {
    const a = useCases.getState().createCase('A');
    const b = useCases.getState().createCase('   ');
    expect(b.title).toBe('Untitled case');
    expect(useCases.getState().activeCaseId).toBe(a.id);
    expect(useCases.getState().cases.map((c) => c.id)).toEqual([a.id, b.id]);
  });

  it('generates unique ids, with a fallback when crypto.randomUUID is unavailable', () => {
    const ids = new Set([newId(), newId(), newId()]);
    expect(ids.size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);

    vi.stubGlobal('crypto', {});
    const fallback = [newId(), newId(), newId()];
    expect(new Set(fallback).size).toBe(3);
    for (const id of fallback) expect(id).toMatch(/^[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/);
    expect(useCases.getState().createCase('no uuid').id).toMatch(/\S/);
  });

  it('renames a case and bumps updatedAt; unknown ids are ignored', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    const c = useCases.getState().createCase('Old');
    vi.setSystemTime(new Date('2026-10-13T11:00:00Z'));
    useCases.getState().renameCase(c.id, '  New  ');
    const after = useCases.getState().cases[0];
    expect(after.title).toBe('New');
    expect(after.updatedAt).toBeGreaterThan(c.updatedAt);
    expect(after.createdAt).toBe(c.createdAt);
    useCases.getState().renameCase('nope', 'X');
    useCases.getState().renameCase(c.id, '');
    expect(useCases.getState().cases.map((x) => x.title)).toEqual(['Untitled case']);
  });

  it('deletes a case and moves the active selection to the first remaining case', () => {
    const a = useCases.getState().createCase('A');
    const b = useCases.getState().createCase('B');
    useCases.getState().setActive(b.id);
    useCases.getState().deleteCase(b.id);
    expect(useCases.getState().cases.map((c) => c.id)).toEqual([a.id]);
    expect(useCases.getState().activeCaseId).toBe(a.id);
    useCases.getState().deleteCase(a.id);
    expect(useCases.getState().cases).toEqual([]);
    expect(useCases.getState().activeCaseId).toBeUndefined();
    expect(getActiveCase()).toBeUndefined();
  });

  it('setActive accepts known ids, clears on undefined or unknown ids', () => {
    const a = useCases.getState().createCase('A');
    useCases.getState().setActive(undefined);
    expect(useCases.getState().activeCaseId).toBeUndefined();
    useCases.getState().setActive(a.id);
    expect(getActiveCase()?.id).toBe(a.id);
    useCases.getState().setActive('missing');
    expect(getActiveCase()).toBeUndefined();
  });
});

describe('cases: entityId', () => {
  it('lower-cases hex values and bech32 addresses, keeps base58 values intact', () => {
    expect(entityId('ethereum', 'address', EVM_ADDR)).toBe(`ethereum:${EVM_ADDR.toLowerCase()}`);
    expect(entityId('ethereum', 'tx', EVM_TX)).toBe(`ethereum:${EVM_TX.toLowerCase()}`);
    expect(entityId('bitcoin', 'tx', 'ABCDEF'.repeat(10) + 'abcd')).toBe(`bitcoin:${('ABCDEF'.repeat(10) + 'abcd').toLowerCase()}`);
    expect(entityId('bitcoin', 'address', 'BC1QGDJQV0AV3Q56JVD82TKDJPY7GDP9UT8TLQMGRPMV24SQ90ECNVQQJWVW97')).toBe(
      'bitcoin:bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97',
    );
    expect(entityId('bitcoin', 'address', BTC_LEGACY)).toBe(`bitcoin:${BTC_LEGACY}`);
    expect(entityId('solana', 'address', SOL_ADDR)).toBe(`solana:${SOL_ADDR}`);
    expect(entityId('solana', 'tx', '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW')).toBe(
      'solana:5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW',
    );
    expect(entityId('ethereum', 'address', `  ${EVM_ADDR}  `)).toBe(`ethereum:${EVM_ADDR.toLowerCase()}`);
  });
});

describe('cases: entities', () => {
  it('adds entities, keeps the display value, and dedupes by entityId', () => {
    const c = useCases.getState().createCase('A');
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'address', value: EVM_ADDR });
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'address', value: EVM_ADDR.toLowerCase() });
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'address', value: ` ${EVM_ADDR.toUpperCase().replace('0X', '0x')} ` });
    useCases.getState().addEntity(c.id, { chain: 'base', kind: 'address', value: EVM_ADDR });
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'tx', value: EVM_TX });
    const entities = useCases.getState().cases[0].entities;
    expect(entities).toHaveLength(3);
    expect(entities[0]).toMatchObject({ id: entityId('ethereum', 'address', EVM_ADDR), chain: 'ethereum', kind: 'address', value: EVM_ADDR });
    expect(typeof entities[0].addedAt).toBe('number');
    expect(entities[0]).not.toHaveProperty('tag');
    expect(entities[1].id).toBe(entityId('base', 'address', EVM_ADDR));
    expect(entities[2].id).toBe(entityId('ethereum', 'tx', EVM_TX));
    expect(registerLabelsMock).not.toHaveBeenCalled();
  });

  it('ignores empty values and unknown cases', () => {
    const c = useCases.getState().createCase('A');
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'address', value: '   ' });
    useCases.getState().addEntity('missing', { chain: 'ethereum', kind: 'address', value: EVM_ADDR });
    expect(useCases.getState().cases[0].entities).toEqual([]);
    expect(useCases.getState().cases).toHaveLength(1);
  });

  it('re-adding an existing entity with a tag updates the tag and keeps addedAt', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    const c = useCases.getState().createCase('A');
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'address', value: EVM_ADDR });
    const addedAt = useCases.getState().cases[0].entities[0].addedAt;
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'address', value: EVM_ADDR, tag: 'Victim', color: '#f00' });
    const e = useCases.getState().cases[0].entities;
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ tag: 'Victim', color: '#f00', addedAt });
    expect(registerLabelsMock).toHaveBeenCalledTimes(1);
  });

  it('removes entities by id', () => {
    const c = useCases.getState().createCase('A');
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'address', value: EVM_ADDR });
    useCases.getState().addEntity(c.id, { chain: 'bitcoin', kind: 'address', value: BTC_LEGACY });
    useCases.getState().removeEntity(c.id, entityId('ethereum', 'address', EVM_ADDR.toLowerCase()));
    expect(useCases.getState().cases[0].entities.map((e) => e.value)).toEqual([BTC_LEGACY]);
    useCases.getState().removeEntity(c.id, 'nope');
    expect(useCases.getState().cases[0].entities).toHaveLength(1);
  });

  it('tags entities and registers address tags as case labels', () => {
    const c = useCases.getState().createCase('A');
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'address', value: EVM_ADDR });
    const id = entityId('ethereum', 'address', EVM_ADDR);
    useCases.getState().tagEntity(c.id, id, ' Attacker ', '#ff0000');
    expect(useCases.getState().cases[0].entities[0]).toMatchObject({ tag: 'Attacker', color: '#ff0000' });
    expect(registerLabelsMock).toHaveBeenCalledTimes(1);
    expect(registerLabelsMock).toHaveBeenLastCalledWith([
      { address: EVM_ADDR, chain: 'ethereum', name: 'Attacker', category: 'wallet', source: 'case' },
    ]);

    // Clearing the tag removes both fields and withdraws the case label instead of publishing one.
    useCases.getState().tagEntity(c.id, id);
    const cleared = useCases.getState().cases[0].entities[0];
    expect(cleared).not.toHaveProperty('tag');
    expect(cleared).not.toHaveProperty('color');
    expect(registerLabelsMock).toHaveBeenCalledTimes(1);
    expect(unregisterLabelsMock).toHaveBeenCalledTimes(1);

    // Unknown entity / case: no-op.
    useCases.getState().tagEntity(c.id, 'missing', 'X');
    useCases.getState().tagEntity('missing', id, 'X');
    expect(registerLabelsMock).toHaveBeenCalledTimes(1);
  });

  it('does not register labels for tagged transactions and survives a throwing label registry', () => {
    const c = useCases.getState().createCase('A');
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'tx', value: EVM_TX, tag: 'Exploit tx' });
    expect(useCases.getState().cases[0].entities[0].tag).toBe('Exploit tx');
    expect(registerLabelsMock).not.toHaveBeenCalled();

    registerLabelsMock.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => useCases.getState().addEntity(c.id, { chain: 'solana', kind: 'address', value: SOL_ADDR, tag: 'CEX' })).not.toThrow();
    expect(useCases.getState().cases[0].entities[1]).toMatchObject({ value: SOL_ADDR, tag: 'CEX' });
  });
});

describe('cases: label retirement', () => {
  const caseLabel = (address: string, chain = 'ethereum' as const, name = 'Attacker') => ({ address, chain, name, category: 'wallet' as const, source: 'case' });
  const lastPredicate = () => unregisterLabelsMock.mock.calls.at(-1)?.[0] as (l: ReturnType<typeof caseLabel> | { source: string; address: string; chain?: string; name: string; category: string }) => boolean;

  it('withdraws only that entity\'s case label when its tag is cleared', () => {
    const c = useCases.getState().createCase('A');
    const id = entityId('ethereum', 'address', EVM_ADDR);
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'address', value: EVM_ADDR, tag: 'Attacker' });
    useCases.getState().tagEntity(c.id, id);
    expect(unregisterLabelsMock).toHaveBeenCalledTimes(1);
    const matches = lastPredicate();
    expect(matches(caseLabel(EVM_ADDR))).toBe(true);
    expect(matches(caseLabel(EVM_ADDR.toLowerCase()))).toBe(true);
    expect(matches({ ...caseLabel(EVM_ADDR), source: 'builtin' })).toBe(false);
    expect(matches({ ...caseLabel(EVM_ADDR), chain: 'base' })).toBe(false);
    expect(matches(caseLabel(`0x${'1'.repeat(40)}`))).toBe(false);

    // Clearing an already untagged entity touches the registry no further.
    useCases.getState().tagEntity(c.id, id);
    expect(unregisterLabelsMock).toHaveBeenCalledTimes(1);
    expect(registerLabelsMock).toHaveBeenCalledTimes(1);
  });

  it('withdraws the label of a removed tagged entity but not of untagged or tx entities', () => {
    const c = useCases.getState().createCase('A');
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'address', value: EVM_ADDR, tag: 'Attacker' });
    useCases.getState().addEntity(c.id, { chain: 'bitcoin', kind: 'address', value: BTC_LEGACY });
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'tx', value: EVM_TX, tag: 'Exploit tx' });
    useCases.getState().removeEntity(c.id, entityId('bitcoin', 'address', BTC_LEGACY));
    useCases.getState().removeEntity(c.id, entityId('ethereum', 'tx', EVM_TX));
    expect(unregisterLabelsMock).not.toHaveBeenCalled();
    useCases.getState().removeEntity(c.id, entityId('ethereum', 'address', EVM_ADDR));
    expect(unregisterLabelsMock).toHaveBeenCalledTimes(1);
    expect(lastPredicate()(caseLabel(EVM_ADDR))).toBe(true);
    expect(useCases.getState().cases[0].entities).toEqual([]);
  });

  it('deleting a case withdraws its tags unless another case still tags the same entity', () => {
    const a = useCases.getState().createCase('A');
    const b = useCases.getState().createCase('B');
    useCases.getState().addEntity(a.id, { chain: 'ethereum', kind: 'address', value: EVM_ADDR, tag: 'Attacker' });
    useCases.getState().addEntity(a.id, { chain: 'solana', kind: 'address', value: SOL_ADDR, tag: 'CEX' });
    useCases.getState().addEntity(b.id, { chain: 'ethereum', kind: 'address', value: EVM_ADDR.toLowerCase(), tag: 'Mule' });
    registerLabelsMock.mockClear();

    useCases.getState().deleteCase(a.id);
    expect(useCases.getState().cases.map((c) => c.id)).toEqual([b.id]);
    // The Ethereum address is still tagged by case B: its tag wins, nothing is withdrawn for it.
    expect(registerLabelsMock).toHaveBeenCalledTimes(1);
    expect(registerLabelsMock).toHaveBeenLastCalledWith([
      { address: EVM_ADDR.toLowerCase(), chain: 'ethereum', name: 'Mule', category: 'wallet', source: 'case' },
    ]);
    // The Solana address was only tagged by case A: withdrawn.
    expect(unregisterLabelsMock).toHaveBeenCalledTimes(1);
    expect(lastPredicate()({ address: SOL_ADDR, chain: 'solana', name: 'CEX', category: 'wallet', source: 'case' })).toBe(true);
    expect(lastPredicate()(caseLabel(EVM_ADDR))).toBe(false);

    // Unknown case: no-op.
    useCases.getState().deleteCase('missing');
    expect(unregisterLabelsMock).toHaveBeenCalledTimes(1);
  });

  it('survives a throwing registry when retiring labels', () => {
    const c = useCases.getState().createCase('A');
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'address', value: EVM_ADDR, tag: 'Attacker' });
    unregisterLabelsMock.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => useCases.getState().removeEntity(c.id, entityId('ethereum', 'address', EVM_ADDR))).not.toThrow();
    expect(useCases.getState().cases[0].entities).toEqual([]);
  });
});

describe('cases: notes', () => {
  it('adds and deletes notes, ignoring blank text', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    const c = useCases.getState().createCase('A');
    useCases.getState().addNote(c.id, 'First note');
    useCases.getState().addNote(c.id, '   ');
    useCases.getState().addNote(c.id, 'Second\nline two');
    useCases.getState().addNote('missing', 'x');
    const notes = useCases.getState().cases[0].notes;
    expect(notes.map((n) => n.text)).toEqual(['First note', 'Second\nline two']);
    expect(notes[0]).toMatchObject({ createdAt: Date.now() });
    expect(notes[0].id).not.toBe(notes[1].id);
    useCases.getState().deleteNote(c.id, notes[0].id);
    expect(useCases.getState().cases[0].notes.map((n) => n.text)).toEqual(['Second\nline two']);
    useCases.getState().deleteNote(c.id, 'nope');
    expect(useCases.getState().cases[0].notes).toHaveLength(1);
  });
});

describe('cases: export / import', () => {
  function seedCase(): InvestigationCase {
    const c = useCases.getState().createCase('Exported');
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'address', value: EVM_ADDR, tag: 'Attacker', color: '#f00' });
    useCases.getState().addEntity(c.id, { chain: 'bitcoin', kind: 'address', value: BTC_LEGACY });
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'tx', value: EVM_TX });
    useCases.getState().addNote(c.id, 'Funds moved to Binance');
    useCases.getState().addNote(c.id, 'Second note');
    return useCases.getState().cases[0];
  }

  it('exports pretty JSON with a format marker and throws for unknown ids', () => {
    const c = seedCase();
    const json = useCases.getState().exportCase(c.id);
    expect(json).toContain('\n  ');
    const parsed = JSON.parse(json);
    expect(parsed.format).toBe(CASE_EXPORT_FORMAT);
    expect(parsed.version).toBe(1);
    expect(parsed.case).toEqual(JSON.parse(JSON.stringify(c)));
    expect(() => useCases.getState().exportCase('missing')).toThrow('Case not found');
  });

  it('round-trips export -> import with a new id and updatedAt, registering tags', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    const original = seedCase();
    const json = useCases.getState().exportCase(original.id);
    registerLabelsMock.mockClear();

    vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
    const imported = useCases.getState().importCase(json);
    expect(imported.id).not.toBe(original.id);
    expect(imported.updatedAt).toBe(Date.now());
    expect(imported.createdAt).toBe(original.createdAt);
    expect(imported.title).toBe(original.title);
    expect(imported.entities).toEqual(original.entities);
    expect(imported.notes).toEqual(original.notes);
    expect(useCases.getState().cases.map((c) => c.id)).toEqual([original.id, imported.id]);
    // Only the original stays active; importing does not change the selection.
    expect(useCases.getState().activeCaseId).toBe(original.id);
    expect(registerLabelsMock).toHaveBeenCalledTimes(1);
    expect(registerLabelsMock).toHaveBeenLastCalledWith([
      { address: EVM_ADDR, chain: 'ethereum', name: 'Attacker', category: 'wallet', source: 'case' },
    ]);
  });

  it('imports a bare case object, filling in ids and timestamps and deduping entities', () => {
    const json = JSON.stringify({
      title: 'Bare',
      entities: [
        { chain: 'ethereum', kind: 'address', value: EVM_ADDR.toLowerCase(), tag: 'x' },
        { chain: 'ethereum', kind: 'address', value: EVM_ADDR },
        { chain: 'solana', kind: 'tx', value: 'sig', addedAt: 'not a number' },
      ],
      notes: [{ text: 'hello' }, { id: 'n1', text: 'a' }, { id: 'n1', text: 'b' }],
    });
    const c = useCases.getState().importCase(json);
    expect(c.entities).toHaveLength(2);
    expect(c.entities[0]).toMatchObject({ value: EVM_ADDR.toLowerCase(), tag: 'x' });
    expect(typeof c.entities[1].addedAt).toBe('number');
    expect(c.notes.map((n) => n.text)).toEqual(['hello', 'a', 'b']);
    expect(new Set(c.notes.map((n) => n.id)).size).toBe(3);
    expect(c.notes[1].id).toBe('n1');
    expect(typeof c.createdAt).toBe('number');
    expect(c.updatedAt).toBeGreaterThanOrEqual(c.createdAt);
  });

  it('throws Error("Invalid case file") for malformed input', () => {
    const bad = [
      'not json',
      '42',
      'null',
      '[]',
      JSON.stringify({ entities: [] }), // no title
      JSON.stringify({ title: 1, entities: [] }),
      JSON.stringify({ title: 'x' }), // no entities
      JSON.stringify({ title: 'x', entities: {} }),
      JSON.stringify({ title: 'x', entities: [{ chain: 'ethereum', kind: 'address' }] }), // no value
      JSON.stringify({ title: 'x', entities: [{ chain: 'ethereum', kind: 'nft', value: EVM_ADDR }] }),
      JSON.stringify({ title: 'x', entities: [{ kind: 'address', value: EVM_ADDR }] }), // no chain
      JSON.stringify({ title: 'x', entities: ['0xabc'] }),
      JSON.stringify({ title: 'x', entities: [], notes: 'nope' }),
      JSON.stringify({ title: 'x', entities: [], notes: [{ id: 'n1' }] }), // note without text
      JSON.stringify({ case: { title: 'x' } }), // wrapped but invalid
    ];
    for (const json of bad) {
      expect(() => useCases.getState().importCase(json), json).toThrow('Invalid case file');
    }
    expect(useCases.getState().cases).toEqual([]);
  });
});

describe('cases: persistence', () => {
  it('writes cases and the active id to localStorage on every change', () => {
    const c = useCases.getState().createCase('Persisted');
    useCases.getState().addEntity(c.id, { chain: 'ethereum', kind: 'address', value: EVM_ADDR });
    useCases.getState().addNote(c.id, 'note');
    const data = stored(CASES_STORAGE_KEY);
    expect(data?.version).toBe(1);
    expect(data?.state.activeCaseId).toBe(c.id);
    expect(data?.state.cases).toEqual(JSON.parse(JSON.stringify(useCases.getState().cases)));
    expect(Object.keys(data?.state ?? {}).sort()).toEqual(['activeCaseId', 'cases']);
  });

  it('rehydrates from storage, drops corrupted cases, fixes a dangling active id and re-registers tags', async () => {
    const good: InvestigationCase = {
      id: 'case-1',
      title: 'From disk',
      createdAt: 1,
      updatedAt: 2,
      entities: [{ id: entityId('ethereum', 'address', EVM_ADDR), chain: 'ethereum', kind: 'address', value: EVM_ADDR, tag: 'Mule', addedAt: 1 }],
      notes: [{ id: 'n1', createdAt: 1, text: 'hi' }],
    };
    localStorage.setItem(
      CASES_STORAGE_KEY,
      JSON.stringify({ state: { cases: [good, { title: 'broken' }, 'junk'], activeCaseId: 'ghost' }, version: 1 }),
    );
    await useCases.persist.rehydrate();
    expect(useCases.getState().cases).toEqual([good]);
    expect(useCases.getState().activeCaseId).toBeUndefined();
    expect(registerLabelsMock).toHaveBeenCalledWith([{ address: EVM_ADDR, chain: 'ethereum', name: 'Mule', category: 'wallet', source: 'case' }]);
    expect(typeof useCases.getState().addEntity).toBe('function');
  });

  it('tolerates garbage in storage', async () => {
    localStorage.setItem(CASES_STORAGE_KEY, JSON.stringify({ state: { cases: 'nope', activeCaseId: 5 }, version: 1 }));
    await useCases.persist.rehydrate();
    expect(useCases.getState().cases).toEqual([]);
    expect(useCases.getState().activeCaseId).toBeUndefined();
  });
});

describe('cases: selectors', () => {
  it('isInCase / casesContaining look through the given case or all cases', () => {
    const a = useCases.getState().createCase('A');
    const b = useCases.getState().createCase('B');
    useCases.getState().addEntity(a.id, { chain: 'ethereum', kind: 'address', value: EVM_ADDR });
    useCases.getState().addEntity(b.id, { chain: 'ethereum', kind: 'address', value: EVM_ADDR });
    useCases.getState().addEntity(b.id, { chain: 'bitcoin', kind: 'address', value: BTC_LEGACY });

    expect(isInCase('ethereum', 'address', EVM_ADDR.toLowerCase())).toBe(true);
    expect(isInCase('ethereum', 'address', EVM_ADDR, a.id)).toBe(true);
    expect(isInCase('bitcoin', 'address', BTC_LEGACY, a.id)).toBe(false);
    expect(isInCase('bitcoin', 'address', BTC_LEGACY, b.id)).toBe(true);
    expect(isInCase('bitcoin', 'address', BTC_LEGACY.toLowerCase())).toBe(false); // base58 is case-sensitive
    expect(isInCase('ethereum', 'tx', EVM_TX)).toBe(false);
    expect(isInCase('ethereum', 'address', EVM_ADDR, 'missing')).toBe(false);

    expect(casesContaining('ethereum', 'address', EVM_ADDR).map((c) => c.id)).toEqual([a.id, b.id]);
    expect(casesContaining('bitcoin', 'address', BTC_LEGACY).map((c) => c.id)).toEqual([b.id]);
    expect(casesContaining('solana', 'address', SOL_ADDR)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Settings store
// ---------------------------------------------------------------------------

describe('settings store', () => {
  it('starts from DEFAULT_SETTINGS and exposes a plain-data getSettings()', () => {
    const s = getSettings();
    expect(s).toEqual({ ...DEFAULT_SETTINGS, theme: 'system' });
    expect(s).not.toHaveProperty('set');
    expect(s.customRpc).toEqual({});
  });

  it('set() patches and reset() restores defaults', () => {
    useSettings.getState().set({ etherscanApiKey: 'KEY', showTestnets: true, theme: 'dark' });
    expect(getSettings()).toMatchObject({ etherscanApiKey: 'KEY', showTestnets: true, theme: 'dark', enableSanctionsFeed: true });
    useSettings.getState().reset();
    expect(getSettings()).toEqual({ ...DEFAULT_SETTINGS, theme: 'system' });
  });

  it('persists to localStorage under the settings key', () => {
    useSettings.getState().set({ etherscanApiKey: 'ABC', customRpc: { base: ['https://base.example'] } });
    const data = stored(SETTINGS_STORAGE_KEY);
    expect(data?.version).toBe(1);
    expect(data?.state).toMatchObject({ etherscanApiKey: 'ABC', customRpc: { base: ['https://base.example'] }, theme: 'system' });
    expect(data?.state).not.toHaveProperty('set');
  });

  it('rehydrates settings from storage', async () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ state: { ...DEFAULT_SETTINGS, heliusApiKey: 'H', theme: 'light', customRpc: { solana: ['https://sol.example'] } }, version: 1 }),
    );
    await useSettings.persist.rehydrate();
    expect(getSettings()).toMatchObject({ heliusApiKey: 'H', theme: 'light' });
    expect(rpcUrlsFor(getChain('solana'))[0]).toBe('https://sol.example');
  });
});

describe('settings: rpcUrlsFor', () => {
  it('returns the registry defaults when nothing is configured', () => {
    const eth = getChain('ethereum');
    const urls = rpcUrlsFor(eth);
    expect(urls).toEqual(eth.rpcUrls);
    expect(urls).not.toBe(eth.rpcUrls); // fresh array, callers may mutate it
    expect(rpcUrlsFor(getChain('bitcoin'))).toEqual(['https://mempool.space/api', 'https://blockstream.info/api']);
  });

  it('puts custom URLs first, trims them, dedupes against defaults and drops invalid entries', () => {
    const eth = getChain('ethereum');
    useSettings.getState().set({
      customRpc: {
        ethereum: [
          '  https://my-node.example/rpc  ',
          'ftp://nope.example',
          'not a url',
          '',
          '   ',
          'eth.llamarpc.com',
          'https://eth.llamarpc.com', // duplicates a default
          'https://my-node.example/rpc', // duplicates a custom entry
          'http://localhost:8545',
          'HTTPS://UPPER.example',
        ],
        base: ['https://base-only.example'],
      },
    });
    expect(rpcUrlsFor(eth)).toEqual([
      'https://my-node.example/rpc',
      'https://eth.llamarpc.com',
      'http://localhost:8545',
      'HTTPS://UPPER.example',
      'https://ethereum-rpc.publicnode.com',
      'https://cloudflare-eth.com',
      'https://rpc.ankr.com/eth',
      'https://1rpc.io/eth',
    ]);
    // Other chains only see their own overrides.
    expect(rpcUrlsFor(getChain('base'))).toEqual(['https://base-only.example', ...getChain('base').rpcUrls]);
    expect(rpcUrlsFor(getChain('arbitrum'))).toEqual(getChain('arbitrum').rpcUrls);
  });

  it('ignores a custom list that contains only invalid entries and tolerates missing keys', () => {
    useSettings.getState().set({ customRpc: { ethereum: ['garbage', 'ws://socket.example'] } });
    expect(rpcUrlsFor(getChain('ethereum'))).toEqual(getChain('ethereum').rpcUrls);
    useSettings.getState().set({ customRpc: {} });
    expect(rpcUrlsFor(getChain('ethereum'))).toEqual(getChain('ethereum').rpcUrls);
  });
});
