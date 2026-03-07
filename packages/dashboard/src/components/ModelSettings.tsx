import { useState, useEffect, useRef } from 'react';

interface ModelOption {
  id: string;
  label: string;
  provider: string;
}

interface ModelConfigData {
  config: { linaModel: string; gloriaModel: string };
  effective: { linaModel: string; gloriaModel: string };
  available: ModelOption[];
}

export default function ModelSettings({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<ModelConfigData | null>(null);
  const [linaModel, setLinaModel] = useState('');
  const [gloriaModel, setGloriaModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/config/models')
      .then(r => r.json())
      .then((d: ModelConfigData) => {
        setData(d);
        setLinaModel(d.config.linaModel);
        setGloriaModel(d.config.gloriaModel);
      })
      .catch(() => setMessage('Failed to load config'));
  }, []);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  async function save() {
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch('/api/config/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linaModel, gloriaModel }),
      });
      const updated = await res.json();
      setData((prev) => prev ? { ...prev, ...updated } : prev);
      setMessage('Saved');
      setTimeout(() => setMessage(''), 2000);
    } catch {
      setMessage('Save failed');
    }
    setSaving(false);
  }

  const selectStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 8px',
    background: '#1e293b',
    color: '#e2e8f0',
    border: '1px solid #475569',
    borderRadius: '4px',
    fontSize: '12px',
    cursor: 'pointer',
  };

  return (
    <div ref={ref} style={{
      position: 'absolute',
      top: '48px',
      right: '8px',
      background: '#1e293b',
      border: '1px solid #475569',
      borderRadius: '8px',
      padding: '16px',
      width: '320px',
      zIndex: 1000,
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <span style={{ fontWeight: 700, fontSize: '14px', color: '#f1f5f9' }}>LLM Model Config</span>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '16px',
        }}>x</button>
      </div>

      {!data ? (
        <div style={{ color: '#64748b', fontSize: '12px' }}>Loading...</div>
      ) : (
        <>
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '11px', color: '#94a3b8', marginBottom: '4px', fontWeight: 600 }}>
              Lina (Redaction)
            </label>
            <select value={linaModel} onChange={e => setLinaModel(e.target.value)} style={selectStyle}>
              <option value="">Default ({data.effective.linaModel})</option>
              {data.available.map(m => (
                <option key={m.id} value={m.id}>{m.label} — {m.provider}</option>
              ))}
            </select>
            {linaModel && (
              <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px' }}>{linaModel}</div>
            )}
          </div>

          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '11px', color: '#94a3b8', marginBottom: '4px', fontWeight: 600 }}>
              Gloria (Review)
            </label>
            <select value={gloriaModel} onChange={e => setGloriaModel(e.target.value)} style={selectStyle}>
              <option value="">Default ({data.effective.gloriaModel})</option>
              {data.available.map(m => (
                <option key={m.id} value={m.id}>{m.label} — {m.provider}</option>
              ))}
            </select>
            {gloriaModel && (
              <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px' }}>{gloriaModel}</div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={save}
              disabled={saving}
              style={{
                background: '#3b82f6',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                padding: '6px 16px',
                fontSize: '12px',
                cursor: saving ? 'wait' : 'pointer',
                opacity: saving ? 0.6 : 1,
              }}
            >
              {saving ? 'Saving...' : 'Apply'}
            </button>
            {message && (
              <span style={{ fontSize: '11px', color: message === 'Saved' ? '#22c55e' : '#ef4444' }}>
                {message}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
