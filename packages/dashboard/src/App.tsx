import { useState, useCallback, useEffect, useRef } from 'react';
import AgentGraph from './components/AgentGraph.js';
import DetailPanel from './components/DetailPanel.js';
import Toolbar from './components/Toolbar.js';
import ChatPanel from './components/ChatPanel.js';
import ConfigPanel from './components/ConfigPanel.js';
import QueuePanel from './components/QueuePanel.js';
import ProcessingQueuePanel from './components/ProcessingQueuePanel.js';
import LinaFanneryQueuePanel from './components/LinaFanneryQueuePanel.js';
import GloriaQueuePanel from './components/GloriaQueuePanel.js';
import KanbanBoard from './components/KanbanBoard.js';
import ReviewPage from './components/ReviewPage.js';
import ContextMenu from './components/ContextMenu.js';
import PromptEditor from './components/PromptEditor.js';
import type { ContextMenuAction } from './components/ContextMenu.js';
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
  const agents: AgentId[] = ['yulieth', 'robinson', 'chucho', 'jaime', 'lina', 'fannery', 'gloria', 'supervisor', 'fisher'];
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
  const agents: AgentId[] = ['yulieth', 'robinson', 'chucho', 'jaime', 'lina', 'fannery', 'gloria', 'supervisor', 'fisher'];
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
  const [chatAgent, setChatAgent] = useState<AgentId | null>(null);

  // Side panel mode: 'chat' | 'config' | 'queue' | 'kanban' | 'prompt'
  type SidePanelMode = 'chat' | 'config' | 'queue' | 'kanban' | 'prompt';
  const [sidePanelMode, setSidePanelMode] = useState<SidePanelMode>('chat');

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; agentId: AgentId;
  } | null>(null);

  // Review page state
  const [reviewJobId, setReviewJobId] = useState<string | null>(null);

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
  const chatNodeData = chatAgent ? nodes.find((n) => n.id === chatAgent) ?? null : null;

  // When a node is clicked, open the queue panel for that agent
  const handleSelectNode = useCallback((id: AgentId | null) => {
    setSelectedNode(id);
    if (id) {
      setChatAgent(id);
      if (id === 'supervisor') {
        setSidePanelMode('kanban');
      } else {
        setSidePanelMode('queue');
      }
    }
  }, []);

  // Listen for custom review events from child components
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ jobId: string }>).detail;
      if (detail?.jobId) setReviewJobId(detail.jobId);
    };
    window.addEventListener('open-review', handler);
    return () => window.removeEventListener('open-review', handler);
  }, []);

  // Right-click on a node → context menu
  const handleNodeContextMenu = useCallback((id: AgentId, x: number, y: number) => {
    setContextMenu({ x, y, agentId: id });
  }, []);

  // Build context menu actions for the right-clicked agent
  const contextMenuActions: ContextMenuAction[] = contextMenu ? [
    {
      label: 'Chat',
      icon: '💬',
      onClick: () => {
        setChatAgent(contextMenu.agentId);
        setSelectedNode(contextMenu.agentId);
        setSidePanelMode('chat');
      },
    },
    {
      label: 'View Queue',
      icon: '📊',
      onClick: () => {
        setChatAgent(contextMenu.agentId);
        setSelectedNode(contextMenu.agentId);
        setSidePanelMode(contextMenu.agentId === 'supervisor' ? 'kanban' : 'queue');
      },
    },
    {
      label: 'View/Edit Prompt',
      icon: '📝',
      onClick: () => {
        setChatAgent(contextMenu.agentId);
        setSelectedNode(contextMenu.agentId);
        setSidePanelMode('prompt');
      },
    },
    ...(contextMenu.agentId === 'yulieth' ? [
      {
        label: 'Configure',
        icon: '⚙️',
        onClick: () => {
          setChatAgent(contextMenu.agentId);
          setSelectedNode(contextMenu.agentId);
          setSidePanelMode('config');
        },
      },
    ] : []),
  ] : [];

  return (
    <>
      {/* Full-screen Review Page overlay */}
      {reviewJobId && (
        <ReviewPage
          jobId={reviewJobId}
          onBack={() => setReviewJobId(null)}
        />
      )}

      {!reviewJobId && (
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

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Main graph area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            <AgentGraph
              nodes={nodes}
              edges={edges}
              statuses={statuses}
              stats={stats}
              selectedNode={selectedNode}
              onSelectNode={handleSelectNode}
              onMoveNode={handleMoveNode}
              onNodeContextMenu={handleNodeContextMenu}
            />

            {/* Keyboard hint */}
            <div style={{
              position: 'absolute',
              bottom: selectedNodeData ? '180px' : '16px',
              right: chatNodeData ? '16px' : '16px',
              background: 'rgba(15,23,42,0.8)',
              padding: '8px 12px',
              borderRadius: '6px',
              fontSize: '11px',
              color: '#64748b',
              transition: 'bottom 0.2s ease',
            }}>
              Click node = queue · Right-click = options · Scroll = zoom · Drag = pan
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

        {/* Side panel: Chat / Config / Queue */}
        {chatNodeData && sidePanelMode === 'chat' && (
          <ChatPanel
            node={chatNodeData}
            onClose={() => setChatAgent(null)}
          />
        )}
        {chatNodeData && sidePanelMode === 'config' && chatAgent === 'yulieth' && (
          <ConfigPanel
            node={chatNodeData}
            onClose={() => setChatAgent(null)}
            onSwitchToChat={() => setSidePanelMode('chat')}
          />
        )}
        {chatNodeData && sidePanelMode === 'queue' && chatAgent === 'yulieth' && (
          <QueuePanel
            node={chatNodeData}
            onClose={() => setChatAgent(null)}
            onSwitchToChat={() => setSidePanelMode('chat')}
            onSwitchToConfig={() => setSidePanelMode('config')}
          />
        )}
        {chatNodeData && sidePanelMode === 'queue' && (chatAgent === 'chucho' || chatAgent === 'jaime') && (
          <ProcessingQueuePanel
            node={chatNodeData}
            agentId={chatAgent}
            onClose={() => setChatAgent(null)}
            onSwitchToChat={() => setSidePanelMode('chat')}
          />
        )}
        {chatNodeData && sidePanelMode === 'queue' && (chatAgent === 'lina' || chatAgent === 'fannery') && (
          <LinaFanneryQueuePanel
            node={chatNodeData}
            agentId={chatAgent}
            onClose={() => setChatAgent(null)}
            onSwitchToChat={() => setSidePanelMode('chat')}
          />
        )}
        {chatNodeData && sidePanelMode === 'queue' && chatAgent === 'gloria' && (
          <GloriaQueuePanel
            node={chatNodeData}
            onClose={() => setChatAgent(null)}
            onSwitchToChat={() => setSidePanelMode('chat')}
          />
        )}
        {chatNodeData && sidePanelMode === 'kanban' && chatAgent === 'supervisor' && (
          <KanbanBoard
            node={chatNodeData}
            onClose={() => setChatAgent(null)}
            onSwitchToChat={() => setSidePanelMode('chat')}
          />
        )}
        {chatNodeData && sidePanelMode === 'prompt' && chatAgent && (
          <PromptEditor
            node={chatNodeData}
            agentId={chatAgent}
            onClose={() => setChatAgent(null)}
            onSwitchToChat={() => setSidePanelMode('chat')}
          />
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          agentId={contextMenu.agentId}
          actions={contextMenuActions}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
      )}
    </>
  );
}
