import { useState, useEffect, useCallback } from 'react';
import type { AgentNode } from '../types/index.js';

interface Props {
  node: AgentNode;
  onClose: () => void;
  onSwitchToChat: () => void;
  onSwitchToConfig: () => void;
}

interface DriveEventFolder {
  folderId: string;
  folderName: string;
  audioFiles: { id: string; name: string; size: number; selected: boolean }[];
  votingFiles: { id: string; name: string; size: number }[];
  status: 'detected' | 'queued' | 'processing' | 'completed' | 'error';
  jobId?: string;
}

interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}

export default function QueuePanel({ node, onClose, onSwitchToChat, onSwitchToConfig }: Props) {
  const [folders, setFolders] = useState<DriveEventFolder[]>([]);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedFolder, setExpandedFolder] = useState<string | null>(null);

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch('/api/agents/yulieth/queue');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setFolders(data.folders || []);
      setQueueStats(data.stats || null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, 15_000);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  const handleEnqueue = useCallback(async (folderId: string) => {
    try {
      const res = await fetch('/api/agents/yulieth/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enqueue failed');
    }
  }, [fetchQueue]);

  const handleReset = useCallback(async (folderId: string) => {
    try {
      const res = await fetch('/api/agents/yulieth/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed');
    }
  }, [fetchQueue]);

  const handleToggleFile = useCallback(async (folderId: string, fileId: string, selected: boolean) => {
    // Optimistic update
    setFolders(prev => prev.map(f => {
      if (f.folderId !== folderId) return f;
      return { ...f, audioFiles: f.audioFiles.map(af => af.id === fileId ? { ...af, selected } : af) };
    }));
    try {
      const res = await fetch('/api/agents/yulieth/selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId, fileSelections: [{ fileId, selected }] }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Selection failed');
      await fetchQueue(); // Revert on failure
    }
  }, [fetchQueue]);

  const handleToggleAll = useCallback(async (folderId: string, selectAll: boolean) => {
    const folder = folders.find(f => f.folderId === folderId);
    if (!folder) return;
    // Optimistic update
    setFolders(prev => prev.map(f => {
      if (f.folderId !== folderId) return f;
      return { ...f, audioFiles: f.audioFiles.map(af => ({ ...af, selected: selectAll })) };
    }));
    try {
      const res = await fetch('/api/agents/yulieth/selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderId,
          fileSelections: folder.audioFiles.map(f => ({ fileId: f.id, selected: selectAll })),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Selection failed');
      await fetchQueue();
    }
  }, [folders, fetchQueue]);

  const statusColor = (s: string) => {
    switch (s) {
      case 'detected': return '#f59e0b';
      case 'queued': return '#38bdf8';
      case 'processing': return '#22c55e';
      case 'completed': return '#10b981';
      case 'error': return '#ef4444';
      default: return '#64748b';
    }
  };

  const statusIcon = (s: string) => {
    switch (s) {
      case 'detected': return '🔍';
      case 'queued': return '📋';
      case 'processing': return '⚡';
      case 'completed': return '✅';
      case 'error': return '❌';
      default: return '❓';
    }
  };

  return (
    <div style={{
      width: '420px',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#1e293b',
      borderLeft: `3px solid ${node.color}`,
      overflow: 'hidden',
      userSelect: 'text',
      WebkitUserSelect: 'text',
    }}
    onPointerDownCapture={(e) => e.stopPropagation()}
    onMouseDownCapture={(e) => e.stopPropagation()}
    onKeyDownCapture={(e) => {
      e.stopPropagation();
    }}
    onContextMenu={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 18px',
        background: '#0f172a',
        borderBottom: '1px solid #334155',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '22px' }}>📂</span>
          <div>
            <h3 style={{ margin: 0, color: '#f1f5f9', fontSize: '15px', fontWeight: 700 }}>
              {node.label}'s Queue
            </h3>
            <p style={{ margin: 0, color: '#64748b', fontSize: '11px' }}>Drive files &amp; processing queue</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={onSwitchToConfig} style={headerBtnStyle} title="Configure">⚙️</button>
          <button onClick={onSwitchToChat} style={headerBtnStyle} title="Chat">💬</button>
          <button onClick={onClose} style={headerBtnStyle} title="Close">✕</button>
        </div>
      </div>

      {/* Queue Stats Bar */}
      {queueStats && (
        <div style={{
          display: 'flex',
          gap: '2px',
          padding: '12px 18px',
          background: '#0f172a',
          borderBottom: '1px solid #334155',
        }}>
          <QStat label="Pending" value={queueStats.pending} color="#f59e0b" />
          <QStat label="Active" value={queueStats.processing} color="#22c55e" />
          <QStat label="Done" value={queueStats.completed} color="#38bdf8" />
          <QStat label="Failed" value={queueStats.failed} color="#ef4444" />
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#64748b' }}>Loading queue…</div>
        )}

        {error && (
          <div style={{
            padding: '12px',
            borderRadius: '6px',
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid #ef444433',
            color: '#fca5a5',
            fontSize: '12px',
            marginBottom: '12px',
          }}>
            ❌ {error}
          </div>
        )}

        {!loading && folders.length === 0 && !error && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <span style={{ fontSize: '40px', display: 'block', marginBottom: '12px' }}>📭</span>
            <p style={{ color: '#64748b', fontSize: '13px', margin: 0 }}>No files in queue</p>
            <p style={{ color: '#475569', fontSize: '11px', margin: '6px 0 0' }}>
              Configure a Drive folder and start the watcher, or scan manually.
            </p>
          </div>
        )}

        {folders.map((folder) => {
          const isExpanded = expandedFolder === folder.folderId;
          const totalFiles = folder.audioFiles.length + folder.votingFiles.length;

          return (
            <div
              key={folder.folderId}
              style={{
                background: '#0f172a',
                borderRadius: '8px',
                border: `1px solid ${isExpanded ? node.color + '66' : '#334155'}`,
                marginBottom: '8px',
                overflow: 'hidden',
              }}
            >
              {/* Folder header */}
              <div
                onClick={() => setExpandedFolder(isExpanded ? null : folder.folderId)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '10px 14px',
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: '14px', transition: 'transform 0.2s', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                  ▶
                </span>
                <span style={{ fontSize: '15px' }}>{statusIcon(folder.status)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: '#e2e8f0', fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {folder.folderName}
                  </div>
                  <div style={{ color: '#64748b', fontSize: '11px', marginTop: '2px' }}>
                    {folder.audioFiles.filter(f => f.selected).length}/{folder.audioFiles.length} audio · {folder.votingFiles.length} voting
                  </div>
                </div>
                <span style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  color: statusColor(folder.status),
                  background: statusColor(folder.status) + '18',
                  padding: '3px 8px',
                  borderRadius: '4px',
                  letterSpacing: '0.05em',
                }}>
                  {folder.status}
                </span>
              </div>

              {/* Expanded file list */}
              {isExpanded && (
                <div style={{ padding: '0 14px 12px', borderTop: '1px solid #1e293b' }}>
                  {folder.audioFiles.length > 0 && (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <div style={{ color: '#94a3b8', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' }}>
                          🎵 Audio Files ({folder.audioFiles.filter(f => f.selected).length}/{folder.audioFiles.length})
                        </div>
                        {folder.status === 'detected' && folder.audioFiles.length > 1 && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const allSelected = folder.audioFiles.every(f => f.selected);
                              handleToggleAll(folder.folderId, !allSelected);
                            }}
                            style={{ background: 'none', border: 'none', color: '#7c3aed', fontSize: '10px', cursor: 'pointer', padding: '0 4px' }}
                          >
                            {folder.audioFiles.every(f => f.selected) ? 'Deselect All' : 'Select All'}
                          </button>
                        )}
                      </div>
                      {folder.audioFiles.map((f) => (
                        <FileRow
                          key={f.id}
                          name={f.name}
                          size={f.size}
                          selected={f.selected}
                          canSelect={folder.status === 'detected'}
                          onToggle={() => handleToggleFile(folder.folderId, f.id, !f.selected)}
                        />
                      ))}
                    </div>
                  )}
                  {folder.votingFiles.length > 0 && (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ color: '#94a3b8', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', marginBottom: '4px' }}>
                        📊 Voting / Attendance
                      </div>
                      {folder.votingFiles.map((f) => (
                        <FileRow key={f.id} name={f.name} size={f.size} />
                      ))}
                    </div>
                  )}

                  {/* Action buttons */}
                  {folder.status === 'detected' && (() => {
                    const selectedCount = folder.audioFiles.filter(f => f.selected).length;
                    const canEnqueue = selectedCount > 0;
                    return (
                      <button
                        onClick={(e) => { e.stopPropagation(); if (canEnqueue) handleEnqueue(folder.folderId); }}
                        disabled={!canEnqueue}
                        style={{
                          marginTop: '10px',
                          width: '100%',
                          background: canEnqueue ? '#7c3aed' : '#334155',
                          color: canEnqueue ? '#fff' : '#64748b',
                          border: 'none',
                          borderRadius: '6px',
                          padding: '8px',
                          fontSize: '12px',
                          fontWeight: 600,
                          cursor: canEnqueue ? 'pointer' : 'not-allowed',
                        }}
                      >
                        📋 Queue for Processing ({selectedCount} file{selectedCount !== 1 ? 's' : ''})
                      </button>
                    );
                  })()}
                  {folder.status !== 'detected' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleReset(folder.folderId); }}
                      style={{
                        marginTop: '10px',
                        width: '100%',
                        background: 'transparent',
                        color: '#f59e0b',
                        border: '1px solid #f59e0b55',
                        borderRadius: '6px',
                        padding: '8px',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      🔄 Reset to Detected
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{
        padding: '10px 18px',
        background: '#0f172a',
        borderTop: '1px solid #334155',
        flexShrink: 0,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span style={{ color: '#475569', fontSize: '11px' }}>
          Auto-refreshes every 15s
        </span>
        <button
          onClick={fetchQueue}
          style={{
            background: '#334155',
            color: '#e2e8f0',
            border: '1px solid #475569',
            borderRadius: '6px',
            padding: '6px 14px',
            fontSize: '12px',
            cursor: 'pointer',
          }}
        >
          🔄 Refresh
        </button>
      </div>
    </div>
  );
}

function FileRow({ name, size, selected, canSelect, onToggle }: {
  name: string;
  size: number;
  selected?: boolean;
  canSelect?: boolean;
  onToggle?: () => void;
}) {
  const sizeStr = size > 1_048_576
    ? `${(size / 1_048_576).toFixed(1)} MB`
    : size > 1024
      ? `${(size / 1024).toFixed(0)} KB`
      : `${size} B`;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '4px 8px',
      borderRadius: '4px',
      fontSize: '12px',
      opacity: selected === false ? 0.45 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flex: 1 }}>
        {canSelect && (
          <input
            type="checkbox"
            checked={selected ?? true}
            onChange={(e) => { e.stopPropagation(); onToggle?.(); }}
            style={{ accentColor: '#7c3aed', cursor: 'pointer', flexShrink: 0 }}
          />
        )}
        <span style={{
          color: '#cbd5e1',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textDecoration: selected === false ? 'line-through' : 'none',
        }}>
          {name}
        </span>
      </div>
      <span style={{ color: '#64748b', fontSize: '11px', flexShrink: 0, marginLeft: '8px' }}>
        {sizeStr}
      </span>
    </div>
  );
}

function QStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      flex: 1,
      textAlign: 'center',
      padding: '4px',
    }}>
      <div style={{ color, fontSize: '18px', fontWeight: 700, fontFamily: 'monospace' }}>{value}</div>
      <div style={{ color: '#64748b', fontSize: '10px', marginTop: '2px' }}>{label}</div>
    </div>
  );
}

const headerBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#64748b',
  fontSize: '16px',
  cursor: 'pointer',
  padding: '4px 8px',
  borderRadius: '4px',
  lineHeight: 1,
};
