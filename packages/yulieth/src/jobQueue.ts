import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { createLogger, getEnvConfig, JobStatus } from '@transcriptor/shared';
import type { EventFolder, EventMetadata, JobId, TranscriptionJob, QueueStats } from '@transcriptor/shared';

const logger = createLogger('yulieth:jobQueue');

const QUEUE_NAME = 'transcriptor:events';

let queue: Queue | null = null;

function getQueue(): Queue {
  if (!queue) {
    const env = getEnvConfig();
    queue = new Queue(QUEUE_NAME, {
      connection: {
        host: env.redisHost,
        port: env.redisPort,
        password: env.redisPassword || undefined,
      },
    });
  }
  return queue;
}

export async function enqueueEvent(eventFolder: EventFolder, eventMetadata: EventMetadata): Promise<JobId> {
  const jobId = randomUUID();
  const q = getQueue();

  await q.add('process-event', {
    jobId,
    eventFolder,
    eventMetadata,
  }, {
    jobId,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
  });

  logger.info(`Event enqueued: ${jobId} (${eventMetadata.buildingName})`);
  return jobId;
}

export async function getQueueStatus(): Promise<QueueStats> {
  const q = getQueue();
  const [waiting, active, completed, failed] = await Promise.all([
    q.getWaitingCount(),
    q.getActiveCount(),
    q.getCompletedCount(),
    q.getFailedCount(),
  ]);

  return {
    pending: waiting,
    processing: active,
    completed,
    failed,
  };
}

export async function getNextJob(): Promise<TranscriptionJob | null> {
  // BullMQ handles dequeuing via workers, this is a status check
  const q = getQueue();
  const jobs = await q.getWaiting(0, 0);
  if (jobs.length === 0) return null;

  const job = jobs[0];
  const data = job.data as Record<string, unknown>;
  return {
    jobId: String(data.jobId || job.id || ''),
    eventId: String((data.eventMetadata as Record<string, unknown>)?.eventId || ''),
    audioFilePath: '',
    status: JobStatus.PENDING,
    scribeJobId: null,
    startedAt: null,
    completedAt: null,
  };
}
