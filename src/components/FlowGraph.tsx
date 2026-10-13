/**
 * Force-directed SVG renderer for a `FlowGraph` (SPEC §5).
 *
 * D3 owns the SVG children (nodes, links) and the simulation; React owns the
 * frame (toolbar, tooltip, legend). The simulation is rebuilt only when the
 * `graph` object identity changes; node positions are carried over between
 * builds so progressive snapshots from `traceFunds` do not jump around.
 * SSR-safe: nothing touches `window` / `document` at import time.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { formatAmount, formatUsd, shorten } from '@/lib/format';
import { displayAddress } from '@/lib/trace/flow';
import type { FlowEdge, FlowGraph as FlowGraphData, FlowNode, Transfer } from '@/lib/types';
import '@/styles/flowgraph.css';

export interface FlowGraphProps {
  graph: FlowGraphData;
  onSelect?: (nodeId: string) => void;
  selected?: string;
  height?: number;
}

/** Node fill by label category / risk; `root` uses the theme accent. */
export const FLOW_COLORS: Record<string, string> = {
  root: 'var(--accent)',
  sanctioned: '#ff2d55',
  scam: '#ff2d55',
  mixer: '#ff8c42',
  exchange: '#58a6ff',
  bridge: '#b48cff',
  dex: '#2dd4bf',
  lending: '#7dd3fc',
  token: '#c7a6ff',
  nft: '#f472b6',
  burn: '#6b7588',
  infrastructure: '#8b9cff',
  wallet: '#3ddc97',
  other: '#98a2b3',
  'risk-critical': '#ff2d55',
  'risk-high': '#ff5c5c',
  'risk-medium': '#f5b942',
  contract: '#9aa4b2',
  default: '#7f93b8',
};

const LEGEND_LABELS: Record<string, string> = {
  root: 'Traced address',
  sanctioned: 'Sanctioned',
  scam: 'Scam',
  mixer: 'Mixer',
  exchange: 'Exchange',
  bridge: 'Bridge',
  dex: 'DEX',
  lending: 'Lending',
  token: 'Token contract',
  nft: 'NFT',
  burn: 'Burn',
  infrastructure: 'Infrastructure',
  wallet: 'Tagged wallet',
  other: 'Labelled',
  'risk-critical': 'Critical risk',
  'risk-high': 'High risk',
  'risk-medium': 'Medium risk',
  contract: 'Contract (unlabelled)',
  default: 'Unlabelled address',
};

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  node: FlowNode;
  r: number;
  colorKey: string;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  edge: FlowEdge;
  width: number;
  curved: boolean;
}

const DEFAULT_HEIGHT = 520;
const MIN_WIDTH = 320;
const ZOOM_EXTENT: [number, number] = [0.15, 8];

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Colour key for a node: root > label category > risk > contract > default. */
export function nodeColorKey(node: FlowNode, root: string): string {
  if (node.id === root) return 'root';
  const cat = node.label?.category;
  if (cat && FLOW_COLORS[cat]) return cat;
  if (node.risk === 'critical' || node.risk === 'high' || node.risk === 'medium') return `risk-${node.risk}`;
  if (node.isContract) return 'contract';
  return 'default';
}

function nodeRadius(node: FlowNode, root: string): number {
  const usd = (node.totalInUsd ?? 0) + (node.totalOutUsd ?? 0);
  const r = clamp(7 + 2.4 * Math.log10(1 + usd), 7, 26);
  return node.id === root ? Math.max(r, 14) : r;
}

function edgeWidth(edge: FlowEdge): number {
  if (edge.totalUsd === undefined || edge.totalUsd <= 0) return 1.4;
  return clamp(1 + Math.log10(1 + edge.totalUsd) * 0.9, 1.4, 8);
}

function nodeTitle(node: FlowNode, chain: string): string {
  return node.label?.name ?? shorten(displayAddress(chain, node.id), 8, 6);
}

function assetSummary(transfers: readonly Transfer[]): string {
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

interface Tooltip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

export default function FlowGraph({ graph, onSelect, selected, height = DEFAULT_HEIGHT }: FlowGraphProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const sizeRef = useRef({ width: 800, height });
  const fittedRootRef = useRef<string | undefined>(undefined);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const [width, setWidth] = useState(800);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const markerId = `fg-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  sizeRef.current = { width, height };

  const legend = useMemo(() => {
    const keys = new Set<string>();
    for (const n of graph.nodes) keys.add(nodeColorKey(n, graph.root));
    const order = Object.keys(FLOW_COLORS);
    return order.filter((k) => keys.has(k));
  }, [graph]);

  const zoomTo = useCallback((transform: d3.ZoomTransform, animate = true) => {
    const svgEl = svgRef.current;
    const zoom = zoomRef.current;
    if (!svgEl || !zoom) return;
    const svg = d3.select(svgEl);
    if (animate) svg.transition().duration(350).call(zoom.transform, transform);
    else svg.call(zoom.transform, transform);
  }, []);

  /** Zoom so that every node is visible. */
  const fit = useCallback(
    (animate = true) => {
      const sim = simRef.current;
      if (!sim) return;
      const nodes = sim.nodes().filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
      if (nodes.length === 0) return;
      const { width: w, height: h } = sizeRef.current;
      const pad = 48;
      const minX = Math.min(...nodes.map((n) => (n.x ?? 0) - n.r));
      const maxX = Math.max(...nodes.map((n) => (n.x ?? 0) + n.r));
      const minY = Math.min(...nodes.map((n) => (n.y ?? 0) - n.r));
      const maxY = Math.max(...nodes.map((n) => (n.y ?? 0) + n.r));
      const bw = Math.max(1, maxX - minX + pad * 2);
      const bh = Math.max(1, maxY - minY + pad * 2);
      const scale = clamp(Math.min(w / bw, h / bh), ZOOM_EXTENT[0], 2.5);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      zoomTo(d3.zoomIdentity.translate(w / 2 - scale * cx, h / 2 - scale * cy).scale(scale), animate);
    },
    [zoomTo],
  );

  /** Identity zoom, release pinned nodes and re-heat the layout. */
  const reset = useCallback(() => {
    const sim = simRef.current;
    if (sim) {
      for (const n of sim.nodes()) {
        n.fx = null;
        n.fy = null;
      }
      sim.alpha(0.6).restart();
    }
    zoomTo(d3.zoomIdentity);
  }, [zoomTo]);

  // Responsive width.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidth(Math.max(MIN_WIDTH, Math.floor(el.clientWidth || 0) || sizeRef.current.width));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Zoom / pan (installed once).
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = d3.select(svgEl);
    const viewport = svg.select<SVGGElement>('g.flowgraph__viewport');
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent(ZOOM_EXTENT)
      // Explicit extent: the SVG size is known, and jsdom has no `viewBox.baseVal`.
      .extent(() => {
        const { width: w, height: h } = sizeRef.current;
        return [
          [0, 0],
          [w, h],
        ];
      })
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        viewport.attr('transform', event.transform.toString());
      });
    svg.call(zoom).on('dblclick.zoom', null);
    zoomRef.current = zoom;
    return () => {
      svg.on('.zoom', null);
      zoomRef.current = null;
    };
  }, []);

  // Build the simulation whenever the graph identity changes.
  useEffect(() => {
    const svgEl = svgRef.current;
    const canvasEl = canvasRef.current;
    if (!svgEl || !canvasEl) return;
    const svg = d3.select(svgEl);
    const linkLayer = svg.select<SVGGElement>('g.flowgraph__links');
    const nodeLayer = svg.select<SVGGElement>('g.flowgraph__nodes');
    const { width: w, height: h } = sizeRef.current;
    const chain = graph.chain;
    const prev = positionsRef.current;
    const firstBuild = fittedRootRef.current !== graph.root;

    const simNodes: SimNode[] = graph.nodes.map((n) => {
      const p = prev.get(n.id);
      return {
        id: n.id,
        node: n,
        r: nodeRadius(n, graph.root),
        colorKey: nodeColorKey(n, graph.root),
        x: p?.x ?? w / 2 + (Math.random() - 0.5) * 40,
        y: p?.y ?? h / 2 + (Math.random() - 0.5) * 40,
      };
    });
    const byId = new Map(simNodes.map((n) => [n.id, n]));
    const edgeIds = new Set(graph.edges.map((e) => e.id));
    const simLinks: SimLink[] = graph.edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({
        source: e.source,
        target: e.target,
        edge: e,
        width: edgeWidth(e),
        curved: edgeIds.has(`${e.target}->${e.source}:${e.chain}`),
      }));

    const pointOf = (event: MouseEvent): { x: number; y: number } => {
      const rect = canvasEl.getBoundingClientRect();
      return { x: event.clientX - rect.left + 14, y: event.clientY - rect.top + 14 };
    };
    const nodeTip = (d: SimNode, event: MouseEvent): Tooltip => {
      const n = d.node;
      const lines = [displayAddress(chain, n.id)];
      if (n.label) lines.push(`${n.label.category} · ${n.label.source}`);
      lines.push(`hop ${n.depth}${n.isContract ? ' · contract' : ''}${n.risk ? ` · risk ${n.risk}` : ''}`);
      lines.push(`in ${formatUsd(n.totalInUsd)} · out ${formatUsd(n.totalOutUsd)}`);
      return { ...pointOf(event), title: nodeTitle(n, chain), lines };
    };
    const linkTip = (d: SimLink, event: MouseEvent): Tooltip => {
      const e = d.edge;
      const src = byId.get(e.source)?.node;
      const dst = byId.get(e.target)?.node;
      const lines = [
        `${e.transfers.length} transfer${e.transfers.length === 1 ? '' : 's'} in ${e.txHashes.length} tx${e.txHashes.length === 1 ? '' : 's'}`,
        assetSummary(e.transfers),
        `total ${formatUsd(e.totalUsd)}`,
      ];
      return { ...pointOf(event), title: `${src ? nodeTitle(src, chain) : shorten(e.source)} → ${dst ? nodeTitle(dst, chain) : shorten(e.target)}`, lines };
    };

    const link = linkLayer
      .selectAll<SVGPathElement, SimLink>('path')
      .data(simLinks, (d) => d.edge.id)
      .join('path')
      .attr('class', 'flowgraph__link')
      .attr('stroke-width', (d) => d.width)
      .attr('marker-end', `url(#${markerId})`)
      .on('mouseenter', (event: MouseEvent, d) => setTooltip(linkTip(d, event)))
      .on('mousemove', (event: MouseEvent) => setTooltip((t) => (t ? { ...t, ...pointOf(event) } : t)))
      .on('mouseleave', () => setTooltip(null));

    const node = nodeLayer
      .selectAll<SVGGElement, SimNode>('g.flowgraph__node')
      .data(simNodes, (d) => d.id)
      .join((enter) => {
        const g = enter.append('g').attr('class', 'flowgraph__node');
        g.append('circle');
        g.append('text');
        return g;
      })
      .classed('is-root', (d) => d.id === graph.root)
      .classed('is-contract', (d) => !!d.node.isContract)
      .classed('is-selected', (d) => d.id === selectedRef.current)
      .on('click', (event: MouseEvent, d) => {
        event.stopPropagation();
        onSelectRef.current?.(d.id);
      })
      .on('mouseenter', (event: MouseEvent, d) => setTooltip(nodeTip(d, event)))
      .on('mousemove', (event: MouseEvent) => setTooltip((t) => (t ? { ...t, ...pointOf(event) } : t)))
      .on('mouseleave', () => setTooltip(null));
    node
      .select<SVGCircleElement>('circle')
      .attr('r', (d) => d.r)
      .style('fill', (d) => FLOW_COLORS[d.colorKey] ?? FLOW_COLORS.default);
    node
      .select<SVGTextElement>('text')
      .attr('dy', (d) => d.r + 12)
      .text((d) => nodeTitle(d.node, chain));

    const sim = d3
      .forceSimulation<SimNode, SimLink>(simNodes)
      .force(
        'link',
        d3
          .forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance((d) => {
            const depth = Math.max((d.source as SimNode).node.depth, (d.target as SimNode).node.depth);
            return 70 + 28 * depth;
          })
          .strength(0.5),
      )
      .force('charge', d3.forceManyBody<SimNode>().strength(-300))
      .force('collide', d3.forceCollide<SimNode>().radius((d) => d.r + 8))
      .force('center', d3.forceCenter(w / 2, h / 2))
      .force('x', d3.forceX<SimNode>(w / 2).strength(0.03))
      .force('y', d3.forceY<SimNode>(h / 2).strength(0.03))
      .alpha(firstBuild ? 1 : 0.5);

    const drag = d3
      .drag<SVGGElement, SimNode>()
      .on('start', (event: d3.D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
        if (!event.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event: d3.D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event: d3.D3DragEvent<SVGGElement, SimNode, SimNode>, d) => {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
    node.call(drag);

    sim.on('tick', () => {
      link.attr('d', (d) => {
        const s = d.source as SimNode;
        const t = d.target as SimNode;
        const sx = s.x ?? 0;
        const sy = s.y ?? 0;
        const tx = t.x ?? 0;
        const ty = t.y ?? 0;
        const dx = tx - sx;
        const dy = ty - sy;
        const dist = Math.hypot(dx, dy) || 1;
        const ux = dx / dist;
        const uy = dy / dist;
        const x1 = sx + ux * s.r;
        const y1 = sy + uy * s.r;
        const x2 = tx - ux * (t.r + 4);
        const y2 = ty - uy * (t.r + 4);
        if (!d.curved) return `M${x1},${y1}L${x2},${y2}`;
        const cx = (x1 + x2) / 2 - uy * dist * 0.18;
        const cy = (y1 + y2) / 2 + ux * dist * 0.18;
        return `M${x1},${y1}Q${cx},${cy} ${x2},${y2}`;
      });
      node.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });
    sim.on('end', () => {
      for (const n of simNodes) if (n.x !== undefined && n.y !== undefined) prev.set(n.id, { x: n.x, y: n.y });
      if (fittedRootRef.current !== graph.root) {
        fittedRootRef.current = graph.root;
        fit();
      }
    });
    simRef.current = sim;

    return () => {
      sim.stop();
      sim.on('tick', null).on('end', null);
      for (const n of simNodes) if (n.x !== undefined && n.y !== undefined) prev.set(n.id, { x: n.x, y: n.y });
      node.on('.drag', null).on('click', null).on('mouseenter', null).on('mousemove', null).on('mouseleave', null);
      link.on('mouseenter', null).on('mousemove', null).on('mouseleave', null);
      if (simRef.current === sim) simRef.current = null;
    };
  }, [graph, markerId, fit]);

  // Keep the layout centred when the container is resized.
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    sim.force('center', d3.forceCenter(width / 2, height / 2));
    sim.force('x', d3.forceX<SimNode>(width / 2).strength(0.03));
    sim.force('y', d3.forceY<SimNode>(height / 2).strength(0.03));
    sim.alpha(Math.max(sim.alpha(), 0.2)).restart();
  }, [width, height]);

  // Highlight the selected node and its edges without touching the simulation.
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = d3.select(svgEl);
    svg.selectAll<SVGGElement, SimNode>('g.flowgraph__node').classed('is-selected', (d) => d.id === selected);
    svg
      .selectAll<SVGPathElement, SimLink>('path.flowgraph__link')
      .classed('is-selected', (d) => !!selected && (d.edge.source === selected || d.edge.target === selected));
  }, [selected, graph]);

  const stats = `${graph.nodes.length} node${graph.nodes.length === 1 ? '' : 's'} · ${graph.edges.length} edge${graph.edges.length === 1 ? '' : 's'}${
    graph.truncated.length ? ` · ${graph.truncated.length} not expanded` : ''
  }`;

  return (
    <div className="flowgraph" ref={wrapRef} data-testid="flow-graph">
      <div className="flowgraph__toolbar">
        <button type="button" className="flowgraph__btn" onClick={() => fit()} aria-label="Fit graph to view">
          Fit
        </button>
        <button type="button" className="flowgraph__btn" onClick={reset} aria-label="Reset view and layout">
          Reset
        </button>
        <span className="flowgraph__stats">{stats}</span>
      </div>
      <div className="flowgraph__canvas" ref={canvasRef}>
        {graph.nodes.length === 0 ? (
          <div className="flowgraph__empty">No fund flows found for this address with the current options.</div>
        ) : null}
        <svg
          ref={svgRef}
          className="flowgraph__svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Fund-flow graph with ${graph.nodes.length} addresses and ${graph.edges.length} edges`}
          onClick={() => setTooltip(null)}
        >
          <defs>
            <marker
              id={markerId}
              viewBox="0 -5 10 10"
              refX="9"
              refY="0"
              markerWidth="8"
              markerHeight="8"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path className="flowgraph__arrow" d="M0,-5L10,0L0,5" />
            </marker>
          </defs>
          <g className="flowgraph__viewport">
            <g className="flowgraph__links" />
            <g className="flowgraph__nodes" />
          </g>
        </svg>
        {tooltip ? (
          <div className="flowgraph__tooltip" role="tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
            <div className="flowgraph__tooltip-title">{tooltip.title}</div>
            {tooltip.lines.map((line, i) => (
              <div className="flowgraph__tooltip-line" key={i}>
                {line}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {legend.length > 0 ? (
        <ul className="flowgraph__legend" aria-label="Legend">
          {legend.map((key) => (
            <li key={key}>
              <span className="flowgraph__swatch" style={{ background: FLOW_COLORS[key] }} aria-hidden="true" />
              {LEGEND_LABELS[key] ?? key}
            </li>
          ))}
          {graph.nodes.some((n) => n.isContract) ? (
            <li>
              <span className="flowgraph__swatch flowgraph__swatch--contract" aria-hidden="true" />
              Dashed ring = contract
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
