import { useState, useEffect, useCallback } from 'react';

// ── Types ──

interface StageInfo {
  stage: string;
  status: string;
  agentName: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

interface JobSummary {
  jobId: string;
  eventId: string;
  clientName: string;
  status: string;
  currentStage: string;
  currentStageStatus: string;
  stages: StageInfo[];
  createdAt: string;
  updatedAt: string;
  delegated: boolean;
  delegationWorkerIp: string | null;
  elapsedMs: number;
}

interface S3Stages {
  transcript: boolean;
  sections: boolean;
  redacted: boolean;
  output: boolean;
}

type FilterMode = 'all' | 'active' | 'completed' | 'failed';

interface Props {
  onClose: () => void;
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

const STATUS_COLORS: Record<string, string> = {
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
  pending: '·',
  processing: '⚙',
  completed: '✓',
  failed: '✗',
  retrying: '↻',
};

function statusBadge(status: string) {
  const color = STATUS_COLORS[status] || '#64748b';
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '10px',
      fontSize: '10px',
      fontWeight: 600,
      background: `${color}20`,
      color,
      border: `1px solid ${color}40`,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    }}>
      {status}
    </span>
  );
}

// ── S3 Status Dots ──

function S3Dots({ s3: s3Stages, loading }: { s3: S3Stages | null; loading: boolean }) {
  if (loading) {
    return <span style={{ fontSize: '11px', color: '#64748b' }}>checking S3…</span>;
  }
  if (!s3Stages) return null;

  const stages = [
    { key: 'transcript', label: 'T' },
    { key: 'sections', label: 'S' },
    { key: 'redacted', label: 'R' },
    { key: 'output', label: 'O' },
  ] as const;

  return (
    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
      <span style={{ fontSize: '10px', color: '#64748b', marginRight: '2px' }}>S3:</span>
      {stages.map(({ key, label }) => (
        <span
          key={key}
          title={`${key}: ${s3Stages[key] ? 'available' : 'missing'}`}
          style={{
            width: '18px',
            height: '18px',
            borderRadius: '3px',
            background: s3Stages[key] ? '#22c55e20' : '#1e293b',
            border: `1px solid ${s3Stages[key] ? '#22c55e' : '#334155'}`,
            color: s3Stages[key] ? '#22c55e' : '#475569',
            fontSize: '9px',
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

// ── Reprocess Dropdown ──

function ReprocessButton({ jobId, onReprocess }: {
  jobId: string;
  onReprocess: (jobId: string, fromStage: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const options = [
    { stage: 'preprocessing', label: 'From Preprocessing (Chucho)' },
    { stage: 'transcribing', label: 'From Transcribing (Jaime)' },
    { stage: 'sectioning', label: 'From Sectioning (Jaime)' },
    { stage: 'redacting', label: 'From Redacting (Lina)' },
    { stage: 'assembling', label: 'From Assembling (Fannery)' },
    { stage: 'reviewing', label: 'From Reviewing (Gloria)' },
  ];

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        style={{
          background: '#1e293b',
          border: '1px solid #6366f1',
          borderRadius: '4px',
          padding: '4px 10px',
          color: '#6366f1',
          cursor: 'pointer',
          fontSize: '11px',
          fontWeight: 600,
        }}
      >
        ↻ Reprocess
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: '4px',
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '6px',
            padding: '4px',
            zIndex: 100,
            minWidth: '200px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          {options.map(({ stage, label }) => (
            <button
              key={stage}
              onClick={() => { onReprocess(jobId, stage); setOpen(false); }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 10px',
                background: 'transparent',
                border: 'none',
                borderRadius: '4px',
                color: '#e2e8f0',
                cursor: 'pointer',
                fontSize: '12px',
              }}
              onMouseOver={(e) => (e.currentTarget.style.background = '#334155')}
              onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Component ──

export default function JobsPanel({ onClose }: Props) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>('all');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [s3Cache, setS3Cache] = useState<Record<string, S3Stages>>({});
  const [s3Loading, setS3Loading] = useState<Record<string, boolean>>({});
  const [reprocessing, setReprocessing] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/jobs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setJobs(data.jobs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch jobs');
    }
  }, []);

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 8000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  // Lazy-load S3 status when a job is selected
  useEffect(() => {
    if (!selectedJobId || s3Cache[selectedJobId]) return;
    setS3Loading(prev => ({ ...prev, [selectedJobId]: true }));
    fetch(`/api/jobs/${selectedJobId}/s3-status`)
      .then(r => r.json())
      .then(data => {
        setS3Cache(prev => ({ ...prev, [selectedJobId]: data.s3Stages }));
        setS3Loading(prev => ({ ...prev, [selectedJobId]: false }));
      })
      .catch(() => {
        setS3Loading(prev => ({ ...prev, [selectedJobId]: false }));
      });
  }, [selectedJobId, s3Cache]);

  const handleReprocess = async (jobId: string, fromStage: string) => {
    setReprocessing(jobId);
    try {
      const res = await fetch(`/api/jobs/${jobId}/reprocess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromStage }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setTimeout(fetchJobs, 1000);
    } catch (err) {
      console.error('Reprocess failed:', err);
    } finally {
      setReprocessing(null);
    }
  };

  const handleRetry = async (jobId: string, stage: string) => {
    try {
      await fetch(`/api/pipeline/${jobId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      });
      setTimeout(fetchJobs, 500);
    } catch (err) {
      console.error('Retry failed:', err);
    }
  };

  // Filter jobs
  const filteredJobs = jobs.filter(job => {
    if (filter === 'all') return true;
    if (filter === 'active') return !['completed', 'failed'].includes(job.status);
    return job.status === filter;
  });

  const counts = {
    all: jobs.length,
    active: jobs.filter(j => !['completed', 'failed'].includes(j.status)).length,
    completed: jobs.filter(j => j.status === 'completed').length,
    failed: jobs.filter(j => j.status === 'failed').length,
  };

  return (
    <div style={{
      width: '700px',
      minWidth: '500px',
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
            &#128188;
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: '15px', color: '#f1f5f9' }}>
              Jobs
            </div>
            <div style={{ fontSize: '12px', color: '#94a3b8' }}>
              {jobs.length} jobs in Redis
            </div>
          </div>
        </div>
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

      {/* Filter bar */}
      <div style={{
        display: 'flex',
        gap: '4px',
        padding: '8px 16px',
        borderBottom: '1px solid #1e293b',
        flexShrink: 0,
      }}>
        {(['all', 'active', 'completed', 'failed'] as FilterMode[]).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              background: filter === f ? '#334155' : 'transparent',
              border: filter === f ? '1px solid #475569' : '1px solid transparent',
              borderRadius: '6px',
              padding: '4px 12px',
              color: filter === f ? '#f1f5f9' : '#64748b',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: filter === f ? 600 : 400,
            }}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)} ({counts[f]})
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: '12px 16px', color: '#ef4444', fontSize: '13px' }}>
          ⚠ {error}
          <button onClick={fetchJobs} style={{
            marginLeft: '8px', background: '#1e293b',
            border: '1px solid #334155', borderRadius: '4px',
            padding: '2px 8px', color: '#94a3b8', cursor: 'pointer',
          }}>Retry</button>
        </div>
      )}

      {/* Job list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
        {filteredJobs.length === 0 && !error && (
          <div style={{
            textAlign: 'center', color: '#475569',
            fontSize: '13px', padding: '40px 0', fontStyle: 'italic',
          }}>
            {filter === 'all' ? 'No jobs in Redis' : `No ${filter} jobs`}
          </div>
        )}

        {filteredJobs.map(job => {
          const isSelected = selectedJobId === job.jobId;
          const statusColor = STATUS_COLORS[job.status] || '#64748b';

          return (
            <div
              key={job.jobId}
              onClick={() => setSelectedJobId(isSelected ? null : job.jobId)}
              style={{
                background: isSelected ? '#1e293b' : '#0f172a',
                borderRadius: '8px',
                padding: '12px',
                marginBottom: '6px',
                border: isSelected ? `1px solid ${statusColor}40` : '1px solid #1e293b',
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {/* Row: clientName + status + elapsed */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
                  {job.clientName && (
                    <span style={{
                      fontSize: '13px', fontWeight: 700, color: '#f1f5f9',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {job.clientName}
                    </span>
                  )}
                  {statusBadge(job.status)}
                  {job.delegated && (
                    <span style={{
                      fontSize: '10px', color: '#f97316', background: '#f9731610',
                      padding: '1px 6px', borderRadius: '8px', border: '1px solid #f9731630',
                    }}>
                      GPU {job.delegationWorkerIp ? `@ ${job.delegationWorkerIp}` : ''}
                    </span>
                  )}
                </div>
                <span style={{ fontSize: '11px', color: '#64748b', fontFamily: 'monospace', flexShrink: 0, marginLeft: '8px' }}>
                  {formatElapsed(job.elapsedMs)}
                </span>
              </div>

              {/* Row: jobId + stage + date */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '10px', fontFamily: 'monospace', color: '#475569' }}>
                  {job.jobId.slice(0, 8)}… · {job.currentStage}
                </span>
                <span style={{ fontSize: '10px', color: '#475569' }}>
                  {formatDate(job.updatedAt)}
                </span>
              </div>

              {/* Stage progress bar (dots) */}
              <div style={{ display: 'flex', gap: '3px', marginTop: '6px' }}>
                {job.stages.map((s, i) => {
                  const dotColor = s.status === 'completed' ? '#22c55e'
                    : s.status === 'processing' ? '#f59e0b'
                    : s.status === 'failed' ? '#ef4444'
                    : '#334155';
                  return (
                    <div
                      key={i}
                      title={`${s.stage}: ${s.status}${s.agentName ? ` (${s.agentName})` : ''}`}
                      style={{
                        flex: 1,
                        height: '4px',
                        borderRadius: '2px',
                        background: dotColor,
                        transition: 'background 0.3s',
                      }}
                    />
                  );
                })}
              </div>

              {/* Expanded detail */}
              {isSelected && (
                <div style={{
                  marginTop: '10px',
                  borderTop: '1px solid #334155',
                  paddingTop: '10px',
                }}>
                  {/* Stage timeline */}
                  <div style={{ marginBottom: '10px' }}>
                    {job.stages.map(stage => (
                      <div key={stage.stage} style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '11px',
                        padding: '3px 0',
                        color: stage.status === 'completed' ? '#22c55e'
                          : stage.status === 'processing' ? '#f59e0b'
                          : stage.status === 'failed' ? '#ef4444'
                          : '#475569',
                      }}>
                        <span style={{ width: '14px', textAlign: 'center', fontSize: '12px' }}>
                          {STATUS_ICONS[stage.status] || '·'}
                        </span>
                        <span style={{ flex: 1 }}>{stage.stage}</span>
                        <span style={{ fontSize: '10px', color: '#64748b' }}>
                          {stage.agentName || '—'}
                        </span>
                        {stage.startedAt && stage.completedAt && (
                          <span style={{ fontSize: '10px', color: '#64748b', fontFamily: 'monospace' }}>
                            {formatElapsed(new Date(stage.completedAt).getTime() - new Date(stage.startedAt).getTime())}
                          </span>
                        )}
                      </div>
                    ))}
                    {/* Show error for failed stages */}
                    {job.stages.filter(s => s.error).map(s => (
                      <div key={`err-${s.stage}`} style={{
                        marginTop: '4px',
                        fontSize: '11px',
                        color: '#f87171',
                        background: '#450a0a',
                        padding: '4px 8px',
                        borderRadius: '4px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {s.stage}: {s.error}
                      </div>
                    ))}
                  </div>

                  {/* Delegation info */}
                  {job.delegated && (
                    <div style={{
                      fontSize: '11px', color: '#f97316',
                      background: '#f9731610', padding: '6px 8px',
                      borderRadius: '4px', marginBottom: '8px',
                    }}>
                      Delegated to GPU worker {job.delegationWorkerIp && `at ${job.delegationWorkerIp}`}
                    </div>
                  )}

                  {/* S3 availability */}
                  <div style={{ marginBottom: '8px' }}>
                    <S3Dots
                      s3={s3Cache[job.jobId] || null}
                      loading={!!s3Loading[job.jobId]}
                    />
                  </div>

                  {/* Actions row */}
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {/* Retry (for failed) */}
                    {job.currentStageStatus === 'failed' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRetry(job.jobId, job.currentStage); }}
                        style={{
                          background: '#1e293b', border: '1px solid #f59e0b',
                          borderRadius: '4px', padding: '4px 10px',
                          color: '#f59e0b', cursor: 'pointer', fontSize: '11px',
                        }}
                      >
                        ↻ Retry {job.currentStage}
                      </button>
                    )}

                    {/* Reprocess from S3 */}
                    <ReprocessButton
                      jobId={job.jobId}
                      onReprocess={handleReprocess}
                    />

                    {/* Loading indicator for reprocess */}
                    {reprocessing === job.jobId && (
                      <span style={{ fontSize: '11px', color: '#6366f1', alignSelf: 'center' }}>
                        downloading from S3…
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
