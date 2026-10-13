/**
 * Investigation cases store (SPEC §7).
 *
 * A case groups addresses / transactions ("entities") with optional user tags
 * and free-text notes. The store is persisted to `localStorage` under
 * `loxdetective.cases.v1`; entity tags are also published to the label
 * registry (`registerLabels`) so they show up across the UI like any other
 * known-address label, and withdrawn again (`unregisterLabels`) when the tag,
 * the entity or the whole case is removed. Fund-flow traces can be attached
 * to a case (`addAttachment`) as serialised graphs, capped at
 * `CASE_ATTACHMENT_MAX_BYTES` each; they travel with the case export.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { registerLabels, unregisterLabels } from '@/lib/intel/labels';
import type { AddressLabel, CaseAttachment, CaseEntity, CaseNote, ChainId, InvestigationCase, TraceOptions } from '@/lib/types';

export const CASES_STORAGE_KEY = 'loxdetective.cases.v1';
/** Marker written into exported case files so they can be recognised on import. */
export const CASE_EXPORT_FORMAT = 'loxdetective-case';
export const CASE_EXPORT_VERSION = 1;
/** Upper bound for one attachment's `data` (the serialised trace graph), in bytes. */
export const CASE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TITLE = 'Untitled case';
const TRACE_DIRECTIONS: ReadonlySet<string> = new Set(['in', 'out', 'both']);

export type NewCaseEntity = Omit<CaseEntity, 'id' | 'addedAt'>;
export type NewCaseAttachment = Omit<CaseAttachment, 'id' | 'createdAt'>;

export interface CasesState {
  cases: InvestigationCase[];
  activeCaseId?: string;
  /** Creates a case; it becomes the active case when none is active yet. */
  createCase(title: string): InvestigationCase;
  renameCase(id: string, title: string): void;
  /** Deletes a case; if it was active, the first remaining case becomes active. */
  deleteCase(id: string): void;
  /** Sets the active case; unknown ids clear the selection. */
  setActive(id?: string): void;
  /** Adds an entity (deduped by `entityId`); re-adding an existing one only updates a supplied tag/colour. */
  addEntity(caseId: string, e: NewCaseEntity): void;
  removeEntity(caseId: string, entityId: string): void;
  /** Sets tag and colour of an entity. Omitted / empty values clear the field. */
  tagEntity(caseId: string, entityId: string, tag?: string, color?: string): void;
  addNote(caseId: string, text: string): void;
  deleteNote(caseId: string, noteId: string): void;
  /**
   * Saves a trace into a case. Returns the stored attachment, or undefined for
   * an unknown case. Throws when the attachment is malformed, its `data`
   * exceeds `CASE_ATTACHMENT_MAX_BYTES`, or the browser storage refuses it.
   */
  addAttachment(caseId: string, a: NewCaseAttachment): CaseAttachment | undefined;
  removeAttachment(caseId: string, attachmentId: string): void;
  /** Pretty-printed JSON case file; throws `Error('Case not found')`. */
  exportCase(id: string): string;
  /**
   * Parses a case file (as produced by `exportCase`, or a bare case object) and
   * adds it as a new case; throws `Error('Invalid case file')`, or an error
   * starting with "Could not import the case" when the browser storage refuses
   * the write (the in-memory list is then left unchanged).
   */
  importCase(json: string): InvestigationCase;
}

/** The subset of the state that is written to storage. */
export type PersistedCases = Pick<CasesState, 'cases' | 'activeCaseId'>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
/** Trimmed non-empty string or undefined. */
const optStr = (v: unknown): string | undefined => (isStr(v) && v.trim() ? v.trim() : undefined);
const numOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Memory fallback so the store works in tests / private windows where localStorage throws. */
function safeStorage(): Storage {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.getItem('__probe__');
      return localStorage;
    }
  } catch {
    /* fall through */
  }
  const mem = new Map<string, string>();
  return {
    get length() {
      return mem.size;
    },
    clear: () => mem.clear(),
    getItem: (k) => mem.get(k) ?? null,
    key: (i) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k) => void mem.delete(k),
    setItem: (k, v) => void mem.set(k, v),
  } as Storage;
}

/** Random id: `crypto.randomUUID()` where available, otherwise a time + random fallback. */
export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const rnd = () => Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rnd()}-${rnd()}`;
}

/** Copy without `undefined`-valued keys (so an emptied optional collection disappears instead of lingering). */
function stripUndefined<T extends object>(obj: T): T {
  const out = { ...obj } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as T;
}

function cleanTitle(title: unknown): string {
  return (isStr(title) ? title.trim() : '') || DEFAULT_TITLE;
}

/**
 * Canonical form of an entity value for identity purposes. Hex values (EVM
 * addresses / hashes, Bitcoin txids) and bech32 Bitcoin addresses are case-
 * insensitive and lower-cased; base58 values (Solana, legacy Bitcoin) are
 * case-sensitive and kept as-is.
 */
function normalizeValue(kind: CaseEntity['kind'], value: string): string {
  const v = value.trim();
  if (kind === 'tx') return /^(0x)?[0-9a-fA-F]+$/.test(v) ? v.toLowerCase() : v;
  return /^0x[0-9a-fA-F]+$/.test(v) || /^bc1/i.test(v) ? v.toLowerCase() : v;
}

/** Stable entity id: `${chain}:${normalised address | hash}`. */
export function entityId(chain: ChainId, kind: CaseEntity['kind'], value: string): string {
  return `${chain}:${normalizeValue(kind, value)}`;
}

/** Copy of an entity with tag / colour set (empty values remove the field). */
function withTag(e: CaseEntity, tag?: string, color?: string): CaseEntity {
  const out: CaseEntity = { id: e.id, chain: e.chain, kind: e.kind, value: e.value, addedAt: e.addedAt };
  if (tag) out.tag = tag;
  if (color) out.color = color;
  return out;
}

function labelOf(e: CaseEntity): AddressLabel | undefined {
  if (e.kind !== 'address' || !e.tag) return undefined;
  return { address: e.value, chain: e.chain, name: e.tag, category: 'wallet', source: 'case' };
}

/** Publishes the tags of the given entities to the label registry. Never throws. */
function publishLabels(entities: CaseEntity[]): void {
  const labels = entities.map(labelOf).filter((l): l is AddressLabel => l !== undefined);
  if (labels.length === 0) return;
  try {
    registerLabels(labels);
  } catch {
    /* label registry problems must never break case editing */
  }
}

/**
 * Withdraws the case labels of previously tagged address entities whose tag is
 * gone (tag cleared, entity removed, case deleted). When another case still
 * tags the same entity, that tag is published instead so the registry keeps
 * following the cases. Never throws.
 */
function retireLabels(entities: CaseEntity[], cases: InvestigationCase[]): void {
  const gone = entities.filter((e) => e.kind === 'address' && e.tag);
  if (gone.length === 0) return;
  try {
    for (const e of gone) {
      const survivor = cases.flatMap((c) => c.entities).find((x) => x.id === e.id && x.kind === 'address' && x.tag);
      const label = survivor ? labelOf(survivor) : undefined;
      if (label) registerLabels([label]);
      else unregisterLabels((l) => l.source === 'case' && l.chain === e.chain && entityId(e.chain, 'address', l.address) === e.id);
    }
  } catch {
    /* label registry problems must never break case editing */
  }
}

// ---------------------------------------------------------------------------
// Validation (shared by import and storage rehydration)
// ---------------------------------------------------------------------------

function parseEntity(raw: unknown, now: number): CaseEntity | undefined {
  if (!isObj(raw)) return undefined;
  const chain = optStr(raw.chain);
  const value = optStr(raw.value);
  const kind = raw.kind;
  if (!chain || !value || (kind !== 'address' && kind !== 'tx')) return undefined;
  const base: CaseEntity = { id: entityId(chain, kind, value), chain, kind, value, addedAt: numOr(raw.addedAt, now) };
  return withTag(base, optStr(raw.tag), optStr(raw.color));
}

function parseNote(raw: unknown, now: number): CaseNote | undefined {
  if (!isObj(raw) || !isStr(raw.text)) return undefined;
  return { id: optStr(raw.id) ?? newId(), createdAt: numOr(raw.createdAt, now), text: raw.text };
}

/** Size of an attachment payload in bytes (UTF-8), falling back to the string length. */
export function attachmentBytes(data: string): number {
  try {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(data).length;
  } catch {
    /* fall through */
  }
  return data.length;
}

/** Validates the trace options of an attachment; returns undefined for a wrong shape. */
function parseTraceOptions(raw: unknown): CaseAttachment['options'] | undefined {
  if (!isObj(raw)) return undefined;
  const { maxHops, maxFanOut, direction, stopAtLabelled, includeTokens, minUsd } = raw;
  if (typeof maxHops !== 'number' || !Number.isFinite(maxHops)) return undefined;
  if (typeof maxFanOut !== 'number' || !Number.isFinite(maxFanOut)) return undefined;
  if (!isStr(direction) || !TRACE_DIRECTIONS.has(direction)) return undefined;
  if (typeof stopAtLabelled !== 'boolean' || typeof includeTokens !== 'boolean') return undefined;
  if (minUsd !== undefined && (typeof minUsd !== 'number' || !Number.isFinite(minUsd))) return undefined;
  const out: CaseAttachment['options'] = { maxHops, maxFanOut, direction: direction as TraceOptions['direction'], stopAtLabelled, includeTokens };
  if (minUsd !== undefined) out.minUsd = minUsd;
  return out;
}

/**
 * Validates an untrusted attachment: kind 'trace', non-empty title / chain /
 * root, well-formed options and a string `data` within the size cap. Ids and
 * timestamps are preserved when present.
 */
export function parseAttachment(raw: unknown, now = Date.now()): CaseAttachment | undefined {
  if (!isObj(raw) || raw.kind !== 'trace') return undefined;
  const title = optStr(raw.title);
  const chain = optStr(raw.chain);
  const root = optStr(raw.root);
  const options = parseTraceOptions(raw.options);
  if (!title || !chain || !root || !options || !isStr(raw.data)) return undefined;
  if (attachmentBytes(raw.data) > CASE_ATTACHMENT_MAX_BYTES) return undefined;
  return { id: optStr(raw.id) ?? newId(), kind: 'trace', title, createdAt: numOr(raw.createdAt, now), chain, root, options, data: raw.data };
}

/**
 * Validates an untrusted case object. Returns undefined when the shape is
 * wrong (title string, entities array of {chain, kind, value}, optional notes
 * array of {text}). Ids and timestamps are preserved when present, entities
 * are deduped by id and duplicate note ids are regenerated.
 */
function parseCase(raw: unknown, opts: { dropBadAttachments?: boolean } = {}): InvestigationCase | undefined {
  if (!isObj(raw) || !isStr(raw.title) || !Array.isArray(raw.entities)) return undefined;
  if (raw.notes !== undefined && !Array.isArray(raw.notes)) return undefined;
  if (raw.attachments !== undefined && !Array.isArray(raw.attachments)) return undefined;
  const now = Date.now();

  const entities: CaseEntity[] = [];
  const entityIds = new Set<string>();
  for (const item of raw.entities) {
    const e = parseEntity(item, now);
    if (!e) return undefined;
    if (entityIds.has(e.id)) continue;
    entityIds.add(e.id);
    entities.push(e);
  }

  const notes: CaseNote[] = [];
  const noteIds = new Set<string>();
  for (const item of raw.notes ?? []) {
    const n = parseNote(item, now);
    if (!n) return undefined;
    if (noteIds.has(n.id)) n.id = newId();
    noteIds.add(n.id);
    notes.push(n);
  }

  const attachments: CaseAttachment[] = [];
  const attachmentIds = new Set<string>();
  for (const item of raw.attachments ?? []) {
    const a = parseAttachment(item, now);
    if (!a) {
      if (opts.dropBadAttachments) continue;
      return undefined;
    }
    if (attachmentIds.has(a.id)) a.id = newId();
    attachmentIds.add(a.id);
    attachments.push(a);
  }

  const createdAt = numOr(raw.createdAt, now);
  const out: InvestigationCase = {
    id: optStr(raw.id) ?? newId(),
    title: cleanTitle(raw.title),
    createdAt,
    updatedAt: numOr(raw.updatedAt, createdAt),
    entities,
    notes,
  };
  if (attachments.length) out.attachments = attachments;
  return out;
}

/** Tolerant version of `parseCase` for storage: drops broken cases (and broken attachments) instead of failing hydration. */
function sanitizePersisted(raw: unknown): PersistedCases {
  if (!isObj(raw) || !Array.isArray(raw.cases)) return { cases: [], activeCaseId: undefined };
  const cases: InvestigationCase[] = [];
  const ids = new Set<string>();
  for (const item of raw.cases) {
    const c = parseCase(item, { dropBadAttachments: true });
    if (c && !ids.has(c.id)) {
      ids.add(c.id);
      cases.push(c);
    }
  }
  const activeCaseId = isStr(raw.activeCaseId) && ids.has(raw.activeCaseId) ? raw.activeCaseId : undefined;
  return { cases, activeCaseId };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useCases = create<CasesState>()(
  persist(
    (set, get) => {
      const find = (id: string): InvestigationCase | undefined => get().cases.find((c) => c.id === id);
      /** Applies a partial update to one case and bumps its `updatedAt`. No-op for unknown ids. */
      const patch = (id: string, fn: (c: InvestigationCase) => Partial<InvestigationCase>): void => {
        set((s) => ({ cases: s.cases.map((c) => (c.id === id ? stripUndefined({ ...c, ...fn(c), updatedAt: Date.now() }) : c)) }));
      };

      return {
        cases: [],
        activeCaseId: undefined,

        createCase: (title) => {
          const now = Date.now();
          const c: InvestigationCase = { id: newId(), title: cleanTitle(title), createdAt: now, updatedAt: now, entities: [], notes: [] };
          set((s) => ({ cases: [...s.cases, c], activeCaseId: s.activeCaseId ?? c.id }));
          return c;
        },

        renameCase: (id, title) => patch(id, () => ({ title: cleanTitle(title) })),

        deleteCase: (id) => {
          const removed = find(id);
          if (!removed) return;
          set((s) => {
            const cases = s.cases.filter((c) => c.id !== id);
            return { cases, activeCaseId: s.activeCaseId === id ? cases[0]?.id : s.activeCaseId };
          });
          retireLabels(removed.entities, get().cases);
        },

        setActive: (id) => set({ activeCaseId: id !== undefined && find(id) ? id : undefined }),

        addEntity: (caseId, e) => {
          const c = find(caseId);
          const value = optStr(e.value);
          if (!c || !value) return;
          const id = entityId(e.chain, e.kind, value);
          const tag = optStr(e.tag);
          const color = optStr(e.color);
          const existing = c.entities.find((x) => x.id === id);
          if (existing && tag === undefined && color === undefined) return; // already there, nothing to change
          const entity = existing
            ? withTag(existing, tag ?? existing.tag, color ?? existing.color)
            : withTag({ id, chain: e.chain, kind: e.kind, value, addedAt: Date.now() }, tag, color);
          patch(caseId, (cur) => ({
            entities: existing ? cur.entities.map((x) => (x.id === id ? entity : x)) : [...cur.entities, entity],
          }));
          publishLabels([entity]);
        },

        removeEntity: (caseId, eid) => {
          const removed = find(caseId)?.entities.find((e) => e.id === eid);
          if (!removed) return;
          patch(caseId, (c) => ({ entities: c.entities.filter((e) => e.id !== eid) }));
          retireLabels([removed], get().cases);
        },

        tagEntity: (caseId, eid, tag, color) => {
          const existing = find(caseId)?.entities.find((e) => e.id === eid);
          if (!existing) return;
          const entity = withTag(existing, optStr(tag), optStr(color));
          patch(caseId, (c) => ({ entities: c.entities.map((e) => (e.id === eid ? entity : e)) }));
          if (entity.tag) publishLabels([entity]);
          else retireLabels([existing], get().cases);
        },

        addNote: (caseId, text) => {
          if (!isStr(text) || !text.trim()) return;
          const note: CaseNote = { id: newId(), createdAt: Date.now(), text };
          patch(caseId, (c) => ({ notes: [...c.notes, note] }));
        },

        deleteNote: (caseId, noteId) => patch(caseId, (c) => ({ notes: c.notes.filter((n) => n.id !== noteId) })),

        addAttachment: (caseId, a) => {
          const target = find(caseId);
          if (!target) return undefined;
          if (!isObj(a) || !isStr(a.data)) throw new Error('Invalid attachment');
          if (attachmentBytes(a.data) > CASE_ATTACHMENT_MAX_BYTES) {
            throw new Error(`Attachment too large (${(attachmentBytes(a.data) / 1024 / 1024).toFixed(1)} MB; the limit is ${CASE_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB)`);
          }
          const attachment = parseAttachment({ ...a, id: newId(), createdAt: Date.now() });
          if (!attachment) throw new Error('Invalid attachment');
          const before = target.attachments ?? [];
          try {
            patch(caseId, (c) => ({ attachments: [...(c.attachments ?? []), attachment] }));
          } catch (err) {
            // The persist middleware writes synchronously; a full localStorage throws here. Roll back the in-memory state.
            patch(caseId, () => (before.length ? { attachments: before } : { attachments: undefined }));
            throw new Error(`Could not save the attachment: browser storage is full or unavailable (${err instanceof Error ? err.message : String(err)})`);
          }
          return attachment;
        },

        removeAttachment: (caseId, attachmentId) => {
          const c = find(caseId);
          if (!c?.attachments?.some((a) => a.id === attachmentId)) return;
          patch(caseId, (cur) => {
            const rest = (cur.attachments ?? []).filter((a) => a.id !== attachmentId);
            return rest.length ? { attachments: rest } : { attachments: undefined };
          });
        },

        exportCase: (id) => {
          const c = find(id);
          if (!c) throw new Error('Case not found');
          const file = { format: CASE_EXPORT_FORMAT, version: CASE_EXPORT_VERSION, exportedAt: new Date().toISOString(), case: c };
          return JSON.stringify(file, null, 2);
        },

        importCase: (json) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(json);
          } catch {
            throw new Error('Invalid case file');
          }
          // Accept both the wrapped export format and a bare case object.
          const raw = isObj(parsed) && isObj(parsed.case) ? parsed.case : parsed;
          const base = parseCase(raw);
          if (!base) throw new Error('Invalid case file');
          const c: InvestigationCase = { ...base, id: newId(), updatedAt: Date.now() };
          const before = get().cases;
          try {
            set((s) => ({ cases: [...s.cases, c] }));
          } catch (err) {
            // The persist middleware writes synchronously; a full localStorage throws here. Roll back the in-memory state.
            try {
              set({ cases: before });
            } catch {
              /* storage still broken; the rollback is best-effort */
            }
            throw new Error(`Could not import the case: browser storage is full or unavailable (${err instanceof Error ? err.message : String(err)})`);
          }
          publishLabels(c.entities);
          return c;
        },
      };
    },
    {
      name: CASES_STORAGE_KEY,
      storage: createJSONStorage(safeStorage),
      version: 1,
      partialize: (s): PersistedCases => ({ cases: s.cases, activeCaseId: s.activeCaseId }),
      merge: (persisted, current) => ({ ...current, ...sanitizePersisted(persisted) }),
      // Re-publish user tags as labels after every (re)hydration so they survive reloads.
      onRehydrateStorage: () => (state) => {
        if (state) publishLabels(state.cases.flatMap((c) => c.entities));
      },
    },
  ),
);

// ---------------------------------------------------------------------------
// Hook-less selectors for plain modules and non-React code
// ---------------------------------------------------------------------------

function activeOf(s: Pick<CasesState, 'cases' | 'activeCaseId'>): InvestigationCase | undefined {
  return s.activeCaseId ? s.cases.find((c) => c.id === s.activeCaseId) : undefined;
}

export function getActiveCase(): InvestigationCase | undefined {
  return activeOf(useCases.getState());
}

/** React hook variant of `getActiveCase`. */
export function useActiveCase(): InvestigationCase | undefined {
  return useCases(activeOf);
}

/** All cases that contain the entity. */
export function casesContaining(chain: ChainId, kind: CaseEntity['kind'], value: string): InvestigationCase[] {
  const id = entityId(chain, kind, value);
  return useCases.getState().cases.filter((c) => c.entities.some((e) => e.id === id));
}

/** Whether the entity is in `caseId` (when given) or in any case. */
export function isInCase(chain: ChainId, kind: CaseEntity['kind'], value: string, caseId?: string): boolean {
  const id = entityId(chain, kind, value);
  const { cases } = useCases.getState();
  return cases.some((c) => (caseId === undefined || c.id === caseId) && c.entities.some((e) => e.id === id));
}
