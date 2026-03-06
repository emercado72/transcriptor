// ──────────────────────────────────────────────
// Event Types
// ──────────────────────────────────────────────

export type EventId = string;

export enum EventStatus {
  DETECTED = 'detected',
  QUEUED = 'queued',
  DELEGATING = 'delegating',
  DELEGATED = 'delegated',
  PREPROCESSING = 'preprocessing',
  TRANSCRIBING = 'transcribing',
  SECTIONING = 'sectioning',
  REDACTING = 'redacting',
  ASSEMBLING = 'assembling',
  REVIEWING = 'reviewing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export type EventType = 'ordinaria' | 'extraordinaria';

export interface EventMetadata {
  eventId: EventId;
  buildingName: string;
  buildingNit: string;
  city: string;
  date: Date;
  eventType: EventType;
  startTime: string;
  endTime: string;
}

export interface EventFolder {
  folderId: string;
  folderName: string;
  audioFiles: string[];
  votingFiles: string[];
  path: string;
}

export interface RosterRecord {
  tower: string;
  unit: string;
  ownerName: string;
  ownerName2: string;
  delegateName: string;
  coefficient: number;
  nominal: number;
  hasMora: boolean;
}

export interface ClientConfig {
  buildingName: string;
  nit: string;
  towers: number;
  unitsPerTower: number;
  adminName: string;
  customTerms: string[];
}
