/**
 * Runtime model configuration — allows switching LLM models at runtime
 * without restarting the server. Stored in Redis for persistence.
 */

import { getRedisClient } from './redis.js';
import { getEnvConfig } from './config.js';

const REDIS_KEY = 'transcriptor:runtime:models';

export interface ModelConfig {
  linaModel: string;
  gloriaModel: string;
}

const AVAILABLE_MODELS = [
  { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6', provider: 'Anthropic' },
  { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash', provider: 'Google' },
  { id: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2', provider: 'DeepSeek' },
  { id: 'qwen/qwen3.5-plus-02-15', label: 'Qwen 3.5 Plus', provider: 'Qwen' },
];

// In-memory cache so we don't hit Redis on every LLM call
let cachedConfig: ModelConfig | null = null;

export function getAvailableModels() {
  return AVAILABLE_MODELS;
}

export async function getModelConfig(): Promise<ModelConfig> {
  if (cachedConfig) return cachedConfig;

  try {
    const redis = getRedisClient();
    const raw = await redis.get(REDIS_KEY);
    if (raw) {
      cachedConfig = JSON.parse(raw) as ModelConfig;
      return cachedConfig;
    }
  } catch {
    // Redis not available — fall through to env defaults
  }

  // Fall back to env config
  const env = getEnvConfig();
  return {
    linaModel: env.linaModel || '',
    gloriaModel: env.gloriaModel || '',
  };
}

export async function setModelConfig(update: Partial<ModelConfig>): Promise<ModelConfig> {
  const current = await getModelConfig();
  const merged: ModelConfig = {
    linaModel: update.linaModel ?? current.linaModel,
    gloriaModel: update.gloriaModel ?? current.gloriaModel,
  };

  cachedConfig = merged;

  try {
    const redis = getRedisClient();
    await redis.set(REDIS_KEY, JSON.stringify(merged));
  } catch {
    // Redis not available — in-memory only
  }

  return merged;
}

/** Resolve the effective model for Lina */
export async function getLinaModel(): Promise<string> {
  const cfg = await getModelConfig();
  const env = getEnvConfig();
  return cfg.linaModel || env.linaModel || env.openrouterModel;
}

/** Resolve the effective model for Gloria */
export async function getGloriaModel(): Promise<string> {
  const cfg = await getModelConfig();
  const env = getEnvConfig();
  return cfg.gloriaModel || env.gloriaModel || env.openrouterModel;
}
