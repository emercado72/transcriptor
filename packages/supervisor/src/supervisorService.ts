import { randomUUID } from 'node:crypto';
import { createLogger } from '@transcriptor/shared';
import {
  EventStatus,
  JobStatus,
} from '@transcriptor/shared';
import type {
  EventId,
  EventFolder,
  JobId,
  PipelineJob,
  StageStatus,
} from '@transcriptor/shared';
import * as stateManager from './stateManager.js';

const logger = createLogger('supervisor');

const PIPELINE_STAGES: { stage: EventStatus; agent: string }[] = [
  { stage: EventStatus.DETECTED, agent: 'yulieth' },
  { stage: EventStatus.QUEUED, agent: 'yulieth' },
  { stage: EventStatus.PREPROCESSING, agent: 'chucho' },
  { stage: EventStatus.TRANSCRIBING, agent: 'jaime' },
  { stage: EventStatus.SECTIONING, agent: 'jaime' },
  { stage: EventStatus.REDACTING, agent: 'lina' },
  { stage: EventStatus.ASSEMBLING, agent: 'fannery' },
  { stage: EventStatus.REVIEWING, agent: 'gloria' },
  { stage: EventStatus.COMPLETED, agent: 'supervisor' },
];

function createStages(): StageStatus[] {
  return PIPELINE_STAGES.map(({ stage, agent }) => ({
    stage,
    status: JobStatus.PENDING,
    agentName: agent,
    startedAt: null,
    completedAt: null,
    error: null,
  }));
}

export async function initPipeline(
  eventId: EventId,
  _eventFolder: EventFolder,
  opts?: { idAsamblea?: number; clientName?: string },
): Promise<PipelineJob> {
  const jobId = randomUUID();
  const now = new Date().toISOString();

  const job: PipelineJob = {
    jobId,
    eventId,
    status: EventStatus.DETECTED,
    stages: createStages(),
    createdAt: now,
    updatedAt: now,
    ...(opts?.idAsamblea != null && { idAsamblea: opts.idAsamblea }),
    ...(opts?.clientName != null && { clientName: opts.clientName }),
  };

  await stateManager.saveState(jobId, job);
  logger.info(`Pipeline initialized: ${jobId} for event ${eventId}` +
    (opts?.idAsamblea ? ` (idAsamblea=${opts.idAsamblea}, client=${opts.clientName})` : ' (no assembly resolved)'));
  return job;
}

export async function advanceStage(jobId: JobId, nextStage: EventStatus): Promise<PipelineJob> {
  const job = await stateManager.loadState(jobId);
  const now = new Date().toISOString();

  job.status = nextStage;
  job.updatedAt = now;

  const stageEntry = job.stages.find((s) => s.stage === nextStage);
  if (stageEntry) {
    stageEntry.status = JobStatus.PROCESSING;
    stageEntry.startedAt = now;
  }

  await stateManager.saveState(jobId, job);
  logger.info(`Pipeline ${jobId} advanced to stage: ${nextStage}`);
  return job;
}

export async function markStageComplete(jobId: JobId, stage: EventStatus): Promise<PipelineJob> {
  const job = await stateManager.loadState(jobId);
  const now = new Date().toISOString();

  const stageEntry = job.stages.find((s) => s.stage === stage);
  if (stageEntry) {
    stageEntry.status = JobStatus.COMPLETED;
    stageEntry.completedAt = now;
  }

  job.updatedAt = now;
  await stateManager.saveState(jobId, job);
  logger.info(`Pipeline ${jobId} stage completed: ${stage}`);
  return job;
}

export async function markStageFailed(jobId: JobId, stage: EventStatus, error: string): Promise<PipelineJob> {
  const job = await stateManager.loadState(jobId);
  const now = new Date().toISOString();

  const stageEntry = job.stages.find((s) => s.stage === stage);
  if (stageEntry) {
    stageEntry.status = JobStatus.FAILED;
    stageEntry.completedAt = now;
    stageEntry.error = error;
  }

  job.status = EventStatus.FAILED;
  job.updatedAt = now;
  await stateManager.saveState(jobId, job);
  logger.error(`Pipeline ${jobId} stage failed: ${stage} — ${error}`);
  return job;
}

export async function retryStage(jobId: JobId, stage: EventStatus): Promise<PipelineJob> {
  const job = await stateManager.loadState(jobId);
  const now = new Date().toISOString();

  const stageEntry = job.stages.find((s) => s.stage === stage);
  if (stageEntry) {
    stageEntry.status = JobStatus.RETRYING;
    stageEntry.startedAt = now;
    stageEntry.completedAt = null;
    stageEntry.error = null;
  }

  job.status = stage;
  job.updatedAt = now;
  await stateManager.saveState(jobId, job);
  logger.info(`Pipeline ${jobId} retrying stage: ${stage}`);
  return job;
}

export async function getPipelineStatus(jobId: JobId): Promise<PipelineJob> {
  return stateManager.loadState(jobId);
}

export async function getActivePipelines(): Promise<PipelineJob[]> {
  const jobIds = await stateManager.listActiveJobs();
  const pipelines: PipelineJob[] = [];

  for (const jobId of jobIds) {
    try {
      const job = await stateManager.loadState(jobId);
      if (job.status !== EventStatus.COMPLETED && job.status !== EventStatus.FAILED) {
        pipelines.push(job);
      }
    } catch {
      // Skip jobs that can't be loaded
    }
  }

  return pipelines;
}

export async function sendNotification(jobId: JobId, message: string): Promise<void> {
  logger.info(`[NOTIFICATION] Job ${jobId}: ${message}`);
  // TODO: Integrate with notification service (email, Slack, etc.)
}
