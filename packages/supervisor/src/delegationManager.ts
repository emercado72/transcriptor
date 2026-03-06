/**
 * Delegation Manager — handles delegating pipeline jobs to remote GPU workers.
 *
 * When the local Supervisor receives a `files_ready` event and RUNTIME_MODE=local,
 * it asks Fisher for a GPU worker, delegates the job to the remote Supervisor,
 * and polls for progress until the remote pipeline completes.
 *
 * Loop prevention: on the remote GPU worker (RUNTIME_MODE=gpu-worker), Fisher
 * is not registered and shouldDelegate() returns false, so the remote Supervisor
 * dispatches agents directly — no delegation loop.
 */

import { createLogger, EventStatus, JobStatus, publishSuccess, publishFailure } from '@transcriptor/shared';
import type { PipelineJob, DelegationInfo, StageStatus } from '@transcriptor/shared';
import * as stateManager from './stateManager.js';
import * as supervisorService from './supervisorService.js';

const logger = createLogger('supervisor:delegation');

// Active polling intervals, keyed by localJobId
const activePollers = new Map<string, ReturnType<typeof setInterval>>();

interface DelegationPayload {
  driveFolderId: string;
  subfolderId: string;
  localJobId: string;
  idAsamblea?: number;
  clientName?: string;
  eventId: string;
}

// ── Core delegation ──

/**
 * Delegate a job to a remote GPU worker.
 *
 * 1. Insert DELEGATING/DELEGATED stages into job
 * 2. Mark job as DELEGATING
 * 3. Ask Fisher to ensure a worker is ready
 * 4. POST to remote /api/pipeline/delegate
 * 5. Mark job as DELEGATED + start polling
 */
export async function delegateJob(jobId: string, driveFolderId: string): Promise<void> {
  const job = await stateManager.loadState(jobId);
  const subfolderId = job.eventId;
  const now = new Date().toISOString();

  // 1. Insert delegation stages after QUEUED
  const delegatingStage: StageStatus = {
    stage: EventStatus.DELEGATING,
    status: JobStatus.PROCESSING,
    agentName: 'fisher',
    startedAt: now,
    completedAt: null,
    error: null,
  };
  const delegatedStage: StageStatus = {
    stage: EventStatus.DELEGATED,
    status: JobStatus.PENDING,
    agentName: 'supervisor',
    startedAt: null,
    completedAt: null,
    error: null,
  };

  const queuedIdx = job.stages.findIndex(s => s.stage === EventStatus.QUEUED);
  job.stages.splice(queuedIdx + 1, 0, delegatingStage, delegatedStage);

  // 2. Mark as DELEGATING
  job.status = EventStatus.DELEGATING;
  job.updatedAt = now;
  await stateManager.saveState(jobId, job);
  logger.info(`Job ${jobId}: DELEGATING — requesting GPU worker from Fisher`);

  try {
    // 3. Ask Fisher for a worker
    const fisher = await import('@transcriptor/fisher');
    const workerIp = await fisher.ensureWorker();
    logger.info(`Job ${jobId}: GPU worker ready at ${workerIp}`);

    // 4. POST to remote /api/pipeline/delegate
    const payload: DelegationPayload = {
      driveFolderId,
      subfolderId,
      localJobId: jobId,
      idAsamblea: job.idAsamblea,
      clientName: job.clientName,
      eventId: job.eventId,
    };

    const res = await fetch(`http://${workerIp}:3001/api/pipeline/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`Remote delegation failed: HTTP ${res.status} — ${(errBody as { error: string }).error}`);
    }

    const { remoteJobId } = await res.json() as { ok: boolean; remoteJobId: string };

    // 5. Mark as DELEGATED
    const delegationInfo: DelegationInfo = {
      workerIp,
      remoteJobId,
      localJobId: jobId,
      delegatedAt: new Date().toISOString(),
      lastPollAt: null,
      remoteStatus: EventStatus.QUEUED,
      remoteStages: [],
      pollFailures: 0,
    };

    const updatedJob = await stateManager.loadState(jobId);

    // Mark DELEGATING stage complete
    const delegatingEntry = updatedJob.stages.find(s => s.stage === EventStatus.DELEGATING);
    if (delegatingEntry) {
      delegatingEntry.status = JobStatus.COMPLETED;
      delegatingEntry.completedAt = new Date().toISOString();
    }

    // Advance to DELEGATED
    const delegatedEntry = updatedJob.stages.find(s => s.stage === EventStatus.DELEGATED);
    if (delegatedEntry) {
      delegatedEntry.status = JobStatus.PROCESSING;
      delegatedEntry.startedAt = new Date().toISOString();
    }

    updatedJob.status = EventStatus.DELEGATED;
    updatedJob.delegationInfo = delegationInfo;
    updatedJob.updatedAt = new Date().toISOString();
    await stateManager.saveState(jobId, updatedJob);

    logger.info(`Job ${jobId}: DELEGATED to ${workerIp} as remote job ${remoteJobId}`);

    // 6. Start polling for remote progress
    startProgressPoller(jobId, workerIp, remoteJobId);

    await publishSuccess('delegation_started', jobId, 'supervisor', {
      workerIp,
      remoteJobId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Job ${jobId}: delegation failed — ${msg}`);

    // Mark DELEGATING as failed
    const failedJob = await stateManager.loadState(jobId);
    const delegatingEntry = failedJob.stages.find(s => s.stage === EventStatus.DELEGATING);
    if (delegatingEntry) {
      delegatingEntry.status = JobStatus.FAILED;
      delegatingEntry.error = msg;
      delegatingEntry.completedAt = new Date().toISOString();
    }
    failedJob.status = EventStatus.FAILED;
    failedJob.updatedAt = new Date().toISOString();
    await stateManager.saveState(jobId, failedJob);

    await publishFailure('delegation_failed', jobId, 'supervisor', msg);
  }
}

// ── Progress polling ──

function startProgressPoller(
  localJobId: string,
  workerIp: string,
  remoteJobId: string,
): void {
  let pollCount = 0;

  const getPollInterval = (): number => {
    if (pollCount < 10) return 30_000;    // First 5 min: every 30s
    if (pollCount < 25) return 60_000;    // Next 15 min: every 60s
    return 120_000;                        // After 20 min: every 120s
  };

  const poll = async (): Promise<void> => {
    pollCount++;
    try {
      const res = await fetch(
        `http://${workerIp}:3001/api/pipeline/${remoteJobId}`,
        { signal: AbortSignal.timeout(10_000) },
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const remoteJob = await res.json() as PipelineJob;

      // Update local state with remote progress
      const localJob = await stateManager.loadState(localJobId);
      if (localJob.delegationInfo) {
        localJob.delegationInfo.lastPollAt = new Date().toISOString();
        localJob.delegationInfo.remoteStatus = remoteJob.status as EventStatus;
        localJob.delegationInfo.remoteStages = remoteJob.stages;
        localJob.delegationInfo.pollFailures = 0;
        localJob.updatedAt = new Date().toISOString();
        await stateManager.saveState(localJobId, localJob);
      }

      logger.info(
        `Job ${localJobId} poll #${pollCount}: remote status=${remoteJob.status}`,
      );

      // Check for terminal states
      if (remoteJob.status === EventStatus.COMPLETED) {
        stopProgressPoller(localJobId);

        const finishedJob = await stateManager.loadState(localJobId);
        const delegatedEntry = finishedJob.stages.find(s => s.stage === EventStatus.DELEGATED);
        if (delegatedEntry) {
          delegatedEntry.status = JobStatus.COMPLETED;
          delegatedEntry.completedAt = new Date().toISOString();
        }
        finishedJob.status = EventStatus.COMPLETED;
        finishedJob.updatedAt = new Date().toISOString();
        await stateManager.saveState(localJobId, finishedJob);

        await publishSuccess('delegation_completed', localJobId, 'supervisor', {
          remoteJobId,
          workerIp,
        });
        logger.info(`🎉 Job ${localJobId}: remote pipeline COMPLETED`);
        return;
      }

      if (remoteJob.status === EventStatus.FAILED) {
        stopProgressPoller(localJobId);

        const failedStage = remoteJob.stages.find(s => s.status === JobStatus.FAILED);
        const errorMsg = failedStage?.error || 'Remote pipeline failed';

        const failedJob = await stateManager.loadState(localJobId);
        const delegatedEntry = failedJob.stages.find(s => s.stage === EventStatus.DELEGATED);
        if (delegatedEntry) {
          delegatedEntry.status = JobStatus.FAILED;
          delegatedEntry.error = errorMsg;
          delegatedEntry.completedAt = new Date().toISOString();
        }
        failedJob.status = EventStatus.FAILED;
        failedJob.updatedAt = new Date().toISOString();
        await stateManager.saveState(localJobId, failedJob);

        await publishFailure('delegation_failed', localJobId, 'supervisor', errorMsg, {
          remoteJobId,
          workerIp,
          failedStage: failedStage?.stage,
        });
        logger.error(`Job ${localJobId}: remote pipeline FAILED — ${errorMsg}`);
        return;
      }
    } catch (err) {
      // Poll failure — track consecutive failures
      try {
        const localJob = await stateManager.loadState(localJobId);
        if (localJob.delegationInfo) {
          localJob.delegationInfo.pollFailures++;
          localJob.delegationInfo.lastPollAt = new Date().toISOString();
          await stateManager.saveState(localJobId, localJob);

          if (localJob.delegationInfo.pollFailures >= 5) {
            stopProgressPoller(localJobId);
            logger.error(`Job ${localJobId}: 5 consecutive poll failures — marking as failed`);

            const delegatedEntry = localJob.stages.find(s => s.stage === EventStatus.DELEGATED);
            if (delegatedEntry) {
              delegatedEntry.status = JobStatus.FAILED;
              delegatedEntry.error = 'Lost connection to remote worker';
              delegatedEntry.completedAt = new Date().toISOString();
            }
            localJob.status = EventStatus.FAILED;
            localJob.updatedAt = new Date().toISOString();
            await stateManager.saveState(localJobId, localJob);

            await publishFailure('delegation_failed', localJobId, 'supervisor',
              'Lost connection to remote worker after 5 poll failures',
              { remoteJobId, workerIp },
            );
            return;
          }
        }
      } catch {
        // State read failed — log and continue
      }
      logger.warn(`Job ${localJobId}: poll failed (${(err as Error).message})`);
    }

    // Schedule next poll with progressive backoff
    if (activePollers.has(localJobId)) {
      clearInterval(activePollers.get(localJobId)!);
      const nextInterval = getPollInterval();
      const interval = setInterval(poll, nextInterval);
      activePollers.set(localJobId, interval);
    }
  };

  // Start with first poll interval
  const interval = setInterval(poll, getPollInterval());
  activePollers.set(localJobId, interval);

  // Immediate first poll
  void poll();
}

function stopProgressPoller(localJobId: string): void {
  const interval = activePollers.get(localJobId);
  if (interval) {
    clearInterval(interval);
    activePollers.delete(localJobId);
    logger.info(`Stopped polling for job ${localJobId}`);
  }
}

// ── Startup / shutdown ──

/**
 * Restore pollers for delegated jobs after a restart.
 * Called during Supervisor startup in local mode.
 */
export async function restoreDelegationPollers(): Promise<void> {
  const activeJobs = await stateManager.listActiveJobs();
  let restored = 0;
  for (const jobId of activeJobs) {
    try {
      const job = await stateManager.loadState(jobId);
      if (job.status === EventStatus.DELEGATED && job.delegationInfo) {
        logger.info(`Restoring poller for delegated job ${jobId} → ${job.delegationInfo.workerIp}`);
        startProgressPoller(
          jobId,
          job.delegationInfo.workerIp,
          job.delegationInfo.remoteJobId,
        );
        restored++;
      }
    } catch {
      // Skip unreadable jobs
    }
  }
  if (restored > 0) {
    logger.info(`Restored ${restored} delegation poller(s)`);
  }
}

/**
 * Stop all active pollers (for graceful shutdown).
 */
export function stopAllPollers(): void {
  for (const [jobId] of activePollers) {
    stopProgressPoller(jobId);
  }
}

/**
 * Check if delegation should happen for the current runtime mode.
 */
export function shouldDelegate(): boolean {
  const mode = process.env.RUNTIME_MODE || 'local';
  if (mode !== 'local') return false;

  const delegateEnabled = process.env.DELEGATE_TO_GPU !== 'false';
  return delegateEnabled;
}
