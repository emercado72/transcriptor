import { getRedisClient, createLogger } from '@transcriptor/shared';
import type { JobId, PipelineJob } from '@transcriptor/shared';

const logger = createLogger('supervisor:state');
const REDIS_PREFIX = 'transcriptor:pipeline:';
const ACTIVE_JOBS_KEY = 'transcriptor:active_jobs';

export async function saveState(jobId: JobId, state: PipelineJob): Promise<void> {
  const redis = getRedisClient();
  const key = `${REDIS_PREFIX}${jobId}`;
  await redis.set(key, JSON.stringify(state));
  await redis.sadd(ACTIVE_JOBS_KEY, jobId);
  logger.info(`State saved for job: ${jobId}`);
}

export async function loadState(jobId: JobId): Promise<PipelineJob> {
  const redis = getRedisClient();
  const key = `${REDIS_PREFIX}${jobId}`;
  const raw = await redis.get(key);
  if (!raw) {
    throw new Error(`No state found for job: ${jobId}`);
  }
  return JSON.parse(raw) as PipelineJob;
}

export async function listActiveJobs(): Promise<JobId[]> {
  const redis = getRedisClient();
  return redis.smembers(ACTIVE_JOBS_KEY);
}

export async function cleanupCompletedJobs(olderThan: Date): Promise<number> {
  const redis = getRedisClient();
  const activeJobs = await listActiveJobs();
  let cleaned = 0;

  for (const jobId of activeJobs) {
    try {
      const state = await loadState(jobId);
      const updatedAt = new Date(state.updatedAt);
      if (
        (state.status === 'completed' || state.status === 'failed') &&
        updatedAt < olderThan
      ) {
        await redis.del(`${REDIS_PREFIX}${jobId}`);
        await redis.srem(ACTIVE_JOBS_KEY, jobId);
        cleaned++;
      }
    } catch {
      // Job may have been already removed
    }
  }

  logger.info(`Cleaned up ${cleaned} completed jobs`);
  return cleaned;
}
