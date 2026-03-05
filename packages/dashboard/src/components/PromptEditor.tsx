import { useState, useEffect, useCallback } from 'react';
import type { AgentNode, AgentId } from '../types/index.js';

const API_BASE = '';

interface Props {
  node: AgentNode;
  agentId: AgentId;
  onClose: () => void;
  onSwitchToChat: () => void;
}

export default function PromptEditor({ node, agentId, onClose, onSwitchToChat }: Props) {
  const [prompt, setPrompt] = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');

  useEffect(() => {
    setLoading(true);
    setStatus('idle');
    fetch(API_BASE + '/api/agents/' + agentId + '/prompt')
      .then(r => r.json())
      .then(data => {
        setPrompt(data.prompt || '');
        setOriginal(data.prompt || '');
        setLoading(false);
      })
      .catch(() => {
        setPrompt('(No prompt available for this agent)');
        setOriginal('');
        setLoading(false);
      });
  }, [agentId]);

  const isDirty = prompt !== original;

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatus('idle');
    try {
      const res = await fetch(API_BASE + '/api/agents/' + agentId + '/prompt', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (res.ok) {
        setOriginal(prompt);
        setStatus('saved');
        setTimeout(() => setStatus('idle'), 3000);
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    }
    setSaving(false);
  }, [agentId, prompt]);

  const handleReset = () => { setPrompt(original); setStatus('idle'); };

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (isDirty) handleSave();
    }
  }, [isDirty, handleSave]);

  return (
    <div style={{
      width: '480px', borderLeft: '1px solid #1e293b', background: '#0f172a',
      display: 'flex', flexDirection: 'column', height: '100%',
    }}>
      {/* Header */}
      <div style={{
        padding: '16px', borderBottom: '1px solid #1e293b',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '20px' }}>{node.icon}</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: '14px', color: '#e2e8f0' }}>
              {node.label} — System Prompt
            </div>
            <div style={{ fontSize: '11px', color: '#64748b' }}>
              {loading ? 'Loading...' : prompt.length + ' chars'}
              {isDirty ? ' (unsaved changes)' : ''}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={onSwitchToChat} title="Chat"
            style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '6px', color: '#94a3b8', padding: '4px 8px', cursor: 'pointer', fontSize: '13px' }}>
            Chat
          </button>
          <button onClick={onClose} title="Close"
            style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '18px', padding: '0 4px' }}>
            x
          </button>
        </div>
      </div>

      {/* Editor */}
      <div style={{ flex: 1, padding: '12px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <textarea
          value={prompt}
          onChange={e => { setPrompt(e.target.value); setStatus('idle'); }}
          onKeyDown={handleKeyDown}
          disabled={loading}
          spellCheck={false}
          style={{
            flex: 1, width: '100%', resize: 'none',
            background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155',
            borderRadius: '8px', padding: '12px', fontSize: '12px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            lineHeight: '1.6', outline: 'none',
          }}
        />
      </div>

      {/* Footer */}
      <div style={{
        padding: '12px 16px', borderTop: '1px solid #1e293b',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ fontSize: '11px', color: '#64748b' }}>
          {status === 'saved' && '✓ Saved'}
          {status === 'error' && '✗ Save failed'}
          {status === 'idle' && isDirty && 'Cmd+S to save'}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={handleReset} disabled={!isDirty}
            style={{
              background: '#1e293b', border: '1px solid #334155', borderRadius: '6px',
              color: isDirty ? '#e2e8f0' : '#475569', padding: '6px 14px',
              cursor: isDirty ? 'pointer' : 'not-allowed', fontSize: '12px',
            }}>
            Reset
          </button>
          <button onClick={handleSave} disabled={!isDirty || saving}
            style={{
              background: isDirty ? node.color : '#334155',
              border: 'none', borderRadius: '6px',
              color: '#fff', padding: '6px 14px',
              cursor: isDirty && !saving ? 'pointer' : 'not-allowed', fontSize: '12px',
              fontWeight: 600, opacity: isDirty ? 1 : 0.5,
            }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
