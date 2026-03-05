import { useState, useEffect, useCallback } from 'react';
import type { AgentNode } from '../types/index.js';

interface Props {
  node: AgentNode;
  agentId: 'lina' | 'fannery';
  onClose: () => void;
  onSwitchToChat: () => void;
}

// ── Lina types ──
interface LinaJob {
  jobId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  reconciliation: {
    started: boolean;
    completed: boolean;
    globalSpeakers: number;
    identifiedSpeakers: number;
    confidence: number;
    speakerNames: Record<string, string>;
  } | null;
  redaction: {
    totalSections: number;
    completedSections: number;
    validationErrors: number;
    validationWarnings: number;
  } | null;
  outputDir: string | null;
}

// ── Fannery types ──
interface FanneryJob {
  jobId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  assembly: {
    inputSections: number;
    documentSizeBytes: number;
    outputPath: string | null;
    markdownPath: string | null;
    pdfPath: string | null;
    driveFileId: string | null;
    driveFileName: string | null;
  } | null;
}

export default function LinaFanneryQueuePanel({ node, agentId, onClose, onSwitchToChat }: Props) {
  const [linaJobs, setLinaJobs] = useState<LinaJob[]>([]);
  const [fanneryJobs, setFanneryJobs] = useState<FanneryJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [modalContent, setModalContent] = useState<string | null>(null);
  const [modalTitle, setModalTitle] = useState<string>('');

  const isLina = agentId === 'lina';
  const agentLabel = isLina ? 'Lina' : 'Fannery';
  const agentIcon = isLina ? '✍️' : '📄';

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/queue`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      if (isLina) {
        setLinaJobs(data.jobs || []);
      } else {
        setFanneryJobs(data.jobs || []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [agentId, isLina]);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, 5_000);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  const jobs = isLina ? linaJobs : fanneryJobs;
  const hasJobs = jobs.length > 0;

  return (
    <div style={{
      width: '440px',
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
              {isLina ? 'Speaker reconciliation & redaction jobs' : 'Document assembly jobs'}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={onSwitchToChat} style={headerBtnStyle} title="Chat">💬</button>
          <button onClick={onClose} style={headerBtnStyle} title="Close">✕</button>
        </div>
      </div>

      {/* Summary bar */}
      {hasJobs && (
        <div style={{
          display: 'flex',
          gap: '2px',
          padding: '12px 18px',
          background: '#0f172a',
          borderBottom: '1px solid #334155',
        }}>
          <StatBadge label="Total" value={jobs.length} color="#94a3b8" />
          <StatBadge label="Active" value={jobs.filter(j => !['completed', 'failed'].includes(j.status)).length} color="#f59e0b" />
          <StatBadge label="Done" value={jobs.filter(j => j.status === 'completed').length} color="#22c55e" />
          <StatBadge label="Failed" value={jobs.filter(j => j.status === 'failed').length} color="#ef4444" />
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

        {!loading && !hasJobs && !error && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <span style={{ fontSize: '40px', display: 'block', marginBottom: '12px' }}>
              {isLina ? '📝' : '📑'}
            </span>
            <p style={{ color: '#64748b', fontSize: '13px', margin: 0 }}>No jobs yet</p>
            <p style={{ color: '#475569', fontSize: '11px', margin: '6px 0 0' }}>
              {isLina
                ? 'Lina is idle. Jobs will appear when the pipeline reaches the redaction stage.'
                : 'Fannery is idle. Jobs will appear when Lina finishes redacting.'}
            </p>
          </div>
        )}

        {/* Lina jobs */}
        {isLina && linaJobs.map((job) => (
          <LinaJobCard
            key={job.jobId}
            job={job}
            color={node.color}
            expanded={expandedJob === job.jobId}
            onToggle={() => setExpandedJob(expandedJob === job.jobId ? null : job.jobId)}
            onOpenPreview={(content, title) => { setModalContent(content); setModalTitle(title); }}
          />
        ))}

        {/* Fannery jobs */}
        {!isLina && fanneryJobs.map((job) => (
          <FanneryJobCard
            key={job.jobId}
            job={job}
            color={node.color}
            expanded={expandedJob === job.jobId}
            onToggle={() => setExpandedJob(expandedJob === job.jobId ? null : job.jobId)}
            onOpenPreview={(content, title) => { setModalContent(content); setModalTitle(title); }}
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

      {/* Full-screen document preview modal */}
      {modalContent && (
        <DocumentPreviewModal
          content={modalContent}
          title={modalTitle}
          onClose={() => setModalContent(null)}
        />
      )}
    </div>
  );
}

// ══════════════════════════════════════
//  Lina Job Card
// ══════════════════════════════════════

function LinaJobCard({ job, color, expanded, onToggle, onOpenPreview }: {
  job: LinaJob; color: string; expanded: boolean; onToggle: () => void;
  onOpenPreview: (content: string, title: string) => void;
}) {
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessMsg, setReprocessMsg] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const handlePreview = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/agents/lina/preview/${job.jobId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const title = `Lina Output ${job.jobId.substring(0, 8)}`;
      onOpenPreview(text, title);
    } catch (err) {
      onOpenPreview(`Error: ${err instanceof Error ? err.message : String(err)}`, 'Preview Error');
    } finally {
      setPreviewLoading(false);
    }
  };

  const statusColor = getStatusColor(job.status);
  const elapsed = job.startedAt
    ? formatDuration(new Date(job.completedAt || new Date()).getTime() - new Date(job.startedAt).getTime())
    : '';

  const handleReprocess = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (reprocessing) return;
    setReprocessing(true);
    setReprocessMsg(null);
    try {
      const res = await fetch(`/api/agents/lina/reprocess/${job.jobId}`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setReprocessMsg('♻️ Reprocessing started…');
    } catch (err) {
      setReprocessMsg(`❌ ${err instanceof Error ? err.message : 'Failed'}`);
    } finally {
      setTimeout(() => setReprocessing(false), 2000);
    }
  };

  return (
    <div style={{
      background: '#0f172a',
      borderRadius: '8px',
      border: `1px solid ${expanded ? color + '66' : '#334155'}`,
      marginBottom: '8px',
      overflow: 'hidden',
    }}>
      {/* Header row */}
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
            {job.status === 'reconciling'
              ? 'Reconciling speakers across chunks…'
              : job.status === 'redacting'
                ? 'Redacting transcript into formal minutes…'
                : job.status === 'completed'
                  ? `✓ ${elapsed} • ${job.reconciliation?.globalSpeakers ?? '?'} speakers`
                  : job.status === 'failed'
                    ? `Failed: ${job.error?.substring(0, 60)}`
                    : 'Queued…'}
          </div>
        </div>
        <StatusBadge status={job.status} color={statusColor} />
      </div>

      {/* Progress indicator for active jobs */}
      {(job.status === 'reconciling' || job.status === 'redacting') && (
        <div style={{ padding: '0 14px 8px' }}>
          <ProgressBar
            value={job.status === 'reconciling' ? 33 : 66}
            color={color}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
            <span style={{ color: '#64748b', fontSize: '10px' }}>⏱ {elapsed}</span>
            <span style={{ color: '#94a3b8', fontSize: '10px' }}>
              {job.status === 'reconciling' ? '👥 Speaker reconciliation' : '✍️ AI redaction'}
            </span>
          </div>
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div style={{ padding: '0 14px 12px', borderTop: '1px solid #1e293b' }}>
          {/* Timing */}
          <SectionLabel label="Timing" />
          <InfoRow label="Started" value={job.startedAt ? formatTimestamp(job.startedAt) : '—'} />
          {job.completedAt && <InfoRow label="Completed" value={formatTimestamp(job.completedAt)} />}
          {elapsed && <InfoRow label="Duration" value={elapsed} />}

          {/* Speaker Reconciliation */}
          {job.reconciliation && (
            <>
              <SectionLabel label="Speaker Reconciliation" />
              <InfoRow label="Total Speakers" value={String(job.reconciliation.globalSpeakers)} />
              <InfoRow label="Identified (Named)" value={String(job.reconciliation.identifiedSpeakers)} />
              <InfoRow label="Confidence" value={`${Math.round(job.reconciliation.confidence * 100)}%`} />

              {/* Speaker names list */}
              {Object.keys(job.reconciliation.speakerNames).length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  <div style={{ color: '#64748b', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', marginBottom: '4px' }}>
                    Identified Speakers
                  </div>
                  <div style={{
                    maxHeight: '140px',
                    overflowY: 'auto',
                    background: '#1e293b',
                    borderRadius: '4px',
                    padding: '6px 8px',
                  }}>
                    {Object.entries(job.reconciliation.speakerNames).map(([id, name]) => (
                      <div key={id} style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '2px 0',
                        fontSize: '11px',
                      }}>
                        <span style={{ color: '#94a3b8', fontFamily: 'monospace', fontSize: '10px' }}>{id}</span>
                        <span style={{ color: '#e2e8f0' }}>{name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Redaction details */}
          {job.redaction && (
            <>
              <SectionLabel label="Redaction" />
              <InfoRow label="Sections" value={`${job.redaction.completedSections}/${job.redaction.totalSections}`} />
              {job.redaction.validationErrors > 0 && (
                <InfoRow label="Errors" value={String(job.redaction.validationErrors)} />
              )}
              {job.redaction.validationWarnings > 0 && (
                <InfoRow label="Warnings" value={String(job.redaction.validationWarnings)} />
              )}
            </>
          )}

          {/* Preview button — available any time sections exist */}
          {(job.status === 'completed' || job.status === 'redacting' || job.status === 'failed') && (
            <div style={{ marginTop: '8px' }}>
              <button
                onClick={handlePreview}
                disabled={previewLoading}
                style={{
                  width: '100%',
                  background: previewLoading ? '#334155' : 'linear-gradient(135deg, #7c3aed, #6d28d9)',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '8px 12px',
                  color: '#fff',
                  cursor: previewLoading ? 'not-allowed' : 'pointer',
                  fontSize: '12px',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  opacity: previewLoading ? 0.6 : 1,
                  marginBottom: '6px',
                }}
              >
                {previewLoading ? '⏳ Loading…' : '🔍 Ver Output de Lina'}
              </button>
            </div>
          )}

          {/* Reprocess button — available for completed or failed jobs */}
          {(job.status === 'completed' || job.status === 'failed') && (
            <div style={{ marginTop: '8px' }}>
              <button
                onClick={handleReprocess}
                disabled={reprocessing}
                style={{
                  width: '100%',
                  background: reprocessing
                    ? '#334155'
                    : 'linear-gradient(135deg, #0891b2, #0e7490)',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '8px 12px',
                  color: '#fff',
                  cursor: reprocessing ? 'not-allowed' : 'pointer',
                  fontSize: '12px',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  opacity: reprocessing ? 0.6 : 1,
                }}
              >
                {reprocessing ? '⏳ Reprocessing…' : '♻️ Reprocess Job'}
              </button>
              {reprocessMsg && (
                <div style={{
                  marginTop: '4px',
                  fontSize: '11px',
                  color: reprocessMsg.startsWith('❌') ? '#fca5a5' : '#67e8f9',
                  textAlign: 'center',
                }}>
                  {reprocessMsg}
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {job.error && (
            <div style={{
              marginTop: '8px',
              padding: '8px',
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid #ef444433',
              borderRadius: '4px',
              color: '#fca5a5',
              fontSize: '11px',
              wordBreak: 'break-word',
            }}>
              ❌ {job.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════
//  Fannery Job Card
// ══════════════════════════════════════

function FanneryJobCard({ job, color, expanded, onToggle, onOpenPreview }: {
  job: FanneryJob; color: string; expanded: boolean; onToggle: () => void;
  onOpenPreview: (content: string, title: string) => void;
}) {
  const [markdownContent, setMarkdownContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessMsg, setReprocessMsg] = useState<string | null>(null);


  const statusColor = getStatusColor(job.status);
  const elapsed = job.startedAt
    ? formatDuration(new Date(job.completedAt || new Date()).getTime() - new Date(job.startedAt).getTime())
    : '';

  const fileName = job.assembly?.outputPath
    ? job.assembly.outputPath.split('/').pop() ?? 'document.docx'
    : null;

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (job.status === 'completed') {
      window.open(`/api/agents/fannery/download/${job.jobId}`, '_blank');
    }
  };

  const handlePreview = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // If we already have the content, go straight to the full modal
    if (markdownContent) {
      const title = job.assembly?.outputPath?.split('/').pop()?.replace('.docx', '') ?? `Job ${job.jobId.substring(0, 8)}`;
      onOpenPreview(markdownContent, title);
      return;
    }
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/agents/fannery/preview/${job.jobId}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const text = await res.text();
      setMarkdownContent(text);
      // Open full modal directly
      const title = job.assembly?.outputPath?.split('/').pop()?.replace('.docx', '') ?? `Job ${job.jobId.substring(0, 8)}`;
      onOpenPreview(text, title);
    } catch {
      setMarkdownContent('*Error loading preview*');
      const title = `Job ${job.jobId.substring(0, 8)}`;
      onOpenPreview('*Error loading preview*', title);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleReprocess = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (reprocessing) return;
    setReprocessing(true);
    setReprocessMsg(null);
    try {
      const res = await fetch(`/api/agents/fannery/reprocess/${job.jobId}`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setReprocessMsg('♻️ Reprocessing started…');
    } catch (err) {
      setReprocessMsg(`❌ ${err instanceof Error ? err.message : 'Failed'}`);
    } finally {
      setTimeout(() => setReprocessing(false), 2000);
    }
  };

  const handleDownloadPdf = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (job.status === 'completed') {
      window.open(`/api/agents/fannery/pdf/${job.jobId}`, '_blank');
    }
  };

  const hasMarkdown = job.status === 'completed' && job.assembly?.markdownPath;

  return (
    <div style={{
      background: '#0f172a',
      borderRadius: '8px',
      border: `1px solid ${expanded ? color + '66' : '#334155'}`,
      marginBottom: '8px',
      overflow: 'hidden',
    }}>
      {/* Header row */}
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
            {job.status === 'assembling'
              ? 'Assembling DOCX document…'
              : job.status === 'uploading'
                ? 'Uploading to Google Drive…'
                : job.status === 'completed'
                  ? `✓ ${elapsed} • ${formatBytes(job.assembly?.documentSizeBytes ?? 0)}`
                  : job.status === 'failed'
                    ? `Failed: ${job.error?.substring(0, 60)}`
                    : 'Queued…'}
          </div>
        </div>
        <StatusBadge status={job.status} color={statusColor} />
      </div>

      {/* Progress indicator for active jobs */}
      {(job.status === 'assembling' || job.status === 'uploading') && (
        <div style={{ padding: '0 14px 8px' }}>
          <ProgressBar
            value={job.status === 'assembling' ? 50 : 85}
            color={color}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
            <span style={{ color: '#64748b', fontSize: '10px' }}>⏱ {elapsed}</span>
            <span style={{ color: '#94a3b8', fontSize: '10px' }}>
              {job.status === 'assembling' ? '📝 Building DOCX' : '☁️ Uploading'}
            </span>
          </div>
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div style={{ padding: '0 14px 12px', borderTop: '1px solid #1e293b' }}>
          {/* Timing */}
          <SectionLabel label="Timing" />
          <InfoRow label="Started" value={job.startedAt ? formatTimestamp(job.startedAt) : '—'} />
          {job.completedAt && <InfoRow label="Completed" value={formatTimestamp(job.completedAt)} />}
          {elapsed && <InfoRow label="Duration" value={elapsed} />}

          {/* Assembly details */}
          {job.assembly && (
            <>
              <SectionLabel label="Document" />
              <InfoRow label="Input Sections" value={String(job.assembly.inputSections)} />
              <InfoRow label="Size" value={formatBytes(job.assembly.documentSizeBytes)} />
              {fileName && (
                <InfoRow label="File" value={fileName} />
              )}
              {job.assembly.driveFileId && (
                <InfoRow label="Drive ID" value={job.assembly.driveFileId.substring(0, 20) + '…'} />
              )}
            </>
          )}

          {/* Download button */}
          {job.status === 'completed' && job.assembly?.outputPath && (
            <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
              <button
                onClick={handleDownload}
                style={{
                  flex: 1,
                  background: 'linear-gradient(135deg, #ca8a04, #a16207)',
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
                📄 Descargar DOCX
              </button>
              <button
                onClick={handleDownloadPdf}
                style={{
                  flex: 1,
                  background: 'linear-gradient(135deg, #dc2626, #b91c1c)',
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
                📕 Descargar PDF
              </button>
              {hasMarkdown && (
                <button
                  onClick={handlePreview}
                  disabled={previewLoading}
                  style={{
                    flex: 1,
                    background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                    border: 'none',
                    borderRadius: '6px',
                    padding: '8px 12px',
                    color: '#fff',
                    cursor: previewLoading ? 'not-allowed' : 'pointer',
                    fontSize: '12px',
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                    opacity: previewLoading ? 0.6 : 1,
                  }}
                >
                  {previewLoading ? '⏳ Loading…' : '👁️ Vista previa'}
                </button>
              )}
            </div>
          )}

          {/* Preview button — available any time sections exist */}

          {/* Reprocess button — available for completed or failed jobs */}
          {(job.status === 'completed' || job.status === 'failed') && (
            <div style={{ marginTop: '8px' }}>
              <button
                onClick={handleReprocess}
                disabled={reprocessing}
                style={{
                  width: '100%',
                  background: reprocessing
                    ? '#334155'
                    : 'linear-gradient(135deg, #0891b2, #0e7490)',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '8px 12px',
                  color: '#fff',
                  cursor: reprocessing ? 'not-allowed' : 'pointer',
                  fontSize: '12px',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  opacity: reprocessing ? 0.6 : 1,
                }}
              >
                {reprocessing ? '⏳ Reprocessing…' : '♻️ Reprocess Job'}
              </button>
              {reprocessMsg && (
                <div style={{
                  marginTop: '4px',
                  fontSize: '11px',
                  color: reprocessMsg.startsWith('❌') ? '#fca5a5' : '#67e8f9',
                  textAlign: 'center',
                }}>
                  {reprocessMsg}
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {job.error && (
            <div style={{
              marginTop: '8px',
              padding: '8px',
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid #ef444433',
              borderRadius: '4px',
              color: '#fca5a5',
              fontSize: '11px',
              wordBreak: 'break-word',
            }}>
              ❌ {job.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════
//  Document Preview Modal (full-screen)
// ══════════════════════════════════════

function DocumentPreviewModal({ content, title, onClose }: {
  content: string; title: string; onClose: () => void;
}) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
      onPointerDownCapture={(e) => e.stopPropagation()}
      onMouseDownCapture={(e) => e.stopPropagation()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '90vw',
          maxWidth: '900px',
          height: '90vh',
          background: '#fff',
          borderRadius: '12px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 25px 60px rgba(0,0,0,0.4)',
        }}
      >
        {/* Modal header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 24px',
          borderBottom: '1px solid #e2e8f0',
          background: '#f8fafc',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '20px' }}>📄</span>
            <div>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>
                {title || 'Document Preview'}
              </h2>
              <p style={{ margin: 0, fontSize: '11px', color: '#64748b' }}>
                Markdown preview — press Esc or click outside to close
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: '#f1f5f9',
              border: '1px solid #e2e8f0',
              borderRadius: '6px',
              padding: '6px 12px',
              color: '#475569',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 600,
            }}
          >
            ✕ Close
          </button>
        </div>

        {/* Document body — scrollable */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '40px 60px',
          color: '#1e293b',
          fontSize: '14px',
          lineHeight: '1.8',
          fontFamily: "'Georgia', 'Times New Roman', 'Noto Serif', serif",
          userSelect: 'text',
          WebkitUserSelect: 'text',
        }}>
          <MarkdownPreview content={content} fullMode />
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════
//  Markdown Preview (lightweight, no deps)
// ══════════════════════════════════════

function MarkdownPreview({ content, fullMode = false }: { content: string; fullMode?: boolean }) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  // Font sizes differ between inline (small) and fullMode (document-like)
  const sz = fullMode
    ? { h1: '20px', h2: '17px', h3: '15px', h4: '14px', p: '14px', li: '14px', sig: '14px' }
    : { h1: '16px', h2: '14px', h3: '13px', h4: '12px', p: '13px', li: '13px', sig: '13px' };
  const spacing = fullMode
    ? { h1mb: '14px', h2mb: '10px', h3mb: '8px', pmb: '10px' }
    : { h1mb: '8px', h2mb: '6px', h3mb: '4px', pmb: '6px' };

  while (i < lines.length) {
    const line = lines[i];

    // Heading ###
    if (line.startsWith('### ')) {
      elements.push(
        <h4 key={i} style={{
          margin: `${fullMode ? '20px' : '12px'} 0 ${spacing.h3mb}`,
          fontSize: sz.h3,
          fontWeight: 700,
          color: '#334155',
          fontFamily: "'Arial', 'Helvetica Neue', sans-serif",
        }}>
          {renderInline(line.slice(4))}
        </h4>,
      );
      i++;
      continue;
    }

    // Heading ##
    if (line.startsWith('## ')) {
      elements.push(
        <h3 key={i} style={{
          margin: `${fullMode ? '28px' : '16px'} 0 ${spacing.h2mb}`,
          fontSize: sz.h2,
          fontWeight: 700,
          color: '#1e293b',
          borderBottom: fullMode ? '2px solid #cbd5e1' : '1px solid #e2e8f0',
          paddingBottom: fullMode ? '6px' : '4px',
          fontFamily: "'Arial', 'Helvetica Neue', sans-serif",
          textTransform: 'uppercase' as const,
          letterSpacing: '0.02em',
        }}>
          {renderInline(line.slice(3))}
        </h3>,
      );
      i++;
      continue;
    }

    // Heading #
    if (line.startsWith('# ')) {
      elements.push(
        <h2 key={i} style={{
          margin: `${fullMode ? '32px' : '20px'} 0 ${spacing.h1mb}`,
          fontSize: sz.h1,
          fontWeight: 700,
          color: '#0f172a',
          textAlign: 'center' as const,
          fontFamily: "'Arial', 'Helvetica Neue', sans-serif",
          textTransform: 'uppercase' as const,
        }}>
          {renderInline(line.slice(2))}
        </h2>,
      );
      i++;
      continue;
    }

    // Horizontal rule (signature separator)
    if (line.trim() === '---') {
      elements.push(
        <hr key={i} style={{
          border: 'none',
          borderTop: fullMode ? '2px solid #94a3b8' : '1px solid #cbd5e1',
          margin: fullMode ? '40px 0 30px' : '20px 0',
        }} />,
      );
      i++;
      continue;
    }

    // Signature block: line of underscores
    if (line.trim().startsWith('______')) {
      elements.push(
        <div key={i} style={{
          marginTop: fullMode ? '30px' : '16px',
          borderBottom: '1px solid #1e293b',
          width: fullMode ? '250px' : '180px',
          marginBottom: '4px',
        }} />,
      );
      i++;
      continue;
    }

    // Table
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1]?.includes('---')) {
      const tableLines: string[] = [];
      let j = i;
      while (j < lines.length && lines[j].includes('|')) {
        tableLines.push(lines[j]);
        j++;
      }
      elements.push(<MarkdownTable key={i} lines={tableLines} fullMode={fullMode} />);
      i = j;
      continue;
    }

    // List item
    if (line.startsWith('- ')) {
      elements.push(
        <div key={i} style={{
          paddingLeft: fullMode ? '24px' : '16px',
          margin: fullMode ? '4px 0' : '2px 0',
          fontSize: sz.li,
          textIndent: '-12px',
          marginLeft: '12px',
        }}>
          • {renderInline(line.slice(2))}
        </div>,
      );
      i++;
      continue;
    }

    // Numbered list item (e.g. "1. ", "2. ")
    if (/^\d+\.\s/.test(line)) {
      const match = line.match(/^(\d+)\.\s(.*)/);
      if (match) {
        elements.push(
          <div key={i} style={{
            paddingLeft: fullMode ? '24px' : '16px',
            margin: fullMode ? '4px 0' : '2px 0',
            fontSize: sz.li,
            textIndent: '-18px',
            marginLeft: '18px',
          }}>
            {match[1]}. {renderInline(match[2])}
          </div>,
        );
        i++;
        continue;
      }
    }

    // Empty line
    if (line.trim() === '') {
      if (fullMode) {
        elements.push(<div key={i} style={{ height: '8px' }} />);
      }
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={i} style={{
        margin: `0 0 ${spacing.pmb} 0`,
        fontSize: sz.p,
        textAlign: 'justify' as const,
        lineHeight: fullMode ? '1.8' : '1.6',
      }}>
        {renderInline(line)}
      </p>,
    );
    i++;
  }

  return <>{elements}</>;
}

function renderInline(text: string): React.ReactNode {
  // Handle **bold** and *italic*
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      parts.push(<strong key={match.index}>{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={match.index}>{match[3]}</em>);
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

function MarkdownTable({ lines, fullMode = false }: { lines: string[]; fullMode?: boolean }) {
  const parseRow = (row: string) =>
    row.split('|').filter((_, i, arr) => i > 0 && i < arr.length - 1).map(c => c.trim());

  const headers = parseRow(lines[0]);
  // Skip separator line (index 1)
  const rows = lines.slice(2).map(parseRow);

  return (
    <table style={{
      width: '100%',
      borderCollapse: 'collapse',
      margin: fullMode ? '16px 0 20px' : '10px 0',
      fontSize: fullMode ? '13px' : '12px',
      fontFamily: "'Arial', 'Helvetica Neue', sans-serif",
    }}>
      <thead>
        <tr>
          {headers.map((h, i) => (
            <th key={i} style={{
              background: fullMode ? '#1e293b' : '#f1f5f9',
              padding: fullMode ? '8px 12px' : '6px 10px',
              textAlign: 'center',
              fontWeight: 700,
              borderBottom: fullMode ? '2px solid #0f172a' : '2px solid #cbd5e1',
              fontSize: fullMode ? '12px' : '11px',
              color: fullMode ? '#f1f5f9' : '#475569',
              textTransform: 'uppercase' as const,
              letterSpacing: '0.03em',
            }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri} style={{
            background: fullMode && ri % 2 === 0 ? '#f8fafc' : 'transparent',
          }}>
            {row.map((cell, ci) => (
              <td key={ci} style={{
                padding: fullMode ? '7px 12px' : '5px 10px',
                borderBottom: '1px solid #e2e8f0',
                color: '#334155',
                textAlign: ci === 0 ? 'left' : 'center',
              }}>
                {renderInline(cell)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ══════════════════════════════════════
//  Shared UI Components
// ══════════════════════════════════════

function StatBadge({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      flex: 1,
      textAlign: 'center',
      padding: '4px 0',
    }}>
      <div style={{ fontSize: '16px', fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: '10px', color: '#64748b', textTransform: 'uppercase' }}>{label}</div>
    </div>
  );
}

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
      <span style={{ color: '#e2e8f0', fontFamily: 'monospace', textAlign: 'right', maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <div style={{
      color: '#94a3b8',
      fontSize: '10px',
      fontWeight: 700,
      textTransform: 'uppercase',
      margin: '10px 0 4px',
      letterSpacing: '0.05em',
    }}>
      {label}
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('es-CO', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'queued': return '#f59e0b';
    case 'reconciling': return '#8b5cf6';
    case 'redacting': return '#ec4899';
    case 'assembling': return '#06b6d4';
    case 'uploading': return '#38bdf8';
    case 'completed': return '#22c55e';
    case 'failed': return '#ef4444';
    default: return '#64748b';
  }
}

function getStatusIcon(status: string): string {
  switch (status) {
    case 'queued': return '⏳';
    case 'reconciling': return '👥';
    case 'redacting': return '✍️';
    case 'assembling': return '📝';
    case 'uploading': return '☁️';
    case 'completed': return '✅';
    case 'failed': return '❌';
    default: return '❓';
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
