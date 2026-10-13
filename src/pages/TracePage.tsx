/**
 * Fund-flow tracer (SPEC §6): options form, run / cancel with an
 * AbortController, live progress from `traceFunds`, the D3 `FlowGraph`,
 * a side panel for the selected node, summary lists, CSV / JSON export and
 * "Save trace to case" (a `CaseAttachment` holding the serialised graph).
 * Nothing runs on mount; the last graph stays in component state. The form
 * is prefilled from the query string (`?hops=&fanout=&direction=&stop=&minUsd=&tokens=`),
 * which is how a saved trace is reopened from the Cases page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import type { CaseAttachment, ChainInfo, FlowGraph as FlowGraphData, FlowNode, TraceOptions, Transfer } from '@/lib/types';
import { findChain } from '@/lib/chains/registry';
import { isEvmAddress } from '@/lib/detect';
import { downloadCsv, downloadJson, safeFilename } from '@/lib/export';
import { formatAmount, formatUsd, shorten } from '@/lib/format';
import { useCases } from '@/lib/cases/store';
import { lookupLabel } from '@/lib/intel/labels';
import { isSanctioned } from '@/lib/intel/sanctions';
import { createDefaultFlowProvider, displayAddress, graphToCsv, graphToJson, riskFromLabel, summarizeGraph, traceFunds } from '@/lib/trace/flow';
import { canonicalAddress } from '@/hooks/dispatch';
import { useLabel, useLabelsRevision } from '@/hooks/useLabel';
import { usePageTitle } from '@/hooks/usePageTitle';
import AddToCaseButton from '@/components/AddToCaseButton';
import AddressDisplay from '@/components/AddressDisplay';
import Card from '@/components/Card';
import ChainBadge from '@/components/ChainBadge';
import CopyButton from '@/components/CopyButton';
import EmptyState from '@/components/EmptyState';
import ErrorBox from '@/components/ErrorBox';
import FlowGraph from '@/components/FlowGraph';
import LabelChip from '@/components/LabelChip';
import RiskBadge from '@/components/RiskBadge';
import Spinner from '@/components/Spinner';
import { useToast } from '@/components/Toast';
import '@/styles/pages.css';

export interface TraceForm {
  maxHops: number;
  maxFanOut: number;
  direction: TraceOptions['direction'];
  stopAtLabelled: boolean;
  minUsd: number;
  includeTokens: boolean;
}

export const DEFAULT_TRACE_FORM: TraceForm = { maxHops: 2, maxFanOut: 8, direction: 'both', stopAtLabelled: true, minUsd: 0, includeTokens: true };
const HOPS_RANGE: [number, number] = [1, 4];
const FANOUT_RANGE: [number, number] = [1, 50];
const MAX_PANEL_EDGES = 8;

/** Parse a numeric input, clamped to a range; `fallback` when not a number. */
export function clampInt(value: string, lo: number, hi: number, fallback: number): number {
  if (value.trim() === '') return fallback;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /cancelled|aborted/i.test(err.message));
}

/** Trace options as they are stored in a case attachment (no signal / callback). */
export type SavedTraceOptions = CaseAttachment['options'];

/**
 * Query string (without `?`) that reopens the tracer with these options:
 * `hops`, `fanout`, `direction`, `stop` (1/0), `minUsd`, `tokens` (1/0).
 */
export function traceQueryFor(o: SavedTraceOptions): string {
  const q = new URLSearchParams();
  q.set('hops', String(o.maxHops));
  q.set('fanout', String(o.maxFanOut));
  q.set('direction', o.direction);
  q.set('stop', o.stopAtLabelled ? '1' : '0');
  q.set('minUsd', String(o.minUsd ?? 0));
  q.set('tokens', o.includeTokens ? '1' : '0');
  return q.toString();
}

function flag(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/**
 * Form state from a query string (`?hops=3&fanout=5&direction=out&stop=0&minUsd=100&tokens=1`).
 * Missing or invalid values fall back to `DEFAULT_TRACE_FORM`; numbers are clamped to their ranges.
 */
export function formFromSearch(search: string | URLSearchParams, base: TraceForm = DEFAULT_TRACE_FORM): TraceForm {
  const q = typeof search === 'string' ? new URLSearchParams(search) : search;
  const direction = q.get('direction');
  // A missing or blank minUsd keeps the base value (Number('') would be 0).
  const rawMinUsd = q.get('minUsd');
  const minUsd = rawMinUsd === null || rawMinUsd.trim() === '' ? base.minUsd : Number(rawMinUsd);
  return {
    maxHops: clampInt(q.get('hops') ?? '', HOPS_RANGE[0], HOPS_RANGE[1], base.maxHops),
    maxFanOut: clampInt(q.get('fanout') ?? '', FANOUT_RANGE[0], FANOUT_RANGE[1], base.maxFanOut),
    direction: direction === 'in' || direction === 'out' || direction === 'both' ? direction : base.direction,
    stopAtLabelled: flag(q.get('stop'), base.stopAtLabelled),
    minUsd: Number.isFinite(minUsd) && minUsd >= 0 ? minUsd : base.minUsd,
    includeTokens: flag(q.get('tokens'), base.includeTokens),
  };
}

/** Default attachment title for a saved trace. */
export function traceTitle(chainName: string, address: string, o: SavedTraceOptions): string {
  const dir = o.direction === 'both' ? 'both ways' : o.direction === 'in' ? 'incoming' : 'outgoing';
  return `${chainName} trace of ${shorten(address, 6, 4)} · ${o.maxHops} hop${o.maxHops === 1 ? '' : 's'}, ${dir}`;
}

/** "3 ETH · 50 USDC" — per-asset sums of a set of transfers (first four assets). */
export function describeTransfers(transfers: readonly Transfer[]): string {
  const sums = new Map<string, { raw: bigint; decimals: number; symbol: string }>();
  for (const t of transfers) {
    const key = `${t.token?.address?.toLowerCase() ?? 'native'}:${t.amount.symbol}`;
    const cur = sums.get(key) ?? { raw: 0n, decimals: t.amount.decimals, symbol: t.amount.symbol };
    cur.raw += t.amount.raw;
    sums.set(key, cur);
  }
  return Array.from(sums.values())
    .slice(0, 4)
    .map((s) => `${formatAmount(s.raw, s.decimals, 4)} ${s.symbol}`)
    .join(' · ');
}

function nodeTitle(graph: FlowGraphData, id: string): string {
  const node = graph.nodes.find((n) => n.id === id);
  return node?.label?.name ?? shorten(displayAddress(graph.chain, id), 8, 6);
}

export default function TracePage() {
  const { chain = '', address = '' } = useParams();
  const { search } = useLocation();
  const info = findChain(chain);
  const display = canonicalAddress(info, address);
  usePageTitle(info ? `Trace ${shorten(display, 8, 6)} · ${info.name}` : 'Trace funds');
  const error = !info ? `Unknown chain "${chain}".` : !display ? 'No address given.' : info.family === 'evm' && !isEvmAddress(display) ? `"${address}" is not a valid EVM address.` : undefined;
  return (
    <div className="trace-page" data-testid="trace-page">
      {error || !info ? (
        <ErrorBox title="Cannot trace this address" message={error ?? 'Unknown chain'} hint={<Link to="/">Back to search</Link>} />
      ) : (
        // Keyed so that navigating to another root or to a saved trace's options resets the form and the graph.
        <Tracer key={`${info.id}:${display}:${search}`} info={info} address={display} />
      )}
    </div>
  );
}

function Tracer({ info, address }: { info: ChainInfo; address: string }) {
  const chain = info.id;
  const toast = useToast();
  const rootLabel = useLabel(address, chain);
  const [searchParams] = useSearchParams();
  // The query string (from a saved trace or a shared link) seeds the form once; later edits are local.
  const [form, setForm] = useState<TraceForm>(() => formFromSearch(searchParams));
  // Numeric fields are kept as raw strings while editing and clamped on blur / run,
  // so clearing the field and retyping does not snap to the minimum mid-keystroke.
  const [draft, setDraft] = useState(() => ({ maxHops: String(form.maxHops), maxFanOut: String(form.maxFanOut) }));
  const [graph, setGraph] = useState<FlowGraphData>();
  /** The options the current graph was produced with (what gets saved with it). */
  const [ranWith, setRanWith] = useState<SavedTraceOptions>();
  const [progress, setProgress] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<Error>();
  const [selected, setSelected] = useState<string>();
  const ctrl = useRef<AbortController>();

  // Cancel an in-flight trace when the page unmounts.
  useEffect(() => () => ctrl.current?.abort(), []);

  const run = useCallback(async () => {
    ctrl.current?.abort();
    const controller = new AbortController();
    ctrl.current = controller;
    setRunning(true);
    setError(undefined);
    setSelected(undefined);
    setProgress('Starting trace…');
    const provider = createDefaultFlowProvider();
    const options: SavedTraceOptions = {
      ...form,
      maxHops: clampInt(draft.maxHops, HOPS_RANGE[0], HOPS_RANGE[1], DEFAULT_TRACE_FORM.maxHops),
      maxFanOut: clampInt(draft.maxFanOut, FANOUT_RANGE[0], FANOUT_RANGE[1], DEFAULT_TRACE_FORM.maxFanOut),
    };
    setRanWith(options);
    // Mirror the options into the URL so the address bar can be copied as a shareable link.
    // replaceState does not fire popstate, so HashRouter's location (and the Tracer key) is untouched and the graph survives.
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      const [path] = url.hash.split('?');
      url.hash = `${path || `#/trace/${chain}/${address}`}?${traceQueryFor(options)}`;
      window.history.replaceState(window.history.state, '', url);
    }
    try {
      const result = await traceFunds(
        chain,
        address,
        {
          ...options,
          signal: controller.signal,
          onProgress: (msg, snapshot) => {
            if (controller.signal.aborted) return;
            setProgress(msg);
            setGraph(snapshot);
          },
        },
        provider,
      );
      if (controller.signal.aborted) return;
      setGraph(result);
      setProgress(
        `Done: ${result.nodes.length} address${result.nodes.length === 1 ? '' : 'es'}, ${result.edges.length} edge${result.edges.length === 1 ? '' : 's'}, ${result.stats.txsScanned.toLocaleString('en-US')} transfers scanned in ${(result.stats.durationMs / 1000).toFixed(1)}s.`,
      );
    } catch (err) {
      if (controller.signal.aborted || isAbort(err)) {
        setProgress('Trace cancelled.');
        return;
      }
      setError(err instanceof Error ? err : new Error(String(err)));
      setProgress('');
    } finally {
      if (ctrl.current === controller) setRunning(false);
    }
  }, [chain, address, form, draft]);

  const cancel = () => {
    ctrl.current?.abort();
    setRunning(false);
    setProgress('Trace cancelled.');
  };

  const exportAs = (kind: 'csv' | 'json') => {
    if (!graph) return;
    const base = safeFilename(`loxdetective-trace-${chain}-${shorten(address, 6, 4).replace('…', '-')}`);
    if (kind === 'csv') downloadCsv(base, graphToCsv(graph));
    else downloadJson(base, graphToJson(graph));
    toast.push(`Exported ${kind.toUpperCase()}`, 'success');
  };

  const summary = useMemo(() => (graph ? summarizeGraph(graph) : undefined), [graph]);
  const selectedNode = graph && selected ? graph.nodes.find((n) => n.id === selected) : undefined;
  const update = <K extends keyof TraceForm>(key: K, value: TraceForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const commitInt = (key: 'maxHops' | 'maxFanOut') => {
    const [lo, hi] = key === 'maxHops' ? HOPS_RANGE : FANOUT_RANGE;
    const v = clampInt(draft[key], lo, hi, DEFAULT_TRACE_FORM[key]);
    update(key, v);
    setDraft((d) => ({ ...d, [key]: String(v) }));
  };

  return (
    <>
      <header className="page-header">
        <div className="page-header__top">
          <ChainBadge chain={info} showName size="lg" />
          <span className="chip chip--other">Fund-flow tracer</span>
        </div>
        <div className="page-header__title">
          <h1 title={address}>{address}</h1>
          <CopyButton value={address} label="Copy address" />
        </div>
        {rootLabel && (
          <div className="page-header__chips">
            <LabelChip label={rootLabel} />
          </div>
        )}
        <div className="page-header__actions">
          <Link className="btn btn--sm" to={`/address/${chain}/${address}`}>
            Open address
          </Link>
          <AddToCaseButton chain={chain} kind="address" value={address} size="sm" />
          <a className="btn btn--sm btn--ghost" href={info.explorer.address(address)} target="_blank" rel="noreferrer noopener">
            {info.explorer.name} ↗
          </a>
        </div>
      </header>

      <Card title="Trace options" subtitle="Breadth-first expansion of the counterparties of the root address, hop by hop">
        <div className="trace-form">
          <label className="field">
            <span className="field__label">Max hops</span>
            <input className="input" type="number" min={HOPS_RANGE[0]} max={HOPS_RANGE[1]} value={draft.maxHops} disabled={running} data-testid="trace-max-hops" onChange={(e) => setDraft((d) => ({ ...d, maxHops: e.target.value }))} onBlur={() => commitInt('maxHops')} />
            <span className="field__hint">1–4 hops from the root</span>
          </label>
          <label className="field">
            <span className="field__label">Fan-out per node</span>
            <input className="input" type="number" min={FANOUT_RANGE[0]} max={FANOUT_RANGE[1]} value={draft.maxFanOut} disabled={running} data-testid="trace-max-fanout" onChange={(e) => setDraft((d) => ({ ...d, maxFanOut: e.target.value }))} onBlur={() => commitInt('maxFanOut')} />
            <span className="field__hint">top counterparties expanded</span>
          </label>
          <label className="field">
            <span className="field__label">Direction</span>
            <select className="input" value={form.direction} disabled={running} onChange={(e) => update('direction', e.target.value as TraceForm['direction'])}>
              <option value="both">Both</option>
              <option value="out">Outgoing only</option>
              <option value="in">Incoming only</option>
            </select>
            <span className="field__hint">which flows to follow</span>
          </label>
          <label className="field">
            <span className="field__label">Min USD per transfer</span>
            <input className="input" type="number" min={0} step={10} value={form.minUsd} disabled={running} onChange={(e) => update('minUsd', Math.max(0, Number(e.target.value) || 0))} />
            <span className="field__hint">applied when a price is known</span>
          </label>
          <label className="field field--row">
            <input type="checkbox" checked={form.stopAtLabelled} disabled={running} onChange={(e) => update('stopAtLabelled', e.target.checked)} />
            <span>
              Stop at labelled entities
              <span className="field__hint">exchanges, bridges, DEXes… are leaves</span>
            </span>
          </label>
          <label className="field field--row">
            <input type="checkbox" checked={form.includeTokens} disabled={running} onChange={(e) => update('includeTokens', e.target.checked)} />
            <span>
              Include token transfers
              <span className="field__hint">ERC-20 / SPL alongside native value</span>
            </span>
          </label>
          <div className="trace-form__actions">
            <button type="button" className="btn btn--primary" data-testid="trace-run" onClick={() => void run()} disabled={running}>
              {running ? 'Tracing…' : graph ? 'Run again' : 'Run trace'}
            </button>
            <button type="button" className="btn" onClick={cancel} disabled={!running}>
              Cancel
            </button>
            <span className="spacer" />
            <button type="button" className="btn btn--sm" onClick={() => exportAs('csv')} disabled={!graph}>
              Export CSV
            </button>
            <button type="button" className="btn btn--sm" onClick={() => exportAs('json')} disabled={!graph}>
              Export JSON
            </button>
            <SaveTraceButton graph={running ? undefined : graph} chain={info} address={address} options={ranWith ?? form} />
          </div>
        </div>
        <div className="trace-progress" aria-live="polite">
          {running && <Spinner size="sm" />}
          <span>{progress || 'Not started — adjust the options and press Run trace.'}</span>
        </div>
        {error && <ErrorBox error={error} onRetry={() => void run()} title="Trace failed" />}
      </Card>

      <div className="trace-layout">
        {graph ? (
          <FlowGraph graph={graph} onSelect={setSelected} selected={selected} />
        ) : (
          <div className="trace-empty">
            <EmptyState title="No trace yet" hint="The graph appears here while the trace runs. Click a node to inspect it; drag to rearrange, scroll to zoom." />
          </div>
        )}
        <aside>
          {graph && selectedNode ? (
            <NodePanel graph={graph} node={selectedNode} chain={info} onSelect={setSelected} />
          ) : (
            <Card title="Selected address">
              <p className="muted small">{graph ? 'Click a node in the graph or an entry in the lists below to see its details.' : 'Run a trace, then click a node to see its label, risk and flows.'}</p>
              {graph && <TraceStats graph={graph} />}
            </Card>
          )}
        </aside>
      </div>

      {graph && summary && (
        <div className="summary-grid">
          <NodeList title="Top sinks" hint="received the most" nodes={summary.topSinks} graph={graph} selected={selected} onSelect={setSelected} usd={(n) => n.totalInUsd} />
          <NodeList title="Top sources" hint="sent the most" nodes={summary.topSources} graph={graph} selected={selected} onSelect={setSelected} usd={(n) => n.totalOutUsd} />
          <NodeList
            title="Labelled endpoints"
            hint="known entities reached"
            nodes={summary.labelledEndpoints}
            graph={graph}
            selected={selected}
            onSelect={setSelected}
            usd={(n) => (n.totalInUsd ?? 0) + (n.totalOutUsd ?? 0) || undefined}
          />
        </div>
      )}
    </>
  );
}

/**
 * Saves the finished graph into a case as a `trace` attachment. Targets the
 * active case (or the one picked inline when several exist) and creates a
 * case when none exists yet, mirroring `AddToCaseButton`.
 */
function SaveTraceButton({ graph, chain, address, options }: { graph?: FlowGraphData; chain: ChainInfo; address: string; options: SavedTraceOptions }) {
  const cases = useCases((s) => s.cases);
  const activeCaseId = useCases((s) => s.activeCaseId);
  const createCase = useCases((s) => s.createCase);
  const setActive = useCases((s) => s.setActive);
  const addAttachment = useCases((s) => s.addAttachment);
  const toast = useToast();
  const [targetId, setTargetId] = useState<string | undefined>(activeCaseId ?? cases[0]?.id);
  useEffect(() => {
    if (!targetId || !cases.some((c) => c.id === targetId)) setTargetId(activeCaseId ?? cases[0]?.id);
  }, [cases, activeCaseId, targetId]);

  const save = () => {
    if (!graph) return;
    const attachment = { kind: 'trace' as const, title: traceTitle(chain.name, address, options), chain: chain.id, root: address, options, data: graphToJson(graph) };
    try {
      let target = cases.find((c) => c.id === targetId);
      if (!target) {
        target = createCase('New case');
        setActive(target.id);
        setTargetId(target.id);
      }
      const saved = addAttachment(target.id, attachment);
      toast.push(saved ? `Trace saved to "${target.title}"` : 'Case not found', saved ? 'success' : 'error');
    } catch (err) {
      toast.push(err instanceof Error ? err.message : 'Could not save the trace', 'error');
    }
  };

  return (
    <span className="add-to-case">
      {cases.length > 1 && (
        <select className="input input--select input--sm" value={targetId ?? ''} onChange={(e) => setTargetId(e.target.value)} aria-label="Target case for the saved trace" disabled={!graph}>
          {cases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      )}
      <button type="button" className="btn btn--sm" data-testid="trace-save-case" onClick={save} disabled={!graph} title="Store this graph in a case; reopen or download it from the Cases page">
        Save trace to case
      </button>
    </span>
  );
}

function TraceStats({ graph }: { graph: FlowGraphData }) {
  const s = graph.stats;
  return (
    <div className="trace-stats">
      <span>{graph.nodes.length} addresses</span>
      <span>{graph.edges.length} edges</span>
      <span>{s.hops} hops</span>
      <span>{s.txsScanned.toLocaleString('en-US')} transfers scanned</span>
      <span>{graph.truncated.length} not expanded</span>
      <span>{(s.durationMs / 1000).toFixed(1)}s</span>
    </div>
  );
}

function NodePanel({ graph, node, chain, onSelect }: { graph: FlowGraphData; node: FlowNode; chain: ChainInfo; onSelect(id: string): void }) {
  const rev = useLabelsRevision();
  const address = displayAddress(chain.id, node.id);
  const label = useMemo(
    () => node.label ?? lookupLabel(address, chain.id) ?? isSanctioned(address),
    // `rev` re-runs the lookup when labels change (feed load, case tags).
    [node.label, address, chain.id, rev],
  );
  const risk = node.risk ?? riskFromLabel(label);
  const edges = useMemo(
    () =>
      graph.edges
        .filter((e) => e.source === node.id || e.target === node.id)
        .sort((a, b) => (b.totalUsd ?? 0) - (a.totalUsd ?? 0) || b.transfers.length - a.transfers.length)
        .slice(0, MAX_PANEL_EDGES),
    [graph, node.id],
  );
  const isRoot = node.id === graph.root;
  const truncated = graph.truncated.includes(node.id);

  return (
    <Card title={isRoot ? 'Traced address' : `Address at hop ${node.depth}`} subtitle={truncated ? 'Not expanded (hop / fan-out limit or load failure)' : undefined}>
      <div className="node-panel">
        <div className="node-panel__addr">
          <AddressDisplay address={address} chain={chain.id} short={false} showLabel={false} copy />
        </div>
        <div className="node-panel__chips">
          {label && <LabelChip label={label} />}
          {risk ? <RiskBadge level={risk} size="sm" testId={null} /> : <span className="chip chip--other">No label-based risk</span>}
          {node.isContract !== undefined && <span className="chip chip--infrastructure">{node.isContract ? 'Contract' : 'EOA'}</span>}
        </div>
        <dl className="kv kv--compact">
          <dt>Received</dt>
          <dd className="num">{formatUsd(node.totalInUsd)}</dd>
          <dt>Sent</dt>
          <dd className="num">{formatUsd(node.totalOutUsd)}</dd>
          <dt>Hop</dt>
          <dd className="num">{node.depth}</dd>
        </dl>
        {edges.length > 0 && (
          <>
            <h3 className="small muted">Largest flows</h3>
            <ul className="node-list">
              {edges.map((e) => {
                const outgoing = e.source === node.id;
                const other = outgoing ? e.target : e.source;
                return (
                  <li key={e.id}>
                    <button type="button" className="node-list__item" onClick={() => onSelect(other)} title={describeTransfers(e.transfers)}>
                      <span className="node-list__hop">{outgoing ? '→' : '←'}</span>
                      <span className="node-list__addr">{nodeTitle(graph, other)}</span>
                      <span className="node-list__meta">{e.totalUsd !== undefined ? formatUsd(e.totalUsd) : `${e.transfers.length} transfer${e.transfers.length === 1 ? '' : 's'}`}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <div className="btn-row">
          <Link className="btn btn--sm" to={`/address/${chain.id}/${address}`}>
            Open address
          </Link>
          <AddToCaseButton chain={chain.id} kind="address" value={address} size="sm" />
          {!isRoot && (
            <Link className="btn btn--sm btn--ghost" to={`/trace/${chain.id}/${address}`}>
              Trace from here
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}

interface NodeListProps {
  title: string;
  hint: string;
  nodes: FlowNode[];
  graph: FlowGraphData;
  selected?: string;
  onSelect(id: string): void;
  usd(node: FlowNode): number | undefined;
}

function NodeList({ title, hint, nodes, graph, selected, onSelect, usd }: NodeListProps) {
  return (
    <Card title={title} subtitle={hint}>
      {nodes.length === 0 ? (
        <p className="muted small">Nothing to show yet.</p>
      ) : (
        <ul className="node-list">
          {nodes.map((n) => (
            <li key={n.id}>
              <button type="button" className={`node-list__item${selected === n.id ? ' is-selected' : ''}`} onClick={() => onSelect(n.id)} title={displayAddress(graph.chain, n.id)}>
                <span className="node-list__hop">h{n.depth}</span>
                <span className="node-list__addr">{n.label ? n.label.name : shorten(displayAddress(graph.chain, n.id), 8, 6)}</span>
                {n.label && <span className={`chip chip--${n.label.category}`}>{n.label.category}</span>}
                <span className="node-list__meta">{formatUsd(usd(n))}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
