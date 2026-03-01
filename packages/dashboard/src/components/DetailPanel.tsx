import type { AgentNode, AgentStatus, AgentStats } from '../types/index.js';

interface Props {
  node: AgentNode;
  status: AgentStatus | null;
  stats: AgentStats | null;
  onClose: () => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  const h = m / 60;
  return `${h.toFixed(1)}h`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${rm}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function timeAgo(isoString: string | null): string {
  if (!isoString) return 'never';
  const diff = Date.now() - new Date(isoString).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function DetailPanel({ node, status, stats, onClose }: Props) {
  const stateColor = status?.state === 'processing'
    ? '#22c55e'
    : status?.state === 'error'
      ? '#ef4444'
      : '#94a3b8';

  return (
    <div style={{
      background: '#1e293b',
      borderTop: `3px solid ${node.color}`,
      padding: '20px 28px',
      display: 'flex',
      gap: '40px',
      alignItems: 'flex-start',
      minHeight: '160px',
      position: 'relative',
    }}>
      {/* Close button */}
      <button
        onClick={onClose}
        style={{
          position: 'absolute',
          top: '10px',
          right: '16px',
          background: 'none',
          border: 'none',
          color: '#64748b',
          fontSize: '20px',
          cursor: 'pointer',
          lineHeight: 1,
        }}
        aria-label="Close"
      >
        ✕
      </button>

      {/* Agent identity */}
      <div style={{ minWidth: '180px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
          <span style={{ fontSize: '28px' }}>{node.icon}</span>
          <div>
            <h3 style={{ margin: 0, color: '#f1f5f9', fontSize: '18px' }}>{node.label}</h3>
            <p style={{ margin: 0, color: '#94a3b8', fontSize: '12px' }}>{node.description}</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' }}>
          <span style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: stateColor,
            display: 'inline-block',
            boxShadow: status?.state === 'processing' ? `0 0 8px ${stateColor}` : 'none',
          }} />
          <span style={{ color: '#cbd5e1', fontSize: '13px', textTransform: 'capitalize' }}>
            {status?.state ?? 'unknown'}
          </span>
        </div>
      </div>

      {/* Current activity */}
      <div style={{ minWidth: '200px' }}>
        <h4 style={{ margin: '0 0 10px', color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Current Activity
        </h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <InfoRow label="Job" value={status?.currentJob ?? '—'} />
          <InfoRow label="Event" value={status?.currentEvent ?? '—'} />
          <InfoRow label="Last Active" value={timeAgo(status?.lastActivity ?? null)} />
          <InfoRow label="Uptime" value={status ? formatUptime(status.uptime) : '—'} />
        </div>
      </div>

      {/* 30-day stats */}
      <div style={{ minWidth: '260px' }}>
        <h4 style={{ margin: '0 0 10px', color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Last 30 Days
        </h4>
        {stats ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <StatCard label="Processed" value={stats.last30Days.jobsProcessed} color="#22c55e" />
            <StatCard label="Failed" value={stats.last30Days.jobsFailed} color="#ef4444" />
            <StatCard label="Avg Duration" value={formatDuration(stats.last30Days.averageDurationMs)} color="#38bdf8" />
            <StatCard label="Total Time" value={formatDuration(stats.last30Days.totalDurationMs)} color="#a78bfa" />
          </div>
        ) : (
          <p style={{ color: '#475569', fontSize: '13px', margin: 0 }}>No stats available</p>
        )}
      </div>

      {/* Today */}
      <div style={{ minWidth: '140px' }}>
        <h4 style={{ margin: '0 0 10px', color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Today
        </h4>
        {stats ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <StatCard label="Processed" value={stats.today.jobsProcessed} color="#22c55e" />
            <StatCard label="Failed" value={stats.today.jobsFailed} color="#ef4444" />
          </div>
        ) : (
          <p style={{ color: '#475569', fontSize: '13px', margin: 0 }}>—</p>
        )}
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px' }}>
      <span style={{ color: '#64748b', fontSize: '12px' }}>{label}</span>
      <span style={{ color: '#e2e8f0', fontSize: '12px', fontFamily: 'monospace' }}>{value}</span>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div style={{
      background: '#0f172a',
      borderRadius: '8px',
      padding: '8px 12px',
      borderLeft: `3px solid ${color}`,
    }}>
      <div style={{ color: '#94a3b8', fontSize: '10px', marginBottom: '2px' }}>{label}</div>
      <div style={{ color: '#f1f5f9', fontSize: '16px', fontWeight: 700, fontFamily: 'monospace' }}>
        {value}
      </div>
    </div>
  );
}
