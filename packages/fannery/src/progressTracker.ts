/**
 * Fannery Progress Tracker — Redis-backed queue and results tracking
 *
 * Tracks:
 *   - Which jobs Fannery has assembled / is assembling / failed
 *   - Document output details per job
 */

import { createLogger, getRedisClient } from '@transcriptor/shared';
import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const logger = createLogger('fannery:progress');

const FANNERY_PROGRESS_PREFIX = 'fannery:progress:';
const FANNERY_ACTIVE_JOBS_KEY = 'fannery:active_jobs';

export type FanneryJobStatus = 'queued' | 'assembling' | 'uploading' | 'completed' | 'failed';

export interface FanneryJobProgress {
  jobId: string;
  status: FanneryJobStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;

  // Assembly details
  assembly: {
    inputSections: number;
    documentSizeBytes: number;
    outputPath: string | null;
    markdownPath: string | null;
    pdfPath: string | null;
    driveFileId: string | null;
    driveFileName: string | null;
  } | null;
}

// ── In-memory state (backed by Redis) ──

const fanneryJobs = new Map<string, FanneryJobProgress>();

export function initFanneryProgress(jobId: string): void {
  const job: FanneryJobProgress = {
    jobId,
    status: 'queued',
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    assembly: null,
  };
  fanneryJobs.set(jobId, job);
  void persistFanneryJob(job);
}

export function updateFanneryProgress(jobId: string, update: Partial<FanneryJobProgress>): void {
  const existing = fanneryJobs.get(jobId);
  if (!existing) {
    logger.warn(`updateFanneryProgress: job ${jobId} not tracked`);
    return;
  }
  Object.assign(existing, update);
  void persistFanneryJob(existing);
}

export function markFanneryAssemblyComplete(
  jobId: string,
  data: {
    inputSections: number;
    documentSizeBytes: number;
    outputPath: string;
    markdownPath: string;
    pdfPath: string | null;
    driveFileId: string | null;
    driveFileName: string | null;
  },
): void {
  const existing = fanneryJobs.get(jobId);
  if (!existing) return;
  existing.status = 'completed';
  existing.completedAt = new Date().toISOString();
  existing.assembly = data;
  void persistFanneryJob(existing);
}

export function markFanneryFailed(jobId: string, error: string): void {
  const existing = fanneryJobs.get(jobId);
  if (!existing) return;
  existing.status = 'failed';
  existing.completedAt = new Date().toISOString();
  existing.error = error;
  void persistFanneryJob(existing);
}

export function getFanneryJobProgress(jobId: string): FanneryJobProgress | undefined {
  return fanneryJobs.get(jobId);
}

export function getAllFanneryProgress(): FanneryJobProgress[] {
  return [...fanneryJobs.values()].sort(
    (a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''),
  );
}

// ── Redis persistence ──

async function persistFanneryJob(job: FanneryJobProgress): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.set(`${FANNERY_PROGRESS_PREFIX}${job.jobId}`, JSON.stringify(job));
    await redis.sadd(FANNERY_ACTIVE_JOBS_KEY, job.jobId);
  } catch (err) {
    logger.warn(`Failed to persist Fannery progress for ${job.jobId}: ${(err as Error).message}`);
  }
}

export async function restoreFanneryJobs(): Promise<void> {
  try {
    const redis = getRedisClient();
    const jobIds = await redis.smembers(FANNERY_ACTIVE_JOBS_KEY);
    let restored = 0;

    for (const jobId of jobIds) {
      const raw = await redis.get(`${FANNERY_PROGRESS_PREFIX}${jobId}`);
      if (raw) {
        const job = JSON.parse(raw) as FanneryJobProgress;
        if (job.status === 'assembling' || job.status === 'uploading') {
          job.status = 'failed';
          job.error = 'Interrupted by server restart';
          job.completedAt = new Date().toISOString();
          await redis.set(`${FANNERY_PROGRESS_PREFIX}${jobId}`, JSON.stringify(job));
        }
        fanneryJobs.set(jobId, job);
        restored++;
      }
    }

    if (restored > 0) {
      logger.info(`Restored ${restored} Fannery job(s) from Redis`);
    }

    // Scan disk for completed jobs not in Redis
    await scanDiskForCompletedFanneryJobs();
  } catch (err) {
    logger.warn(`Failed to restore Fannery jobs: ${(err as Error).message}`);
  }
}

async function scanDiskForCompletedFanneryJobs(): Promise<void> {
  try {
    const projectRoot = path.resolve(import.meta.dirname, '../../..');
    const jobsDir = path.join(projectRoot, 'data', 'jobs');

    if (!existsSync(jobsDir)) return;

    const jobDirNames = readdirSync(jobsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    let discovered = 0;

    for (const jobId of jobDirNames) {
      if (fanneryJobs.has(jobId)) continue;

      const outputDir = path.join(jobsDir, jobId, 'output');
      const manifestPath = path.join(outputDir, 'manifest.json');
      if (!existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

        // Find the .docx file in the output dir
        const docxFiles = readdirSync(outputDir).filter(f => f.endsWith('.docx'));
        const docxPath = docxFiles.length > 0 ? path.join(outputDir, docxFiles[0]) : null;
        let docxSize = 0;
        if (docxPath && existsSync(docxPath)) {
          const { statSync } = await import('node:fs');
          docxSize = statSync(docxPath).size;
        }

        // Find the .md file in the output dir
        const mdFiles = readdirSync(outputDir).filter(f => f.endsWith('.md'));
        const mdPath = mdFiles.length > 0 ? path.join(outputDir, mdFiles[0]) : null;

        // Find the .pdf file in the output dir
        const pdfFiles = readdirSync(outputDir).filter(f => f.endsWith('.pdf'));
        const pdfPath = pdfFiles.length > 0 ? path.join(outputDir, pdfFiles[0]) : null;

        const job: FanneryJobProgress = {
          jobId,
          status: 'completed',
          startedAt: manifest.assembledAt || manifest.redactedAt || null,
          completedAt: manifest.assembledAt || manifest.redactedAt || null,
          error: null,
          assembly: {
            inputSections: manifest.totalSections || 0,
            documentSizeBytes: docxSize,
            outputPath: docxPath,
            markdownPath: mdPath || manifest.markdownPath || null,
            pdfPath: pdfPath || manifest.pdfPath || null,
            driveFileId: null,
            driveFileName: null,
          },
        };

        fanneryJobs.set(jobId, job);
        void persistFanneryJob(job);
        discovered++;
      } catch {
        // Skip malformed manifests
      }
    }

    if (discovered > 0) {
      logger.info(`Discovered ${discovered} completed Fannery job(s) from disk`);
    }
  } catch (err) {
    logger.warn(`Disk scan for Fannery jobs failed: ${(err as Error).message}`);
  }
}
