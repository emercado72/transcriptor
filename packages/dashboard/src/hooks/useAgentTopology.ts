import type { AgentNode, AgentEdge, AgentId, LayoutState } from '../types/index.js';

// ── Default auto-arranged positions (pipeline flow, left to right) ──
const DEFAULT_POSITIONS: Record<AgentId, { x: number; y: number }> = {
  yulieth:    { x: 100,  y: 200 },
  robinson:   { x: 100,  y: 400 },
  chucho:     { x: 300,  y: 200 },
  jaime:      { x: 500,  y: 200 },
  lina:       { x: 700,  y: 200 },
  fannery:    { x: 900,  y: 200 },
  gloria:     { x: 1100, y: 200 },
  supervisor: { x: 500,  y: 400 },
  fisher:     { x: 300,  y: 400 },
};

export function getDefaultNodes(): AgentNode[] {
  return [
    { id: 'yulieth',    label: 'Yulieth',    description: 'Drive Watcher & Job Queue',     color: '#7c3aed', icon: '👁️', ...DEFAULT_POSITIONS.yulieth },
    { id: 'robinson',   label: 'Robinson',   description: 'Data Layer (Tecnoreuniones)',    color: '#0891b2', icon: '🗄️', ...DEFAULT_POSITIONS.robinson },
    { id: 'chucho',     label: 'Chucho',     description: 'Audio Preprocessor',             color: '#ea580c', icon: '🎵', ...DEFAULT_POSITIONS.chucho },
    { id: 'jaime',      label: 'Jaime',      description: 'Transcription & Sectioning & QA', color: '#16a34a', icon: '📝', ...DEFAULT_POSITIONS.jaime },
    { id: 'lina',       label: 'Lina',       description: 'AI Redaction Engine',            color: '#dc2626', icon: '✍️', ...DEFAULT_POSITIONS.lina },
    { id: 'fannery',    label: 'Fannery',    description: 'Document Assembly (.docx)',       color: '#ca8a04', icon: '📄', ...DEFAULT_POSITIONS.fannery },
    { id: 'gloria',     label: 'Gloria',     description: 'Review & Approval',              color: '#9333ea', icon: '✅', ...DEFAULT_POSITIONS.gloria },
    { id: 'supervisor', label: 'Supervisor', description: 'Pipeline Orchestrator',           color: '#475569', icon: '🎛️', ...DEFAULT_POSITIONS.supervisor },
    { id: 'fisher',     label: 'Fisher',     description: 'GPU Worker Provisioner',          color: '#0d9488', icon: '🐟', ...DEFAULT_POSITIONS.fisher },
  ];
}

export function getEdges(): AgentEdge[] {
  return [
    { from: 'yulieth',    to: 'chucho',     label: 'audio files' },
    { from: 'yulieth',    to: 'robinson',   label: 'event detected' },
    { from: 'robinson',   to: 'jaime',      label: 'voting + attendance data' },
    { from: 'robinson',   to: 'lina',       label: 'roster for diarization' },
    { from: 'robinson',   to: 'fannery',    label: 'voting details + quorum' },
    { from: 'chucho',     to: 'jaime',      label: 'preprocessed audio' },
    { from: 'jaime',      to: 'lina',       label: 'sections + transcript' },
    { from: 'lina',       to: 'fannery',    label: 'redacted sections' },
    { from: 'fannery',    to: 'gloria',     label: 'draft .docx' },
    { from: 'supervisor', to: 'yulieth',    label: 'orchestrates' },
    { from: 'supervisor', to: 'chucho',     label: 'orchestrates' },
    { from: 'supervisor', to: 'jaime',      label: 'orchestrates' },
    { from: 'supervisor', to: 'lina',       label: 'orchestrates' },
    { from: 'supervisor', to: 'fannery',    label: 'orchestrates' },
    { from: 'supervisor', to: 'gloria',     label: 'orchestrates' },
    { from: 'fisher',     to: 'supervisor', label: 'provisions GPU workers' },
    { from: 'fisher',     to: 'yulieth',    label: 'enqueues on remote' },
  ];
}

const LAYOUT_STORAGE_KEY = 'transcriptor:dashboard:layout';

export function saveLayout(positions: Record<AgentId, { x: number; y: number }>): void {
  const layout: LayoutState = {
    positions,
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
}

export function loadLayout(): Record<AgentId, { x: number; y: number }> | null {
  const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const layout = JSON.parse(raw) as LayoutState;
    return layout.positions;
  } catch {
    return null;
  }
}

export function clearLayout(): void {
  localStorage.removeItem(LAYOUT_STORAGE_KEY);
}

export function getAutoArrangedPositions(): Record<AgentId, { x: number; y: number }> {
  return { ...DEFAULT_POSITIONS };
}
