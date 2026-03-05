/**
 * Jaime — Progress Tracker
 *
 * Redis-persisted state tracking for Jaime's transcription jobs.
 * Tracks per-segment progress, audio-transcriber steps, elapsed time, and ETA.
 * Survives Gloria restarts — on startup, recoverJobs() restores state from Redis.
 */

import { createLogger, getRedisClient } from '@transcriptor/shared';

const logger = createLogger('jaime:progress');

const REDIS_PREFIX = 'jaime:progress:';
const ACTIVE_JOBS_KEY = 'jaime:active_jobs';

// ── Types ──

export interface SegmentProgress {
  fileName: string;
  status: 'pending' | 'preprocessing' | 'transcribing' | 'diarizing' | 'merging' | 'saving' | 'completed' | 'failed';
  /** Current step of audio-transcriber (1–5) */
  currentStep: number;
  totalSteps: number;
  /** Whisper segments processed so far */
  segmentsProcessed: number;
  /** Duration of this audio segment in seconds (from manifest) */
  durationSec: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
}

export interface JobProgress {
  jobId: string;
  provider: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'crashed';
  /** Total audio segments from Chucho's manifest */
  totalSegments: number;
  /** Segments that have completed transcription */
  completedSegments: number;
  /** Segments that failed */
  failedSegments: number;
  /** Per-segment details */
  segments: SegmentProgress[];
  /** Total audio duration across all segments (seconds) */
  totalDurationSec: number;
  /** Elapsed wall-clock time (ms) */
  elapsedMs: number;
  /** Estimated time remaining (ms), null if unknown */
  etaMs: number | null;
  /** Overall progress percentage 0-100 */
  progressPct: number;
  startedAt: number | null;
  updatedAt: number;
}

// ── In-memory store (hot cache) ──

const jobs = new Map<string, JobProgress>();

// Debounce Redis writes — persist at most every 3s per job
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function schedulePersist(jobId: string): void {
  if (persistTimers.has(jobId)) return; // already scheduled
  persistTimers.set(jobId, setTimeout(() => {
    persistTimers.delete(jobId);
    const job = jobs.get(jobId);
    if (job) void persistToRedis(job);
  }, 3_000));
}

async function persistToRedis(job: JobProgress): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.set(`${REDIS_PREFIX}${job.jobId}`, JSON.stringify(job));
    if (job.status === 'processing' || job.status === 'pending') {
      await redis.sadd(ACTIVE_JOBS_KEY, job.jobId);
    }
  } catch (err) {
    logger.warn(`Failed to persist progress for ${job.jobId}: ${(err as Error).message}`);
  }
}

async function persistNow(job: JobProgress): Promise<void> {
  // Cancel any pending debounced write
  const timer = persistTimers.get(job.jobId);
  if (timer) { clearTimeout(timer); persistTimers.delete(job.jobId); }
  await persistToRedis(job);
}

async function removeFromActive(jobId: string): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.srem(ACTIVE_JOBS_KEY, jobId);
  } catch { /* non-fatal */ }
}

/**
 * Recover jobs from Redis on startup.
 * Returns jobs that were stuck in "processing" (crashed).
 */
export async function recoverJobs(): Promise<JobProgress[]> {
  const crashed: JobProgress[] = [];
  try {
    const redis = getRedisClient();
    const activeIds = await redis.smembers(ACTIVE_JOBS_KEY);
    logger.info(`Recovering Jaime progress: ${activeIds.length} tracked job(s) in Redis`);

    for (const jobId of activeIds) {
      const raw = await redis.get(`${REDIS_PREFIX}${jobId}`);
      if (!raw) {
        await redis.srem(ACTIVE_JOBS_KEY, jobId);
        continue;
      }
      const job = JSON.parse(raw) as JobProgress;

      if (job.status === 'processing' || job.status === 'pending') {
        // Check if a sync process is actively updating this job (updatedAt within last 30s)
        const timeSinceUpdate = Date.now() - job.updatedAt;
        if (timeSinceUpdate < 30_000) {
          // Job was recently updated — likely still running via external process
          logger.info(`Job ${jobId} was recently updated (${Math.round(timeSinceUpdate / 1000)}s ago) — treating as still active`);
        } else {
          // This was running when the process died — mark as crashed
          job.status = 'crashed';
          job.updatedAt = Date.now();
          // Mark any in-progress segments as failed
          for (const seg of job.segments) {
            if (seg.status !== 'completed' && seg.status !== 'failed' && seg.status !== 'pending') {
              seg.status = 'failed';
              seg.completedAt = Date.now();
              seg.error = 'Process crashed — Gloria was restarted while transcription was running';
              job.failedSegments++;
            }
          }
          recalcProgress(job);
          crashed.push(job);
          logger.warn(`Job ${jobId} was in-progress when Gloria stopped — marked as crashed (${job.completedSegments}/${job.totalSegments} segments done)`);
        }
      }

      // Restore to in-memory cache
      jobs.set(jobId, job);
      await persistToRedis(job); // save updated crash state
    }
  } catch (err) {
    logger.error(`Failed to recover Jaime jobs from Redis: ${(err as Error).message}`);
  }
  return crashed;
}

/**
 * Initialize tracking for a new job.
 */
export function initJobProgress(
  jobId: string,
  provider: string,
  fileNames: string[],
  durations: number[],
): void {
  const segments: SegmentProgress[] = fileNames.map((fileName, i) => ({
    fileName,
    status: 'pending',
    currentStep: 0,
    totalSteps: 5,
    segmentsProcessed: 0,
    durationSec: durations[i] ?? 0,
    startedAt: null,
    completedAt: null,
    error: null,
  }));

  const totalDurationSec = durations.reduce((a, b) => a + b, 0);

  const job: JobProgress = {
    jobId,
    provider,
    status: 'processing',
    totalSegments: fileNames.length,
    completedSegments: 0,
    failedSegments: 0,
    segments,
    totalDurationSec,
    elapsedMs: 0,
    etaMs: null,
    progressPct: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };

  jobs.set(jobId, job);
  void persistNow(job); // immediately persist new job

  logger.info(`Progress tracker initialized for job ${jobId}: ${fileNames.length} segments, ${totalDurationSec.toFixed(0)}s total`);
}

/**
 * Mark a segment as started.
 */
export function markSegmentStarted(jobId: string, segmentIndex: number): void {
  const job = jobs.get(jobId);
  if (!job || !job.segments[segmentIndex]) return;

  job.segments[segmentIndex].status = 'preprocessing';
  job.segments[segmentIndex].startedAt = Date.now();
  job.segments[segmentIndex].currentStep = 1;
  job.updatedAt = Date.now();
  recalcProgress(job);
  void persistNow(job); // persist segment start immediately
}

/**
 * Update segment progress from audio-transcriber stdout parsing.
 */
export function updateSegmentProgress(
  jobId: string,
  segmentIndex: number,
  update: Partial<Pick<SegmentProgress, 'status' | 'currentStep' | 'segmentsProcessed'>>,
): void {
  const job = jobs.get(jobId);
  if (!job || !job.segments[segmentIndex]) return;

  Object.assign(job.segments[segmentIndex], update);
  job.updatedAt = Date.now();
  recalcProgress(job);
  schedulePersist(jobId); // debounced — these come fast from stdout
}

/**
 * Mark a segment as completed.
 */
export function markSegmentCompleted(jobId: string, segmentIndex: number): void {
  const job = jobs.get(jobId);
  if (!job || !job.segments[segmentIndex]) return;

  job.segments[segmentIndex].status = 'completed';
  job.segments[segmentIndex].completedAt = Date.now();
  job.segments[segmentIndex].currentStep = 5;
  job.completedSegments++;
  job.updatedAt = Date.now();
  recalcProgress(job);
  void persistNow(job); // persist completion immediately
}

/**
 * Mark a segment as failed.
 */
export function markSegmentFailed(jobId: string, segmentIndex: number, error: string): void {
  const job = jobs.get(jobId);
  if (!job || !job.segments[segmentIndex]) return;

  job.segments[segmentIndex].status = 'failed';
  job.segments[segmentIndex].completedAt = Date.now();
  job.segments[segmentIndex].error = error;
  job.failedSegments++;
  job.updatedAt = Date.now();
  recalcProgress(job);
  void persistNow(job);
}

/**
 * Mark the whole job as completed or failed.
 */
export function markJobDone(jobId: string, status: 'completed' | 'failed'): void {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = status;
  job.updatedAt = Date.now();
  recalcProgress(job);
  void persistNow(job);
  void removeFromActive(jobId); // no longer active
}

/**
 * Get progress for a specific job.
 */
export function getJobProgress(jobId: string): JobProgress | null {
  const job = jobs.get(jobId);
  if (!job) return null;

  // Update elapsed time
  if (job.startedAt && job.status === 'processing') {
    job.elapsedMs = Date.now() - job.startedAt;
  }
  recalcProgress(job);
  return { ...job, segments: [...job.segments] };
}

/**
 * Get progress for all tracked jobs.
 * Refreshes from Redis to pick up external updates (e.g., from _sync_progress.py).
 */
export async function getAllJobProgress(): Promise<JobProgress[]> {
  // Refresh in-memory cache from Redis for active jobs
  try {
    const redis = getRedisClient();
    const activeIds = await redis.smembers(ACTIVE_JOBS_KEY);
    for (const jobId of activeIds) {
      const raw = await redis.get(`${REDIS_PREFIX}${jobId}`);
      if (raw) {
        const redisJob = JSON.parse(raw) as JobProgress;
        const memJob = jobs.get(jobId);
        // If Redis is newer, use it (external sync is updating)
        if (!memJob || redisJob.updatedAt > memJob.updatedAt) {
          jobs.set(jobId, redisJob);
        }
      }
    }
  } catch {
    // Fall back to in-memory cache if Redis fails
  }

  const result: JobProgress[] = [];
  for (const job of jobs.values()) {
    if (job.startedAt && job.status === 'processing') {
      job.elapsedMs = Date.now() - job.startedAt;
    }
    recalcProgress(job);
    result.push({ ...job, segments: [...job.segments] });
  }
  return result;
}

/**
 * Parse a stdout line from audio-transcriber and update progress accordingly.
 */
export function parseProgressLine(jobId: string, segmentIndex: number, line: string): void {
  const job = jobs.get(jobId);
  if (!job || !job.segments[segmentIndex]) return;

  // Step detection: "--- Step 1/5: Audio Preprocessing ---"
  const stepMatch = line.match(/Step (\d+)\/(\d+):\s*(.+?)\s*---/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10);
    const stepName = stepMatch[3].toLowerCase();

    let status: SegmentProgress['status'] = 'preprocessing';
    if (stepName.includes('transcription')) status = 'transcribing';
    else if (stepName.includes('diarization')) status = 'diarizing';
    else if (stepName.includes('merg')) status = 'merging';
    else if (stepName.includes('sav')) status = 'saving';

    updateSegmentProgress(jobId, segmentIndex, { currentStep: step, status });
    return;
  }

  // Segment count: "[Transcription] Processed 50 segments..."
  const segMatch = line.match(/Processed (\d+) segments/);
  if (segMatch) {
    const count = parseInt(segMatch[1], 10);
    updateSegmentProgress(jobId, segmentIndex, { segmentsProcessed: count });
    return;
  }

  // Transcription done: "[Transcription] Done. Total segments: 1234"
  const doneMatch = line.match(/Done\. Total segments: (\d+)/);
  if (doneMatch) {
    const count = parseInt(doneMatch[1], 10);
    updateSegmentProgress(jobId, segmentIndex, { segmentsProcessed: count });
    return;
  }

  // Diarization done: "[Diarization] Done. Found X speakers"
  if (line.includes('[Diarization] Done')) {
    updateSegmentProgress(jobId, segmentIndex, { status: 'diarizing', currentStep: 3 });
    return;
  }
}

// ── Internal ──

function recalcProgress(job: JobProgress): void {
  if (job.totalSegments === 0) {
    job.progressPct = 0;
    job.etaMs = null;
    return;
  }

  // Weight progress by duration of each segment
  let weightedComplete = 0;
  for (const seg of job.segments) {
    const weight = job.totalDurationSec > 0 ? seg.durationSec / job.totalDurationSec : 1 / job.totalSegments;

    if (seg.status === 'completed' || seg.status === 'failed') {
      weightedComplete += weight;
    } else if (seg.currentStep > 0) {
      // Intra-segment progress: step-based (step 2 = transcription is the heavy one ~70%)
      const stepWeights = [0.02, 0.70, 0.15, 0.08, 0.05]; // steps 1-5
      let stepProgress = 0;
      for (let i = 0; i < seg.currentStep - 1; i++) {
        stepProgress += stepWeights[i] ?? 0;
      }
      // Add partial progress within current step (for transcription, use segment count)
      if (seg.currentStep === 2 && seg.segmentsProcessed > 0) {
        // Rough estimate: ~1 segment per 2-4 seconds of audio → estimate total segments
        const estTotalSegments = Math.max(seg.segmentsProcessed, seg.durationSec / 3);
        const intraStepPct = Math.min(seg.segmentsProcessed / estTotalSegments, 0.99);
        stepProgress += stepWeights[1] * intraStepPct;
      }
      weightedComplete += weight * stepProgress;
    }
  }

  job.progressPct = Math.min(Math.round(weightedComplete * 100), 99);
  if (job.status === 'completed') job.progressPct = 100;

  // ETA calculation
  if (job.startedAt && job.progressPct > 0 && job.status === 'processing') {
    const elapsed = Date.now() - job.startedAt;
    const rate = elapsed / job.progressPct;
    job.etaMs = Math.round(rate * (100 - job.progressPct));
    job.elapsedMs = elapsed;
  }
}
