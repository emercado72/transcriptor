import { useRef, useCallback, useState, useEffect, type PointerEvent as ReactPointerEvent } from 'react';
import type { AgentNode, AgentEdge, AgentId, AgentStatus, AgentStats } from '../types/index.js';
import type { FisherWorkerInfo } from '../api/client.js';

interface Props {
  nodes: AgentNode[];
  edges: AgentEdge[];
  statuses: Record<AgentId, AgentStatus>;
  stats: Record<AgentId, AgentStats>;
  selectedNode: AgentId | null;
  onSelectNode: (id: AgentId | null) => void;
  onMoveNode: (id: AgentId, x: number, y: number) => void;
  onNodeContextMenu?: (id: AgentId, x: number, y: number) => void;
  fisherWorker?: FisherWorkerInfo | null;
}

const NODE_RADIUS = 40;
const GPU_RADIUS = 36;
const GPU_OFFSET_Y = 150;

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

/** Vertical-biased spline (for Fisher → GPU worker below) */
function verticalSpline(x1: number, y1: number, x2: number, y2: number): string {
  const dy = y2 - y1;
  const cp1y = y1 + dy * 0.35;
  const cp2y = y2 - dy * 0.35;
  return `M ${x1} ${y1} C ${x1} ${cp1y}, ${x2} ${cp2y}, ${x2} ${y2}`;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return seconds + 's';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return m + 'm ' + s + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

/** Determine GPU worker circle position, offset from Fisher to avoid collisions with other nodes */
function gpuWorkerPosition(fisherNode: AgentNode, allNodes: AgentNode[]): { x: number; y: number } {
  // Default: directly below Fisher
  const baseX = fisherNode.x;
  const baseY = fisherNode.y + GPU_OFFSET_Y;

  // Check for collisions with existing nodes
  const minDist = NODE_RADIUS + GPU_RADIUS + 20;
  const candidates = [
    { x: baseX, y: baseY },
    { x: baseX - 120, y: baseY },
    { x: baseX + 120, y: baseY },
    { x: baseX - 60, y: baseY + 40 },
    { x: baseX + 60, y: baseY + 40 },
  ];

  for (const pos of candidates) {
    const collision = allNodes.some(n => {
      const dx = n.x - pos.x;
      const dy = n.y - pos.y;
      return Math.sqrt(dx * dx + dy * dy) < minDist;
    });
    if (!collision) return pos;
  }

  // Fallback: place far below
  return { x: baseX, y: baseY + 80 };
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
  fisherWorker,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<AgentId | null>(null);
  const dragOffset = useRef({ dx: 0, dy: 0 });
  const [viewBox, setViewBox] = useState({ x: -50, y: -50, w: 1300, h: 600 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, vx: 0, vy: 0 });

  // Tick every second for GPU worker elapsed timer
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!fisherWorker?.createdAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [fisherWorker?.createdAt]);

  // ── Node positions as a map for quick lookup ──
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // ── GPU worker state ──
  const fisherNode = nodeMap.get('fisher');
  const showGpuWorker = fisherWorker && fisherNode && fisherWorker.state !== 'idle';
  const gpuState = fisherWorker?.state ?? 'idle';
  const isProvisioning = gpuState === 'provisioning' || gpuState === 'booting';
  const isReady = gpuState === 'processing';
  const isWinding = gpuState === 'backing_up' || gpuState === 'destroying';
  const isError = gpuState === 'error';

  const gpuPos = fisherNode ? gpuWorkerPosition(fisherNode, nodes) : { x: 0, y: 0 };
  const gpuColor = isReady ? '#a3e635' : isError ? '#ef4444' : isWinding ? '#64748b' : '#f97316';

  const elapsed = fisherWorker?.createdAt
    ? Math.max(0, Math.floor((now - new Date(fisherWorker.createdAt).getTime()) / 1000))
    : 0;

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
        <filter id="glow-gpu">
          <feGaussianBlur stdDeviation="6" result="blur" />
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

      {/* ── GPU Worker spline + node ── */}
      {showGpuWorker && fisherNode && (
        <g key="gpu-worker">
          {/* Dashed spline from Fisher to GPU worker */}
          <path
            d={verticalSpline(
              fisherNode.x, fisherNode.y + NODE_RADIUS,
              gpuPos.x, gpuPos.y - GPU_RADIUS,
            )}
            fill="none"
            stroke={gpuColor}
            strokeWidth={2}
            strokeDasharray="8 5"
            opacity={0.7}
          >
            {isProvisioning && (
              <animate
                attributeName="stroke-dashoffset"
                values="0;-26"
                dur="1.5s"
                repeatCount="indefinite"
              />
            )}
          </path>

          {/* GPU worker group — click opens remote dashboard */}
          <g
            transform={`translate(${gpuPos.x}, ${gpuPos.y})`}
            style={{ cursor: 'pointer' }}
            onClick={() => {
              if (fisherWorker?.ip && isReady) {
                window.open('http://' + fisherWorker.ip + ':3001', '_blank');
              }
              onSelectNode('fisher');
            }}
          >
            {/* Outer glow ring */}
            <circle
              r={GPU_RADIUS + 8}
              fill="none"
              stroke={gpuColor}
              strokeWidth={2.5}
              filter="url(#glow-gpu)"
            >
              {isProvisioning && (
                <animate
                  attributeName="opacity"
                  values="0.8;0.15;0.8"
                  dur="1.8s"
                  repeatCount="indefinite"
                />
              )}
              {isReady && (
                <animate
                  attributeName="opacity"
                  values="0.5;0.3;0.5"
                  dur="3s"
                  repeatCount="indefinite"
                />
              )}
              {!isProvisioning && !isReady && (
                <set attributeName="opacity" to="0.3" />
              )}
            </circle>

            {/* Main circle body */}
            <circle
              r={GPU_RADIUS}
              fill={isReady ? '#1a2e05' : isError ? '#2a0a0a' : '#2a1800'}
              filter="url(#shadow)"
              opacity={0.95}
            />
            <circle
              r={GPU_RADIUS}
              fill="none"
              stroke={gpuColor}
              strokeWidth={2.5}
            >
              {isProvisioning && (
                <animate
                  attributeName="opacity"
                  values="1;0.3;1"
                  dur="1.8s"
                  repeatCount="indefinite"
                />
              )}
            </circle>

            {/* Inner border */}
            <circle
              r={GPU_RADIUS - 3}
              fill="none"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth={1}
            />

            {/* IP address inside the circle */}
            <text
              textAnchor="middle"
              dominantBaseline="central"
              fill={isReady ? '#d9f99d' : isError ? '#fca5a5' : '#fed7aa'}
              fontSize="8.5"
              fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
              fontWeight="600"
              letterSpacing="-0.3"
              style={{ pointerEvents: 'none', userSelect: 'none' }}
            >
              {fisherWorker!.ip || '...'}
            </text>

            {/* Label below */}
            <text
              y={GPU_RADIUS + 16}
              textAnchor="middle"
              fill="#94a3b8"
              fontSize="10"
              fontWeight="500"
              style={{ pointerEvents: 'none', userSelect: 'none' }}
            >
              GPU Worker
            </text>

            {/* Elapsed timer below label */}
            <text
              y={GPU_RADIUS + 30}
              textAnchor="middle"
              fill={isReady ? '#a3e635' : '#f97316'}
              fontSize="11"
              fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
              fontWeight="700"
              style={{ pointerEvents: 'none', userSelect: 'none' }}
            >
              {formatElapsed(elapsed)}
            </text>

            {/* State label at top */}
            <g transform={`translate(0, ${-GPU_RADIUS - 14})`}>
              <rect
                x={-30}
                y={-8}
                width={60}
                height={16}
                rx={8}
                fill={gpuColor}
                opacity={0.2}
              />
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fill={gpuColor}
                fontSize="8"
                fontWeight="700"
                letterSpacing="0.5"
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {isReady ? 'ONLINE' : isProvisioning ? 'BOOTING' : isWinding ? gpuState.toUpperCase() : gpuState.toUpperCase()}
              </text>
            </g>
          </g>
        </g>
      )}

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
