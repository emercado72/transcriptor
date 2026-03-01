import { useState, useCallback, useEffect, useRef } from 'react';
import AgentGraph from './components/AgentGraph.js';
import DetailPanel from './components/DetailPanel.js';
import Toolbar from './components/Toolbar.js';
import {
  getDefaultNodes,
  getEdges,
  saveLayout,
  loadLayout,
  getAutoArrangedPositions,
} from './hooks/useAgentTopology.js';
import { getAgentStatuses, getAgentStats, getPipelineOverview } from './api/client.js';
import type { AgentId, AgentNode, AgentStatus, AgentStats, PipelineOverview } from './types/index.js';

// ── Mock data for when the API isn't running yet ──
function mockStatuses(): Record<AgentId, AgentStatus> {
  const agents: AgentId[] = ['yulieth', 'robinson', 'chucho', 'jaime', 'lina', 'fannery', 'gloria', 'supervisor'];
  const result: Record<string, AgentStatus> = {};
  for (const id of agents) {
    result[id] = {
      agentId: id,
      state: 'idle',
      currentJob: null,
      currentEvent: null,
      lastActivity: null,
      uptime: Math.floor(Math.random() * 86400),
    };
  }
  return result as Record<AgentId, AgentStatus>;
}

function mockStats(): Record<AgentId, AgentStats> {
  const agents: AgentId[] = ['yulieth', 'robinson', 'chucho', 'jaime', 'lina', 'fannery', 'gloria', 'supervisor'];
  const result: Record<string, AgentStats> = {};
  for (const id of agents) {
    result[id] = {
      agentId: id,
      last30Days: {
        jobsProcessed: 0,
        jobsFailed: 0,
        averageDurationMs: 0,
        totalDurationMs: 0,
      },
      today: {
        jobsProcessed: 0,
        jobsFailed: 0,
      },
    };
  }
  return result as Record<AgentId, AgentStats>;
}

function mockOverview(): PipelineOverview {
  return {
    activeJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    queuedJobs: 0,
    recentJobs: [],
  };
}

export default function App() {
  // ── Node state with persisted layout ──
  const [nodes, setNodes] = useState<AgentNode[]>(() => {
    const defaults = getDefaultNodes();
    const savedPositions = loadLayout();
    if (savedPositions) {
      return defaults.map((n) => ({
        ...n,
        x: savedPositions[n.id]?.x ?? n.x,
        y: savedPositions[n.id]?.y ?? n.y,
      }));
    }
    return defaults;
  });

  const edges = getEdges();
  const [selectedNode, setSelectedNode] = useState<AgentId | null>(null);

  // ── Agent data ──
  const [statuses, setStatuses] = useState<Record<AgentId, AgentStatus>>(mockStatuses);
  const [stats, setStats] = useState<Record<AgentId, AgentStats>>(mockStats);
  const [overview, setOverview] = useState<PipelineOverview>(mockOverview);

  // ── Save layout on drag (debounced) ──
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistLayout = useCallback((updatedNodes: AgentNode[]) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      const positions: Record<string, { x: number; y: number }> = {};
      for (const n of updatedNodes) {
        positions[n.id] = { x: n.x, y: n.y };
      }
      saveLayout(positions as Record<AgentId, { x: number; y: number }>);
    }, 300);
  }, []);

  const handleMoveNode = useCallback((id: AgentId, x: number, y: number) => {
    setNodes((prev) => {
      const updated = prev.map((n) => (n.id === id ? { ...n, x, y } : n));
      persistLayout(updated);
      return updated;
    });
  }, [persistLayout]);

  const handleAutoArrange = useCallback(() => {
    const positions = getAutoArrangedPositions();
    setNodes((prev) =>
      prev.map((n) => ({
        ...n,
        x: positions[n.id]?.x ?? n.x,
        y: positions[n.id]?.y ?? n.y,
      }))
    );
    saveLayout(positions);
  }, []);

  // ── Poll API for live data ──
  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const [statusData, statsData, overviewData] = await Promise.all([
          getAgentStatuses(),
          getAgentStats(),
          getPipelineOverview(),
        ]);

        if (!active) return;

        const statusMap: Record<string, AgentStatus> = {};
        for (const s of statusData) statusMap[s.agentId] = s;
        setStatuses(statusMap as Record<AgentId, AgentStatus>);

        const statsMap: Record<string, AgentStats> = {};
        for (const s of statsData) statsMap[s.agentId] = s;
        setStats(statsMap as Record<AgentId, AgentStats>);

        setOverview(overviewData);
      } catch {
        // API not running — keep mock data
      }
    }

    poll();
    const interval = setInterval(poll, 10_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const selectedNodeData = selectedNode ? nodes.find((n) => n.id === selectedNode) ?? null : null;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: '#0f172a',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      color: '#e2e8f0',
      overflow: 'hidden',
    }}>
      <Toolbar overview={overview} onAutoArrange={handleAutoArrange} />

      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <AgentGraph
          nodes={nodes}
          edges={edges}
          statuses={statuses}
          stats={stats}
          selectedNode={selectedNode}
          onSelectNode={setSelectedNode}
          onMoveNode={handleMoveNode}
        />

        {/* Keyboard hint */}
        <div style={{
          position: 'absolute',
          bottom: selectedNodeData ? '180px' : '16px',
          right: '16px',
          background: 'rgba(15,23,42,0.8)',
          padding: '8px 12px',
          borderRadius: '6px',
          fontSize: '11px',
          color: '#64748b',
          transition: 'bottom 0.2s ease',
        }}>
          Scroll to zoom · Drag background to pan · Drag nodes to rearrange
        </div>
      </div>

      {selectedNodeData && (
        <DetailPanel
          node={selectedNodeData}
          status={statuses[selectedNode!] ?? null}
          stats={stats[selectedNode!] ?? null}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}
