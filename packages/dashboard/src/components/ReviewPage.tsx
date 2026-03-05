/**
 * ReviewPage — Split-pane document review with LLM-detected inconsistencies.
 *
 * Left pane:  Rendered Markdown document on a light/paper background + audio controls
 * Right pane: Kanban board of review items (Pending → Reviewing → Fixed / Dismissed)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ReviewItem, ReviewItemStatus, ReviewSession } from '../types/review.js';
import {
  startReview,
  getReviewSession as fetchReviewSession,
  getReviewItems,
  getReviewDocument,
  updateReviewItemStatus,
  applyReviewFix,
  getRawAudioUrl,
  getTranscriptSegments,
  saveReviewDocument,
  exportReviewDocument,
  getOutputFiles,
  getDownloadUrl,
} from '../api/client.js';
import type { TranscriptSegment, AudioFileInfo, OutputFile } from '../api/client.js';

// ── Constants ──

const KANBAN_COLUMNS: { key: ReviewItemStatus; label: string; color: string; icon: string }[] = [
  { key: 'pending', label: 'Pendiente', color: '#f59e0b', icon: '⏳' },
  { key: 'reviewing', label: 'En Revisión', color: '#3b82f6', icon: '🔍' },
  { key: 'fixed', label: 'Corregido', color: '#22c55e', icon: '✅' },
  { key: 'dismissed', label: 'Descartado', color: '#6b7280', icon: '🚫' },
];

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#dc2626',
  warning: '#d97706',
  info: '#2563eb',
};

const SEVERITY_ICONS: Record<string, string> = {
  critical: '🔴',
  warning: '🟡',
  info: '🔵',
};

const TYPE_LABELS: Record<string, string> = {
  factual_inconsistency: 'Inconsistencia factual',
  numerical_error: 'Error numérico',
  speaker_attribution: 'Atribución de orador',
  missing_content: 'Contenido faltante',
  formatting_issue: 'Formato',
  legal_reference: 'Referencia legal',
  voting_mismatch: 'Discrepancia votación',
  grammar_style: 'Gramática / Estilo',
  other: 'Otro',
};

interface Props {
  jobId: string;
  onBack: () => void;
}

export default function ReviewPage({ jobId, onBack }: Props) {
  const [session, setSession] = useState<Omit<ReviewSession, 'markdownContent'> | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [markdown, setMarkdown] = useState<string>('');
  const [selectedItem, setSelectedItem] = useState<ReviewItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applyingFix, setApplyingFix] = useState<string | null>(null);
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [audioFiles, setAudioFiles] = useState<AudioFileInfo[]>([]);
  const docRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [activeAudioTime, setActiveAudioTime] = useState<{ start: number; end: number } | null>(null);
  const [currentAudioPart, setCurrentAudioPart] = useState<number>(-1);
  const [globalPlayheadSec, setGlobalPlayheadSec] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editBuffer, setEditBuffer] = useState('');
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [outputFiles, setOutputFiles] = useState<OutputFile[]>([]);
  const totalDuration = audioFiles.length > 0
    ? audioFiles[audioFiles.length - 1].endSec
    : 0;

  // ── Initialize review session ──

  const initReview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Try to get existing session first
      let sess: Omit<ReviewSession, 'markdownContent'> | null = null;
      try {
        sess = await fetchReviewSession(jobId);
      } catch {
        // No session yet, start one
        await startReview(jobId);
      }

      if (!sess || sess.status === 'analyzing') {
        // Poll until analysis is ready
        let attempts = 0;
        while (attempts < 60) {
          await new Promise(r => setTimeout(r, 3000));
          try {
            sess = await fetchReviewSession(jobId);
            if (sess && sess.status !== 'analyzing') break;
          } catch {
            // Keep polling
          }
          attempts++;
        }
      }

      if (!sess) {
        throw new Error('Review session could not be created');
      }

      setSession(sess);

      if (sess.status === 'ready' || sess.status === 'in_review' || sess.status === 'completed') {
        const [itemsData, doc] = await Promise.all([
          getReviewItems(jobId),
          getReviewDocument(jobId),
        ]);
        setItems(itemsData.items);
        setMarkdown(doc);

        // Load transcript segments for audio linking
        try {
          const tsData = await getTranscriptSegments(jobId);
          setTranscriptSegments(tsData.segments);
          setAudioFiles(tsData.audioFiles || []);
        } catch {
          // No transcript data — audio won't be linked
        }

        // Load available output files for download
        try {
          const filesData = await getOutputFiles(jobId);
          setOutputFiles(filesData.files);
        } catch {
          // No files yet
        }
      } else if (sess.status === 'failed') {
        setError(sess.error || 'Review analysis failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initialize review');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    initReview();
  }, [initReview]);

  // ── Refresh items ──

  const refreshItems = useCallback(async () => {
    try {
      const data = await getReviewItems(jobId);
      setItems(data.items);
      const sess = await fetchReviewSession(jobId);
      setSession(sess);
    } catch {
      // Silently fail on refresh
    }
  }, [jobId]);

  // ── Handle item click → navigate to document location ──

  const handleItemClick = useCallback((item: ReviewItem) => {
    setSelectedItem(item);

    // Navigate to the paragraph in the document
    if (docRef.current) {
      const paragraphs = docRef.current.querySelectorAll('[data-para-idx]');
      const targetIdx = item.location.paragraphIndex;

      for (const p of paragraphs) {
        const idx = parseInt(p.getAttribute('data-para-idx') || '-1', 10);
        if (idx === targetIdx) {
          p.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Highlight the paragraph
          p.classList.add('review-highlight');
          setTimeout(() => p.classList.remove('review-highlight'), 3000);
          break;
        }
      }
    }
  }, []);

  // ── Handle status change (kanban drag) ──

  const handleStatusChange = useCallback(async (itemId: string, newStatus: ReviewItemStatus) => {
    try {
      await updateReviewItemStatus(jobId, itemId, newStatus);
      await refreshItems();
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  }, [jobId, refreshItems]);

  // ── Handle apply fix (magic wand) ──

  const handleApplyFix = useCallback(async (itemId: string) => {
    setApplyingFix(itemId);
    try {
      const result = await applyReviewFix(jobId, itemId);
      if (result.success) {
        // Refresh both items and document
        await refreshItems();
        const doc = await getReviewDocument(jobId);
        setMarkdown(doc);
      } else {
        alert(`No se pudo aplicar la corrección: ${result.message}`);
      }
    } catch (err) {
      console.error('Failed to apply fix:', err);
      alert('Error al aplicar la corrección');
    } finally {
      setApplyingFix(null);
    }
  }, [jobId, refreshItems]);

  // ── Find which audio chunk covers a global timestamp ──

  const findChunkForTime = useCallback((globalSec: number): { part: number; offsetSec: number } => {
    if (audioFiles.length === 0) return { part: 0, offsetSec: globalSec };
    for (let i = 0; i < audioFiles.length; i++) {
      const af = audioFiles[i];
      if (globalSec >= af.startSec && globalSec < af.endSec) {
        return { part: i, offsetSec: globalSec - af.startSec };
      }
    }
    // Past the end — use last chunk
    const last = audioFiles[audioFiles.length - 1];
    return { part: audioFiles.length - 1, offsetSec: globalSec - last.startSec };
  }, [audioFiles]);

  // ── Seek to a global time (used by slider and audio buttons) ──

  const seekToGlobal = useCallback((globalSec: number, autoPlay = false) => {
    if (!audioRef.current) return;
    const audio = audioRef.current;
    const clamped = Math.max(0, Math.min(globalSec, totalDuration));
    const { part, offsetSec } = findChunkForTime(clamped);

    setGlobalPlayheadSec(clamped);

    if (currentAudioPart !== part) {
      setCurrentAudioPart(part);
      audio.src = getRawAudioUrl(jobId, part);
      const onReady = () => {
        audio.currentTime = offsetSec;
        if (autoPlay) audio.play().then(() => setAudioPlaying(true)).catch(() => {});
        audio.removeEventListener('loadedmetadata', onReady);
      };
      audio.addEventListener('loadedmetadata', onReady);
      audio.load();
    } else {
      audio.currentTime = offsetSec;
      if (autoPlay) audio.play().then(() => setAudioPlaying(true)).catch(() => {});
    }
  }, [findChunkForTime, totalDuration, currentAudioPart, jobId]);

  // ── Play audio at specific global timestamp (with auto-stop at endSec) ──

  const playAudioAt = useCallback((startSec: number, endSec: number) => {
    // Compute end offset relative to the chunk that startSec falls in
    const { part } = findChunkForTime(startSec);
    const chunkStart = audioFiles.length > 0 ? audioFiles[part].startSec : 0;
    const endOffset = endSec - chunkStart;
    setActiveAudioTime({ start: startSec - chunkStart, end: endOffset });

    seekToGlobal(startSec, true);
  }, [findChunkForTime, audioFiles, seekToGlobal]);

  // ── Toggle play/pause ──

  const togglePlayPause = useCallback(() => {
    if (!audioRef.current) return;
    const audio = audioRef.current;
    if (audioPlaying) {
      audio.pause();
    } else {
      // If no chunk loaded yet, load the first one at current global position
      if (currentAudioPart < 0) {
        seekToGlobal(globalPlayheadSec, true);
      } else {
        audio.play().then(() => setAudioPlaying(true)).catch(() => {});
      }
    }
  }, [audioPlaying, currentAudioPart, globalPlayheadSec, seekToGlobal]);

  // ── Skip forward/backward ──

  const skipBy = useCallback((deltaSec: number) => {
    const newPos = Math.max(0, Math.min(globalPlayheadSec + deltaSec, totalDuration));
    seekToGlobal(newPos, audioPlaying);
  }, [globalPlayheadSec, totalDuration, audioPlaying, seekToGlobal]);

  // ── Track playhead position as global time via timeupdate ──

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => {
      if (isSeeking) return;
      const chunkStart = audioFiles.length > 0 && currentAudioPart >= 0
        ? audioFiles[currentAudioPart].startSec
        : 0;
      setGlobalPlayheadSec(chunkStart + audio.currentTime);

      // Auto-stop check for section playback
      if (activeAudioTime && audio.currentTime >= activeAudioTime.end) {
        audio.pause();
        setAudioPlaying(false);
        setActiveAudioTime(null);
      }
    };
    audio.addEventListener('timeupdate', onTimeUpdate);
    return () => audio.removeEventListener('timeupdate', onTimeUpdate);
  }, [audioFiles, currentAudioPart, isSeeking, activeAudioTime]);

  // ── Auto-advance to next chunk when current one ends ──

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onEnded = () => {
      // If there's a next chunk, load it and continue
      if (currentAudioPart >= 0 && currentAudioPart < audioFiles.length - 1) {
        const nextPart = currentAudioPart + 1;
        setCurrentAudioPart(nextPart);
        audio.src = getRawAudioUrl(jobId, nextPart);
        const onReady = () => {
          audio.currentTime = 0;
          audio.play().catch(() => {});
          audio.removeEventListener('loadedmetadata', onReady);
        };
        audio.addEventListener('loadedmetadata', onReady);
        audio.load();
      } else {
        setAudioPlaying(false);
        setActiveAudioTime(null);
      }
    };
    audio.addEventListener('ended', onEnded);
    return () => audio.removeEventListener('ended', onEnded);
  }, [currentAudioPart, audioFiles, jobId]);

  // ── Render markdown as HTML with paragraph indices ──

  const renderedHTML = markdownToAnnotatedHTML(markdown, transcriptSegments);

  // ── Loading / Error states ──

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loadingOverlay}>
          <div style={styles.spinner} />
          <p style={{ color: '#94a3b8', marginTop: 16 }}>
            {session?.status === 'analyzing'
              ? 'Analizando documento con IA... Esto puede tomar hasta 1 minuto.'
              : 'Cargando sesión de revisión...'}
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.container}>
        <div style={styles.errorBox}>
          <h3>Error en revisión</h3>
          <p>{error}</p>
          <button onClick={onBack} style={styles.backButton}>← Volver</button>
        </div>
      </div>
    );
  }

  // ── Group items by status for kanban ──
  const columns = KANBAN_COLUMNS.map(col => ({
    ...col,
    items: items.filter(i => i.status === col.key),
  }));

  return (
    <div style={styles.container}>
      {/* Hidden audio element — src is set dynamically per chunk */}
      <audio
        ref={audioRef}
        preload="none"
        onPause={() => setAudioPlaying(false)}
        onPlay={() => setAudioPlaying(true)}
      />

      {/* Header bar */}
      <div style={styles.header}>
        <button onClick={onBack} style={styles.backButton}>← Volver</button>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h2 style={styles.title}>📝 Revisión del Acta</h2>
          {session?.clientName && (
            <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 600, letterSpacing: '0.05em' }}>
              🏢 {session.clientName}
            </span>
          )}
        </div>
        <div style={styles.statsBar}>
          {session?.stats && (
            <>
              <span style={{ ...styles.statBadge, background: '#dc2626' }}>
                {session.stats.critical} críticos
              </span>
              <span style={{ ...styles.statBadge, background: '#d97706' }}>
                {session.stats.warning} advertencias
              </span>
              <span style={{ ...styles.statBadge, background: '#2563eb' }}>
                {session.stats.info} info
              </span>
              <span style={{ ...styles.statBadge, background: '#16a34a' }}>
                {session.stats.fixed} corregidos
              </span>
            </>
          )}
        </div>
      </div>

      {/* Split pane */}
      <div style={styles.splitPane}>
        {/* Left: Document Preview — light paper background */}
        <div style={styles.leftPane}>
          {/* ── Sticky Audio Player Bar ── */}
          {totalDuration > 0 && (
            <div style={styles.audioPlayerBar}>
              {/* Play / Pause */}
              <button onClick={togglePlayPause} style={styles.playPauseBtn} title={audioPlaying ? 'Pausar' : 'Reproducir'}>
                {audioPlaying ? '⏸' : '▶'}
              </button>

              {/* Rewind 10s */}
              <button onClick={() => skipBy(-10)} style={styles.skipBtn} title="Retroceder 10s">
                ⏪
              </button>

              {/* Current time */}
              <span style={styles.timeLabel}>{formatTime(globalPlayheadSec)}</span>

              {/* Seek slider — represents total audio duration across all chunks */}
              <input
                type="range"
                min={0}
                max={totalDuration}
                step={0.5}
                value={globalPlayheadSec}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  setGlobalPlayheadSec(val);
                }}
                onMouseDown={() => setIsSeeking(true)}
                onMouseUp={(e) => {
                  setIsSeeking(false);
                  const val = parseFloat((e.target as HTMLInputElement).value);
                  seekToGlobal(val, audioPlaying);
                }}
                onTouchStart={() => setIsSeeking(true)}
                onTouchEnd={(e) => {
                  setIsSeeking(false);
                  const val = parseFloat((e.target as HTMLInputElement).value);
                  seekToGlobal(val, audioPlaying);
                }}
                style={styles.seekSlider}
              />

              {/* Total time */}
              <span style={styles.timeLabel}>{formatTime(totalDuration)}</span>

              {/* Forward 10s */}
              <button onClick={() => skipBy(10)} style={styles.skipBtn} title="Avanzar 10s">
                ⏩
              </button>

              {/* Chunk indicator */}
              <span style={styles.chunkIndicator}>
                {currentAudioPart >= 0 ? `Parte ${currentAudioPart + 1}/${audioFiles.length}` : ''}
              </span>
            </div>
          )}

          {/* Document header with mode toggle + actions */}
          <div style={styles.docHeader}>
            <h3 style={{ margin: 0, fontSize: 14, color: '#475569' }}>📄 Documento</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
              {/* Toggle Edit / View */}
              <button
                onClick={() => {
                  if (!editMode) {
                    setEditBuffer(markdown);
                    setEditMode(true);
                  } else {
                    setEditMode(false);
                  }
                }}
                style={{
                  ...styles.docActionBtn,
                  background: editMode ? '#3b82f6' : '#e2e8f0',
                  color: editMode ? '#fff' : '#334155',
                }}
              >
                {editMode ? '📖 Vista previa' : '✏️ Editar'}
              </button>
              {/* Save */}
              {editMode && (
                <button
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true);
                    try {
                      await saveReviewDocument(jobId, editBuffer);
                      setMarkdown(editBuffer);
                      setEditMode(false);
                    } catch (err) {
                      alert(`Error al guardar: ${(err as Error).message}`);
                    } finally {
                      setSaving(false);
                    }
                  }}
                  style={{ ...styles.docActionBtn, background: '#22c55e', color: '#fff', opacity: saving ? 0.6 : 1 }}
                >
                  {saving ? '⏳ Guardando...' : '💾 Guardar'}
                </button>
              )}
              {/* Generate & Download DOCX/PDF — single unified button */}
              <button
                disabled={exporting}
                onClick={async () => {
                  setExporting(true);
                  try {
                    // If in edit mode, save first
                    if (editMode) {
                      await saveReviewDocument(jobId, editBuffer);
                      setMarkdown(editBuffer);
                      setEditMode(false);
                    }
                    const result = await exportReviewDocument(jobId);
                    if (result.success) {
                      // Refresh file list
                      const filesData = await getOutputFiles(jobId);
                      setOutputFiles(filesData.files);
                    } else {
                      alert(`Error: ${result.message}`);
                    }
                  } catch (err) {
                    alert(`Error al exportar: ${(err as Error).message}`);
                  } finally {
                    setExporting(false);
                  }
                }}
                style={{ ...styles.docActionBtn, background: '#7c3aed', color: '#fff', opacity: exporting ? 0.6 : 1 }}
              >
                {exporting ? '⏳ Generando...' : '🔄 Generar Documento'}
              </button>
              {/* Download links — show after generation */}
              {(() => {
                const docx = outputFiles.filter(f => f.ext === 'docx');
                const pdf = outputFiles.filter(f => f.ext === 'pdf');
                const latest = [
                  ...(docx.length > 0 ? [docx[docx.length - 1]] : []),
                  ...(pdf.length > 0 ? [pdf[pdf.length - 1]] : []),
                ];
                return latest.map((f) => (
                  <a
                    key={f.name}
                    href={getDownloadUrl(jobId, f.name)}
                    download={f.name}
                    style={{
                      ...styles.docActionBtn,
                      background: f.ext === 'docx' ? '#2563eb' : '#dc2626',
                      color: '#fff',
                      textDecoration: 'none',
                      fontSize: 11,
                    }}
                    title={`Descargar ${f.name} (${(f.size / 1024).toFixed(0)} KB)`}
                  >
                    {f.ext === 'docx' ? '📄 Descargar DOCX' : '📕 Descargar PDF'}
                  </a>
                ));
              })()}
            </div>
          </div>
          {/* Edit mode: textarea | View mode: rendered HTML */}
          {editMode ? (
            <textarea
              value={editBuffer}
              onChange={(e) => setEditBuffer(e.target.value)}
              style={styles.editTextarea}
              spellCheck={false}
            />
          ) : (
            <div
              ref={docRef}
              style={styles.docContent}
              dangerouslySetInnerHTML={{ __html: renderedHTML }}
              onClick={(e) => {
                // Handle audio button clicks — seek the player bar + play the section
                const target = e.target as HTMLElement;
                const btn = target.closest('[data-audio-start]') as HTMLElement | null;
                if (btn) {
                  e.preventDefault();
                  const start = parseFloat(btn.getAttribute('data-audio-start') || '0');
                  const end = parseFloat(btn.getAttribute('data-audio-end') || '0');
                  setActiveAudioTime(null);
                  playAudioAt(start, end);
                }
              }}
            />
          )}
        </div>

        {/* Divider */}
        <div style={styles.divider} />

        {/* Right: Review Kanban + Selected Item Detail */}
        <div style={styles.rightPane}>
          {/* Selected item detail card */}
          {selectedItem && (
            <div style={styles.detailCard}>
              <div style={styles.detailHeader}>
                <span style={{ fontSize: 12 }}>
                  {SEVERITY_ICONS[selectedItem.severity]} {TYPE_LABELS[selectedItem.type]}
                </span>
                <button
                  onClick={() => setSelectedItem(null)}
                  style={styles.closeBtn}
                >✕</button>
              </div>
              <h4 style={{ margin: '8px 0 4px', color: '#e2e8f0' }}>{selectedItem.title}</h4>
              <p style={{ fontSize: 13, color: '#94a3b8', margin: '0 0 8px' }}>
                {selectedItem.description}
              </p>

              {selectedItem.location.contextSnippet && (
                <div style={styles.contextSnippetBox}>
                  <div style={{ fontSize: 10, color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>
                    Contexto en el documento:
                  </div>
                  <p style={{ fontSize: 12, color: '#cbd5e1', margin: 0, fontStyle: 'italic' }}>
                    &quot;{selectedItem.location.contextSnippet.substring(0, 200)}&quot;
                  </p>
                </div>
              )}

              {selectedItem.suggestedFix && (
                <div style={styles.suggestedFix}>
                  <div style={{ fontSize: 11, color: '#22c55e', marginBottom: 4 }}>
                    💡 Corrección sugerida:
                  </div>
                  <p style={{ fontSize: 12, color: '#cbd5e1', margin: 0, whiteSpace: 'pre-wrap' }}>
                    {selectedItem.suggestedFix}
                  </p>
                </div>
              )}

              <div style={styles.detailActions}>
                {selectedItem.status !== 'fixed' && selectedItem.suggestedFix && (
                  <button
                    onClick={() => handleApplyFix(selectedItem.id)}
                    disabled={applyingFix === selectedItem.id}
                    style={{
                      ...styles.actionBtn,
                      background: '#22c55e',
                      opacity: applyingFix === selectedItem.id ? 0.5 : 1,
                    }}
                  >
                    {applyingFix === selectedItem.id ? '⏳' : '🪄'} Aplicar corrección
                  </button>
                )}
                {selectedItem.status !== 'dismissed' && (
                  <button
                    onClick={() => handleStatusChange(selectedItem.id, 'dismissed')}
                    style={{ ...styles.actionBtn, background: '#6b7280' }}
                  >
                    🚫 Descartar
                  </button>
                )}
                {selectedItem.status !== 'reviewing' && selectedItem.status !== 'fixed' && (
                  <button
                    onClick={() => handleStatusChange(selectedItem.id, 'reviewing')}
                    style={{ ...styles.actionBtn, background: '#3b82f6' }}
                  >
                    🔍 En revisión
                  </button>
                )}
                {selectedItem.audioRef?.startTimeSec != null && (
                  <button
                    onClick={() => playAudioAt(
                      selectedItem.audioRef!.startTimeSec!,
                      selectedItem.audioRef!.endTimeSec || selectedItem.audioRef!.startTimeSec! + 60,
                    )}
                    style={{ ...styles.actionBtn, background: '#7c3aed' }}
                  >
                    🎧 Escuchar ({formatTime(selectedItem.audioRef.startTimeSec)})
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Kanban columns */}
          <div style={styles.kanbanContainer}>
            {columns.map(col => (
              <div key={col.key} style={styles.kanbanColumn}>
                <div style={{
                  ...styles.kanbanColumnHeader,
                  borderBottomColor: col.color,
                }}>
                  <span>{col.icon} {col.label}</span>
                  <span style={styles.kanbanCount}>{col.items.length}</span>
                </div>
                <div style={styles.kanbanCards}>
                  {col.items.map(item => (
                    <div
                      key={item.id}
                      onClick={() => handleItemClick(item)}
                      style={{
                        ...styles.kanbanCard,
                        borderLeftColor: SEVERITY_COLORS[item.severity],
                        background: selectedItem?.id === item.id ? '#1e3a5f' : '#1e293b',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 11 }}>{SEVERITY_ICONS[item.severity]}</span>
                        <span style={{
                          fontSize: 10,
                          padding: '1px 6px',
                          borderRadius: 4,
                          background: 'rgba(255,255,255,0.1)',
                          color: '#94a3b8',
                        }}>
                          {TYPE_LABELS[item.type]}
                        </span>
                        {item.audioRef?.startTimeSec != null && (
                          <span
                            style={{ fontSize: 10, cursor: 'pointer' }}
                            title={`Audio: ${formatTime(item.audioRef.startTimeSec)}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              playAudioAt(
                                item.audioRef!.startTimeSec!,
                                item.audioRef!.endTimeSec || item.audioRef!.startTimeSec! + 60,
                              );
                            }}
                          >🎧</span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 500 }}>
                        {item.title}
                      </div>
                      <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                        § {item.location.sectionHeading?.substring(0, 40)}
                      </div>
                    </div>
                  ))}
                  {col.items.length === 0 && (
                    <div style={{ padding: 12, fontSize: 12, color: '#475569', textAlign: 'center' }}>
                      Sin elementos
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ──

function formatTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Convert markdown to annotated HTML with paragraph indices and audio buttons.
 * Uses a light/paper theme for readability.
 */
function markdownToAnnotatedHTML(markdown: string, segments: TranscriptSegment[]): string {
  if (!markdown) return '<p style="color:#94a3b8;text-align:center;padding:40px">Cargando documento...</p>';

  const paragraphs = markdown.split(/\n\n+/);
  const htmlParts: string[] = [];

  htmlParts.push(`<style>
    .review-highlight {
      background: rgba(250, 204, 21, 0.25) !important;
      outline: 2px solid #eab308;
      border-radius: 4px;
      transition: all 0.3s ease;
    }
    .audio-btn {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 10px;
      margin-left: 8px;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 12px;
      color: #2563eb;
      font-size: 11px;
      cursor: pointer;
      vertical-align: middle;
      transition: background 0.15s;
      font-family: inherit;
      font-weight: 500;
    }
    .audio-btn:hover {
      background: #dbeafe;
      border-color: #93c5fd;
    }
    .doc-section-heading {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
  </style>`);

  let inAnnex = false;

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i].trim();
    if (!p) continue;

    // Detect ANEXOS section
    if (p.startsWith('# ') && /ANEXOS/i.test(p)) {
      inAnnex = true;
    }

    // Skip detail voting tables in the body (they belong in the annex)
    if (!inAnnex && p.startsWith('|')) {
      const firstLine = p.split('\n')[0] || '';
      const lower = firstLine.toLowerCase();
      if (lower.includes('unidad') && (lower.includes('propietario') || lower.includes('coef'))) {
        htmlParts.push(`<div data-para-idx="${i}" style="padding:3px 6px"><p style="margin:8px 0;color:#64748b;font-style:italic">Ver anexo de acta de votación detallada.</p></div>`);
        continue;
      }
    }

    // Skip "Acta detallada de votación" bold headings in the body
    if (!inAnnex && /^\*\*Acta detallada|^\*\*ACTA DE VOTACION/i.test(p)) {
      continue;
    }

    let html: string;

    if (p.startsWith('# ')) {
      const heading = escapeHtml(p.slice(2));
      const audioBtn = findAudioButton(heading, segments);
      html = `<h1 class="doc-section-heading" style="font-size:22px;color:#0f172a;border-bottom:2px solid #cbd5e1;padding-bottom:10px;margin:40px 0 14px;font-weight:700">${heading}${audioBtn}</h1>`;
    } else if (p.startsWith('## ')) {
      const heading = escapeHtml(p.slice(3));
      const audioBtn = findAudioButton(heading, segments);
      html = `<h2 class="doc-section-heading" style="font-size:18px;color:#1e293b;margin:36px 0 10px;font-weight:600">${heading}${audioBtn}</h2>`;
    } else if (p.startsWith('### ')) {
      const heading = escapeHtml(p.slice(4));
      const audioBtn = findAudioButton(heading, segments);
      html = `<h3 class="doc-section-heading" style="font-size:15px;color:#334155;margin:30px 0 8px;font-weight:600">${heading}${audioBtn}</h3>`;
    } else if (p.startsWith('**') && p.endsWith('**') && !p.includes('\n')) {
      // Bold-only line = section heading
      const heading = escapeHtml(p.slice(2, -2));
      const audioBtn = findAudioButton(heading, segments);
      html = `<h3 class="doc-section-heading" style="font-size:14px;color:#1e293b;margin:32px 0 10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">${heading}${audioBtn}</h3>`;
    } else if (p.startsWith('> ')) {
      html = `<blockquote style="border-left:3px solid #3b82f6;padding:10px 16px;margin:10px 0;color:#475569;font-style:italic;background:#eff6ff;border-radius:0 6px 6px 0">${formatInlineMarkdown(p.slice(2))}</blockquote>`;
    } else if (p.startsWith('- ')) {
      const listItems = p.split('\n').map(l => `<li style="margin:3px 0">${formatInlineMarkdown(l.replace(/^-\s*/, ''))}</li>`).join('');
      html = `<ul style="margin:8px 0;padding-left:24px;color:#334155">${listItems}</ul>`;
    } else if (p.startsWith('|')) {
      html = renderMarkdownTable(p);
    } else if (p === '---') {
      html = '<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0" />';
    } else {
      html = `<p style="margin:10px 0;line-height:1.8;color:#334155;text-align:justify">${formatInlineMarkdown(p)}</p>`;
    }

    htmlParts.push(`<div data-para-idx="${i}" style="padding:3px 6px;border-radius:4px;cursor:pointer" title="Párrafo ${i}">${html}</div>`);
  }

  return htmlParts.join('\n');
}

/**
 * Find a matching transcript segment for a section heading and generate an audio button.
 */
function findAudioButton(headingText: string, segments: TranscriptSegment[]): string {
  if (segments.length === 0) return '';

  const words = headingText
    .toLowerCase()
    .replace(/[^a-záéíóúñü\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 4)
    .slice(0, 6);

  if (words.length < 2) return '';

  let bestSeg: TranscriptSegment | null = null;
  let bestScore = 0;

  for (const seg of segments) {
    const segText = seg.text.toLowerCase();
    const score = words.filter(w => segText.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      bestSeg = seg;
    }
  }

  if (!bestSeg || bestScore < 2) return '';

  const hrs = Math.floor(bestSeg.start / 3600);
  const mins = Math.floor((bestSeg.start % 3600) / 60);
  const secs = Math.floor(bestSeg.start % 60);
  const timeStr = hrs > 0
    ? `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    : `${mins}:${secs.toString().padStart(2, '0')}`;

  return `<button class="audio-btn" data-audio-start="${bestSeg.start}" data-audio-end="${bestSeg.end}" title="Escuchar desde ${timeStr}">🎧 ${timeStr}</button>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatInlineMarkdown(text: string): string {
  let html = escapeHtml(text);
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#0f172a;font-weight:600">$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  return html;
}

function renderMarkdownTable(tableStr: string): string {
  const lines = tableStr.split('\n').filter(l => l.trim().startsWith('|'));
  if (lines.length < 2) return `<p>${escapeHtml(tableStr)}</p>`;

  const parseRow = (line: string) =>
    line.split('|').slice(1, -1).map(c => c.trim());

  const headers = parseRow(lines[0]);
  // Skip separator line (index 1)
  const dataRows = lines.slice(2).map(parseRow);

  let html = '<div style="overflow-x:auto;margin:12px 0"><table style="width:100%;border-collapse:collapse;font-size:12px">';
  html += '<thead><tr>';
  for (const h of headers) {
    html += `<th style="border:1px solid #163d64;padding:6px 10px;background:#1F4E79;color:#ffffff;text-align:center;font-weight:600;font-size:11px">${escapeHtml(h)}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r];
    const isTotals = row.some(c => /\*\*TOTAL|Total general/i.test(c));
    const bg = isTotals ? '#D9D9D9' : (r % 2 === 1 ? '#D6E4F0' : '#ffffff');
    const fontWeight = isTotals ? 'font-weight:700;' : '';
    html += `<tr style="background:${bg}">`;
    for (const cell of row) {
      html += `<td style="border:1px solid #d1d5db;padding:4px 10px;color:#334155;text-align:center;${fontWeight}">${formatInlineMarkdown(cell)}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

// ── Styles ──

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: '#0f172a',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#e2e8f0',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '8px 16px',
    background: '#1e293b',
    borderBottom: '1px solid #334155',
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 600,
    color: '#f8fafc',
  },
  statsBar: {
    display: 'flex',
    gap: 8,
    marginLeft: 'auto',
  },
  statBadge: {
    padding: '2px 10px',
    borderRadius: 12,
    fontSize: 11,
    fontWeight: 600,
    color: '#fff',
  },
  backButton: {
    background: 'transparent',
    border: '1px solid #475569',
    color: '#94a3b8',
    padding: '4px 12px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
  },
  splitPane: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  leftPane: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    minWidth: 0,
  },
  docHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 16px',
    background: '#f1f5f9',
    borderBottom: '1px solid #e2e8f0',
  },
  docContent: {
    flex: 1,
    overflow: 'auto',
    padding: '24px 40px',
    fontSize: 14,
    lineHeight: 1.8,
    background: '#ffffff',
    color: '#1e293b',
  },
  editTextarea: {
    flex: 1,
    width: '100%',
    padding: '24px 40px',
    fontSize: 13,
    lineHeight: 1.7,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    background: '#fffef5',
    color: '#1e293b',
    border: 'none',
    outline: 'none',
    resize: 'none' as const,
    boxSizing: 'border-box' as const,
  },
  docActionBtn: {
    border: 'none',
    padding: '4px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    whiteSpace: 'nowrap' as const,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  },
  audioPlayerBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 16px',
    background: 'linear-gradient(180deg, #1e293b 0%, #0f172a 100%)',
    borderBottom: '1px solid #334155',
    flexShrink: 0,
    position: 'sticky' as const,
    top: 0,
    zIndex: 20,
  },
  playPauseBtn: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    border: 'none',
    background: '#3b82f6',
    color: '#fff',
    fontSize: 14,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    transition: 'background 0.15s',
  },
  skipBtn: {
    background: 'transparent',
    border: 'none',
    color: '#94a3b8',
    fontSize: 14,
    cursor: 'pointer',
    padding: '2px 4px',
    borderRadius: 4,
    flexShrink: 0,
    transition: 'color 0.15s',
  },
  timeLabel: {
    fontSize: 11,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    color: '#94a3b8',
    minWidth: 52,
    textAlign: 'center' as const,
    flexShrink: 0,
    userSelect: 'none' as const,
  },
  seekSlider: {
    flex: 1,
    height: 6,
    cursor: 'pointer',
    accentColor: '#3b82f6',
    margin: '0 4px',
  },
  chunkIndicator: {
    fontSize: 10,
    color: '#475569',
    flexShrink: 0,
    minWidth: 60,
    textAlign: 'right' as const,
  },
  divider: {
    width: 4,
    background: '#334155',
    cursor: 'col-resize',
    flexShrink: 0,
  },
  rightPane: {
    width: 520,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: '#0f172a',
    flexShrink: 0,
  },
  detailCard: {
    margin: '8px 8px 0',
    padding: 12,
    background: '#1e293b',
    borderRadius: 8,
    border: '1px solid #334155',
    flexShrink: 0,
    maxHeight: 350,
    overflow: 'auto',
  },
  detailHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: '#64748b',
    cursor: 'pointer',
    fontSize: 14,
    padding: '2px 6px',
  },
  contextSnippetBox: {
    background: 'rgba(100, 116, 139, 0.1)',
    border: '1px solid rgba(100, 116, 139, 0.2)',
    borderRadius: 6,
    padding: 8,
    marginBottom: 8,
  },
  suggestedFix: {
    background: 'rgba(34, 197, 94, 0.08)',
    border: '1px solid rgba(34, 197, 94, 0.2)',
    borderRadius: 6,
    padding: 8,
    marginBottom: 8,
  },
  detailActions: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap' as const,
  },
  actionBtn: {
    border: 'none',
    color: '#fff',
    padding: '4px 10px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 500,
  },
  kanbanContainer: {
    flex: 1,
    overflow: 'auto',
    padding: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },
  kanbanColumn: {
    background: '#1e293b',
    borderRadius: 8,
    marginBottom: 8,
    overflow: 'hidden',
  },
  kanbanColumnHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 600,
    color: '#e2e8f0',
    borderBottom: '2px solid',
  },
  kanbanCount: {
    background: 'rgba(255,255,255,0.1)',
    padding: '1px 8px',
    borderRadius: 10,
    fontSize: 11,
    color: '#94a3b8',
  },
  kanbanCards: {
    padding: 6,
    maxHeight: 200,
    overflow: 'auto',
  },
  kanbanCard: {
    padding: '8px 10px',
    borderRadius: 6,
    marginBottom: 4,
    cursor: 'pointer',
    borderLeft: '3px solid',
    transition: 'background 0.15s',
  },
  loadingOverlay: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  spinner: {
    width: 40,
    height: 40,
    border: '3px solid #334155',
    borderTop: '3px solid #3b82f6',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  errorBox: {
    maxWidth: 400,
    margin: '100px auto',
    padding: 24,
    background: '#1e293b',
    borderRadius: 12,
    border: '1px solid #ef4444',
    textAlign: 'center' as const,
  },
};
