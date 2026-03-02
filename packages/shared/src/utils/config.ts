import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import type { ClientConfig, GlossaryEntry, EnvConfig } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..', '..');

// Load .env.local from project root
dotenv.config({ path: path.join(ROOT_DIR, '.env.local') });

export function getEnvConfig(): EnvConfig {
  return {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost:5432/transcriptor',
    redisHost: process.env.REDIS_HOST || '127.0.0.1',
    redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
    redisPassword: process.env.REDIS_PASSWORD || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    groqApiKey: process.env.GROQ_API_KEY || '',
    groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || '',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/auth/google/callback',
    googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
    googleServiceAccountKeyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || '',
    googleImpersonateEmail: process.env.GOOGLE_IMPERSONATE_EMAIL || '',
    googleDriveRootFolderId: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '',
    tecnoreunionesApiUrl: process.env.TECNOREUNIONES_API_URL || '',
    tecnoreunionesApiKey: process.env.TECNOREUNIONES_API_KEY || '',
    tecnoreunionesDbHost: process.env.TECNOREUNIONES_DB_HOST || 'n1.tecnoreuniones.com',
    tecnoreunionesDbUser: process.env.TECNOREUNIONES_DB_USER || 'tecno',
    tecnoreunionesDbPass: process.env.TECNOREUNIONES_DB_PASS || 'reuniones',
    tecnoreunionesDbName: process.env.TECNOREUNIONES_DB_NAME || 'Tecnoreuniones',
    logLevel: process.env.LOG_LEVEL || 'debug',
    gloriaPort: parseInt(process.env.GLORIA_PORT || '3001', 10),
  };
}

export function loadClientConfig(clientId: string): ClientConfig {
  const configPath = path.join(ROOT_DIR, 'config', 'clients', `${clientId}.json`);
  if (!existsSync(configPath)) {
    throw new Error(`Client config not found: ${configPath}`);
  }
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as ClientConfig;
}

export function loadGlossary(clientId: string): GlossaryEntry[] {
  const clientPath = path.join(ROOT_DIR, 'config', 'glossary', `${clientId}.json`);
  const defaultPath = path.join(ROOT_DIR, 'config', 'glossary', 'default.json');

  const defaultGlossary = loadDefaultGlossary();

  if (existsSync(clientPath)) {
    const raw = readFileSync(clientPath, 'utf-8');
    const clientGlossary = JSON.parse(raw) as GlossaryEntry[];
    return [...defaultGlossary, ...clientGlossary];
  }

  return defaultGlossary;
}

export function loadDefaultGlossary(): GlossaryEntry[] {
  const defaultPath = path.join(ROOT_DIR, 'config', 'glossary', 'default.json');
  if (!existsSync(defaultPath)) {
    return [];
  }
  const raw = readFileSync(defaultPath, 'utf-8');
  return JSON.parse(raw) as GlossaryEntry[];
}
