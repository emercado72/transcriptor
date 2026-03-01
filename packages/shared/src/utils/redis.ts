import { Redis } from 'ioredis';
import { getEnvConfig } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('redis');

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    const config = getEnvConfig();
    redisClient = new Redis({
      host: config.redisHost,
      port: config.redisPort,
      password: config.redisPassword || undefined,
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => {
        if (times > 3) {
          logger.error(`Redis connection failed after ${times} retries`);
          return null;
        }
        return Math.min(times * 200, 2000);
      },
    });

    redisClient.on('connect', () => logger.info('Redis connected'));
    redisClient.on('error', (err: Error) => logger.error('Redis error', err));
  }

  return redisClient;
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis connection closed');
  }
}
