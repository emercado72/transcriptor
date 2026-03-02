import { useEffect, useRef } from 'react';
import type { AgentId } from '../types/index.js';

export interface ContextMenuAction {
  label: string;
  icon: string;
  onClick: () => void;
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  agentId: AgentId;
  actions: ContextMenuAction[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, actions, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 9999,
        background: '#1e293b',
        border: '1px solid #475569',
        borderRadius: '8px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        padding: '4px 0',
        minWidth: '180px',
        animation: 'ctxFadeIn 0.12s ease-out',
      }}
    >
      <style>{`
        @keyframes ctxFadeIn {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
      {actions.map((action, i) => (
        <button
          key={i}
          onClick={() => { action.onClick(); onClose(); }}
          disabled={action.disabled}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            width: '100%',
            padding: '8px 16px',
            border: 'none',
            background: 'transparent',
            color: action.disabled ? '#475569' : '#e2e8f0',
            fontSize: '13px',
            cursor: action.disabled ? 'not-allowed' : 'pointer',
            textAlign: 'left',
            fontFamily: 'inherit',
          }}
          onMouseEnter={(e) => {
            if (!action.disabled) (e.currentTarget.style.background = '#334155');
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <span style={{ fontSize: '15px', width: '20px', textAlign: 'center' }}>{action.icon}</span>
          {action.label}
        </button>
      ))}
    </div>
  );
}
