/**
 * User-importable labels: a CSV the investigator pastes in Settings, kept in
 * `localStorage` and registered in the label registry with `source: 'user'`.
 *
 * Precedence is the registry's: any non-builtin source beats the built-in
 * list, so a user label overrides a built-in one for the same address and
 * scope; case tags (also non-builtin, registered later) beat user labels by
 * recency when both match the same scope.
 *
 * CSV format (header optional, `#` comments and blank lines skipped):
 *
 *     address,name,category,chain
 *
 * - `category` is one of the `LabelCategory` values; blank means `wallet`.
 * - `chain` is `evm` (every EVM chain) or a registry chain id; blank means
 *   `evm` for `0x` addresses, `bitcoin` for Bitcoin shapes and `solana` for
 *   base58 account keys. The chain must match the address family.
 */
import type { AddressLabel, LabelCategory } from '../types';
import { detectInput } from '../detect';
import { findChain } from '../chains/registry';
import { BUILTIN_LABELS, normalizeAddress, registerLabels, unregisterLabels } from './labels';

export const USER_LABELS_STORAGE_KEY = 'loxdetective.labels.v1';
export const USER_LABEL_SOURCE = 'user';
export const LABEL_CSV_HEADER = 'address,name,category,chain';

export const LABEL_CATEGORIES: readonly LabelCategory[] = [
  'exchange',
  'bridge',
  'dex',
  'lending',
  'mixer',
  'sanctioned',
  'scam',
  'token',
  'burn',
  'infrastructure',
  'nft',
  'wallet',
  'other',
];

const MAX_NAME_LENGTH = 120;
const MAX_LABELS = 5000;

export interface ParsedLabelCsv {
  labels: AddressLabel[];
  errors: string[];
}

function isCategory(s: string): s is LabelCategory {
  return (LABEL_CATEGORIES as readonly string[]).includes(s);
}

/** Split one CSV line into trimmed fields; double-quoted fields may contain commas and doubled quotes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"' && cur.trim() === '') {
      quoted = true;
      cur = '';
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Parse `address,name,category,chain` lines into labels (source `user`).
 * Every bad line yields one `Line N: …` error and is skipped; good lines are
 * kept. Later lines replace earlier ones with the same address and chain.
 */
export function parseLabelCsv(text: string): ParsedLabelCsv {
  const errors: string[] = [];
  const byKey = new Map<string, AddressLabel>();
  const lines = (text ?? '').split(/\r?\n/);
  let sawHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#')) continue;
    const fields = splitCsvLine(raw);
    const [addressField = '', nameField = '', categoryField = '', chainField = ''] = fields;

    if (!sawHeader && byKey.size === 0 && addressField.toLowerCase() === 'address') {
      sawHeader = true;
      continue;
    }
    if (fields.length > 4) {
      errors.push(`Line ${lineNo}: expected at most 4 columns (address,name,category,chain), got ${fields.length}. Quote names that contain commas.`);
      continue;
    }

    const detected = detectInput(addressField);
    if (!addressField || !(detected.kind === 'evm-address' || detected.kind === 'btc-address' || detected.kind === 'sol-address')) {
      errors.push(`Line ${lineNo}: "${addressField || '(empty)'}" is not a valid EVM, Bitcoin or Solana address.`);
      continue;
    }
    const address = detected.value;
    const family = detected.families[0];

    if (!nameField) {
      errors.push(`Line ${lineNo}: name is required.`);
      continue;
    }
    if (nameField.length > MAX_NAME_LENGTH) {
      errors.push(`Line ${lineNo}: name is longer than ${MAX_NAME_LENGTH} characters.`);
      continue;
    }

    let category: LabelCategory = 'wallet';
    if (categoryField) {
      const c = categoryField.toLowerCase();
      if (!isCategory(c)) {
        errors.push(`Line ${lineNo}: unknown category "${categoryField}". Use one of: ${LABEL_CATEGORIES.join(', ')}.`);
        continue;
      }
      category = c;
    }

    let chain: AddressLabel['chain'];
    if (!chainField) {
      chain = family === 'evm' ? 'evm' : family;
    } else {
      const c = chainField.toLowerCase();
      if (c === 'evm') {
        chain = 'evm';
      } else {
        const info = findChain(c);
        if (!info) {
          errors.push(`Line ${lineNo}: unknown chain "${chainField}". Use "evm" or a chain id such as ethereum, base, arbitrum, bitcoin or solana.`);
          continue;
        }
        chain = info.id;
      }
      const chainFamily = chain === 'evm' ? 'evm' : findChain(chain)?.family;
      if (!chainFamily || !detected.families.includes(chainFamily)) {
        errors.push(`Line ${lineNo}: chain "${chainField}" does not match the address (${detected.hint}).`);
        continue;
      }
    }

    byKey.set(`${normalizeAddress(address)}|${chain}`, { address, chain, name: nameField, category, source: USER_LABEL_SOURCE });
    if (byKey.size > MAX_LABELS) {
      errors.push(`Line ${lineNo}: more than ${MAX_LABELS} labels; the rest were ignored.`);
      break;
    }
  }

  return { labels: Array.from(byKey.values()), errors };
}

/** Labels back to the CSV format `parseLabelCsv` reads (with header). */
export function exportUserLabelsCsv(labels: AddressLabel[] = loadUserLabels()): string {
  const rows = labels.map((l) => [l.address, l.name, l.category, l.chain ?? 'any'].map(csvField).join(','));
  return [LABEL_CSV_HEADER, ...rows].join('\n') + '\n';
}

function storage(): Storage | undefined {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s && typeof s.getItem === 'function' ? s : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeLabel(raw: unknown): AddressLabel | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.address !== 'string' || !o.address.trim()) return undefined;
  if (typeof o.name !== 'string' || !o.name.trim()) return undefined;
  const category = typeof o.category === 'string' && isCategory(o.category) ? o.category : 'wallet';
  const chain = typeof o.chain === 'string' && o.chain ? o.chain : undefined;
  if (chain !== undefined && chain !== 'evm' && chain !== 'any' && !findChain(chain)) return undefined;
  return { address: o.address.trim(), chain, name: o.name.trim().slice(0, MAX_NAME_LENGTH), category, source: USER_LABEL_SOURCE };
}

/** Labels persisted in localStorage (empty when missing, unreadable or malformed). */
export function loadUserLabels(): AddressLabel[] {
  try {
    const text = storage()?.getItem(USER_LABELS_STORAGE_KEY);
    if (!text) return [];
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const out: AddressLabel[] = [];
    for (const item of parsed) {
      const l = sanitizeLabel(item);
      if (l) out.push(l);
      if (out.length >= MAX_LABELS) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Persist labels (source forced to `user`); returns false when storage is unavailable. */
export function saveUserLabels(labels: AddressLabel[]): boolean {
  try {
    const s = storage();
    if (!s) return false;
    const clean = labels.map((l) => ({ address: l.address, chain: l.chain, name: l.name, category: l.category, source: USER_LABEL_SOURCE }));
    s.setItem(USER_LABELS_STORAGE_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

/**
 * Withdraw every user label. `registerLabels` replaces an earlier label with
 * the same address and scope, so a user label can have displaced a built-in
 * one; the built-in entries for the affected addresses are registered again.
 */
function withdrawUserLabels(): void {
  const affected = new Set<string>();
  unregisterLabels((l) => {
    if (l.source !== USER_LABEL_SOURCE) return false;
    affected.add(normalizeAddress(l.address));
    return true;
  });
  if (affected.size) registerLabels(BUILTIN_LABELS.filter((b) => affected.has(normalizeAddress(b.address))));
}

/**
 * Register the persisted user labels in the registry (replacing any user
 * labels registered earlier). Called once at startup; returns the count.
 */
export function applyUserLabels(labels: AddressLabel[] = loadUserLabels()): number {
  try {
    withdrawUserLabels();
    const clean = labels.map((l) => ({ ...l, source: USER_LABEL_SOURCE }));
    registerLabels(clean);
    return clean.length;
  } catch {
    return 0;
  }
}

/** Unregister every user label and forget the stored CSV. */
export function clearUserLabels(): void {
  try {
    withdrawUserLabels();
  } catch {
    /* registry unavailable: nothing to unregister */
  }
  try {
    storage()?.removeItem(USER_LABELS_STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}
