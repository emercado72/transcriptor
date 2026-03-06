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

/** Generate a random 4-word confirmation phrase */
function generateConfirmPhrase(): string {
  const words = [
    'alpha', 'bravo', 'cedar', 'delta', 'eagle', 'frost', 'gamma', 'hyper',
    'ivory', 'jolly', 'kappa', 'lunar', 'mango', 'nexus', 'omega', 'prism',
    'quartz', 'radar', 'sigma', 'tango', 'ultra', 'vivid', 'wired', 'xenon',
    'yield', 'zephyr', 'blaze', 'coral', 'drift', 'flint', 'grove', 'haven',
  ];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()} ${pick()} ${pick()} ${pick()}`;
}

const COLUMN_COLORS: Record<string, string> = {
  queued: '#3b82f6',
  delegating: '#14b8a6',
  delegated: '#0ea5e9',
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

// ── Confirmation Modal ──

interface ConfirmModalProps {
  action: 'stop' | 'delete';
  jobId: string;
  clientName?: string;
  phrase: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmModal({ action, jobId, clientName, phrase, onConfirm, onCancel }: ConfirmModalProps) {
  const [input, setInput] = useState('');
  const isMatch = input.trim().toLowerCase() === phrase.toLowerCase();

  const colors = action === 'delete'
    ? { accent: '#ef4444', bg: '#450a0a', border: '#dc2626' }
    : { accent: '#f59e0b', bg: '#451a03', border: '#d97706' };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.7)', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
    }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#1e293b', border: `1px solid ${colors.border}`,
        borderRadius: '12px', padding: '24px', width: '420px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        <div style={{ fontSize: '16px', fontWeight: 700, color: colors.accent, marginBottom: '8px' }}>
          {action === 'delete' ? '🗑️ Delete Job Permanently' : '⛔ Stop Job Processing'}
        </div>

        <div style={{ fontSize: '13px', color: '#cbd5e1', marginBottom: '16px', lineHeight: 1.5 }}>
          {action === 'delete'
            ? 'This will permanently remove all data, files, and history for this job. This cannot be undone.'
            : 'This will stop all processing and mark the job as failed.'}
        </div>

        <div style={{
          background: colors.bg, borderRadius: '6px', padding: '10px 12px',
          marginBottom: '16px', fontSize: '12px',
        }}>
          <div style={{ color: '#94a3b8', marginBottom: '4px' }}>
            Job: <span style={{ color: '#f1f5f9', fontFamily: 'monospace' }}>{jobId.slice(0, 8)}</span>
            {clientName && <span style={{ color: '#f1f5f9' }}> — {clientName}</span>}
          </div>
        </div>

        <div style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '8px' }}>
          Type the following to confirm:
        </div>
        <div style={{
          fontFamily: 'monospace', fontSize: '15px', fontWeight: 700,
          color: colors.accent, background: '#0f172a',
          padding: '8px 12px', borderRadius: '6px', marginBottom: '12px',
          letterSpacing: '0.05em', textAlign: 'center',
          border: '1px solid #334155', userSelect: 'all',
        }}>
          {phrase}
        </div>

        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Type the 4 words above..."
          autoFocus
          style={{
            width: '100%', padding: '10px 12px', fontSize: '14px',
            background: '#0f172a', border: `1px solid ${isMatch ? colors.accent : '#334155'}`,
            borderRadius: '6px', color: '#f1f5f9', outline: 'none',
            fontFamily: 'monospace', boxSizing: 'border-box',
            transition: 'border-color 0.2s',
          }}
          onKeyDown={e => { if (e.key === 'Enter' && isMatch) onConfirm(); if (e.key === 'Escape') onCancel(); }}
        />

        <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            background: '#334155', border: 'none', borderRadius: '6px',
            padding: '8px 16px', color: '#94a3b8', cursor: 'pointer', fontSize: '13px',
          }}>
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!isMatch}
            style={{
              background: isMatch ? colors.accent : '#334155',
              border: 'none', borderRadius: '6px',
              padding: '8px 16px', color: isMatch ? '#fff' : '#64748b',
              cursor: isMatch ? 'pointer' : 'not-allowed', fontSize: '13px',
              fontWeight: 600, transition: 'all 0.2s',
              opacity: isMatch ? 1 : 0.5,
            }}
          >
            {action === 'delete' ? 'Delete Forever' : 'Stop Job'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ──

export default function KanbanBoard({ node, onClose, onSwitchToChat }: Props) {
  const [board, setBoard] = useState<KanbanBoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCard, setSelectedCard] = useState<KanbanCard | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    action: 'stop' | 'delete';
    jobId: string;
    clientName?: string;
    phrase: string;
  } | null>(null);

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
      setTimeout(fetchBoard, 500);
    } catch (err) {
      console.error('Retry failed:', err);
    }
  };

  const handleStop = (card: KanbanCard) => {
    setConfirmAction({
      action: 'stop',
      jobId: card.jobId,
      clientName: card.clientName,
      phrase: generateConfirmPhrase(),
    });
  };

  const handleDelete = (card: KanbanCard) => {
    setConfirmAction({
      action: 'delete',
      jobId: card.jobId,
      clientName: card.clientName,
      phrase: generateConfirmPhrase(),
    });
  };

  const executeAction = async () => {
    if (!confirmAction) return;
    const { action, jobId } = confirmAction;
    try {
      if (action === 'stop') {
        const res = await fetch(`/api/pipeline/${jobId}/stop`, { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } else {
        const res = await fetch(`/api/pipeline/${jobId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      setConfirmAction(null);
      setSelectedCard(null);
      setTimeout(fetchBoard, 500);
    } catch (err) {
      console.error(`${action} failed:`, err);
      setConfirmAction(null);
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
      {/* Confirmation Modal */}
      {confirmAction && (
        <ConfirmModal
          action={confirmAction.action}
          jobId={confirmAction.jobId}
          clientName={confirmAction.clientName}
          phrase={confirmAction.phrase}
          onConfirm={executeAction}
          onCancel={() => setConfirmAction(null)}
        />
      )}

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

                      {/* Action buttons */}
                      <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                        {/* Retry button for failed jobs */}
                        {card.currentStageStatus === 'failed' && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRetry(card.jobId, card.currentStage);
                            }}
                            style={{
                              flex: 1,
                              background: '#1e293b',
                              border: '1px solid #f59e0b',
                              borderRadius: '4px',
                              padding: '4px 8px',
                              color: '#f59e0b',
                              cursor: 'pointer',
                              fontSize: '11px',
                            }}
                          >
                            🔄 Retry
                          </button>
                        )}

                        {/* Stop button — only for active (non-terminal) jobs */}
                        {card.status !== 'completed' && card.status !== 'failed' && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStop(card);
                            }}
                            style={{
                              flex: 1,
                              background: '#1e293b',
                              border: '1px solid #f59e0b',
                              borderRadius: '4px',
                              padding: '4px 8px',
                              color: '#f59e0b',
                              cursor: 'pointer',
                              fontSize: '11px',
                            }}
                          >
                            ⛔ Stop
                          </button>
                        )}

                        {/* Delete button — always available */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(card);
                          }}
                          style={{
                            flex: 1,
                            background: '#1e293b',
                            border: '1px solid #ef4444',
                            borderRadius: '4px',
                            padding: '4px 8px',
                            color: '#ef4444',
                            cursor: 'pointer',
                            fontSize: '11px',
                          }}
                        >
                          🗑️ Delete
                        </button>
                      </div>
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
