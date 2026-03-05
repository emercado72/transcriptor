// ──────────────────────────────────────────────
// Job & Pipeline Types
// ──────────────────────────────────────────────

import { EventId, EventStatus } from './eventTypes.js';

export type JobId = string;

export enum JobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  RETRYING = 'retrying',
}

export interface TranscriptionJob {
  jobId: JobId;
  eventId: EventId;
  audioFilePath: string;
  status: JobStatus;
  scribeJobId: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface StageStatus {
  stage: EventStatus;
  status: JobStatus;
  agentName: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface PipelineJob {
  jobId: JobId;
  eventId: EventId;
  status: EventStatus;
  stages: StageStatus[];
  createdAt: string;
  updatedAt: string;
  /** Tecnoreuniones assembly ID (resolved from folder/file name) */
  idAsamblea?: number;
  /** Client name from Tecnoreuniones (e.g. "PORTAL VALPARAISO") */
  clientName?: string;
}

export interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}
