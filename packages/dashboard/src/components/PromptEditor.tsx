import { useState, useEffect, useCallback } from 'react';
import type { AgentNode, AgentId } from '../types/index.js';

// Agents that have processing prompts (sent to Claude for actual data work)
const PROCESSING_AGENTS = new Set(['jaime', 'lina']);

interface ProcessingPrompt { key: string; label: string; prompt: string; length: number }

interface Props {
  node: AgentNode;
  agentId: AgentId;
  onClose: () => void;
  onSwitchToChat: () => void;
}

export default function PromptEditor({ node, agentId, onClose, onSwitchToChat }: Props) {
  const hasProcessing = PROCESSING_AGENTS.has(agentId);
  const [tab, setTab] = useState<'processing' | 'chat'>(hasProcessing ? 'processing' : 'chat');
  const [prompt, setPrompt] = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [processingPrompts, setProcessingPrompts] = useState<ProcessingPrompt[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [promptLabel, setPromptLabel] = useState('');

  // Load chat prompt
  const loadChatPrompt = useCallback(() => {
    setLoading(true);
    fetch('/api/agents/' + agentId + '/prompt')
      .then(r => r.json())
      .then(data => { setPrompt(data.prompt || ''); setOriginal(data.prompt || ''); setPromptLabel('Chat System Prompt'); setLoading(false); })
      .catch(() => { setPrompt(''); setOriginal(''); setLoading(false); });
  }, [agentId]);

  // Load processing prompts
  const loadProcessingPrompts = useCallback(() => {
    setLoading(true);
    fetch('/api/agents/' + agentId + '/processing-prompt')
      .then(r => r.json())
      .then(data => {
        const list: ProcessingPrompt[] = (data.prompts || []).map((p: any) => ({ key: p.key, label: p.label, prompt: p.prompt, length: p.prompt.length }));
        setProcessingPrompts(list);
        if (list.length > 0) {
          const first = list[0];
          setSelectedKey(first.key);
          setPrompt(first.prompt);
          setOriginal(first.prompt);
          setPromptLabel(first.label);
        }
        setLoading(false);
      })
      .catch(() => { setProcessingPrompts([]); setLoading(false); });
  }, [agentId]);

  useEffect(() => {
    setStatus('idle');
    if (tab === 'processing' && hasProcessing) loadProcessingPrompts();
    else loadChatPrompt();
  }, [agentId, tab]);

  const selectProcessingPrompt = (key: string) => {
    const p = processingPrompts.find(pp => pp.key === key);
    if (p) { setSelectedKey(key); setPrompt(p.prompt); setOriginal(p.prompt); setPromptLabel(p.label); setStatus('idle'); }
  };

  const isDirty = prompt !== original;

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatus('idle');
    try {
      let res;
      if (tab === 'processing') {
        res = await fetch('/api/processing-prompts/' + selectedKey, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, label: promptLabel }),
        });
      } else {
        res = await fetch('/api/agents/' + agentId + '/prompt', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        });
      }
      if (res.ok) { setOriginal(prompt); setStatus('saved'); setTimeout(() => setStatus('idle'), 3000); }
      else setStatus('error');
    } catch { setStatus('error'); }
    setSaving(false);
  }, [agentId, tab, selectedKey, prompt, promptLabel]);

  const handleReset = () => { setPrompt(original); setStatus('idle'); };

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (isDirty) handleSave(); }
  }, [isDirty, handleSave]);

  return (
    <div style={{ width: '520px', borderLeft: '1px solid #1e293b', background: '#0f172a', display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '16px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '20px' }}>{node.icon}</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: '14px', color: '#e2e8f0' }}>{promptLabel || node.label + ' Prompt'}</div>
            <div style={{ fontSize: '11px', color: '#64748b' }}>
              {loading ? 'Loading...' : prompt.length + ' chars'}{isDirty ? ' (unsaved)' : ''}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={onSwitchToChat} style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '6px', color: '#94a3b8', padding: '4px 8px', cursor: 'pointer', fontSize: '13px' }}>Chat</button>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '18px' }}>x</button>
        </div>
      </div>

      {/* Tabs (only show if agent has processing prompts) */}
      {hasProcessing && (
        <div style={{ display: 'flex', borderBottom: '1px solid #1e293b' }}>
          <button onClick={() => setTab('processing')}
            style={{ flex: 1, padding: '8px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
              background: tab === 'processing' ? '#1e293b' : 'transparent', color: tab === 'processing' ? node.color : '#64748b' }}>
            Processing Prompt
          </button>
          <button onClick={() => setTab('chat')}
            style={{ flex: 1, padding: '8px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
              background: tab === 'chat' ? '#1e293b' : 'transparent', color: tab === 'chat' ? node.color : '#64748b' }}>
            Chat Prompt
          </button>
        </div>
      )}

      {/* Processing prompt selector (when agent has multiple) */}
      {tab === 'processing' && processingPrompts.length > 1 && (
        <div style={{ display: 'flex', gap: '4px', padding: '8px 12px', borderBottom: '1px solid #1e293b', flexWrap: 'wrap' }}>
          {processingPrompts.map(p => (
            <button key={p.key} onClick={() => selectProcessingPrompt(p.key)}
              style={{
                padding: '4px 10px', borderRadius: '4px', border: 'none', cursor: 'pointer', fontSize: '11px',
                background: selectedKey === p.key ? node.color : '#1e293b',
                color: selectedKey === p.key ? '#fff' : '#94a3b8',
              }}>
              {p.label.split(' — ')[1] || p.label}
            </button>
          ))}
        </div>
      )}

      {/* Editor */}
      <div style={{ flex: 1, padding: '12px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <textarea value={prompt} onChange={e => { setPrompt(e.target.value); setStatus('idle'); }} onKeyDown={handleKeyDown} disabled={loading} spellCheck={false}
          style={{ flex: 1, width: '100%', resize: 'none', background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: '8px', padding: '12px', fontSize: '12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.6', outline: 'none' }} />
      </div>

      {/* Footer */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid #1e293b', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: '11px', color: '#64748b' }}>
          {status === 'saved' && '✓ Saved + synced to S3'}
          {status === 'error' && '✗ Save failed'}
          {status === 'idle' && isDirty && 'Cmd+S to save'}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={handleReset} disabled={!isDirty}
            style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '6px', color: isDirty ? '#e2e8f0' : '#475569', padding: '6px 14px', cursor: isDirty ? 'pointer' : 'not-allowed', fontSize: '12px' }}>Reset</button>
          <button onClick={handleSave} disabled={!isDirty || saving}
            style={{ background: isDirty ? node.color : '#334155', border: 'none', borderRadius: '6px', color: '#fff', padding: '6px 14px', cursor: isDirty && !saving ? 'pointer' : 'not-allowed', fontSize: '12px', fontWeight: 600, opacity: isDirty ? 1 : 0.5 }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
