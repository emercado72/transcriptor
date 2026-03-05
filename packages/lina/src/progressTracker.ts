/**
 * Lina Progress Tracker — Redis-backed queue and results tracking
 *
 * Tracks:
 *   - Which jobs Lina has processed / is processing / failed
 *   - Speaker reconciliation results per job
 *   - Redaction results per job
 */

import { createLogger, getRedisClient } from '@transcriptor/shared';
import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const logger = createLogger('lina:progress');

const LINA_PROGRESS_PREFIX = 'lina:progress:';
const LINA_ACTIVE_JOBS_KEY = 'lina:active_jobs';

export type LinaJobStatus = 'queued' | 'reconciling' | 'redacting' | 'completed' | 'failed';

export interface LinaJobProgress {
  jobId: string;
  status: LinaJobStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;

  // Speaker reconciliation
  reconciliation: {
    started: boolean;
    completed: boolean;
    globalSpeakers: number;
    identifiedSpeakers: number;
    confidence: number;
    speakerNames: Record<string, string>;
  } | null;

  // Redaction
  redaction: {
    totalSections: number;
    completedSections: number;
    validationErrors: number;
    validationWarnings: number;
  } | null;

  // Output
  outputDir: string | null;
}

// ── In-memory state (backed by Redis) ──

const linaJobs = new Map<string, LinaJobProgress>();

export function initLinaProgress(jobId: string): void {
  const job: LinaJobProgress = {
    jobId,
    status: 'queued',
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    reconciliation: null,
    redaction: null,
    outputDir: null,
  };
  linaJobs.set(jobId, job);
  void persistLinaJob(job);
}

export function updateLinaProgress(jobId: string, update: Partial<LinaJobProgress>): void {
  const existing = linaJobs.get(jobId);
  if (!existing) {
    logger.warn(`updateLinaProgress: job ${jobId} not tracked`);
    return;
  }
  Object.assign(existing, update);
  void persistLinaJob(existing);
}

export function markLinaReconciliation(
  jobId: string,
  data: {
    globalSpeakers: number;
    identifiedSpeakers: number;
    confidence: number;
    speakerNames: Record<string, string>;
  },
): void {
  const existing = linaJobs.get(jobId);
  if (!existing) return;
  existing.status = 'redacting';
  existing.reconciliation = {
    started: true,
    completed: true,
    ...data,
  };
  void persistLinaJob(existing);
}

export function markLinaRedactionComplete(
  jobId: string,
  data: {
    totalSections: number;
    validationErrors: number;
    validationWarnings: number;
    outputDir: string;
  },
): void {
  const existing = linaJobs.get(jobId);
  if (!existing) return;
  existing.status = 'completed';
  existing.completedAt = new Date().toISOString();
  existing.redaction = {
    totalSections: data.totalSections,
    completedSections: data.totalSections,
    validationErrors: data.validationErrors,
    validationWarnings: data.validationWarnings,
  };
  existing.outputDir = data.outputDir;
  void persistLinaJob(existing);
}

export function markLinaFailed(jobId: string, error: string): void {
  const existing = linaJobs.get(jobId);
  if (!existing) return;
  existing.status = 'failed';
  existing.completedAt = new Date().toISOString();
  existing.error = error;
  void persistLinaJob(existing);
}

export function getLinaJobProgress(jobId: string): LinaJobProgress | undefined {
  return linaJobs.get(jobId);
}

export function getAllLinaProgress(): LinaJobProgress[] {
  return [...linaJobs.values()].sort(
    (a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''),
  );
}

// ── Redis persistence ──

async function persistLinaJob(job: LinaJobProgress): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.set(`${LINA_PROGRESS_PREFIX}${job.jobId}`, JSON.stringify(job));
    await redis.sadd(LINA_ACTIVE_JOBS_KEY, job.jobId);
  } catch (err) {
    logger.warn(`Failed to persist Lina progress for ${job.jobId}: ${(err as Error).message}`);
  }
}

export async function restoreLinaJobs(): Promise<void> {
  try {
    const redis = getRedisClient();
    const jobIds = await redis.smembers(LINA_ACTIVE_JOBS_KEY);
    let restored = 0;

    for (const jobId of jobIds) {
      const raw = await redis.get(`${LINA_PROGRESS_PREFIX}${jobId}`);
      if (raw) {
        const job = JSON.parse(raw) as LinaJobProgress;
        // Mark in-progress jobs as failed on restart
        if (job.status === 'reconciling' || job.status === 'redacting') {
          job.status = 'failed';
          job.error = 'Interrupted by server restart';
          job.completedAt = new Date().toISOString();
          await redis.set(`${LINA_PROGRESS_PREFIX}${jobId}`, JSON.stringify(job));
        }
        linaJobs.set(jobId, job);
        restored++;
      }
    }

    if (restored > 0) {
      logger.info(`Restored ${restored} Lina job(s) from Redis`);
    }

    // Also scan disk for completed jobs not tracked in Redis
    // (handles jobs that ran before progress tracking was added)
    await scanDiskForCompletedJobs();
  } catch (err) {
    logger.warn(`Failed to restore Lina jobs: ${(err as Error).message}`);
  }
}

/**
 * Scan disk for completed Lina jobs not tracked in Redis
 * (handles jobs that ran before progress tracking was added).
 * Looks at data/jobs/{id}/redacted/manifest.json and reconstructs progress.
 */
async function scanDiskForCompletedJobs(): Promise<void> {
  try {
    const projectRoot = path.resolve(import.meta.dirname, '../../..');
    const jobsDir = path.join(projectRoot, 'data', 'jobs');

    if (!existsSync(jobsDir)) return;

    const jobDirs = readdirSync(jobsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    let discovered = 0;

    for (const jobId of jobDirs) {
      // Skip if already tracked
      if (linaJobs.has(jobId)) continue;

      const manifestPath = path.join(jobsDir, jobId, 'redacted', 'manifest.json');
      if (!existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

        const job: LinaJobProgress = {
          jobId,
          status: 'completed',
          startedAt: manifest.redactedAt || null,
          completedAt: manifest.redactedAt || null,
          error: null,
          reconciliation: {
            started: true,
            completed: true,
            globalSpeakers: (manifest.globalSpeakers || []).length,
            identifiedSpeakers: Object.keys(manifest.identifiedSpeakers || {}).length,
            confidence: manifest.speakerReconciliationConfidence || 0,
            speakerNames: manifest.identifiedSpeakers || {},
          },
          redaction: {
            totalSections: manifest.totalSections || 0,
            completedSections: manifest.totalSections || 0,
            validationErrors: (manifest.validationErrors || []).length,
            validationWarnings: (manifest.validationWarnings || []).length,
          },
          outputDir: path.join(jobsDir, jobId, 'redacted'),
        };

        linaJobs.set(jobId, job);
        // Persist to Redis so it shows up on next restart too
        void persistLinaJob(job);
        discovered++;
      } catch {
        // Skip malformed manifests
      }
    }

    if (discovered > 0) {
      logger.info(`Discovered ${discovered} completed Lina job(s) from disk`);
    }
  } catch (err) {
    logger.warn(`Disk scan for Lina jobs failed: ${(err as Error).message}`);
  }
}
