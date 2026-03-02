import { useRef, useCallback, useState, useEffect, type PointerEvent as ReactPointerEvent } from 'react';
import type { AgentNode, AgentEdge, AgentId, AgentStatus, AgentStats } from '../types/index.js';

interface Props {
  nodes: AgentNode[];
  edges: AgentEdge[];
  statuses: Record<AgentId, AgentStatus>;
  stats: Record<AgentId, AgentStats>;
  selectedNode: AgentId | null;
  onSelectNode: (id: AgentId | null) => void;
  onMoveNode: (id: AgentId, x: number, y: number) => void;
  onNodeContextMenu?: (id: AgentId, x: number, y: number) => void;
}

const NODE_RADIUS = 40;

function statusGlow(state: AgentStatus['state']): string {
  switch (state) {
    case 'processing': return '#22c55e';
    case 'error':      return '#ef4444';
    default:           return 'transparent';
  }
}

function cubicSpline(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  const cp1x = x1 + dx * 0.4;
  const cp2x = x2 - dx * 0.4;
  return `M ${x1} ${y1} C ${cp1x} ${y1}, ${cp2x} ${y2}, ${x2} ${y2}`;
}

export default function AgentGraph({
  nodes,
  edges,
  statuses,
  stats,
  selectedNode,
  onSelectNode,
  onMoveNode,
  onNodeContextMenu,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<AgentId | null>(null);
  const dragOffset = useRef({ dx: 0, dy: 0 });
  const [viewBox, setViewBox] = useState({ x: -50, y: -50, w: 1300, h: 600 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, vx: 0, vy: 0 });

  // ── Node positions as a map for quick lookup ──
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // ── Pointer events for dragging nodes ──
  const handleNodePointerDown = useCallback((e: ReactPointerEvent<SVGGElement>, id: AgentId) => {
    e.stopPropagation();
    const node = nodeMap.get(id);
    if (!node || !svgRef.current) return;

    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM()?.inverse();
    if (!ctm) return;
    const svgPt = pt.matrixTransform(ctm);

    dragOffset.current = { dx: svgPt.x - node.x, dy: svgPt.y - node.y };
    setDragging(id);
    (e.target as Element).setPointerCapture(e.pointerId);
  }, [nodeMap]);

  const handlePointerMove = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;

    if (dragging) {
      const svg = svgRef.current;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const ctm = svg.getScreenCTM()?.inverse();
      if (!ctm) return;
      const svgPt = pt.matrixTransform(ctm);
      onMoveNode(dragging, svgPt.x - dragOffset.current.dx, svgPt.y - dragOffset.current.dy);
    } else if (isPanning) {
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      const scale = viewBox.w / (svgRef.current.clientWidth || 1);
      setViewBox((vb) => ({
        ...vb,
        x: panStart.current.vx - dx * scale,
        y: panStart.current.vy - dy * scale,
      }));
    }
  }, [dragging, isPanning, onMoveNode, viewBox.w]);

  const handlePointerUp = useCallback(() => {
    setDragging(null);
    setIsPanning(false);
  }, []);

  // ── Pan on background drag ──
  const handleBgPointerDown = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).tagName === 'svg' || (e.target as Element).classList.contains('bg-rect')) {
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY, vx: viewBox.x, vy: viewBox.y };
      onSelectNode(null);
    }
  }, [viewBox.x, viewBox.y, onSelectNode]);

  // ── Zoom ──
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.1 : 0.9;
      setViewBox((vb) => {
        const newW = vb.w * factor;
        const newH = vb.h * factor;
        const cx = vb.x + vb.w / 2;
        const cy = vb.y + vb.h / 2;
        return { x: cx - newW / 2, y: cy - newH / 2, w: newW, h: newH };
      });
    };

    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <svg
      ref={svgRef}
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
      style={{ width: '100%', height: '100%', cursor: isPanning ? 'grabbing' : dragging ? 'grabbing' : 'default' }}
      onPointerDown={handleBgPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <defs>
        <filter id="glow-processing">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="glow-error">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="shadow">
          <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.3" />
        </filter>
        <marker
          id="arrowhead"
          markerWidth="10"
          markerHeight="7"
          refX="9"
          refY="3.5"
          orient="auto"
        >
          <polygon points="0 0, 10 3.5, 0 7" fill="#64748b" opacity="0.6" />
        </marker>
      </defs>

      {/* Background */}
      <rect
        className="bg-rect"
        x={viewBox.x - 5000}
        y={viewBox.y - 5000}
        width={viewBox.w + 10000}
        height={viewBox.h + 10000}
        fill="#0f172a"
      />

      {/* Grid dots */}
      {Array.from({ length: 80 }, (_, i) =>
        Array.from({ length: 40 }, (_, j) => (
          <circle
            key={`dot-${i}-${j}`}
            cx={i * 50}
            cy={j * 50}
            r={1}
            fill="#1e293b"
          />
        ))
      )}

      {/* Edges (splines) */}
      {edges.map((edge, i) => {
        const from = nodeMap.get(edge.from);
        const to = nodeMap.get(edge.to);
        if (!from || !to) return null;

        const isSupervisorEdge = edge.from === 'supervisor';
        return (
          <g key={`edge-${i}`}>
            <path
              d={cubicSpline(from.x, from.y, to.x, to.y)}
              fill="none"
              stroke={isSupervisorEdge ? '#334155' : '#64748b'}
              strokeWidth={isSupervisorEdge ? 1 : 2}
              strokeDasharray={isSupervisorEdge ? '6 4' : 'none'}
              opacity={isSupervisorEdge ? 0.4 : 0.6}
              markerEnd="url(#arrowhead)"
            />
          </g>
        );
      })}

      {/* Nodes */}
      {nodes.map((node) => {
        const status = statuses[node.id];
        const stat = stats[node.id];
        const isSelected = selectedNode === node.id;
        const glowColor = status ? statusGlow(status.state) : 'transparent';
        const hasGlow = glowColor !== 'transparent';

        return (
          <g
            key={node.id}
            transform={`translate(${node.x}, ${node.y})`}
            onPointerDown={(e) => {
              handleNodePointerDown(e, node.id);
              onSelectNode(node.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (onNodeContextMenu) {
                onNodeContextMenu(node.id, e.clientX, e.clientY);
              }
            }}
            style={{ cursor: 'pointer' }}
          >
            {/* Glow ring */}
            {hasGlow && (
              <circle
                r={NODE_RADIUS + 8}
                fill="none"
                stroke={glowColor}
                strokeWidth={3}
                opacity={0.6}
                filter={status?.state === 'error' ? 'url(#glow-error)' : 'url(#glow-processing)'}
              >
                <animate
                  attributeName="opacity"
                  values="0.6;0.2;0.6"
                  dur={status?.state === 'processing' ? '2s' : '1s'}
                  repeatCount="indefinite"
                />
              </circle>
            )}

            {/* Selection ring */}
            {isSelected && (
              <circle
                r={NODE_RADIUS + 5}
                fill="none"
                stroke="#38bdf8"
                strokeWidth={2}
                strokeDasharray="4 3"
              >
                <animateTransform
                  attributeName="transform"
                  type="rotate"
                  from="0"
                  to="360"
                  dur="8s"
                  repeatCount="indefinite"
                />
              </circle>
            )}

            {/* Node body */}
            <circle
              r={NODE_RADIUS}
              fill={node.color}
              filter="url(#shadow)"
              opacity={0.95}
            />
            <circle
              r={NODE_RADIUS - 3}
              fill="none"
              stroke="rgba(255,255,255,0.15)"
              strokeWidth={1}
            />

            {/* Icon */}
            <text
              textAnchor="middle"
              dominantBaseline="central"
              fontSize="22"
              style={{ pointerEvents: 'none', userSelect: 'none' }}
            >
              {node.icon}
            </text>

            {/* Label */}
            <text
              y={NODE_RADIUS + 18}
              textAnchor="middle"
              fill="#e2e8f0"
              fontSize="13"
              fontWeight="600"
              style={{ pointerEvents: 'none', userSelect: 'none' }}
            >
              {node.label}
            </text>

            {/* Mini stat badge */}
            {stat && (
              <g transform={`translate(${NODE_RADIUS - 5}, ${-NODE_RADIUS + 5})`}>
                <rect
                  x={-14}
                  y={-10}
                  width={28}
                  height={18}
                  rx={9}
                  fill="#1e293b"
                  stroke={node.color}
                  strokeWidth={1}
                />
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="#e2e8f0"
                  fontSize="9"
                  fontWeight="600"
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {stat.last30Days.jobsProcessed}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
