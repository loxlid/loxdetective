/**
 * Investigation cases (SPEC §6 / §7): list, create, rename and delete cases,
 * entities with tags and colours, notes, saved traces (attachments) and JSON
 * export / import. Everything lives in the cases store (localStorage).
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { CaseAttachment, CaseEntity, InvestigationCase } from '@/lib/types';
import { allChains, findChain } from '@/lib/chains/registry';
import { useCases } from '@/lib/cases/store';
import { downloadJson, safeFilename } from '@/lib/export';
import { shorten } from '@/lib/format';
import { traceQueryFor } from '@/pages/TracePage';
import { usePageTitle } from '@/hooks/usePageTitle';
import AddressDisplay from '@/components/AddressDisplay';
import Card from '@/components/Card';
import ChainBadge from '@/components/ChainBadge';
import { copyText } from '@/components/CopyButton';
import EmptyState from '@/components/EmptyState';
import HashDisplay from '@/components/HashDisplay';
import Timestamp from '@/components/Timestamp';
import { useToast } from '@/components/Toast';

const TAG_COLORS = ['#f5b942', '#ff5c5c', '#3ddc97', '#58a6ff', '#c084fc', '#f472b6', '#94a3b8'];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'case';
}

export interface AttachmentStats {
  nodes: number;
  edges: number;
  /** Hops actually reached, when the graph stats carry it. */
  hops?: number;
  /** Set when `data` could not be parsed as a flow export. */
  error?: string;
}

/** Node / edge counts of a saved trace; parsed on demand, never throws. */
export function attachmentStats(data: string): AttachmentStats {
  try {
    const parsed: unknown = JSON.parse(data);
    const graph = parsed && typeof parsed === 'object' && 'graph' in parsed ? (parsed as { graph: unknown }).graph : parsed;
    if (!graph || typeof graph !== 'object') return { nodes: 0, edges: 0, error: 'Not a trace export' };
    const g = graph as { nodes?: unknown; edges?: unknown; stats?: { hops?: unknown } };
    if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return { nodes: 0, edges: 0, error: 'Not a trace export' };
    const hops = typeof g.stats?.hops === 'number' ? g.stats.hops : undefined;
    return hops === undefined ? { nodes: g.nodes.length, edges: g.edges.length } : { nodes: g.nodes.length, edges: g.edges.length, hops };
  } catch {
    return { nodes: 0, edges: 0, error: 'Unreadable attachment data' };
  }
}

/** Route that reopens the tracer with the attachment's root and options. */
export function attachmentTraceLink(a: Pick<CaseAttachment, 'chain' | 'root' | 'options'>): string {
  return `/trace/${a.chain}/${a.root}?${traceQueryFor(a.options)}`;
}

function describeOptions(o: CaseAttachment['options']): string {
  const dir = o.direction === 'both' ? 'both directions' : o.direction === 'in' ? 'incoming' : 'outgoing';
  const parts = [`${o.maxHops} hop${o.maxHops === 1 ? '' : 's'}`, `fan-out ${o.maxFanOut}`, dir];
  if (o.minUsd) parts.push(`min $${o.minUsd}`);
  parts.push(o.includeTokens ? 'with tokens' : 'native only');
  if (o.stopAtLabelled) parts.push('stops at labels');
  return parts.join(' · ');
}

function AttachmentRow({ c, a }: { c: InvestigationCase; a: CaseAttachment }) {
  const removeAttachment = useCases((s) => s.removeAttachment);
  const toast = useToast();
  const stats = useMemo(() => attachmentStats(a.data), [a.data]);
  const chain = findChain(a.chain);
  const doDownload = () => {
    try {
      downloadJson(safeFilename(`loxdetective-trace-${a.chain}-${shorten(a.root, 6, 4).replace('…', '-')}`), a.data);
      toast.push('Trace JSON downloaded', 'success');
    } catch (err) {
      toast.push(err instanceof Error ? err.message : 'Download failed', 'error');
    }
  };
  return (
    <li className="note attachment" data-testid="case-attachment">
      <div className="note__text">
        <strong>{a.title}</strong>
        <div className="attachment__meta muted small">
          {chain ? <ChainBadge chain={chain} size="sm" showName /> : <span className="chip chip--other">{a.chain}</span>}{' '}
          <AddressDisplay address={a.root} chain={a.chain} copy />
        </div>
        <div className="muted small" data-testid="case-attachment-stats">
          {stats.error ? stats.error : `${stats.nodes} address${stats.nodes === 1 ? '' : 'es'} · ${stats.edges} edge${stats.edges === 1 ? '' : 's'}`} · {describeOptions(a.options)}
        </div>
      </div>
      <div className="note__meta">
        <Timestamp ts={Math.floor(a.createdAt / 1000)} mode="both" />
        <span className="btn-row">
          <Link className="btn btn--sm" to={attachmentTraceLink(a)} data-testid="case-attachment-open">
            Open trace
          </Link>
          <button type="button" className="btn btn--sm" onClick={doDownload}>
            Download JSON
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => removeAttachment(c.id, a.id)} aria-label={`Remove attachment ${a.title}`}>
            Remove
          </button>
        </span>
      </div>
    </li>
  );
}

function EntityRow({ c, e }: { c: InvestigationCase; e: CaseEntity }) {
  const tagEntity = useCases((s) => s.tagEntity);
  const removeEntity = useCases((s) => s.removeEntity);
  const [tag, setTag] = useState(e.tag ?? '');
  useEffect(() => setTag(e.tag ?? ''), [e.tag]);
  const commitTag = () => {
    if ((tag.trim() || undefined) !== e.tag) tagEntity(c.id, e.id, tag.trim() || undefined, e.color);
  };
  return (
    <li className="entity" style={e.color ? ({ '--entity-color': e.color } as React.CSSProperties) : undefined}>
      <span className="entity__swatch" aria-hidden="true" />
      <ChainBadge chain={e.chain} size="sm" />
      <span className="entity__value">
        {e.kind === 'address' ? <AddressDisplay address={e.value} chain={e.chain} copy /> : <HashDisplay hash={e.value} chain={e.chain} copy />}
      </span>
      <input
        className="input input--sm entity__tag"
        value={tag}
        placeholder="Tag (becomes a label)"
        onChange={(ev) => setTag(ev.target.value)}
        onBlur={commitTag}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
        }}
        aria-label={`Tag for ${shorten(e.value)}`}
      />
      <span className="entity__colors" role="group" aria-label="Colour">
        {TAG_COLORS.map((col) => (
          <button
            key={col}
            type="button"
            className={`swatch${e.color === col ? ' is-active' : ''}`}
            style={{ '--swatch': col } as React.CSSProperties}
            onClick={() => tagEntity(c.id, e.id, e.tag, e.color === col ? undefined : col)}
            aria-label={`Colour ${col}`}
            title={col}
          />
        ))}
      </span>
      <Link className="btn btn--sm btn--ghost" to={e.kind === 'address' ? `/address/${e.chain}/${e.value}` : `/tx/${e.chain}/${e.value}`}>
        Open
      </Link>
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => removeEntity(c.id, e.id)} aria-label="Remove entity" title="Remove">
        ×
      </button>
    </li>
  );
}

function CaseDetail({ c }: { c: InvestigationCase }) {
  const renameCase = useCases((s) => s.renameCase);
  const deleteCase = useCases((s) => s.deleteCase);
  const addNote = useCases((s) => s.addNote);
  const deleteNote = useCases((s) => s.deleteNote);
  const addEntity = useCases((s) => s.addEntity);
  const exportCase = useCases((s) => s.exportCase);
  const toast = useToast();

  const [title, setTitle] = useState(c.title);
  useEffect(() => setTitle(c.title), [c.title, c.id]);
  const [note, setNote] = useState('');
  const [entityValue, setEntityValue] = useState('');
  const [entityChain, setEntityChain] = useState('ethereum');
  const [entityKind, setEntityKind] = useState<CaseEntity['kind']>('address');
  const attachments = c.attachments ?? [];

  const submitNote = (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    addNote(c.id, note.trim());
    setNote('');
  };

  const submitEntity = (e: FormEvent) => {
    e.preventDefault();
    const v = entityValue.trim();
    if (!v) return;
    addEntity(c.id, { chain: entityChain, kind: entityKind, value: v });
    setEntityValue('');
  };

  const doExport = () => {
    try {
      downloadJson(`loxdetective-${slug(c.title)}`, exportCase(c.id));
      toast.push('Case exported', 'success');
    } catch (err) {
      toast.push(err instanceof Error ? err.message : 'Export failed', 'error');
    }
  };

  const copyJson = async () => {
    try {
      const ok = await copyText(exportCase(c.id));
      toast.push(ok ? 'Case JSON copied' : 'Copy failed', ok ? 'success' : 'error');
    } catch (err) {
      toast.push(err instanceof Error ? err.message : 'Copy failed', 'error');
    }
  };

  const remove = () => {
    if (typeof window !== 'undefined' && !window.confirm(`Delete case "${c.title}"? This cannot be undone.`)) return;
    deleteCase(c.id);
  };

  return (
    <div className="case-detail">
      <div className="case-detail__head">
        <input
          className="input case-detail__title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title.trim() && title.trim() !== c.title) renameCase(c.id, title.trim());
            else setTitle(c.title);
          }}
          aria-label="Case title"
        />
        <div className="btn-row">
          <button type="button" className="btn btn--sm" onClick={doExport}>
            Export JSON
          </button>
          <button type="button" className="btn btn--sm" onClick={copyJson}>
            Copy JSON
          </button>
          <button type="button" className="btn btn--sm btn--danger" onClick={remove}>
            Delete
          </button>
        </div>
      </div>
      <p className="muted case-detail__meta">
        Created <Timestamp ts={Math.floor(c.createdAt / 1000)} /> · updated <Timestamp ts={Math.floor(c.updatedAt / 1000)} /> · {c.entities.length} entit{c.entities.length === 1 ? 'y' : 'ies'} · {c.notes.length} note{c.notes.length === 1 ? '' : 's'}
        {attachments.length > 0 && ` · ${attachments.length} saved trace${attachments.length === 1 ? '' : 's'}`}
      </p>

      <Card title="Entities" subtitle="Addresses and transactions in this case. Tags show up as labels everywhere in the app.">
        {c.entities.length === 0 ? (
          <EmptyState compact title="No entities yet" hint='Use "Add to case" on any address or transaction page, or add one below.' />
        ) : (
          <ul className="entity-list">
            {c.entities.map((e) => (
              <EntityRow key={e.id} c={c} e={e} />
            ))}
          </ul>
        )}
        <form className="entity-add" onSubmit={submitEntity}>
          <select className="input input--select input--sm" value={entityKind} onChange={(e) => setEntityKind(e.target.value as CaseEntity['kind'])} aria-label="Entity kind">
            <option value="address">Address</option>
            <option value="tx">Transaction</option>
          </select>
          <ChainPicker value={entityChain} onChange={setEntityChain} />
          <input className="input input--sm mono entity-add__value" value={entityValue} onChange={(e) => setEntityValue(e.target.value)} placeholder={entityKind === 'address' ? 'Address' : 'Transaction hash'} aria-label="Entity value" spellCheck={false} />
          <button type="submit" className="btn btn--sm" disabled={!entityValue.trim()}>
            Add
          </button>
        </form>
      </Card>

      <Card title="Saved traces" subtitle="Fund-flow graphs stored with this case. Reopen one to re-run it with the same options, or download the graph JSON.">
        {attachments.length === 0 ? (
          <EmptyState compact title="No saved traces" hint='Run a trace and press "Save trace to case" on the tracer page.' />
        ) : (
          <ul className="note-list attachment-list">
            {attachments.map((a) => (
              <AttachmentRow key={a.id} c={c} a={a} />
            ))}
          </ul>
        )}
      </Card>

      <Card title="Notes">
        {c.notes.length === 0 ? <p className="muted">No notes yet.</p> : null}
        <ul className="note-list">
          {c.notes.map((n) => (
            <li key={n.id} className="note">
              <div className="note__text">{n.text}</div>
              <div className="note__meta">
                <Timestamp ts={Math.floor(n.createdAt / 1000)} mode="both" />
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => deleteNote(c.id, n.id)} aria-label="Delete note">
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
        <form className="note-add" onSubmit={submitNote}>
          <textarea data-testid="case-note-input" className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Write a note… (plain text; one entry per observation works best)" aria-label="New note" />
          <div className="btn-row">
            <button data-testid="case-add-note" type="submit" className="btn btn--primary btn--sm" disabled={!note.trim()}>
              Add note
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}

/** Small inline chain picker; kept local to avoid the settings-aware ChainSelect's hook in SSR tests. */
function ChainPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select className="input input--select input--sm" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Chain">
      {CHAIN_OPTIONS.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

const CHAIN_OPTIONS = allChains(true).map((c) => ({ id: c.id, name: c.name }));

export default function CasesPage() {
  usePageTitle('Cases');
  const cases = useCases((s) => s.cases);
  const activeCaseId = useCases((s) => s.activeCaseId);
  const createCase = useCases((s) => s.createCase);
  const setActive = useCases((s) => s.setActive);
  const importCase = useCases((s) => s.importCase);
  const toast = useToast();
  const [newTitle, setNewTitle] = useState('');
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const selected = cases.find((c) => c.id === activeCaseId) ?? cases[0];

  const submitCreate = (e: FormEvent) => {
    e.preventDefault();
    const c = createCase(newTitle);
    setActive(c.id);
    setNewTitle('');
  };

  const doImport = (json: string) => {
    try {
      const c = importCase(json);
      setActive(c.id);
      setImportText('');
      setShowImport(false);
      toast.push(`Imported case "${c.title}"`, 'success');
    } catch (err) {
      toast.push(err instanceof Error ? err.message : 'Invalid case file', 'error');
    }
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => doImport(String(reader.result ?? ''));
    reader.onerror = () => toast.push('Could not read the file', 'error');
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="cases-page" data-testid="cases-page">
      <div className="page-head">
        <div>
          <h1>Cases</h1>
          <p className="muted">Group addresses and transactions, tag them and keep notes. Stored in this browser; export to share.</p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="btn" onClick={() => setShowImport((v) => !v)}>
            Import JSON
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" onChange={onFile} aria-label="Import case file" />
        </div>
      </div>

      {showImport && (
        <Card
          title="Import a case"
          actions={
            <button type="button" className="btn btn--sm" onClick={() => fileRef.current?.click()}>
              Choose file…
            </button>
          }
        >
          <textarea className="input mono" rows={5} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='Paste a case exported from LoxDetective ({"format":"loxdetective-case", …})' aria-label="Case JSON" />
          <div className="btn-row">
            <button type="button" className="btn btn--primary btn--sm" onClick={() => doImport(importText)} disabled={!importText.trim()}>
              Import
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowImport(false)}>
              Cancel
            </button>
          </div>
        </Card>
      )}

      <div className="cases-layout">
        <aside className="cases-side">
          <Card title="Your cases">
            <form className="case-create" onSubmit={submitCreate}>
              <input data-testid="case-title-input" className="input" type="text" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="New case title" aria-label="New case title" />
              <button data-testid="case-create" type="submit" className="btn btn--primary">
                Create
              </button>
            </form>
            {cases.length === 0 ? (
              <p className="muted">No cases yet. Create one above.</p>
            ) : (
              <ul className="case-list">
                {cases.map((c) => (
                  <li key={c.id}>
                    <button type="button" className={`case-list__item${selected?.id === c.id ? ' is-active' : ''}`} onClick={() => setActive(c.id)}>
                      <span className="case-list__title">{c.title}</span>
                      <span className="case-list__meta muted">
                        {c.entities.length} entit{c.entities.length === 1 ? 'y' : 'ies'} · {c.notes.length} note{c.notes.length === 1 ? '' : 's'}
                        {c.attachments?.length ? ` · ${c.attachments.length} trace${c.attachments.length === 1 ? '' : 's'}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
        <div className="cases-main">
          {selected ? <CaseDetail key={selected.id} c={selected} /> : <EmptyState title="No case selected" hint="Create a case to start collecting addresses, transactions and notes." />}
        </div>
      </div>
    </div>
  );
}
