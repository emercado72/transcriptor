/**
 * Fisher — Job Backup Service (Legacy)
 *
 * Previously handled rsync-based file backup from remote GPU workers.
 * Now replaced by S3 push model — agents upload results directly to S3.
 *
 * This module is retained for potential disaster recovery use only.
 * The main backup path is now: agent → S3 → dashboard reads from S3.
 */

import { createLogger } from '@transcriptor/shared';

const logger = createLogger('fisher:backup');

export interface BackupResult {
  jobId: string;
  filesBackedUp: string[];
  redisKeysRestored: number;
  totalSizeBytes: number;
  durationMs: number;
}

// Legacy exports kept for type compatibility — no longer called in normal flow.
logger.info('Job backup module loaded (S3 push model active — rsync disabled)');
