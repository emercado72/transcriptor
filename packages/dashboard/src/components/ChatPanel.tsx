import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react';
import type { AgentId, AgentNode } from '../types/index.js';
import { sendChatMessage } from '../api/client.js';

interface Props {
  node: AgentNode;
  onClose: () => void;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  timestamp: Date;
  loading?: boolean;
  error?: boolean;
}

// Per-agent personality hints shown as the first system bubble
const AGENT_GREETINGS: Record<AgentId, string> = {
  robinson:   '🗄️ I can query Tecnoreuniones for you — ask about assemblies, attendance, quorum, voting results, delegates, or anything else.',
  yulieth:    '👁️ I watch Google Drive for new audio files. Ask me about detected files, pending jobs, or queue status.',
  chucho:     '🎵 I preprocess audio files with FFmpeg. Ask me about audio formats, segment durations, or processing status.',
  jaime:      '📝 I handle transcription and sectioning. Ask me about transcripts, sections, speaker identification, or QA checks.',
  lina:       '✍️ I redact transcription sections into formal minutes using OpenAI. Ask me about prompt templates, redaction quality, or section content.',
  fannery:    '📄 I assemble the final .docx document. Ask me about document structure, tables, page layout, or template rendering.',
  gloria:     '✅ I manage review and approval. Ask me about draft status, flagged sections, or approval workflows.',
  supervisor: '🎛️ I orchestrate the entire pipeline. Ask me about job states, pipeline progress, error recovery, or agent coordination.',
};

let msgCounter = 0;
function nextId(): string {
  return `msg-${++msgCounter}-${Date.now()}`;
}

export default function ChatPanel({ node, onClose }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const prevAgentRef = useRef<AgentId | null>(null);

  // Reset chat when agent changes
  useEffect(() => {
    if (prevAgentRef.current !== node.id) {
      setMessages([{
        id: nextId(),
        role: 'agent',
        text: AGENT_GREETINGS[node.id],
        timestamp: new Date(),
      }]);
      setInput('');
      prevAgentRef.current = node.id;
    }
  }, [node.id]);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input on mount / agent change
  useEffect(() => {
    inputRef.current?.focus();
  }, [node.id]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isSending) return;

    const userMsg: ChatMessage = { id: nextId(), role: 'user', text, timestamp: new Date() };
    const loadingMsg: ChatMessage = { id: nextId(), role: 'agent', text: '', timestamp: new Date(), loading: true };

    setMessages((prev) => [...prev, userMsg, loadingMsg]);
    setInput('');
    setIsSending(true);

    try {
      const reply = await sendChatMessage(node.id, text);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === loadingMsg.id
            ? { ...m, text: reply, loading: false }
            : m
        )
      );
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === loadingMsg.id
            ? { ...m, text: `Error: ${err instanceof Error ? err.message : 'Request failed'}`, loading: false, error: true }
            : m
        )
      );
    } finally {
      setIsSending(false);
      inputRef.current?.focus();
    }
  }, [input, isSending, node.id]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  return (
    <div style={{
      width: '420px',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#1e293b',
      borderLeft: `3px solid ${node.color}`,
      overflow: 'hidden',
    }}>
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
          <span style={{ fontSize: '22px' }}>{node.icon}</span>
          <div>
            <h3 style={{ margin: 0, color: '#f1f5f9', fontSize: '15px', fontWeight: 700 }}>
              Chat with {node.label}
            </h3>
            <p style={{ margin: 0, color: '#64748b', fontSize: '11px' }}>{node.description}</p>
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: '#64748b',
            fontSize: '18px',
            cursor: 'pointer',
            padding: '4px 8px',
            borderRadius: '4px',
            lineHeight: 1,
          }}
          aria-label="Close chat"
          title="Close chat"
        >
          ✕
        </button>
      </div>

      {/* Messages */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              display: 'flex',
              justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div style={{
              maxWidth: '85%',
              padding: '10px 14px',
              borderRadius: msg.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
              background: msg.role === 'user'
                ? '#3b82f6'
                : msg.error
                  ? '#7f1d1d'
                  : '#334155',
              color: msg.error ? '#fca5a5' : '#e2e8f0',
              fontSize: '13px',
              lineHeight: '1.5',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {msg.loading ? (
                <span style={{ display: 'inline-flex', gap: '4px', padding: '4px 0' }}>
                  <Dot delay={0} color={node.color} />
                  <Dot delay={150} color={node.color} />
                  <Dot delay={300} color={node.color} />
                </span>
              ) : msg.text}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: '12px 16px',
        background: '#0f172a',
        borderTop: '1px solid #334155',
        flexShrink: 0,
      }}>
        <div style={{
          display: 'flex',
          gap: '8px',
          alignItems: 'flex-end',
        }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Ask ${node.label} something…`}
            rows={1}
            style={{
              flex: 1,
              resize: 'none',
              background: '#1e293b',
              border: '1px solid #475569',
              borderRadius: '10px',
              padding: '10px 14px',
              color: '#e2e8f0',
              fontSize: '13px',
              fontFamily: 'inherit',
              outline: 'none',
              maxHeight: '120px',
              lineHeight: '1.4',
            }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isSending}
            style={{
              background: input.trim() && !isSending ? node.color : '#334155',
              color: '#fff',
              border: 'none',
              borderRadius: '10px',
              padding: '10px 16px',
              fontSize: '14px',
              cursor: input.trim() && !isSending ? 'pointer' : 'not-allowed',
              opacity: input.trim() && !isSending ? 1 : 0.5,
              transition: 'background 0.15s, opacity 0.15s',
              flexShrink: 0,
              lineHeight: 1,
            }}
            aria-label="Send"
            title="Send message (Enter)"
          >
            ▶
          </button>
        </div>
        <div style={{ color: '#475569', fontSize: '10px', marginTop: '6px', textAlign: 'right' }}>
          Enter to send · Shift+Enter for newline
        </div>
      </div>
    </div>
  );
}

function Dot({ delay, color }: { delay: number; color: string }) {
  return (
    <span style={{
      width: '7px',
      height: '7px',
      borderRadius: '50%',
      background: color,
      display: 'inline-block',
      animation: `dotPulse 1s ${delay}ms ease-in-out infinite`,
    }}>
      <style>{`
        @keyframes dotPulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1.1); }
        }
      `}</style>
    </span>
  );
}
