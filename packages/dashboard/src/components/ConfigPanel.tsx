import { useState, useEffect, useCallback } from 'react';
import type { AgentNode } from '../types/index.js';

interface Props {
  node: AgentNode;
  onClose: () => void;
  onSwitchToChat: () => void;
}

export interface YuliethConfig {
  driveFolderId: string;
  pollIntervalSeconds: number;
  autoQueue: boolean;
  audioExtensions: string[];
  votingExtensions: string[];
  isWatching: boolean;
}

const DEFAULT_CONFIG: YuliethConfig = {
  driveFolderId: '',
  pollIntervalSeconds: 60,
  autoQueue: false,
  audioExtensions: ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.mp4'],
  votingExtensions: ['.xlsx', '.csv', '.json'],
  isWatching: false,
};

export default function ConfigPanel({ node, onClose, onSwitchToChat }: Props) {
  const [config, setConfig] = useState<YuliethConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [scanning, setScanning] = useState(false);

  // Load config on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/agents/yulieth/config`);
        if (res.ok) {
          const data = await res.json();
          setConfig({ ...DEFAULT_CONFIG, ...data });
        }
      } catch {
        // Use defaults
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/agents/yulieth/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setConfig(data.config);
      setMessage({ type: 'success', text: '✅ Configuration saved' });
    } catch (err) {
      setMessage({ type: 'error', text: `❌ ${err instanceof Error ? err.message : 'Save failed'}` });
    } finally {
      setSaving(false);
    }
  }, [config]);

  const handleToggleWatcher = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      const action = config.isWatching ? 'stop' : 'start';
      const res = await fetch(`/api/agents/yulieth/watcher`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setConfig((prev) => ({ ...prev, isWatching: data.isWatching }));
      setMessage({ type: 'success', text: data.isWatching ? '👁️ Watcher started' : '⏸️ Watcher stopped' });
    } catch (err) {
      setMessage({ type: 'error', text: `❌ ${err instanceof Error ? err.message : 'Failed'}` });
    } finally {
      setSaving(false);
    }
  }, [config.isWatching]);

  const handleScanNow = useCallback(async () => {
    setScanning(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/agents/yulieth/drive-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: config.driveFolderId }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setMessage({ type: 'success', text: `🔍 Found ${data.folders?.length ?? 0} event folders` });
    } catch (err) {
      setMessage({ type: 'error', text: `❌ ${err instanceof Error ? err.message : 'Scan failed'}` });
    } finally {
      setScanning(false);
    }
  }, [config.driveFolderId]);

  if (loading) {
    return (
      <div style={{ width: '420px', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1e293b', borderLeft: `3px solid ${node.color}` }}>
        <span style={{ color: '#94a3b8', fontSize: '14px' }}>Loading config…</span>
      </div>
    );
  }

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
      // Allow all keyboard shortcuts (Cmd+C, Cmd+V, Cmd+X, Cmd+A) inside the panel
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
          <span style={{ fontSize: '22px' }}>⚙️</span>
          <div>
            <h3 style={{ margin: 0, color: '#f1f5f9', fontSize: '15px', fontWeight: 700 }}>
              Configure {node.label}
            </h3>
            <p style={{ margin: 0, color: '#64748b', fontSize: '11px' }}>Pipeline intake settings</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={onSwitchToChat} style={headerBtnStyle} title="Switch to Chat">💬</button>
          <button onClick={onClose} style={headerBtnStyle} title="Close">✕</button>
        </div>
      </div>

      {/* Form */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 18px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

        {/* Drive Folder */}
        <FieldGroup label="Google Drive Folder ID" hint="The root folder Yulieth monitors for new assembly event subfolders.">
          <input
            type="text"
            value={config.driveFolderId}
            onChange={(e) => setConfig((c) => ({ ...c, driveFolderId: e.target.value }))}
            placeholder="e.g. 1wtG2eFqugeA9PEzyiHxKd3Cp22GEtFsD"
            style={inputStyle}
          />
        </FieldGroup>

        {/* Poll Interval */}
        <FieldGroup label="Poll Interval (seconds)" hint="How often to check for new files. Minimum 30s.">
          <input
            type="number"
            min={30}
            max={3600}
            value={config.pollIntervalSeconds}
            onChange={(e) => setConfig((c) => ({ ...c, pollIntervalSeconds: Math.max(30, parseInt(e.target.value) || 60) }))}
            style={inputStyle}
          />
        </FieldGroup>

        {/* Auto Queue */}
        <FieldGroup label="Auto-Queue Jobs" hint="When enabled, valid event folders are automatically queued for processing.">
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <div
              onClick={() => setConfig((c) => ({ ...c, autoQueue: !c.autoQueue }))}
              style={{
                width: '44px',
                height: '24px',
                borderRadius: '12px',
                background: config.autoQueue ? '#7c3aed' : '#475569',
                position: 'relative',
                transition: 'background 0.2s',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <div style={{
                width: '18px',
                height: '18px',
                borderRadius: '50%',
                background: '#fff',
                position: 'absolute',
                top: '3px',
                left: config.autoQueue ? '23px' : '3px',
                transition: 'left 0.2s',
              }} />
            </div>
            <span style={{ color: '#cbd5e1', fontSize: '13px' }}>
              {config.autoQueue ? 'Enabled — files auto-queued' : 'Disabled — manual queue only'}
            </span>
          </label>
        </FieldGroup>

        {/* Audio Extensions */}
        <FieldGroup label="Audio Extensions" hint="File extensions recognized as audio recordings.">
          <input
            type="text"
            value={config.audioExtensions.join(', ')}
            onChange={(e) => setConfig((c) => ({
              ...c,
              audioExtensions: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
            }))}
            style={inputStyle}
          />
        </FieldGroup>

        {/* Voting Extensions */}
        <FieldGroup label="Voting File Extensions" hint="File extensions recognized as voting/attendance data.">
          <input
            type="text"
            value={config.votingExtensions.join(', ')}
            onChange={(e) => setConfig((c) => ({
              ...c,
              votingExtensions: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
            }))}
            style={inputStyle}
          />
        </FieldGroup>

        {/* Watcher Status */}
        <div style={{
          background: '#0f172a',
          borderRadius: '8px',
          padding: '14px 16px',
          border: `1px solid ${config.isWatching ? '#7c3aed' : '#334155'}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                background: config.isWatching ? '#22c55e' : '#64748b',
                display: 'inline-block',
                boxShadow: config.isWatching ? '0 0 8px #22c55e' : 'none',
              }} />
              <span style={{ color: '#e2e8f0', fontSize: '13px', fontWeight: 600 }}>
                Watcher {config.isWatching ? 'Active' : 'Stopped'}
              </span>
            </div>
            <button
              onClick={handleToggleWatcher}
              disabled={saving || !config.driveFolderId}
              style={{
                background: config.isWatching ? '#dc2626' : '#7c3aed',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                padding: '6px 14px',
                fontSize: '12px',
                cursor: saving || !config.driveFolderId ? 'not-allowed' : 'pointer',
                opacity: saving || !config.driveFolderId ? 0.5 : 1,
              }}
            >
              {config.isWatching ? '⏸ Stop' : '▶ Start'}
            </button>
          </div>
          <button
            onClick={handleScanNow}
            disabled={scanning || !config.driveFolderId}
            style={{
              width: '100%',
              background: '#334155',
              color: '#e2e8f0',
              border: '1px solid #475569',
              borderRadius: '6px',
              padding: '8px',
              fontSize: '12px',
              cursor: scanning || !config.driveFolderId ? 'not-allowed' : 'pointer',
              opacity: scanning || !config.driveFolderId ? 0.5 : 1,
            }}
          >
            {scanning ? '🔍 Scanning…' : '🔍 Scan Now'}
          </button>
        </div>

        {/* Status message */}
        {message && (
          <div style={{
            padding: '10px 14px',
            borderRadius: '6px',
            background: message.type === 'success' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            border: `1px solid ${message.type === 'success' ? '#22c55e33' : '#ef444433'}`,
            color: message.type === 'success' ? '#86efac' : '#fca5a5',
            fontSize: '12px',
          }}>
            {message.text}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: '12px 18px',
        background: '#0f172a',
        borderTop: '1px solid #334155',
        flexShrink: 0,
      }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            width: '100%',
            background: '#7c3aed',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            padding: '10px',
            fontSize: '13px',
            fontWeight: 600,
            cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : '💾 Save Configuration'}
        </button>
      </div>
    </div>
  );
}

// ── Helpers ──

function FieldGroup({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', color: '#e2e8f0', fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>
        {label}
      </label>
      <p style={{ margin: '0 0 8px', color: '#64748b', fontSize: '11px' }}>{hint}</p>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#0f172a',
  border: '1px solid #475569',
  borderRadius: '6px',
  padding: '10px 12px',
  color: '#e2e8f0',
  fontSize: '13px',
  fontFamily: 'monospace',
  outline: 'none',
  boxSizing: 'border-box',
  userSelect: 'text',
  WebkitUserSelect: 'text',
};

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
