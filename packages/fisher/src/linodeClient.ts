/**
 * Fisher — Linode API Client
 *
 * Thin wrapper around Linode REST API for GPU worker lifecycle.
 */

import { createLogger } from '@transcriptor/shared';

const logger = createLogger('fisher:linode');

export interface LinodeInstance {
  id: number;
  label: string;
  status: string;  // provisioning, booting, running, offline, shutting_down
  ipv4: string[];
  region: string;
  type: string;
  created: string;
}

export interface FisherConfig {
  apiToken: string;
  region: string;           // us-ord, us-east, etc
  instanceType: string;     // g2-gpu-rtx4000a1-s
  stackScriptId: number;
  sshPubKey: string;
  rootPass: string;
  labelPrefix: string;      // transcriptor-gpu
}

const API_BASE = 'https://api.linode.com/v4';

function headers(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/** Create a new GPU worker instance */
export async function createWorker(config: FisherConfig): Promise<LinodeInstance> {
  const label = `${config.labelPrefix}-${Date.now().toString(36)}`;
  logger.info(`Creating GPU worker: ${label} (${config.instanceType} in ${config.region})`);

  const res = await fetch(`${API_BASE}/linode/instances`, {
    method: 'POST',
    headers: headers(config.apiToken),
    body: JSON.stringify({
      label,
      type: config.instanceType,
      region: config.region,
      image: 'linode/ubuntu24.04',
      root_pass: config.rootPass,
      stackscript_id: config.stackScriptId,
      authorized_keys: [config.sshPubKey],
      booted: true,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Linode API error ${res.status}: ${JSON.stringify(err)}`);
  }

  const instance = await res.json() as LinodeInstance;
  logger.info(`Worker created: ${instance.id} (${instance.label}) — ${instance.ipv4[0]}`);
  return instance;
}

/** Get instance status */
export async function getWorker(config: FisherConfig, instanceId: number): Promise<LinodeInstance> {
  const res = await fetch(`${API_BASE}/linode/instances/${instanceId}`, {
    headers: headers(config.apiToken),
  });
  if (!res.ok) throw new Error(`Linode API error ${res.status}`);
  return await res.json() as LinodeInstance;
}

/** Delete a worker instance */
export async function deleteWorker(config: FisherConfig, instanceId: number): Promise<void> {
  logger.info(`Deleting worker: ${instanceId}`);
  const res = await fetch(`${API_BASE}/linode/instances/${instanceId}`, {
    method: 'DELETE',
    headers: headers(config.apiToken),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Delete failed ${res.status}: ${JSON.stringify(err)}`);
  }
  logger.info(`Worker ${instanceId} deleted`);
}

/** List all workers matching our label prefix */
export async function listWorkers(config: FisherConfig): Promise<LinodeInstance[]> {
  const res = await fetch(`${API_BASE}/linode/instances`, {
    headers: headers(config.apiToken),
  });
  if (!res.ok) throw new Error(`Linode API error ${res.status}`);
  const data = await res.json() as { data: LinodeInstance[] };
  return data.data.filter(i => i.label.startsWith(config.labelPrefix));
}

/** Wait for instance to reach a specific status */
export async function waitForStatus(
  config: FisherConfig,
  instanceId: number,
  targetStatus: string,
  timeoutMs: number = 600_000, // 10 min default
  pollMs: number = 10_000,
): Promise<LinodeInstance> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const instance = await getWorker(config, instanceId);
    if (instance.status === targetStatus) return instance;
    logger.info(`Worker ${instanceId}: ${instance.status} (waiting for ${targetStatus})`);
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`Timeout waiting for worker ${instanceId} to reach ${targetStatus}`);
}

/** Wait for Gloria health endpoint to respond on the worker */
export async function waitForGloria(
  ip: string,
  port: number = 3001,
  timeoutMs: number = 600_000,
  pollMs: number = 15_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://${ip}:${port}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        logger.info(`Gloria responding on ${ip}:${port}`);
        return true;
      }
    } catch {
      // not ready yet
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    logger.info(`Waiting for Gloria on ${ip}:${port} (${elapsed}s elapsed)`);
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}
