import { useState, useEffect, useCallback } from 'react';
import type { AgentNode } from '../types/index.js';

// ── Types matching supervisor's KanbanBoard output ──

interface KanbanCard {
  jobId: string;
  eventId: string;
  status: string;
  currentStage: string;
  stages: Array<{
    stage: string;
    status: string;
    agentName: string;
    startedAt: string | null;
    completedAt: string | null;
    error: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
  currentStageStatus: string;
  error: string | null;
  elapsedMs: number;
  stageElapsedMs?: number;
  clientName?: string;
}

interface KanbanColumn {
  stage: string;
  label: string;
  agent: string;
  jobs: KanbanCard[];
}

interface KanbanBoardData {
  columns: KanbanColumn[];
  orchestratorRunning: boolean;
  timestamp: string;
}

interface Props {
  node: AgentNode;
  onClose: () => void;
  onSwitchToChat: () => void;
}

// ── Helpers ──

function formatElapsed(ms: number): string {
  if (ms < 1000) return '<1s';
  const totalSec = Math.floor(ms / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('es-CO', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const COLUMN_COLORS: Record<string, string> = {
  queued: '#3b82f6',
  preprocessing: '#f59e0b',
  transcribing: '#8b5cf6',
  sectioning: '#8b5cf6',
  redacting: '#ec4899',
  assembling: '#06b6d4',
  reviewing: '#10b981',
  completed: '#22c55e',
  failed: '#ef4444',
};

const STATUS_ICONS: Record<string, string> = {
  pending: '⏳',
  processing: '⚙️',
  completed: '✅',
  failed: '❌',
  retrying: '🔄',
};

export default function KanbanBoard({ node, onClose, onSwitchToChat }: Props) {
  const [board, setBoard] = useState<KanbanBoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCard, setSelectedCard] = useState<KanbanCard | null>(null);

  const fetchBoard = useCallback(async () => {
    try {
      const res = await fetch('/api/supervisor/kanban');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setBoard(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    }
  }, []);

  useEffect(() => {
    fetchBoard();
    const interval = setInterval(fetchBoard, 5000);
    return () => clearInterval(interval);
  }, [fetchBoard]);

  const handleRetry = async (jobId: string, stage: string) => {
    try {
      const res = await fetch(`/api/pipeline/${jobId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Refresh after retry
      setTimeout(fetchBoard, 500);
    } catch (err) {
      console.error('Retry failed:', err);
    }
  };

  return (
    <div style={{
      width: '800px',
      minWidth: '600px',
      borderLeft: '1px solid #334155',
      background: '#0f172a',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
    }}>
      {/* Header */}
      <div style={{
        padding: '16px',
        borderBottom: '1px solid #334155',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            background: '#6366f1', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontSize: '18px',
          }}>
            📋
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: '15px', color: '#f1f5f9' }}>
              {node.label} — Pipeline Kanban
            </div>
            <div style={{ fontSize: '12px', color: '#94a3b8', display: 'flex', gap: '12px', alignItems: 'center' }}>
              {board && (
                <>
                  <span>Orchestrator: {board.orchestratorRunning
                    ? <span style={{ color: '#22c55e' }}>● Running</span>
                    : <span style={{ color: '#ef4444' }}>● Stopped</span>}
                  </span>
                  <span>Updated: {formatDate(board.timestamp)}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={onSwitchToChat}
            style={{
              background: '#1e293b', border: '1px solid #334155',
              borderRadius: '6px', padding: '4px 10px',
              color: '#94a3b8', cursor: 'pointer', fontSize: '12px',
            }}
          >
            💬 Chat
          </button>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none',
              color: '#64748b', cursor: 'pointer', fontSize: '18px',
            }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div style={{ padding: '16px', color: '#ef4444', fontSize: '13px' }}>
          ⚠️ {error}
          <button onClick={fetchBoard} style={{
            marginLeft: '8px', background: '#1e293b',
            border: '1px solid #334155', borderRadius: '4px',
            padding: '2px 8px', color: '#94a3b8', cursor: 'pointer',
          }}>Retry</button>
        </div>
      )}

      {/* Kanban columns */}
      <div style={{
        flex: 1,
        overflowX: 'auto',
        overflowY: 'auto',
        padding: '16px',
        display: 'flex',
        gap: '12px',
      }}>
        {board?.columns.map(column => (
          <div key={column.stage} style={{
            minWidth: '200px',
            maxWidth: '280px',
            flex: '1 0 200px',
            background: '#1e293b',
            borderRadius: '8px',
            border: `1px solid ${COLUMN_COLORS[column.stage] || '#334155'}30`,
            display: 'flex',
            flexDirection: 'column',
          }}>
            {/* Column header */}
            <div style={{
              padding: '10px 12px',
              borderBottom: `2px solid ${COLUMN_COLORS[column.stage] || '#334155'}`,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <span style={{
                fontSize: '13px',
                fontWeight: 600,
                color: COLUMN_COLORS[column.stage] || '#94a3b8',
              }}>
                {column.label}
              </span>
              <span style={{
                fontSize: '11px',
                color: '#64748b',
                background: '#0f172a',
                borderRadius: '10px',
                padding: '2px 7px',
              }}>
                {column.jobs.length}
              </span>
            </div>

            {/* Cards */}
            <div style={{
              padding: '8px',
              flex: 1,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}>
              {column.jobs.length === 0 && (
                <div style={{
                  textAlign: 'center',
                  color: '#475569',
                  fontSize: '12px',
                  padding: '16px 0',
                  fontStyle: 'italic',
                }}>
                  No jobs
                </div>
              )}
              {column.jobs.map(card => (
                <div
                  key={card.jobId}
                  onClick={() => setSelectedCard(selectedCard?.jobId === card.jobId ? null : card)}
                  style={{
                    background: '#0f172a',
                    borderRadius: '6px',
                    padding: '10px',
                    border: selectedCard?.jobId === card.jobId
                      ? `1px solid ${COLUMN_COLORS[column.stage] || '#6366f1'}`
                      : '1px solid #334155',
                    cursor: 'pointer',
                    transition: 'border-color 0.15s',
                  }}
                >
                  {/* Nickname (clientName) — primary identifier */}
                  {card.clientName && (
                    <div style={{
                      fontSize: '12px',
                      fontWeight: 700,
                      color: '#f1f5f9',
                      marginBottom: '3px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      letterSpacing: '0.01em',
                    }}>
                      🏢 {card.clientName}
                    </div>
                  )}

                  {/* Job ID + short eventId */}
                  <div style={{
                    fontSize: '10px',
                    fontFamily: 'monospace',
                    color: '#475569',
                    marginBottom: '4px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {card.jobId.slice(0, 8)}… · {card.eventId.slice(0, 12)}
                  </div>

                  {/* Status + timing */}
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: '11px',
                  }}>
                    <span style={{ color: '#94a3b8' }}>
                      {STATUS_ICONS[card.currentStageStatus] || '❓'} {card.currentStageStatus}
                    </span>
                    <span style={{ color: '#64748b' }}>
                      {card.stageElapsedMs
                        ? formatElapsed(card.stageElapsedMs)
                        : formatElapsed(card.elapsedMs)}
                    </span>
                  </div>

                  {/* Error */}
                  {card.error && (
                    <div style={{
                      marginTop: '6px',
                      fontSize: '11px',
                      color: '#f87171',
                      background: '#450a0a',
                      padding: '4px 6px',
                      borderRadius: '4px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {card.error}
                    </div>
                  )}

                  {/* Expanded stage timeline */}
                  {selectedCard?.jobId === card.jobId && (
                    <div style={{
                      marginTop: '8px',
                      borderTop: '1px solid #334155',
                      paddingTop: '8px',
                    }}>
                      {card.stages.map(stage => (
                        <div key={stage.stage} style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          fontSize: '11px',
                          padding: '2px 0',
                          color: stage.status === 'completed' ? '#22c55e'
                            : stage.status === 'processing' ? '#f59e0b'
                            : stage.status === 'failed' ? '#ef4444'
                            : '#475569',
                        }}>
                          <span style={{ width: '14px', textAlign: 'center' }}>
                            {STATUS_ICONS[stage.status] || '·'}
                          </span>
                          <span style={{ flex: 1 }}>{stage.stage}</span>
                          <span style={{ fontSize: '10px', color: '#64748b' }}>
                            {stage.agentName}
                          </span>
                        </div>
                      ))}

                      {/* Retry button for failed jobs */}
                      {card.currentStageStatus === 'failed' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRetry(card.jobId, card.currentStage);
                          }}
                          style={{
                            marginTop: '8px',
                            width: '100%',
                            background: '#1e293b',
                            border: '1px solid #f59e0b',
                            borderRadius: '4px',
                            padding: '4px 8px',
                            color: '#f59e0b',
                            cursor: 'pointer',
                            fontSize: '11px',
                          }}
                        >
                          🔄 Retry {card.currentStage}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Empty state */}
        {board && board.columns.every(c => c.jobs.length === 0) && (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#475569',
            fontSize: '14px',
          }}>
            No active pipelines — Yulieth will populate this when she detects new files
          </div>
        )}
      </div>
    </div>
  );
}
