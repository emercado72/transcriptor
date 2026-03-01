import { createLogger } from '../utils/logger.js';

const logger = createLogger('seed');

async function seed(): Promise<void> {
  logger.info('Database seeding placeholder — no seed data configured yet.');
  logger.info('Add seed data to this file as needed.');
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
