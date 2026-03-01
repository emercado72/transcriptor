import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
import { getEnvConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('database');

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let pool: pg.Pool | null = null;

export function getDb() {
  if (!db) {
    const config = getEnvConfig();
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 10,
    });

    pool.on('error', (err) => {
      logger.error('Database pool error', err);
    });

    db = drizzle(pool, { schema });
    logger.info('Database connection established');
  }

  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
    logger.info('Database connection closed');
  }
}

export * from './schema.js';
