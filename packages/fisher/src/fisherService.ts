/**
 * Fisher - GPU Worker Orchestrator
 * Manages lifecycle: PROVISION -> MONITOR -> BACKUP -> DESTROY
 */
import { createLogger } from '@transcriptor/shared';
import * as linode from './linodeClient.js';
import * as backup from './jobBackup.js';
import * as monitor from './workerMonitor.js';

const logger = createLogger('fisher');

export type WorkerState = 'idle' | 'provisioning' | 'booting' | 'processing' | 'backing_up' | 'destroying' | 'error';

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
  backups: backup.BackupResult[];
  heartbeats: monitor.WorkerHeartbeat[];
}

let workerInfo: WorkerInfo = { instanceId: null, ip: null, label: null, state: 'idle', currentJobId: null, createdAt: null, error: null };
let fisherConfig: linode.FisherConfig | null = null;
let backupHistory: backup.BackupResult[] = [];
let monitorInterval: ReturnType<typeof setInterval> | null = null;

export function initFisher(): linode.FisherConfig {
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
  logger.info('Fisher initialized: ' + fisherConfig.region + ' / ' + fisherConfig.instanceType);
  return fisherConfig;
}

export function getStatus(): FisherStatus {
  return {
    worker: { ...workerInfo },
    config: fisherConfig ? { region: fisherConfig.region, instanceType: fisherConfig.instanceType, labelPrefix: fisherConfig.labelPrefix } : {},
    backups: [...backupHistory],
    heartbeats: monitor.getAllHeartbeats(),
  };
}

export async function provisionWorker(): Promise<string> {
  if (!fisherConfig) throw new Error('Fisher not initialized');
  if (workerInfo.state !== 'idle' && workerInfo.state !== 'error') throw new Error('Cannot provision: worker is ' + workerInfo.state);
  workerInfo.state = 'provisioning';
  workerInfo.error = null;
  try {
    const instance = await linode.createWorker(fisherConfig);
    workerInfo.instanceId = instance.id;
    workerInfo.ip = instance.ipv4[0];
    workerInfo.label = instance.label;
    workerInfo.createdAt = new Date().toISOString();
    workerInfo.state = 'booting';
    await linode.waitForStatus(fisherConfig, instance.id, 'running', 300_000);
    logger.info('Worker ' + instance.id + ' running at ' + workerInfo.ip);
    logger.info('Waiting for Gloria (init script ~5min)...');
    const ready = await linode.waitForGloria(workerInfo.ip!, 3001, 720_000, 20_000);
    if (!ready) throw new Error('Gloria did not come online within 12 minutes');
    workerInfo.state = 'processing';
    monitor.startHeartbeat(instance.id, workerInfo.ip!, workerInfo.label!, 30_000);
    return workerInfo.ip!;
  } catch (err) {
    workerInfo.state = 'error';
    workerInfo.error = (err as Error).message;
    throw err;
  }
}

export function startMonitoring(jobId: string, backupAtStage = 'completed', pollMs = 30_000): void {
  if (!workerInfo.ip) throw new Error('No worker to monitor');
  workerInfo.currentJobId = jobId;
  logger.info('Monitoring job ' + jobId + ' on ' + workerInfo.ip);
  monitorInterval = setInterval(async () => {
    try {
      const status = backup.getRemoteJobStatus(workerInfo.ip!, jobId);
      if (!status) return;
      logger.info('Job ' + jobId + ': ' + status.status);
      if (status.status === backupAtStage || status.status === 'completed' || status.status === 'failed') {
        stopMonitoring();
        workerInfo.state = 'backing_up';
        try { const r = await backup.backupJob(workerInfo.ip!, jobId); backupHistory.push(r); } catch (e) { logger.error('Backup failed: ' + (e as Error).message); }
        await destroyWorker();
      }
    } catch (err) { logger.error('Monitor: ' + (err as Error).message); }
  }, pollMs);
}

export function stopMonitoring(): void {
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
}

export async function backupAndDestroy(): Promise<backup.BackupResult[]> {
  if (!workerInfo.ip) throw new Error('No worker');
  stopMonitoring();
  workerInfo.state = 'backing_up';
  const results: backup.BackupResult[] = [];
  for (const jobId of backup.listRemoteJobs(workerInfo.ip)) {
    try { const r = await backup.backupJob(workerInfo.ip, jobId); results.push(r); backupHistory.push(r); } catch (e) { logger.error('Backup ' + jobId + ': ' + (e as Error).message); }
  }
  await destroyWorker();
  return results;
}

export async function destroyWorker(): Promise<void> {
  if (!fisherConfig || !workerInfo.instanceId) { workerInfo.state = 'idle'; return; }
  workerInfo.state = 'destroying';
  monitor.stopHeartbeat(workerInfo.instanceId);
  try { await linode.deleteWorker(fisherConfig, workerInfo.instanceId); } catch (e) { logger.error('Destroy: ' + (e as Error).message); }
  workerInfo = { instanceId: null, ip: null, label: null, state: 'idle', currentJobId: null, createdAt: null, error: null };
}

export async function processFolder(driveFolderId: string, subfolderId: string): Promise<backup.BackupResult | null> {
  if (!fisherConfig) throw new Error('Fisher not initialized');
  logger.info('=== Fisher: processing folder ' + subfolderId + ' ===');
  const ip = await provisionWorker();

  const scanRes = await fetch('http://' + ip + ':3001/api/agents/yulieth/drive-scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId: driveFolderId }) });
  if (!scanRes.ok) throw new Error('Scan failed: ' + scanRes.status);
  await new Promise(r => setTimeout(r, 2000));

  const enqRes = await fetch('http://' + ip + ':3001/api/agents/yulieth/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderId: subfolderId }) });
  if (!enqRes.ok) throw new Error('Enqueue failed: ' + enqRes.status);
  const { jobId } = await enqRes.json() as { jobId: string };
  logger.info('Job ' + jobId + ' enqueued');

  return new Promise((resolve) => {
    workerInfo.currentJobId = jobId;
    const interval = setInterval(async () => {
      try {
        const s = backup.getRemoteJobStatus(ip, jobId);
        if (!s) return;
        logger.info('Job ' + jobId + ': ' + s.status);
        if (s.status === 'reviewing' || s.status === 'completed' || s.status === 'failed') {
          clearInterval(interval);
          workerInfo.state = 'backing_up';
          let result: backup.BackupResult | null = null;
          try { result = await backup.backupJob(ip, jobId); backupHistory.push(result); } catch (e) { logger.error('Backup: ' + (e as Error).message); }
          await destroyWorker();
          resolve(result);
        }
      } catch (e) { logger.error('Monitor: ' + (e as Error).message); }
    }, 30_000);
  });
}
