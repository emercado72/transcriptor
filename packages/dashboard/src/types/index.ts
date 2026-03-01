// ── Agent topology types ──

export interface AgentNode {
  id: AgentId;
  label: string;
  description: string;
  color: string;
  icon: string;
  x: number;
  y: number;
}

export interface AgentEdge {
  from: AgentId;
  to: AgentId;
  label?: string;
}

export type AgentId =
  | 'yulieth'
  | 'chucho'
  | 'jaime'
  | 'lina'
  | 'fannery'
  | 'gloria'
  | 'robinson'
  | 'supervisor';

export interface AgentStatus {
  agentId: AgentId;
  state: 'idle' | 'processing' | 'error';
  currentJob: string | null;
  currentEvent: string | null;
  lastActivity: string | null;
  uptime: number;
}

export interface AgentStats {
  agentId: AgentId;
  last30Days: {
    jobsProcessed: number;
    jobsFailed: number;
    averageDurationMs: number;
    totalDurationMs: number;
  };
  today: {
    jobsProcessed: number;
    jobsFailed: number;
  };
}

export interface PipelineOverview {
  activeJobs: number;
  completedJobs: number;
  failedJobs: number;
  queuedJobs: number;
  recentJobs: PipelineJobSummary[];
}

export interface PipelineJobSummary {
  jobId: string;
  eventId: string;
  buildingName: string;
  status: string;
  currentStage: string;
  createdAt: string;
  updatedAt: string;
}

export interface LayoutState {
  positions: Record<AgentId, { x: number; y: number }>;
  savedAt: string;
}
