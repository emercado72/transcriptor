/**
 * Fisher — Job Backup Service
 *
 * Copies processed job data (transcription, sections, redacted, output)
 * from a remote GPU worker to the local machine via SSH/rsync.
 * Excludes raw audio files to save space.
 * Also copies Redis state so the job can be resumed locally.
 */

import { execSync, exec } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createLogger, getRedisClient } from '@transcriptor/shared';

const logger = createLogger('fisher:backup');

export interface BackupResult {
  jobId: string;
  filesBackedUp: string[];
  redisKeysRestored: number;
  totalSizeBytes: number;
  durationMs: number;
}

/**
 * Backup a job from a remote GPU worker to the local machine.
 * Copies: processed/, transcript/, sections/, redacted/, output/
 * Skips: raw/ (audio files)
 */
export async function backupJob(
  workerIp: string,
  jobId: string,
  localJobsDir?: string,
): Promise<BackupResult> {
  const start = Date.now();
  const projectRoot = path.resolve(import.meta.dirname, '../../..');
  const localDir = localJobsDir || path.join(projectRoot, 'data', 'jobs');
  const localJobDir = path.join(localDir, jobId);

  logger.info(`Backing up job ${jobId} from ${workerIp} to ${localJobDir}`);

  // Step 1: rsync job data (exclude raw audio)
  fs.mkdirSync(localJobDir, { recursive: true });

  const rsyncCmd = [
    'rsync', '-avz', '--exclude=raw/',
    `root@${workerIp}:/opt/transcriptor/transcriptor/data/jobs/${jobId}/`,
    `${localJobDir}/`,
  ].join(' ');

  logger.info(`rsync: ${rsyncCmd}`);
  execSync(rsyncCmd, { encoding: 'utf-8', timeout: 300_000 });

  const dirs = fs.readdirSync(localJobDir);
  logger.info(`Job ${jobId}: backed up directories: ${dirs.join(', ')}`);

  // Step 2: Copy Redis state from remote
  const redisKeys = await backupRedisState(workerIp, jobId);

  // Calculate total size
  let totalSize = 0;
  const calcSize = (dir: string) => {
    try {
      const output = execSync(`du -sb ${dir}`, { encoding: 'utf-8' });
      totalSize = parseInt(output.split('\t')[0], 10);
    } catch { /* ignore */ }
  };
  calcSize(localJobDir);

  const result: BackupResult = {
    jobId,
    filesBackedUp: dirs,
    redisKeysRestored: redisKeys,
    totalSizeBytes: totalSize,
    durationMs: Date.now() - start,
  };

  logger.info(`Backup complete for ${jobId}: ${dirs.length} dirs, ${redisKeys} Redis keys, ${(totalSize / 1024 / 1024).toFixed(1)}MB, ${result.durationMs}ms`);
  return result;
}

/**
 * Copy all Redis keys for a job from a remote worker to local Redis.
 */
async function backupRedisState(workerIp: string, jobId: string): Promise<number> {
  const redis = getRedisClient();
  let keysRestored = 0;

  try {
    // Get all keys matching this jobId from remote
    const remoteKeys = execSync(
      `ssh root@${workerIp} "redis-cli KEYS '*${jobId}*'"`,
      { encoding: 'utf-8', timeout: 30_000 },
    ).trim().split('\n').filter(Boolean);

    for (const key of remoteKeys) {
      const value = execSync(
        `ssh root@${workerIp} "redis-cli GET '${key}'"`,
        { encoding: 'utf-8', timeout: 30_000 },
      ).trim();

      if (value && value !== '(nil)') {
        await redis.set(key, value);
        keysRestored++;
      }
    }

    // Add to active_jobs set
    await redis.sadd('transcriptor:active_jobs', jobId);

    // Check agent sets
    const setsToCheck = ['lina:active_jobs', 'fannery:active_jobs'];
    for (const setKey of setsToCheck) {
      const isMember = execSync(
        `ssh root@${workerIp} "redis-cli SISMEMBER '${setKey}' '${jobId}'"`,
        { encoding: 'utf-8', timeout: 10_000 },
      ).trim();
      if (isMember === '1') {
        await redis.sadd(setKey, jobId);
      }
    }

    logger.info(`Restored ${keysRestored} Redis keys for job ${jobId}`);
  } catch (err) {
    logger.error(`Redis backup failed for ${jobId}: ${(err as Error).message}`);
  }

  return keysRestored;
}

/**
 * List all jobs on a remote worker.
 */
export function listRemoteJobs(workerIp: string): string[] {
  try {
    const output = execSync(
      `ssh -o ConnectTimeout=5 root@${workerIp} "ls /opt/transcriptor/transcriptor/data/jobs/ 2>/dev/null"`,
      { encoding: 'utf-8', timeout: 15_000 },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get pipeline status of a job on a remote worker.
 */
export function getRemoteJobStatus(workerIp: string, jobId: string): any {
  try {
    const output = execSync(
      `ssh -o ConnectTimeout=5 root@${workerIp} "redis-cli GET 'transcriptor:pipeline:${jobId}'"`,
      { encoding: 'utf-8', timeout: 15_000 },
    );
    return JSON.parse(output.trim());
  } catch {
    return null;
  }
}
