/**
 * Pipeline Events — Redis-backed event bus for agent ↔ supervisor communication.
 *
 * Agents push events when they finish (or fail) a task.
 * Supervisor polls the event queue and orchestrates the next step.
 *
 * Uses a Redis List (LPUSH/BRPOP) for reliable ordered delivery.
 */

import { Redis } from 'ioredis';
import { getRedisClient } from './redis.js';
import { getEnvConfig } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('pipeline:events');

const EVENT_QUEUE_KEY = 'supervisor:event_queue';

/**
 * Dedicated Redis connection for BRPOP.
 * BRPOP blocks the connection until an item arrives or the timeout expires,
 * which would stall all other Redis commands if we used the shared client.
 */
let blockingClient: Redis | null = null;

function getBlockingClient(): Redis {
  if (!blockingClient) {
    const config = getEnvConfig();
    blockingClient = new Redis({
      host: config.redisHost,
      port: config.redisPort,
      password: config.redisPassword || undefined,
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
    });
    blockingClient.on('error', (err: Error) => logger.error('Blocking Redis error', err));
    logger.info('Dedicated blocking Redis client created for BRPOP');
  }
  return blockingClient;
}

// ── Event Types ──

export type PipelineEventType =
  | 'files_ready'        // Yulieth: files downloaded, ready for preprocessing
  | 'preprocessing_done' // Chucho: preprocessing complete
  | 'preprocessing_failed'
  | 'transcription_done' // Jaime: transcription + sectioning complete
  | 'transcription_failed'
  | 'redaction_done'     // Lina: redaction complete
  | 'redaction_failed'
  | 'assembly_done'      // Fannery: document assembly complete
  | 'assembly_failed'
  | 'review_done'        // Gloria: review approved
  | 'review_failed'
  | 'job_retry';         // Manual retry request

export interface PipelineEvent {
  type: PipelineEventType;
  jobId: string;
  agent: string;
  timestamp: string;
  /** Optional result data from the agent */
  data?: Record<string, unknown>;
  /** Error message if this is a failure event */
  error?: string;
}

// ── Publishing (used by agents) ──

/**
 * Publish an event to the supervisor queue.
 * Called by agents when they complete or fail their work.
 */
export async function publishEvent(event: PipelineEvent): Promise<void> {
  const redis = getRedisClient();
  const payload = JSON.stringify(event);
  await redis.lpush(EVENT_QUEUE_KEY, payload);
  logger.info(`Event published: ${event.type} for job ${event.jobId} by ${event.agent}`);
}

/**
 * Helper: publish a success event.
 */
export async function publishSuccess(
  type: PipelineEventType,
  jobId: string,
  agent: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await publishEvent({
    type,
    jobId,
    agent,
    timestamp: new Date().toISOString(),
    data,
  });
}

/**
 * Helper: publish a failure event.
 */
export async function publishFailure(
  type: PipelineEventType,
  jobId: string,
  agent: string,
  error: string,
  data?: Record<string, unknown>,
): Promise<void> {
  await publishEvent({
    type,
    jobId,
    agent,
    timestamp: new Date().toISOString(),
    error,
    data,
  });
}

// ── Consuming (used by supervisor) ──

/**
 * Pop the next event from the queue (blocking, with timeout).
 * Returns null if no event is available within the timeout.
 */
export async function popEvent(timeoutSeconds = 5): Promise<PipelineEvent | null> {
  const redis = getBlockingClient();
  const result = await redis.brpop(EVENT_QUEUE_KEY, timeoutSeconds);
  if (!result) return null;

  const [, payload] = result;
  try {
    return JSON.parse(payload) as PipelineEvent;
  } catch (err) {
    logger.error(`Failed to parse event: ${payload} — ${(err as Error).message}`);
    return null;
  }
}

/**
 * Get the current queue length (for monitoring).
 */
export async function getQueueLength(): Promise<number> {
  const redis = getRedisClient();
  return redis.llen(EVENT_QUEUE_KEY);
}
