import { useState, useEffect, useCallback } from 'react';
import type { AgentNode } from '../types/index.js';

interface Props {
  node: AgentNode;
  onClose: () => void;
  onSwitchToChat: () => void;
}

interface GloriaJob {
  jobId: string;
  clientName?: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  stats: {
    total: number;
    pending: number;
    reviewing: number;
    fixed: number;
    dismissed: number;
    critical: number;
    warning: number;
    info: number;
  };
  itemCount: number;
}

export default function GloriaQueuePanel({ node, onClose, onSwitchToChat }: Props) {
  const [jobs, setJobs] = useState<GloriaJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch('/api/agents/gloria/queue');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setJobs(data.jobs || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, 10_000);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  const statusColor = (s: string) => {
    switch (s) {
      case 'ready': return '#10b981';
      case 'in_review': return '#3b82f6';
      case 'completed': return '#8b5cf6';
      case 'analyzing': return '#f59e0b';
      case 'failed': return '#ef4444';
      default: return '#94a3b8';
    }
  };

  const statusLabel = (s: string) => {
    switch (s) {
      case 'ready': return '✅ Revisión lista';
      case 'in_review': return '🔍 En revisión';
      case 'completed': return '✔️ Completada';
      case 'analyzing': return '⏳ Analizando…';
      case 'failed': return '❌ Error';
      default: return s;
    }
  };

  return (
    <div style={{
      width: '380px',
      minWidth: '380px',
      background: '#1e293b',
      borderLeft: '1px solid #334155',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        borderBottom: '1px solid #334155',
        background: '#0f172a',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '18px' }}>🔍</span>
          <span style={{ fontWeight: 700, fontSize: '14px' }}>Gloria — Revisión IA</span>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            onClick={onSwitchToChat}
            title="Chat"
            style={{
              background: 'none', border: 'none', color: '#94a3b8',
              cursor: 'pointer', fontSize: '16px', padding: '4px',
            }}
          >
            💬
          </button>
          <button
            onClick={onClose}
            title="Close"
            style={{
              background: 'none', border: 'none', color: '#94a3b8',
              cursor: 'pointer', fontSize: '16px', padding: '4px',
            }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
        {loading && (
          <div style={{ textAlign: 'center', color: '#94a3b8', padding: '40px 0' }}>
            ⏳ Cargando revisiones…
          </div>
        )}

        {error && (
          <div style={{
            padding: '12px', background: 'rgba(239,68,68,0.1)',
            border: '1px solid #ef444433', borderRadius: '8px',
            color: '#fca5a5', fontSize: '12px', textAlign: 'center',
          }}>
            ❌ {error}
          </div>
        )}

        {!loading && !error && jobs.length === 0 && (
          <div style={{ textAlign: 'center', color: '#94a3b8', padding: '40px 0' }}>
            <div style={{ fontSize: '32px', marginBottom: '8px' }}>📭</div>
            <div>No hay revisiones aún</div>
            <div style={{ fontSize: '11px', marginTop: '4px', color: '#64748b' }}>
              Las revisiones aparecerán cuando se analicen documentos
            </div>
          </div>
        )}

        {!loading && !error && jobs.map((job) => (
          <div
            key={job.jobId}
            style={{
              background: '#0f172a',
              borderRadius: '8px',
              border: '1px solid #334155',
              padding: '12px',
              marginBottom: '8px',
            }}
          >
            {/* Client name / nickname — primary identifier */}
            {job.clientName && (
              <div style={{
                fontSize: '13px', fontWeight: 700, color: '#f1f5f9',
                marginBottom: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                🏢 {job.clientName}
              </div>
            )}

            {/* Job ID — secondary */}
            <div style={{
              fontSize: '10px', color: '#475569', fontFamily: 'monospace',
              marginBottom: '6px', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {job.jobId.slice(0, 16)}…
            </div>

            {/* Status */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px',
            }}>
              <div style={{
                width: '8px', height: '8px', borderRadius: '50%',
                background: statusColor(job.status),
              }} />
              <span style={{ fontSize: '12px', fontWeight: 600 }}>
                {statusLabel(job.status)}
              </span>
            </div>

            {/* Stats */}
            {['ready', 'in_review', 'completed'].includes(job.status) && job.stats && (
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '4px', marginBottom: '8px',
              }}>
                <StatBadge label="Total" value={job.stats.total} color="#94a3b8" />
                <StatBadge label="Pendientes" value={job.stats.pending} color="#f59e0b" />
                <StatBadge label="Corregidos" value={job.stats.fixed} color="#10b981" />
                <StatBadge label="Críticos" value={job.stats.critical} color="#ef4444" />
                <StatBadge label="Advertencias" value={job.stats.warning} color="#f59e0b" />
                <StatBadge label="Info" value={job.stats.info} color="#3b82f6" />
              </div>
            )}

            {/* Timestamps */}
            {job.startedAt && (
              <div style={{ fontSize: '10px', color: '#64748b' }}>
                Iniciado: {new Date(job.startedAt).toLocaleString()}
              </div>
            )}
            {job.completedAt && (
              <div style={{ fontSize: '10px', color: '#64748b' }}>
                Completado: {new Date(job.completedAt).toLocaleString()}
              </div>
            )}

            {/* Error */}
            {job.error && (
              <div style={{
                marginTop: '6px', padding: '6px',
                background: 'rgba(239,68,68,0.1)', border: '1px solid #ef444433',
                borderRadius: '4px', color: '#fca5a5', fontSize: '11px',
              }}>
                ❌ {job.error}
              </div>
            )}

            {/* Open review button */}
            {['ready', 'in_review', 'completed'].includes(job.status) && (
              <div style={{ marginTop: '8px' }}>
                <button
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('open-review', { detail: { jobId: job.jobId } }));
                  }}
                  style={{
                    width: '100%',
                    background: 'linear-gradient(135deg, #10b981, #059669)',
                    border: 'none',
                    borderRadius: '6px',
                    padding: '8px 12px',
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                  }}
                >
                  🔍 Revisar con IA
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatBadge({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      background: '#1e293b',
      borderRadius: '4px',
      padding: '4px 6px',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: '14px', fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: '9px', color: '#64748b' }}>{label}</div>
    </div>
  );
}
