import { useState } from 'react';
import ModelSettings from './ModelSettings.js';
import type { PipelineOverview } from '../types/index.js';

interface Props {
  overview: PipelineOverview | null;
  onAutoArrange: () => void;
  onOpenJobs: () => void;
}

export default function Toolbar({ overview, onAutoArrange, onOpenJobs }: Props) {
  const [showSettings, setShowSettings] = useState(false);
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 24px',
      background: '#1e293b',
      borderBottom: '1px solid #334155',
    }}>
      {/* Left: Title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: '20px' }}>🎛️</span>
        <h1 style={{ margin: 0, color: '#f1f5f9', fontSize: '18px', fontWeight: 700 }}>
          Transcriptor
        </h1>
        <span style={{ color: '#475569', fontSize: '13px' }}>Agent Dashboard</span>
      </div>

      {/* Center: Pipeline stats */}
      <div style={{ display: 'flex', gap: '24px', alignItems: 'center' }}>
        {overview && (
          <>
            <PipelineStat label="Active" value={overview.activeJobs} color="#22c55e" />
            <PipelineStat label="Queued" value={overview.queuedJobs} color="#f59e0b" />
            <PipelineStat label="Completed" value={overview.completedJobs} color="#38bdf8" />
            <PipelineStat label="Failed" value={overview.failedJobs} color="#ef4444" />
          </>
        )}
      </div>

      {/* Right: Actions */}
      <div style={{ display: 'flex', gap: '8px', position: 'relative' }}>
        <button
          onClick={onAutoArrange}
          style={{
            background: '#334155',
            color: '#e2e8f0',
            border: '1px solid #475569',
            borderRadius: '6px',
            padding: '6px 14px',
            fontSize: '12px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
          title="Reset nodes to default pipeline layout"
        >
          <span style={{ fontSize: '14px' }}>⬡</span>
          Auto-arrange
        </button>
        <button
          onClick={onOpenJobs}
          style={{
            background: '#334155',
            color: '#e2e8f0',
            border: '1px solid #475569',
            borderRadius: '6px',
            padding: '6px 14px',
            fontSize: '12px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
          title="Job-centered view with S3 reprocessing"
        >
          <span style={{ fontSize: '14px' }}>&#128188;</span>
          Jobs
        </button>
        <button
          onClick={() => setShowSettings(s => !s)}
          style={{
            background: showSettings ? '#475569' : '#334155',
            color: '#e2e8f0',
            border: '1px solid #475569',
            borderRadius: '6px',
            padding: '6px 14px',
            fontSize: '12px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
          title="LLM model configuration"
        >
          &#9881; Models
        </button>
        {showSettings && <ModelSettings onClose={() => setShowSettings(false)} />}
      </div>
    </div>
  );
}

function PipelineStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <span style={{
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: color,
        display: 'inline-block',
      }} />
      <span style={{ color: '#94a3b8', fontSize: '12px' }}>{label}</span>
      <span style={{ color: '#f1f5f9', fontSize: '14px', fontWeight: 700, fontFamily: 'monospace' }}>
        {value}
      </span>
    </div>
  );
}
