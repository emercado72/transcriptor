/**
 * Fisher - GPU Worker Orchestrator
 *
 * Push model: provision worker → dispatch job → done.
 * Agents upload results to S3 themselves.
 * Fisher no longer polls for job status or runs rsync backups.
 * Lifecycle: PROVISION → PROCESSING → DESTROY
 */
import { createLogger, getRedisClient } from '@transcriptor/shared';
import * as linode from './linodeClient.js';
import * as monitor from './workerMonitor.js';

const logger = createLogger('fisher');
const REDIS_KEY = 'fisher:workerInfo';

export type WorkerState = 'idle' | 'provisioning' | 'booting' | 'processing' | 'destroying' | 'error';

export interface WorkerInfo {
  instanceId: number | null;
  ip: string | null;
  label: string | null;
  state: WorkerState;
  currentJobId: string | null;
  createdAt: string | null;
  error: string | null;
}

export interface FisherStatus {
  worker: WorkerInfo;
  config: Partial<linode.FisherConfig>;
  heartbeats: monitor.WorkerHeartbeat[];
}

let workerInfo: WorkerInfo = { instanceId: null, ip: null, label: null, state: 'idle', currentJobId: null, createdAt: null, error: null };
let fisherConfig: linode.FisherConfig | null = null;

const IDLE_WORKER: WorkerInfo = { instanceId: null, ip: null, label: null, state: 'idle', currentJobId: null, createdAt: null, error: null };

async function persistWorkerInfo(): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.set(REDIS_KEY, JSON.stringify(workerInfo));
  } catch (e) { logger.warn('Failed to persist workerInfo: ' + (e as Error).message); }
}

async function restoreWorkerInfo(): Promise<WorkerInfo | null> {
  try {
    const redis = getRedisClient();
    const raw = await redis.get(REDIS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as WorkerInfo;
  } catch (e) { logger.warn('Failed to restore workerInfo: ' + (e as Error).message); return null; }
}

async function verifyWorkerAlive(ip: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${ip}:3001/api/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch { return false; }
}

export async function initFisher(): Promise<linode.FisherConfig> {
  fisherConfig = {
    apiToken: process.env.LINODE_API_TOKEN || '',
    region: process.env.FISHER_REGION || 'us-ord',
    instanceType: process.env.FISHER_INSTANCE_TYPE || 'g2-gpu-rtx4000a1-s',
    stackScriptId: parseInt(process.env.FISHER_STACKSCRIPT_ID || '2041254', 10),
    sshPubKey: process.env.FISHER_SSH_PUBKEY || '',
    rootPass: process.env.FISHER_ROOT_PASS || 'Tr4nscr1pt0r!GPU@2026',
    labelPrefix: process.env.FISHER_LABEL_PREFIX || 'transcriptor-gpu',
  };
  if (!fisherConfig.apiToken) logger.warn('LINODE_API_TOKEN not set');

  // Restore worker state from Redis (survives restarts)
  const saved = await restoreWorkerInfo();
  if (saved && saved.state === 'processing' && saved.ip) {
    logger.info('Restored worker state from Redis: ' + saved.ip + ' (instance ' + saved.instanceId + ')');
    const alive = await verifyWorkerAlive(saved.ip);
    if (alive) {
      workerInfo = saved;
      logger.info('Worker ' + saved.ip + ' is alive — resuming monitoring');
      if (saved.instanceId && saved.label) {
        monitor.startHeartbeat(saved.instanceId, saved.ip, saved.label, 60_000);
      }
    } else {
      logger.warn('Saved worker ' + saved.ip + ' is not responding — marking as error for investigation');
      workerInfo = { ...saved, state: 'error', error: 'Worker not responding after restart' };
      await persistWorkerInfo();
    }
  } else if (saved && saved.state !== 'idle') {
    // Non-processing state (provisioning, booting, destroying) — reset to idle
    logger.warn('Saved worker in transient state "' + saved.state + '" — resetting to idle');
    workerInfo = { ...IDLE_WORKER };
    await persistWorkerInfo();
  }

  // When heartbeat declares a worker down, verify with Linode API
  monitor.onWorkerDown(async (instanceId, label, failures) => {
    logger.error('Worker ' + label + ' (' + instanceId + ') missed ' + failures + ' heartbeats — checking Linode API...');
    try {
      const instance = await linode.getWorker(fisherConfig!, instanceId);
      logger.warn('Worker ' + label + ' still exists on Linode (status: ' + instance.status + ') — marking as error, keeping alive for investigation');
      workerInfo.state = 'error';
      workerInfo.error = 'Worker unreachable after ' + failures + ' heartbeats (Linode status: ' + instance.status + ')';
      await persistWorkerInfo();
    } catch {
      logger.error('Worker ' + label + ' no longer exists on Linode — resetting to idle');
      workerInfo = { ...IDLE_WORKER };
      await persistWorkerInfo();
    }
  });

  logger.info('Fisher initialized: ' + fisherConfig.region + ' / ' + fisherConfig.instanceType + ' (worker: ' + workerInfo.state + ')');
  return fisherConfig;
}

export function getStatus(): FisherStatus {
  return {
    worker: { ...workerInfo },
    config: fisherConfig ? { region: fisherConfig.region, instanceType: fisherConfig.instanceType, labelPrefix: fisherConfig.labelPrefix } : {},
    heartbeats: monitor.getAllHeartbeats(),
  };
}

export async function provisionWorker(): Promise<string> {
  if (!fisherConfig) throw new Error('Fisher not initialized');
  if (workerInfo.state !== 'idle' && workerInfo.state !== 'error') throw new Error('Cannot provision: worker is ' + workerInfo.state);

  // Cleanup: if recovering from error with an existing instance, destroy it first
  if (workerInfo.state === 'error' && workerInfo.instanceId) {
    logger.warn('Cleaning up orphaned worker ' + workerInfo.instanceId + ' from previous error');
    try { await linode.deleteWorker(fisherConfig, workerInfo.instanceId); } catch (e) { logger.error('Orphan cleanup failed: ' + (e as Error).message); }
    workerInfo = { ...IDLE_WORKER };
    await persistWorkerInfo();
  }

  // Also cleanup any orphaned instances from previous runs (label prefix match)
  // Skip the current active worker (workerInfo.instanceId) — it's tracked, not orphaned
  try {
    const orphans = await linode.listWorkers(fisherConfig);
    const realOrphans = orphans.filter(w => w.id !== workerInfo.instanceId);
    if (realOrphans.length > 0) {
      logger.warn('Found ' + realOrphans.length + ' orphaned worker(s), cleaning up...');
      for (const orphan of realOrphans) {
        try { await linode.deleteWorker(fisherConfig, orphan.id); } catch (e) { logger.error('Orphan ' + orphan.id + ' cleanup: ' + (e as Error).message); }
      }
    }
  } catch (e) { logger.error('Orphan scan failed: ' + (e as Error).message); }

  workerInfo.state = 'provisioning';
  workerInfo.error = null;
  workerInfo.createdAt = new Date().toISOString();
  await persistWorkerInfo();
  try {
    const instance = await linode.createWorker(fisherConfig);
    workerInfo.instanceId = instance.id;
    workerInfo.ip = instance.ipv4[0];
    workerInfo.label = instance.label;
    workerInfo.state = 'booting';
    await persistWorkerInfo();
    await linode.waitForStatus(fisherConfig, instance.id, 'running', 300_000);
    logger.info('Worker ' + instance.id + ' running at ' + workerInfo.ip);
    logger.info('Waiting for Gloria (init script ~5min + reboot)...');
    const ready = await linode.waitForGloria(workerInfo.ip!, 3001, 900_000, 20_000);
    if (!ready) throw new Error('Gloria did not come online within 15 minutes');
    workerInfo.state = 'processing';
    await persistWorkerInfo();
    monitor.startHeartbeat(instance.id, workerInfo.ip!, workerInfo.label!, 60_000);
    return workerInfo.ip!;
  } catch (err) {
    workerInfo.state = 'error';
    workerInfo.error = (err as Error).message;
    await persistWorkerInfo();
    if (workerInfo.instanceId) {
      logger.warn('Provisioning failed — instance ' + workerInfo.instanceId + ' (' + workerInfo.ip + ') kept alive for debugging');
      logger.warn('SSH: ssh root@' + workerInfo.ip);
      logger.warn('Destroy manually via POST /api/agents/fisher/destroy or /cleanup-orphans');
    }
    throw err;
  }
}

/** Find and destroy any orphaned GPU workers (matching label prefix) */
export async function cleanupOrphans(): Promise<{ destroyed: number; ids: number[] }> {
  if (!fisherConfig) throw new Error('Fisher not initialized');
  const workers = await linode.listWorkers(fisherConfig);
  // Don't destroy the current active worker
  const orphans = workers.filter(w => w.id !== workerInfo.instanceId);
  const ids: number[] = [];
  for (const orphan of orphans) {
    try {
      await linode.deleteWorker(fisherConfig, orphan.id);
      ids.push(orphan.id);
      logger.info('Destroyed orphan: ' + orphan.id + ' (' + orphan.label + ')');
    } catch (e) { logger.error('Failed to destroy orphan ' + orphan.id + ': ' + (e as Error).message); }
  }
  return { destroyed: ids.length, ids };
}

// ── Discovery — find and adopt a running GPU worker ──

export interface DiscoveredWorker {
  instanceId: number;
  label: string;
  ip: string;
  linodeStatus: string;
  gloriaHealthy: boolean;
  adopted: boolean;
}

/**
 * Scan Linode for running transcriptor-gpu-* instances, health-check each,
 * and adopt the first healthy one. Useful when Fisher lost track after a restart.
 */
export async function discoverWorkers(): Promise<{ discovered: DiscoveredWorker[]; adopted: DiscoveredWorker | null }> {
  if (!fisherConfig) throw new Error('Fisher not initialized');

  // If already tracking a healthy worker, don't overwrite
  if (workerInfo.state === 'processing' && workerInfo.ip) {
    const alive = await verifyWorkerAlive(workerInfo.ip);
    if (alive) {
      return {
        discovered: [{
          instanceId: workerInfo.instanceId!,
          label: workerInfo.label || 'unknown',
          ip: workerInfo.ip,
          linodeStatus: 'running',
          gloriaHealthy: true,
          adopted: true,
        }],
        adopted: null, // already tracking
      };
    }
  }

  const instances = await linode.listWorkers(fisherConfig);
  const discovered: DiscoveredWorker[] = [];
  let adopted: DiscoveredWorker | null = null;

  for (const instance of instances) {
    const ip = instance.ipv4[0];
    const healthy = ip ? await verifyWorkerAlive(ip) : false;
    const entry: DiscoveredWorker = {
      instanceId: instance.id,
      label: instance.label,
      ip: ip || '',
      linodeStatus: instance.status,
      gloriaHealthy: healthy,
      adopted: false,
    };
    discovered.push(entry);

    // Adopt the first healthy worker
    if (!adopted && healthy && instance.status === 'running') {
      workerInfo = {
        instanceId: instance.id,
        ip,
        label: instance.label,
        state: 'processing',
        currentJobId: null,
        createdAt: instance.created,
        error: null,
      };
      await persistWorkerInfo();
      monitor.startHeartbeat(instance.id, ip, instance.label, 60_000);
      entry.adopted = true;
      adopted = entry;
      logger.info('Discovered and adopted worker: ' + instance.label + ' (' + ip + ')');
    }
  }

  if (!adopted && discovered.length > 0) {
    logger.warn('Discovered ' + discovered.length + ' worker(s) but none are healthy');
  } else if (discovered.length === 0) {
    logger.info('No transcriptor-gpu-* workers found on Linode');
  }

  return { discovered, adopted };
}

// ── Worker query / provision helpers (used by Supervisor delegation) ──

/**
 * Query current worker status without side effects.
 */
export function getWorkerStatus(): WorkerInfo {
  return { ...workerInfo };
}

/**
 * Ensure a GPU worker is available. Provisions one if needed.
 * If already provisioning/booting, waits until ready.
 * Returns the worker IP when the worker is healthy.
 */
export async function ensureWorker(): Promise<string> {
  if (!fisherConfig) throw new Error('Fisher not initialized');

  switch (workerInfo.state) {
    case 'processing':
      if (!workerInfo.ip) throw new Error('Worker in processing state but no IP');
      return workerInfo.ip;

    case 'idle':
    case 'error':
      return provisionWorker();

    case 'provisioning':
    case 'booting':
      return waitForWorkerReady();

    case 'destroying':
      throw new Error('Worker is being destroyed — try again shortly');

    default:
      throw new Error('Unknown worker state: ' + workerInfo.state);
  }
}

/**
 * Poll workerInfo until state reaches 'processing' (ready) or 'error'.
 */
async function waitForWorkerReady(timeoutMs = 900_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (workerInfo.state === 'processing' && workerInfo.ip) {
      return workerInfo.ip;
    }
    if (workerInfo.state === 'error') {
      throw new Error('Worker provisioning failed: ' + (workerInfo.error || 'unknown'));
    }
    if (workerInfo.state === 'idle') {
      throw new Error('Worker reset to idle unexpectedly');
    }
    await new Promise(r => setTimeout(r, 5_000));
  }
  throw new Error('Timeout waiting for worker to be ready');
}

export async function destroyWorker(): Promise<void> {
  if (!fisherConfig || !workerInfo.instanceId) { workerInfo = { ...IDLE_WORKER }; await persistWorkerInfo(); return; }
  workerInfo.state = 'destroying';
  await persistWorkerInfo();
  monitor.stopHeartbeat(workerInfo.instanceId);
  try { await linode.deleteWorker(fisherConfig, workerInfo.instanceId); } catch (e) { logger.error('Destroy: ' + (e as Error).message); }
  workerInfo = { ...IDLE_WORKER };
  await persistWorkerInfo();
}

/**
 * Process a folder: provision worker → dispatch job.
 * Returns the jobId. Fisher does NOT wait for completion —
 * agents push results to S3 themselves.
 */
export async function processFolder(driveFolderId: string, subfolderId: string): Promise<{ jobId: string; workerIp: string }> {
  if (!fisherConfig) throw new Error('Fisher not initialized');
  logger.info('=== Fisher: processing folder ' + subfolderId + ' ===');
  const ip = await provisionWorker();

  const scanRes = await fetch('http://' + ip + ':3001/api/agents/yulieth/drive-scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId: driveFolderId }) });
  if (!scanRes.ok) throw new Error('Scan failed: ' + scanRes.status);
  await new Promise(r => setTimeout(r, 2000));

  const enqRes = await fetch('http://' + ip + ':3001/api/agents/yulieth/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId: subfolderId }) });
  if (!enqRes.ok) throw new Error('Enqueue failed: ' + enqRes.status);
  const { jobId } = await enqRes.json() as { jobId: string };

  workerInfo.currentJobId = jobId;
  await persistWorkerInfo();
  logger.info('Job ' + jobId + ' dispatched to ' + ip + ' — agents will push results to S3');

  return { jobId, workerIp: ip };
}
