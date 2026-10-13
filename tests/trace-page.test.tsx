// @vitest-environment jsdom
/**
 * Trace ↔ cases integration: query-string prefill of the tracer form, the
 * "Save trace to case" button, the attachments list on the Cases page and
 * the shared download helpers. Network calls are mocked (empty history).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

vi.mock('@/lib/export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/export')>();
  return { ...actual, downloadCsv: vi.fn(), downloadJson: vi.fn() };
});

import type { CaseAttachment } from '@/lib/types';
import { downloadCsv, downloadJson } from '@/lib/export';
import { useSettings } from '@/lib/settings/store';
import { useCases } from '@/lib/cases/store';
import { graphToJson } from '@/lib/trace/flow';
import TracePage, { DEFAULT_TRACE_FORM, formFromSearch, traceQueryFor, traceTitle } from '@/pages/TracePage';
import CasesPage, { attachmentStats, attachmentTraceLink } from '@/pages/CasesPage';

const ADDRESS = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
const downloadCsvMock = vi.mocked(downloadCsv);
const downloadJsonMock = vi.mocked(downloadJson);

type RpcReq = { id: number; method: string; params?: unknown[] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function answerRpc(r: RpcReq): unknown {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: r.id, result });
  switch (r.method) {
    case 'eth_blockNumber':
      return ok('0x1234567');
    case 'eth_getBalance':
      return ok('0xde0b6b3a7640000');
    case 'eth_getCode':
      return ok('0x');
    case 'eth_getTransactionCount':
      return ok('0x5');
    default:
      return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: `Method not found: ${r.method}` } };
  }
}

/** Mock fetch: JSON-RPC, empty Blockscout collections, DefiLlama; 404 elsewhere. */
function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && init.body) {
        const req = JSON.parse(String(init.body)) as RpcReq | RpcReq[];
        return jsonResponse(Array.isArray(req) ? req.map(answerRpc) : answerRpc(req));
      }
      if (url.includes('/api/v2/')) return jsonResponse({ items: [], next_page_params: null });
      if (url.includes('coins.llama.fi')) return jsonResponse({ coins: { 'coingecko:ethereum': { price: 2500, symbol: 'ETH', decimals: 18, timestamp: 1_720_000_000, confidence: 0.99 } } });
      if (url.includes('raw.githubusercontent.com')) return jsonResponse([]);
      return jsonResponse({}, 404);
    }),
  );
}

interface Mounted {
  container: HTMLElement;
  unmount(): void;
}

function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="loc">{`${loc.pathname}${loc.search}`}</span>;
}

const live = new Set<Mounted>();

async function mount(el: ReactElement, path: string, routePattern: string): Promise<Mounted> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path={routePattern}
              element={
                <>
                  {el}
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  const mounted: Mounted = {
    container,
    unmount: () => {
      live.delete(mounted);
      act(() => root.unmount());
      container.remove();
      client.clear();
    },
  };
  live.add(mounted);
  return mounted;
}

async function waitFor(check: () => boolean, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
}

const byTestId = (c: HTMLElement, id: string): HTMLElement | null => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function click(el: HTMLElement | null): Promise<void> {
  if (!el) throw new Error('click: element not found');
  await act(async () => {
    el.click();
  });
}

const OPTIONS: CaseAttachment['options'] = { maxHops: 3, maxFanOut: 5, direction: 'out', stopAtLabelled: false, minUsd: 100, includeTokens: false };
const GRAPH_JSON = graphToJson({
  root: ADDRESS.toLowerCase(),
  chain: 'ethereum',
  nodes: [
    { id: ADDRESS.toLowerCase(), chain: 'ethereum', depth: 0 },
    { id: '0x1111111111111111111111111111111111111111', chain: 'ethereum', depth: 1 },
  ],
  edges: [{ id: 'e1', source: ADDRESS.toLowerCase(), target: '0x1111111111111111111111111111111111111111', chain: 'ethereum', transfers: [{ kind: 'native', from: ADDRESS.toLowerCase(), to: '0x1111111111111111111111111111111111111111', amount: { raw: 10n ** 18n, decimals: 18, symbol: 'ETH' } }], txHashes: ['0xabc'], totalUsd: 2500 }],
  truncated: [],
  stats: { hops: 1, txsScanned: 1, durationMs: 5 },
});

beforeEach(() => {
  installFetch();
  localStorage.clear();
  useSettings.getState().reset();
  useCases.setState({ cases: [], activeCaseId: undefined });
  downloadCsvMock.mockClear();
  downloadJsonMock.mockClear();
});

afterEach(() => {
  for (const m of Array.from(live)) m.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('trace query string', () => {
  it('round-trips the saved options through traceQueryFor / formFromSearch', () => {
    const q = traceQueryFor(OPTIONS);
    expect(q).toBe('hops=3&fanout=5&direction=out&stop=0&minUsd=100&tokens=0');
    expect(formFromSearch(`?${q}`)).toEqual(OPTIONS);
    expect(formFromSearch(new URLSearchParams(q))).toEqual(OPTIONS);
    expect(formFromSearch(traceQueryFor({ ...OPTIONS, minUsd: undefined }))).toEqual({ ...OPTIONS, minUsd: 0 });
  });

  it('falls back to the defaults for missing or invalid values and clamps numbers', () => {
    expect(formFromSearch('')).toEqual(DEFAULT_TRACE_FORM);
    expect(formFromSearch('?hops=99&fanout=0&direction=sideways&stop=maybe&minUsd=-5&tokens=')).toEqual({ ...DEFAULT_TRACE_FORM, maxHops: 4, maxFanOut: 1 });
    expect(formFromSearch('?hops=abc&minUsd=abc')).toEqual(DEFAULT_TRACE_FORM);
    expect(formFromSearch('?stop=true&tokens=false&direction=in')).toMatchObject({ stopAtLabelled: true, includeTokens: false, direction: 'in' });
    expect(formFromSearch('?stop=off&tokens=yes')).toMatchObject({ stopAtLabelled: false, includeTokens: true });
  });

  it('keeps the base minUsd when the parameter is missing, blank or invalid, and accepts an explicit 0', () => {
    const base = { ...DEFAULT_TRACE_FORM, minUsd: 100 };
    expect(formFromSearch('', base).minUsd).toBe(100);
    expect(formFromSearch('minUsd=', base).minUsd).toBe(100);
    expect(formFromSearch('minUsd=%20', base).minUsd).toBe(100);
    expect(formFromSearch('minUsd=0', base).minUsd).toBe(0);
    expect(formFromSearch('minUsd=abc', base).minUsd).toBe(100);
    expect(formFromSearch('minUsd=-5', base).minUsd).toBe(100);
    expect(formFromSearch('minUsd=250', base).minUsd).toBe(250);
    expect(formFromSearch('hops=2', base)).toEqual({ ...base, maxHops: 2 });
  });

  it('names a saved trace after the chain, root and options', () => {
    expect(traceTitle('Ethereum', ADDRESS, OPTIONS)).toBe('Ethereum trace of 0x742d…f44e · 3 hops, outgoing');
    expect(traceTitle('Base', ADDRESS, { ...OPTIONS, maxHops: 1, direction: 'both' })).toBe('Base trace of 0x742d…f44e · 1 hop, both ways');
    expect(traceTitle('Bitcoin', 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97', { ...OPTIONS, direction: 'in' })).toContain('incoming');
  });
});

describe('attachment helpers', () => {
  it('counts nodes and edges of a flow export lazily and never throws', () => {
    expect(attachmentStats(GRAPH_JSON)).toEqual({ nodes: 2, edges: 1, hops: 1 });
    expect(attachmentStats(JSON.stringify({ nodes: [], edges: [] }))).toEqual({ nodes: 0, edges: 0 });
    expect(attachmentStats('not json')).toMatchObject({ nodes: 0, edges: 0, error: 'Unreadable attachment data' });
    expect(attachmentStats(JSON.stringify({ graph: 'nope' }))).toMatchObject({ error: 'Not a trace export' });
    expect(attachmentStats(JSON.stringify({ graph: { nodes: 3 } }))).toMatchObject({ error: 'Not a trace export' });
    expect(attachmentStats('null')).toMatchObject({ error: 'Not a trace export' });
  });

  it('builds the tracer route with the saved options as query parameters', () => {
    expect(attachmentTraceLink({ chain: 'ethereum', root: ADDRESS, options: OPTIONS })).toBe(`/trace/ethereum/${ADDRESS}?hops=3&fanout=5&direction=out&stop=0&minUsd=100&tokens=0`);
  });
});

// ---------------------------------------------------------------------------
// TracePage
// ---------------------------------------------------------------------------

describe('TracePage with query parameters', () => {
  it('prefills the form from the query string', async () => {
    const m = await mount(<TracePage />, `/trace/ethereum/${ADDRESS}?${traceQueryFor(OPTIONS)}`, '/trace/:chain/:address');
    const c = m.container;
    expect((byTestId(c, 'trace-max-hops') as HTMLInputElement).value).toBe('3');
    expect((byTestId(c, 'trace-max-fanout') as HTMLInputElement).value).toBe('5');
    expect(c.querySelector<HTMLSelectElement>('select.input')?.value).toBe('out');
    const checkboxes = Array.from(c.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(checkboxes.map((cb) => cb.checked)).toEqual([false, false]);
    expect(c.querySelector<HTMLInputElement>('input[type="number"][step="10"]')?.value).toBe('100');
    // The save button exists but is disabled until a graph exists.
    expect((byTestId(c, 'trace-save-case') as HTMLButtonElement).disabled).toBe(true);
    m.unmount();
  });

  it('keeps the defaults without query parameters', async () => {
    const m = await mount(<TracePage />, `/trace/ethereum/${ADDRESS}`, '/trace/:chain/:address');
    expect((byTestId(m.container, 'trace-max-hops') as HTMLInputElement).value).toBe(String(DEFAULT_TRACE_FORM.maxHops));
    expect((byTestId(m.container, 'trace-max-fanout') as HTMLInputElement).value).toBe(String(DEFAULT_TRACE_FORM.maxFanOut));
    m.unmount();
  });

  it('mirrors the options into the hash URL when a trace runs and keeps the graph mounted', async () => {
    window.history.replaceState(null, '', '/');
    expect(window.location.hash).toBe('');
    const m = await mount(<TracePage />, `/trace/ethereum/${ADDRESS}`, '/trace/:chain/:address');
    const c = m.container;
    const hops = byTestId(c, 'trace-max-hops') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(hops, '3');
      hops.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const direction = c.querySelector<HTMLSelectElement>('select.input') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(direction, 'out');
      direction.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(byTestId(c, 'trace-run'));
    await waitFor(() => c.textContent?.includes('Done:') ?? false);

    const expected = { ...DEFAULT_TRACE_FORM, maxHops: 3, direction: 'out' as const };
    expect(window.location.hash).toBe(`#/trace/ethereum/${ADDRESS}?${traceQueryFor(expected)}`);
    expect(window.location.hash).toContain('hops=3&');
    expect(window.location.hash).toContain('&direction=out&');
    // The router location is untouched (no navigation), so the Tracer and its graph survive.
    expect(byTestId(c, 'loc')?.textContent).toBe(`/trace/ethereum/${ADDRESS}`);
    expect((byTestId(c, 'trace-save-case') as HTMLButtonElement).disabled).toBe(false);
    expect(c.querySelector('[data-testid="trace-page"]')).not.toBeNull();
    expect(c.querySelector('svg')).not.toBeNull();

    // A second run with other options rewrites the query part only.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(direction, 'in');
      direction.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(byTestId(c, 'trace-run'));
    await waitFor(() => c.textContent?.includes('Done:') ?? false);
    expect(window.location.hash).toBe(`#/trace/ethereum/${ADDRESS}?${traceQueryFor({ ...expected, direction: 'in' })}`);
    m.unmount();
    window.history.replaceState(null, '', '/');
  });

  it('saves a finished trace into a new case and exports through the shared helpers', async () => {
    const m = await mount(<TracePage />, `/trace/ethereum/${ADDRESS}?hops=1&direction=out`, '/trace/:chain/:address');
    const c = m.container;
    await click(byTestId(c, 'trace-run'));
    await waitFor(() => c.textContent?.includes('Done:') ?? false);
    expect((byTestId(c, 'trace-save-case') as HTMLButtonElement).disabled).toBe(false);

    await click(byTestId(c, 'trace-save-case'));
    const cases = useCases.getState().cases;
    expect(cases).toHaveLength(1);
    expect(cases[0].title).toBe('New case');
    expect(useCases.getState().activeCaseId).toBe(cases[0].id);
    const att = cases[0].attachments?.[0];
    expect(att).toMatchObject({ kind: 'trace', chain: 'ethereum', root: ADDRESS, title: 'Ethereum trace of 0x742d…f44e · 1 hop, outgoing' });
    expect(att?.options).toEqual({ maxHops: 1, maxFanOut: 8, direction: 'out', stopAtLabelled: true, minUsd: 0, includeTokens: true });
    expect(attachmentStats(att?.data ?? '')).toMatchObject({ nodes: 1, edges: 0 });
    expect(JSON.parse(att?.data ?? '{}').format).toBe('loxdetective-flow');

    // A second save goes into the same (now active) case.
    await click(byTestId(c, 'trace-save-case'));
    expect(useCases.getState().cases).toHaveLength(1);
    expect(useCases.getState().cases[0].attachments).toHaveLength(2);

    // Exports use src/lib/export.
    const buttons = Array.from(c.querySelectorAll<HTMLButtonElement>('button'));
    await click(buttons.find((b) => b.textContent === 'Export CSV') ?? null);
    expect(downloadCsvMock).toHaveBeenCalledTimes(1);
    expect(downloadCsvMock.mock.calls[0][0]).toBe('loxdetective-trace-ethereum-0x742d-f44e');
    expect(downloadCsvMock.mock.calls[0][1]).toContain('source,source_label');
    await click(buttons.find((b) => b.textContent === 'Export JSON') ?? null);
    expect(downloadJsonMock).toHaveBeenCalledTimes(1);
    expect(downloadJsonMock.mock.calls[0][0]).toBe('loxdetective-trace-ethereum-0x742d-f44e');
    expect(String(downloadJsonMock.mock.calls[0][1])).toContain('"loxdetective-flow"');
    m.unmount();
  });

  it('offers a case picker when several cases exist and saves into the chosen one', async () => {
    const a = useCases.getState().createCase('Alpha');
    const b = useCases.getState().createCase('Beta');
    useCases.getState().setActive(a.id);
    const m = await mount(<TracePage />, `/trace/ethereum/${ADDRESS}`, '/trace/:chain/:address');
    const c = m.container;
    await click(byTestId(c, 'trace-run'));
    await waitFor(() => c.textContent?.includes('Done:') ?? false);
    const select = c.querySelector<HTMLSelectElement>('select[aria-label="Target case for the saved trace"]');
    expect(select).not.toBeNull();
    expect(select?.value).toBe(a.id);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, b.id);
      select?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(byTestId(c, 'trace-save-case'));
    expect(useCases.getState().cases.find((x) => x.id === a.id)?.attachments).toBeUndefined();
    expect(useCases.getState().cases.find((x) => x.id === b.id)?.attachments).toHaveLength(1);
    m.unmount();
  });
});

// ---------------------------------------------------------------------------
// CasesPage attachments
// ---------------------------------------------------------------------------

describe('CasesPage attachments', () => {
  it('lists saved traces with counts, an Open trace link and JSON download, and removes them', async () => {
    const c = useCases.getState().createCase('With trace');
    useCases.getState().setActive(c.id);
    const att = useCases.getState().addAttachment(c.id, { kind: 'trace', title: 'My trace', chain: 'ethereum', root: ADDRESS, options: OPTIONS, data: GRAPH_JSON })!;
    const m = await mount(<CasesPage />, '/cases', '/cases');
    const el = m.container;
    expect(el.textContent).toContain('1 saved trace');
    expect(el.textContent).toContain('1 trace');
    const row = byTestId(el, 'case-attachment') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('My trace');
    expect(byTestId(row, 'case-attachment-stats')?.textContent).toContain('2 addresses · 1 edge');
    expect(byTestId(row, 'case-attachment-stats')?.textContent).toContain('3 hops · fan-out 5 · outgoing · min $100 · native only');
    expect(byTestId(row, 'case-attachment-open')?.getAttribute('href')).toBe(attachmentTraceLink(att));
    expect(row.querySelector(`a[href="/address/ethereum/${ADDRESS}"]`)).not.toBeNull();

    const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>('button'));
    await click(buttons.find((b) => b.textContent === 'Download JSON') ?? null);
    expect(downloadJsonMock).toHaveBeenCalledWith('loxdetective-trace-ethereum-0x742d-f44e', GRAPH_JSON);

    await click(buttons.find((b) => b.textContent === 'Remove') ?? null);
    expect(useCases.getState().cases[0]).not.toHaveProperty('attachments');
    expect(byTestId(el, 'case-attachment')).toBeNull();
    expect(el.textContent).toContain('No saved traces');
    m.unmount();
  });

  it('exports the case (with attachments) through downloadJson', async () => {
    const c = useCases.getState().createCase('Exported case');
    useCases.getState().addAttachment(c.id, { kind: 'trace', title: 'T', chain: 'ethereum', root: ADDRESS, options: OPTIONS, data: GRAPH_JSON });
    const m = await mount(<CasesPage />, '/cases', '/cases');
    const buttons = Array.from(m.container.querySelectorAll<HTMLButtonElement>('button'));
    await click(buttons.find((b) => b.textContent === 'Export JSON') ?? null);
    expect(downloadJsonMock).toHaveBeenCalledTimes(1);
    expect(downloadJsonMock.mock.calls[0][0]).toBe('loxdetective-exported-case');
    const file = JSON.parse(String(downloadJsonMock.mock.calls[0][1]));
    expect(file.format).toBe('loxdetective-case');
    expect(file.case.attachments).toHaveLength(1);
    m.unmount();
  });
});
