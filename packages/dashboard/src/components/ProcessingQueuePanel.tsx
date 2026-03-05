import { useState, useEffect, useCallback } from 'react';
import type { AgentNode } from '../types/index.js';

interface Props {
  node: AgentNode;
  agentId: 'chucho' | 'jaime';
  onClose: () => void;
  onSwitchToChat: () => void;
}

// ── Chucho types ──
interface ChuchoJob {
  jobId: string;
  status: 'pending' | 'downloading' | 'preprocessing' | 'completed' | 'failed';
  totalFiles: number;
  processedFiles: number;
  currentFile: string | null;
  downloadedFiles: number;
  totalDownloadFiles: number;
  totalSegments: number;
  totalDurationSec: number;
  costEstimate: number;
  startedAt: number;
  updatedAt: number;
  elapsedMs: number;
  error: string | null;
}

// ── Jaime types ──
interface JaimeSegment {
  fileName: string;
  status: string;
  currentStep: number;
  totalSteps: number;
  segmentsProcessed: number;
  durationSec: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
}

interface JaimeJob {
  jobId: string;
  provider: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  totalSegments: number;
  completedSegments: number;
  failedSegments: number;
  segments: JaimeSegment[];
  totalDurationSec: number;
  elapsedMs: number;
  etaMs: number | null;
  progressPct: number;
  startedAt: number | null;
  updatedAt: number;
}

export default function ProcessingQueuePanel({ node, agentId, onClose, onSwitchToChat }: Props) {
  const [chuchoJobs, setChuchoJobs] = useState<ChuchoJob[]>([]);
  const [jaimeJobs, setJaimeJobs] = useState<JaimeJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/queue`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();

      if (agentId === 'chucho') {
        setChuchoJobs(data.jobs || []);
      } else {
        setJaimeJobs(data.jobs || []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, 5_000); // refresh every 5s
    return () => clearInterval(interval);
  }, [fetchQueue]);

  const isChucho = agentId === 'chucho';
  const agentLabel = isChucho ? 'Chucho' : 'Jaime';
  const agentIcon = isChucho ? '🎛️' : '🎤';
  const jobs = isChucho ? chuchoJobs : jaimeJobs;
  const hasJobs = jobs.length > 0;

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
    onKeyDownCapture={(e) => e.stopPropagation()}
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
          <span style={{ fontSize: '22px' }}>{agentIcon}</span>
          <div>
            <h3 style={{ margin: 0, color: '#f1f5f9', fontSize: '15px', fontWeight: 700 }}>
              {agentLabel}'s Queue
            </h3>
            <p style={{ margin: 0, color: '#64748b', fontSize: '11px' }}>
              {isChucho ? 'Audio preprocessing jobs' : 'Transcription & sectioning jobs'}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={onSwitchToChat} style={headerBtnStyle} title="Chat">💬</button>
          <button onClick={onClose} style={headerBtnStyle} title="Close">✕</button>
        </div>
      </div>

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

        {!loading && !hasJobs && !error && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <span style={{ fontSize: '40px', display: 'block', marginBottom: '12px' }}>
              {isChucho ? '😴' : '🎧'}
            </span>
            <p style={{ color: '#64748b', fontSize: '13px', margin: 0 }}>No active jobs</p>
            <p style={{ color: '#475569', fontSize: '11px', margin: '6px 0 0' }}>
              {isChucho
                ? 'Chucho is idle. Enqueue a folder to start preprocessing.'
                : 'Jaime is idle. Processed audio will be queued automatically.'}
            </p>
          </div>
        )}

        {/* Chucho jobs */}
        {isChucho && chuchoJobs.map((job) => (
          <ChuchoJobCard
            key={job.jobId}
            job={job}
            color={node.color}
            expanded={expandedJob === job.jobId}
            onToggle={() => setExpandedJob(expandedJob === job.jobId ? null : job.jobId)}
          />
        ))}

        {/* Jaime jobs */}
        {!isChucho && jaimeJobs.map((job) => (
          <JaimeJobCard
            key={job.jobId}
            job={job}
            color={node.color}
            expanded={expandedJob === job.jobId}
            onToggle={() => setExpandedJob(expandedJob === job.jobId ? null : job.jobId)}
          />
        ))}
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
          Auto-refreshes every 5s
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

// ══════════════════════════════════════
//  Chucho Job Card
// ══════════════════════════════════════

function ChuchoJobCard({ job, color, expanded, onToggle }: {
  job: ChuchoJob; color: string; expanded: boolean; onToggle: () => void;
}) {
  const statusColor = getStatusColor(job.status);
  const elapsed = formatDuration(job.elapsedMs);

  return (
    <div style={{
      background: '#0f172a',
      borderRadius: '8px',
      border: `1px solid ${expanded ? color + '66' : '#334155'}`,
      marginBottom: '8px',
      overflow: 'hidden',
    }}>
      <div onClick={onToggle} style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '10px 14px', cursor: 'pointer',
      }}>
        <span style={{
          fontSize: '14px', transition: 'transform 0.2s',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>▶</span>
        <span style={{ fontSize: '15px' }}>{getStatusIcon(job.status)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: '#e2e8f0', fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Job {job.jobId.substring(0, 8)}…
          </div>
          <div style={{ color: '#64748b', fontSize: '11px', marginTop: '2px' }}>
            {job.status === 'downloading'
              ? `Downloading ${job.downloadedFiles}/${job.totalDownloadFiles} files`
              : job.status === 'preprocessing'
                ? `Preprocessing • ${elapsed}`
                : job.status === 'completed'
                  ? `${job.totalSegments} segments • ${formatDuration(job.totalDurationSec * 1000)} audio`
                  : job.status === 'failed'
                    ? `Failed: ${job.error?.substring(0, 60)}`
                    : 'Pending…'}
          </div>
        </div>
        <StatusBadge status={job.status} color={statusColor} />
      </div>

      {/* Progress bar */}
      {(job.status === 'downloading' || job.status === 'preprocessing') && (
        <div style={{ padding: '0 14px 8px' }}>
          <ProgressBar
            value={job.status === 'downloading'
              ? (job.totalDownloadFiles > 0 ? (job.downloadedFiles / job.totalDownloadFiles) * 100 : 0)
              : 50 /* preprocessing is hard to estimate */}
            color={color}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
            <span style={{ color: '#64748b', fontSize: '10px' }}>⏱ {elapsed}</span>
            {job.currentFile && (
              <span style={{ color: '#64748b', fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '200px', whiteSpace: 'nowrap' }}>
                📄 {job.currentFile}
              </span>
            )}
          </div>
        </div>
      )}

      {expanded && job.status === 'completed' && (
        <div style={{ padding: '0 14px 12px', borderTop: '1px solid #1e293b' }}>
          <InfoRow label="Segments" value={String(job.totalSegments)} />
          <InfoRow label="Total Duration" value={formatDuration(job.totalDurationSec * 1000)} />
          <InfoRow label="Est. Cost" value={`$${job.costEstimate.toFixed(2)}`} />
          <InfoRow label="Processing Time" value={elapsed} />
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════
//  Jaime Job Card
// ══════════════════════════════════════

function JaimeJobCard({ job, color, expanded, onToggle }: {
  job: JaimeJob; color: string; expanded: boolean; onToggle: () => void;
}) {
  const statusColor = getStatusColor(job.status);
  const elapsed = formatDuration(job.elapsedMs);
  const eta = job.etaMs ? formatDuration(job.etaMs) : null;

  return (
    <div style={{
      background: '#0f172a',
      borderRadius: '8px',
      border: `1px solid ${expanded ? color + '66' : '#334155'}`,
      marginBottom: '8px',
      overflow: 'hidden',
    }}>
      <div onClick={onToggle} style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '10px 14px', cursor: 'pointer',
      }}>
        <span style={{
          fontSize: '14px', transition: 'transform 0.2s',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>▶</span>
        <span style={{ fontSize: '15px' }}>{getStatusIcon(job.status)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: '#e2e8f0', fontSize: '13px', fontWeight: 600 }}>
            Job {job.jobId.substring(0, 8)}… <span style={{ fontWeight: 400, color: '#94a3b8', fontSize: '11px' }}>({job.provider})</span>
          </div>
          <div style={{ color: '#64748b', fontSize: '11px', marginTop: '2px' }}>
            {job.completedSegments}/{job.totalSegments} segments •{' '}
            {job.progressPct}% •{' '}
            {elapsed}
            {eta && ` • ETA ${eta}`}
          </div>
        </div>
        <StatusBadge status={job.status} color={statusColor} />
      </div>

      {/* Progress bar */}
      {job.status === 'processing' && (
        <div style={{ padding: '0 14px 8px' }}>
          <ProgressBar value={job.progressPct} color={color} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
            <span style={{ color: '#64748b', fontSize: '10px' }}>
              ⏱ {elapsed}
            </span>
            {eta && (
              <span style={{ color: '#94a3b8', fontSize: '10px' }}>
                🏁 ETA: {eta}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Expanded segment list */}
      {expanded && (
        <div style={{ padding: '0 14px 12px', borderTop: '1px solid #1e293b' }}>
          <div style={{ color: '#94a3b8', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', margin: '8px 0 4px' }}>
            Audio Segments
          </div>
          {job.segments.map((seg, i) => (
            <SegmentRow key={i} segment={seg} index={i} color={color} />
          ))}

          <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #334155' }}>
            <InfoRow label="Provider" value={job.provider} />
            <InfoRow label="Total Audio" value={formatDuration(job.totalDurationSec * 1000)} />
            <InfoRow label="Failed" value={String(job.failedSegments)} />
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════
//  Segment Row (Jaime)
// ══════════════════════════════════════

const STEP_LABELS: Record<number, string> = {
  1: 'Preprocessing',
  2: 'Transcribing',
  3: 'Diarizing',
  4: 'Merging',
  5: 'Saving',
};

function SegmentRow({ segment, index, color }: { segment: JaimeSegment; index: number; color: string }) {
  const statusColor = getSegmentStatusColor(segment.status);
  const stepLabel = STEP_LABELS[segment.currentStep] || '';
  const elapsed = segment.startedAt ? formatDuration(
    (segment.completedAt || Date.now()) - segment.startedAt
  ) : '';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '6px 8px', borderRadius: '4px',
      background: segment.status === 'completed' ? 'rgba(34,197,94,0.05)' :
        segment.status === 'failed' ? 'rgba(239,68,68,0.05)' :
          segment.status !== 'pending' ? 'rgba(56,189,248,0.05)' : 'transparent',
      marginBottom: '2px',
    }}>
      <span style={{ fontSize: '12px', color: '#64748b', fontFamily: 'monospace', minWidth: '20px' }}>
        #{index}
      </span>
      <span style={{ fontSize: '12px' }}>{getSegmentIcon(segment.status)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: '#cbd5e1', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {segment.fileName}
        </div>
        {segment.status !== 'pending' && segment.status !== 'completed' && segment.status !== 'failed' && (
          <div style={{ color: '#64748b', fontSize: '10px', marginTop: '1px' }}>
            Step {segment.currentStep}/5: {stepLabel}
            {segment.segmentsProcessed > 0 && ` • ${segment.segmentsProcessed} segs`}
            {elapsed && ` • ${elapsed}`}
          </div>
        )}
        {segment.status === 'completed' && elapsed && (
          <div style={{ color: '#4ade80', fontSize: '10px', marginTop: '1px' }}>
            ✓ {elapsed} • {formatDuration(segment.durationSec * 1000)} audio
          </div>
        )}
        {segment.status === 'failed' && (
          <div style={{ color: '#fca5a5', fontSize: '10px', marginTop: '1px' }}>
            ✗ {segment.error?.substring(0, 60)}
          </div>
        )}
      </div>
      {/* Mini progress for active segments */}
      {segment.status !== 'pending' && segment.status !== 'completed' && segment.status !== 'failed' && (
        <div style={{
          width: '40px', height: '4px', borderRadius: '2px',
          background: '#334155', overflow: 'hidden', flexShrink: 0,
        }}>
          <div style={{
            height: '100%', borderRadius: '2px',
            background: color,
            width: `${Math.round((segment.currentStep / segment.totalSteps) * 100)}%`,
            transition: 'width 0.3s',
          }} />
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════
//  Shared UI Components
// ══════════════════════════════════════

function ProgressBar({ value, color }: { value: number; color: string }) {
  return (
    <div style={{
      width: '100%', height: '6px', borderRadius: '3px',
      background: '#334155', overflow: 'hidden',
    }}>
      <div style={{
        height: '100%', borderRadius: '3px',
        background: `linear-gradient(90deg, ${color}, ${color}cc)`,
        width: `${Math.min(value, 100)}%`,
        transition: 'width 0.5s ease',
      }} />
    </div>
  );
}

function StatusBadge({ status, color }: { status: string; color: string }) {
  return (
    <span style={{
      fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
      color, background: color + '18',
      padding: '3px 8px', borderRadius: '4px', letterSpacing: '0.05em',
    }}>
      {status}
    </span>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '3px 0', fontSize: '11px',
    }}>
      <span style={{ color: '#64748b' }}>{label}</span>
      <span style={{ color: '#e2e8f0', fontFamily: 'monospace' }}>{value}</span>
    </div>
  );
}

// ══════════════════════════════════════
//  Helpers
// ══════════════════════════════════════

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'pending': return '#f59e0b';
    case 'downloading': return '#38bdf8';
    case 'preprocessing': case 'processing': return '#8b5cf6';
    case 'completed': return '#22c55e';
    case 'failed': case 'crashed': return '#ef4444';
    default: return '#64748b';
  }
}

function getStatusIcon(status: string): string {
  switch (status) {
    case 'pending': return '⏳';
    case 'downloading': return '⬇️';
    case 'preprocessing': return '🎛️';
    case 'processing': return '⚡';
    case 'completed': return '✅';
    case 'failed': return '❌';
    case 'crashed': return '💥';
    default: return '❓';
  }
}

function getSegmentIcon(status: string): string {
  switch (status) {
    case 'pending': return '⬜';
    case 'preprocessing': return '🔄';
    case 'transcribing': return '🎤';
    case 'diarizing': return '👥';
    case 'merging': return '🔗';
    case 'saving': return '💾';
    case 'completed': return '✅';
    case 'failed': return '❌';
    default: return '⬜';
  }
}

function getSegmentStatusColor(status: string): string {
  switch (status) {
    case 'pending': return '#64748b';
    case 'transcribing': return '#38bdf8';
    case 'diarizing': return '#a78bfa';
    case 'completed': return '#22c55e';
    case 'failed': return '#ef4444';
    default: return '#f59e0b';
  }
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
