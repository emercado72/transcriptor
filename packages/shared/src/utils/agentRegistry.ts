/**
 * Agent Registry — Redis-backed service discovery
 *
 * Agents call registerAgent() on startup to announce themselves.
 * Supervisor calls getRegistry() to discover all agents and their tools.
 *
 * Storage:
 *   agent:manifest:{agentId} — JSON string of AgentManifest
 *   agent:manifests — SET of agentIds with active manifests
 */

import { createLogger } from '../utils/logger.js';
import type { AgentManifest, AgentRuntimeStatus } from '../types/agentRegistry.js';

const logger = createLogger('agent-registry');
const MANIFEST_PREFIX = 'agent:manifest:';
const MANIFEST_SET = 'agent:manifests';

// Store manifests locally so heartbeat can re-register if Redis expires
const localManifests = new Map<string, AgentManifest>();
const HEARTBEAT_TTL = 120; // seconds — manifest expires if no heartbeat in 2 min

let redisClient: any = null;

export function setRegistryRedis(client: any): void {
  redisClient = client;
}

function getRedis(): any {
  if (!redisClient) throw new Error('Registry Redis not initialized — call setRegistryRedis() first');
  return redisClient;
}

/**
 * Register an agent manifest in Redis.
 * Called by each agent on startup.
 */
export async function registerAgent(manifest: AgentManifest): Promise<void> {
  const redis = getRedis();
  const key = MANIFEST_PREFIX + manifest.agentId;
  manifest.registeredAt = manifest.registeredAt || new Date().toISOString();
  manifest.lastHeartbeat = new Date().toISOString();
  manifest.status = 'online';

  await redis.set(key, JSON.stringify(manifest));
  await redis.sadd(MANIFEST_SET, manifest.agentId);
  localManifests.set(manifest.agentId, manifest);

  logger.info(`Agent registered: ${manifest.agentId} (${manifest.tools.length} tools, ${manifest.capabilities.length} capabilities)`);
}

/**
 * Send a heartbeat to keep the manifest alive.
 * Called periodically by each agent.
 */
export async function heartbeat(agentId: string, status?: AgentRuntimeStatus): Promise<void> {
  const redis = getRedis();
  const key = MANIFEST_PREFIX + agentId;
  let raw = await redis.get(key);

  // Re-register if expired
  if (!raw) {
    const local = localManifests.get(agentId);
    if (local) {
      local.lastHeartbeat = new Date().toISOString();
      if (status) local.status = status;
      await redis.set(key, JSON.stringify(local));
      await redis.sadd(MANIFEST_SET, agentId);
      return;
    }
    return;
  }

  const manifest = JSON.parse(raw) as AgentManifest;
  manifest.lastHeartbeat = new Date().toISOString();
  if (status) manifest.status = status;

  await redis.set(key, JSON.stringify(manifest));
}

/**
 * Update agent status (online, degraded, offline).
 */
export async function updateAgentStatus(agentId: string, status: AgentRuntimeStatus): Promise<void> {
  await heartbeat(agentId, status);
}

/**
 * Get a single agent manifest.
 */
export async function getAgentManifest(agentId: string): Promise<AgentManifest | null> {
  const redis = getRedis();
  const raw = await redis.get(MANIFEST_PREFIX + agentId);
  if (!raw) return null;
  return JSON.parse(raw) as AgentManifest;
}

/**
 * Get all registered agent manifests.
 * Used by Supervisor to understand the system.
 */
export async function getAllManifests(): Promise<AgentManifest[]> {
  const redis = getRedis();
  const agentIds = await redis.smembers(MANIFEST_SET) as string[];
  const manifests: AgentManifest[] = [];

  for (const id of agentIds) {
    const raw = await redis.get(MANIFEST_PREFIX + id);
    if (raw) {
      manifests.push(JSON.parse(raw));
    } else {
      // Expired — remove from set
      await redis.srem(MANIFEST_SET, id);
    }
  }

  return manifests;
}

/**
 * Get a summary for the Supervisor LLM context.
 * Returns a compact text description of all agents and their tools.
 */
export async function getRegistrySummary(): Promise<string> {
  const manifests = await getAllManifests();
  if (manifests.length === 0) return 'No agents registered.';

  const lines: string[] = ['## Active Agents\n'];

  for (const m of manifests) {
    const age = Math.round((Date.now() - new Date(m.lastHeartbeat).getTime()) / 1000);
    lines.push(`### ${m.name} (${m.agentId}) — ${m.status}${age > 60 ? ' [stale ' + age + 's]' : ''}`);
    lines.push(m.description);
    lines.push('');

    if (m.capabilities.length > 0) {
      lines.push('**Capabilities:**');
      for (const c of m.capabilities) {
        lines.push(`- ${c.name}: ${c.description}${c.pipelineStage ? ' (stage: ' + c.pipelineStage + ')' : ''}`);
      }
      lines.push('');
    }

    if (m.tools.length > 0) {
      lines.push('**Available Tools:**');
      for (const t of m.tools) {
        lines.push(`- \`${t.method} ${t.endpoint}\` — ${t.name}: ${t.description}${t.async ? ' (async)' : ''}`);
        if (Object.keys(t.inputSchema).length > 0) {
          lines.push(`  Input: ${JSON.stringify(t.inputSchema)}`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Start periodic heartbeat for an agent.
 * Returns a cleanup function to stop the heartbeat.
 */
export function startHeartbeatLoop(agentId: string, intervalMs: number = 30_000): () => void {
  const interval = setInterval(() => {
    heartbeat(agentId).catch(() => {});
  }, intervalMs);
  return () => clearInterval(interval);
}

/**
 * Unregister an agent (on graceful shutdown).
 */
export async function unregisterAgent(agentId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(MANIFEST_PREFIX + agentId);
  await redis.srem(MANIFEST_SET, agentId);
  logger.info(`Agent unregistered: ${agentId}`);
}
