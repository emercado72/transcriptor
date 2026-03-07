/**
 * Reprocess Manager — the Supervisor's brain for job reprocessing.
 *
 * Determines prerequisites, downloads S3 data, checks local audio,
 * delegates to GPU workers if audio is missing, resets state, and
 * kicks off the pipeline. No excuses.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  createLogger,
  EventStatus,
  JobStatus,
  downloadJobStage,
  publishEvent,
} from '@transcriptor/shared';
import type { PipelineJob } from '@transcriptor/shared';
import * as stateManager from './stateManager.js';
import { delegateJob, shouldDelegate } from './delegationManager.js';
import { PIPELINE_STAGES } from './supervisorService.js';

const logger = createLogger('supervisor:reprocess');

// ── Prerequisite Map ──

interface StagePrerequisite {
  /** S3 stages to download before dispatch */
  s3Stages: string[];
  /** Local dirs that must have audio files */
  localDirs: ('raw' | 'processed')[];
  /** Whether this stage requires audio (not available in S3) */
  needsAudio: boolean;
}

const STAGE_PREREQUISITES: Record<string, StagePrerequisite> = {
  preprocessing: { s3Stages: [], localDirs: ['raw'], needsAudio: true },
  transcribing:  { s3Stages: [], localDirs: ['processed'], needsAudio: true },
  redacting:     { s3Stages: ['transcript', 'sections'], localDirs: [], needsAudio: false },
  assembling:    { s3Stages: ['redacted'], localDirs: [], needsAudio: false },
  reviewing:     { s3Stages: ['output'], localDirs: [], needsAudio: false },
};

const VALID_STAGES = Object.keys(STAGE_PREREQUISITES);

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.wma', '.mp4', '.webm']);

// ── Helpers ──

function getProjectRoot(): string {
  return path.resolve(import.meta.dirname, '../../..');
}

function hasLocalAudio(jobId: string, dir: 'raw' | 'processed'): boolean {
  const dirPath = path.join(getProjectRoot(), 'data', 'jobs', jobId, dir);
  if (!existsSync(dirPath)) return false;
  const files = readdirSync(dirPath);
  return files.some(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()));
}

async function downloadS3Prerequisites(
  jobId: string,
  stages: string[],
): Promise<Record<string, string[]>> {
  const downloaded: Record<string, string[]> = {};
  const jobDir = path.join(getProjectRoot(), 'data', 'jobs', jobId);

  for (const stage of stages) {
    const localDir = path.join(jobDir, stage);
    const files = await downloadJobStage(jobId, stage, localDir);
    if (files.length === 0) {
      throw new Error(`Cannot reprocess: ${stage} files not found in S3`);
    }
    downloaded[stage] = files;
  }
  return downloaded;
}

function resolveDriveFolderId(): string {
  const envId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (envId) return envId;

  try {
    const cfgPath = path.resolve(process.cwd(), 'config/yulieth-config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    if (cfg.driveFolderId) return cfg.driveFolderId;
  } catch { /* config not found */ }

  throw new Error('Cannot delegate: no driveFolderId (set GOOGLE_DRIVE_ROOT_FOLDER_ID)');
}

// ── State Reset ──

async function resetJobForReprocess(
  jobId: string,
  fromStage: EventStatus,
  forDelegation: boolean,
): Promise<PipelineJob> {
  const job = await stateManager.loadState(jobId);
  const now = new Date().toISOString();

  // Remove delegation stages from prior runs
  job.stages = job.stages.filter(
    s => s.stage !== EventStatus.DELEGATING && s.stage !== EventStatus.DELEGATED,
  );
  delete job.delegationInfo;

  // Find the index of the target stage in the pipeline
  const stageIndex = PIPELINE_STAGES.findIndex(s => s.stage === fromStage);

  // Reset target stage and all subsequent stages to PENDING
  for (let i = stageIndex; i < PIPELINE_STAGES.length; i++) {
    const entry = job.stages.find(s => s.stage === PIPELINE_STAGES[i].stage);
    if (entry) {
      entry.status = JobStatus.PENDING;
      entry.startedAt = null;
      entry.completedAt = null;
      entry.error = null;
    }
  }

  if (forDelegation) {
    // delegateJob expects the job in QUEUED status
    job.status = EventStatus.QUEUED;
  } else {
    // Mark target stage as RETRYING for local dispatch
    job.status = fromStage;
    const stageEntry = job.stages.find(s => s.stage === fromStage);
    if (stageEntry) {
      stageEntry.status = JobStatus.RETRYING;
      stageEntry.startedAt = now;
    }
  }

  job.updatedAt = now;
  await stateManager.saveState(jobId, job);
  return job;
}

// ── Main Function ──

export interface ReprocessResult {
  ok: boolean;
  jobId: string;
  fromStage: string;
  strategy: 'local' | 'delegated';
  s3Downloaded: Record<string, string[]>;
  message: string;
}

export async function reprocessJob(
  jobId: string,
  fromStage: string,
): Promise<ReprocessResult> {
  // 1. Validate and remap
  if (fromStage === 'sectioning') {
    fromStage = 'transcribing';
    logger.info(`Job ${jobId}: sectioning remapped to transcribing (Jaime handles both)`);
  }

  if (!VALID_STAGES.includes(fromStage)) {
    throw new Error(`Invalid stage: ${fromStage}. Must be one of: ${VALID_STAGES.join(', ')}`);
  }

  const prereqs = STAGE_PREREQUISITES[fromStage];
  const stageEnum = fromStage as EventStatus;

  // 2. Load job — must exist for eventId (needed for delegation)
  const job = await stateManager.loadState(jobId);
  logger.info(`Job ${jobId}: reprocess from ${fromStage} requested (current: ${job.status})`);

  // 3. Delegation check — delegate ALL reprocessing to GPU worker when enabled
  if (shouldDelegate()) {
    if (prereqs.needsAudio) {
      // Audio-dependent: full pipeline delegation (GPU downloads from Drive)
      logger.info(`Job ${jobId}: delegation enabled, delegating audio-dependent stage to GPU worker`);
      await resetJobForReprocess(jobId, EventStatus.QUEUED, true);
      const driveFolderId = resolveDriveFolderId();
      await delegateJob(jobId, driveFolderId);
    } else {
      // Text-only: delegate reprocess from specific stage (GPU downloads from S3)
      logger.info(`Job ${jobId}: delegation enabled, delegating reprocess of ${fromStage} to GPU worker`);
      await resetJobForReprocess(jobId, EventStatus.QUEUED, true);
      const driveFolderId = resolveDriveFolderId();
      await delegateJob(jobId, driveFolderId, fromStage);
    }

    return {
      ok: true,
      jobId,
      fromStage,
      strategy: 'delegated',
      s3Downloaded: {},
      message: `Delegated reprocess of ${fromStage} to GPU worker.`,
    };
  }

  // 4. Local processing — only when delegation is disabled or on GPU worker itself

  // Audio-dependent stages: verify local audio exists
  if (prereqs.needsAudio) {
    const hasAudio = prereqs.localDirs.some(dir => hasLocalAudio(jobId, dir));
    if (!hasAudio) {
      throw new Error(
        `Cannot reprocess ${fromStage} locally: audio not available in ${prereqs.localDirs.join(', ')}`,
      );
    }
    logger.info(`Job ${jobId}: audio found locally, retrying ${fromStage} locally`);
  }

  // Download S3 prerequisites (text-only stages)
  const s3Downloaded = prereqs.s3Stages.length > 0
    ? await downloadS3Prerequisites(jobId, prereqs.s3Stages)
    : {};

  // 5. Reset state for local retry
  await resetJobForReprocess(jobId, stageEnum, false);

  // 6. Publish retry event — orchestrator picks it up and dispatches the agent
  await publishEvent({
    type: 'job_retry',
    jobId,
    agent: 'supervisor',
    timestamp: new Date().toISOString(),
    data: { stage: fromStage },
  });

  const totalFiles = Object.values(s3Downloaded).reduce((sum, arr) => sum + arr.length, 0);
  const msg = totalFiles > 0
    ? `Downloaded ${totalFiles} S3 files. Retrying ${fromStage} locally.`
    : `Retrying ${fromStage} locally.`;

  logger.info(`Job ${jobId}: ${msg}`);
  return {
    ok: true,
    jobId,
    fromStage,
    strategy: 'local',
    s3Downloaded,
    message: msg,
  };
}
