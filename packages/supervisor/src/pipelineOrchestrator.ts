/**
 * Pipeline Orchestrator — Supervisor's event loop.
 *
 * Polls the supervisor:event_queue for agent completion/failure events
 * and dispatches the next step in the pipeline.
 *
 * This is the ONLY place that decides "what happens next" in a pipeline.
 * Agents just do their work and report back — they never call each other.
 */

import { createLogger, popEvent, EventStatus, JobStatus } from '@transcriptor/shared';
import type { PipelineEvent, PipelineEventType } from '@transcriptor/shared';
import * as stateManager from './stateManager.js';
import * as supervisorService from './supervisorService.js';

const logger = createLogger('supervisor:orchestrator');

let running = false;
let loopPromise: Promise<void> | null = null;

// ── Agent dispatch registry ──
// Maps pipeline stages to the function that kicks off the responsible agent.
// Each dispatcher receives (jobId) and should start the agent's work asynchronously.

type AgentDispatcher = (jobId: string) => Promise<void>;
const dispatchers = new Map<EventStatus, AgentDispatcher>();

// Tracks currently in-flight dispatches to prevent duplicate runs.
// Key format: "jobId::stage"
const inFlightDispatches = new Set<string>();
function dispatchKey(jobId: string, stage: EventStatus): string {
  return `${jobId}::${stage}`;
}

/**
 * Register an agent dispatcher for a pipeline stage.
 * Called by Gloria's reviewServer at startup to wire agents.
 */
export function registerDispatcher(stage: EventStatus, dispatcher: AgentDispatcher): void {
  dispatchers.set(stage, dispatcher);
  logger.info(`Dispatcher registered for stage: ${stage}`);
}

// ── Event → next stage mapping ──

const EVENT_TO_NEXT_STAGE: Record<string, EventStatus | null> = {
  'files_ready': EventStatus.PREPROCESSING,
  'preprocessing_done': EventStatus.TRANSCRIBING,
  'transcription_done': EventStatus.REDACTING,
  'redaction_done': EventStatus.ASSEMBLING,
  'assembly_done': EventStatus.REVIEWING,
  'review_done': EventStatus.COMPLETED,
};

const EVENT_TO_CURRENT_STAGE: Record<string, EventStatus> = {
  'files_ready': EventStatus.QUEUED,
  'preprocessing_done': EventStatus.PREPROCESSING,
  'preprocessing_failed': EventStatus.PREPROCESSING,
  'transcription_done': EventStatus.TRANSCRIBING,
  'transcription_failed': EventStatus.TRANSCRIBING,
  'redaction_done': EventStatus.REDACTING,
  'redaction_failed': EventStatus.REDACTING,
  'assembly_done': EventStatus.ASSEMBLING,
  'assembly_failed': EventStatus.ASSEMBLING,
  'review_done': EventStatus.REVIEWING,
  'review_failed': EventStatus.REVIEWING,
};

// ── Event handlers ──

async function handleEvent(event: PipelineEvent): Promise<void> {
  const { type, jobId, agent, error, data } = event;

  logger.info(`Processing event: ${type} for job ${jobId} from ${agent}`);

  try {
    // Handle failure events
    if (type.endsWith('_failed')) {
      const currentStage = EVENT_TO_CURRENT_STAGE[type];
      if (currentStage) {
        await supervisorService.markStageFailed(jobId, currentStage, error || 'Unknown error');
        logger.error(`Pipeline ${jobId}: ${currentStage} FAILED — ${error}`);
      }
      return;
    }

    // Handle success events — mark current stage complete, advance to next
    const currentStage = EVENT_TO_CURRENT_STAGE[type];
    const nextStage = EVENT_TO_NEXT_STAGE[type];

    if (currentStage) {
      await supervisorService.markStageComplete(jobId, currentStage);

      // Special case: Jaime does transcription AND sectioning in one step
      if (type === 'transcription_done') {
        await supervisorService.advanceStage(jobId, EventStatus.SECTIONING);
        await supervisorService.markStageComplete(jobId, EventStatus.SECTIONING);
      }
    }

    if (nextStage === EventStatus.COMPLETED) {
      // Pipeline is done
      await supervisorService.advanceStage(jobId, EventStatus.COMPLETED);
      await supervisorService.markStageComplete(jobId, EventStatus.COMPLETED);
      logger.info(`🎉 Pipeline ${jobId} COMPLETED`);
      return;
    }

    if (nextStage) {
      // Advance pipeline and dispatch next agent
      await supervisorService.advanceStage(jobId, nextStage);

      const dKey = dispatchKey(jobId, nextStage);
      if (inFlightDispatches.has(dKey)) {
        logger.warn(`Dispatch skipped: ${nextStage} already in-flight for job ${jobId}`);
      } else {
        const dispatcher = dispatchers.get(nextStage);
        if (dispatcher) {
          inFlightDispatches.add(dKey);
          logger.info(`Dispatching ${nextStage} for job ${jobId}`);
          // Run the agent asynchronously — don't await (it may take hours)
          void dispatcher(jobId)
            .catch(async (err) => {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error(`Dispatcher for ${nextStage} failed for job ${jobId}: ${msg}`);
              await supervisorService.markStageFailed(jobId, nextStage, `Dispatch error: ${msg}`);
            })
            .finally(() => inFlightDispatches.delete(dKey));
        } else {
          logger.warn(`No dispatcher registered for stage ${nextStage} — pipeline ${jobId} stalled`);
        }
      }
    }

    // Handle retry events
    if (type === 'job_retry') {
      const retryStage = data?.stage as EventStatus | undefined;
      if (retryStage) {
        const rKey = dispatchKey(jobId, retryStage);
        if (inFlightDispatches.has(rKey)) {
          logger.warn(`Retry skipped: ${retryStage} already in-flight for job ${jobId}`);
        } else {
          await supervisorService.retryStage(jobId, retryStage);
          const dispatcher = dispatchers.get(retryStage);
          if (dispatcher) {
            inFlightDispatches.add(rKey);
            logger.info(`Retrying ${retryStage} for job ${jobId}`);
            void dispatcher(jobId)
              .catch(async (err) => {
                const msg = err instanceof Error ? err.message : String(err);
                await supervisorService.markStageFailed(jobId, retryStage, `Retry failed: ${msg}`);
              })
              .finally(() => inFlightDispatches.delete(rKey));
          }
        }
      }
    }
  } catch (err) {
    logger.error(`Error handling event ${type} for ${jobId}: ${(err as Error).message}`);
  }
}

// ── Event loop ──

/**
 * Start the supervisor event loop.
 * Polls Redis for agent events and dispatches pipeline steps.
 */
export function startOrchestrator(): void {
  if (running) {
    logger.warn('Orchestrator already running');
    return;
  }

  running = true;
  logger.info('🚀 Supervisor orchestrator started — listening for agent events');

  loopPromise = (async () => {
    while (running) {
      try {
        const event = await popEvent(5); // 5s timeout
        if (event) {
          await handleEvent(event);
        }
      } catch (err) {
        logger.error(`Event loop error: ${(err as Error).message}`);
        // Brief backoff on errors
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    logger.info('Supervisor orchestrator stopped');
  })();
}

/**
 * Stop the orchestrator gracefully.
 */
export async function stopOrchestrator(): Promise<void> {
  running = false;
  if (loopPromise) {
    await loopPromise;
    loopPromise = null;
  }
  logger.info('Orchestrator shutdown complete');
}

/**
 * Check if the orchestrator is running.
 */
export function isOrchestratorRunning(): boolean {
  return running;
}

/**
 * Get a Kanban-style view of all active pipelines.
 * Groups jobs by their current stage.
 */
export async function getKanbanBoard(): Promise<KanbanBoard> {
  const allJobIds = await stateManager.listActiveJobs();
  const columns: KanbanColumn[] = KANBAN_STAGES.map(stage => ({
    stage,
    label: STAGE_LABELS[stage] || stage,
    agent: STAGE_AGENTS[stage] || 'unknown',
    jobs: [],
  }));

  const columnMap = new Map(columns.map(c => [c.stage, c]));

  for (const jobId of allJobIds) {
    try {
      const job = await stateManager.loadState(jobId);
      const card: KanbanCard = {
        jobId: job.jobId,
        eventId: job.eventId,
        clientName: job.clientName,
        status: job.status,
        currentStage: job.status,
        stages: job.stages,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        currentStageStatus: 'pending',
        error: null,
        elapsedMs: Date.now() - new Date(job.createdAt).getTime(),
      };

      // Find the current stage's status
      const currentStageEntry = job.stages.find(s => s.stage === job.status);
      if (currentStageEntry) {
        card.currentStageStatus = currentStageEntry.status;
        card.error = currentStageEntry.error;
        if (currentStageEntry.startedAt) {
          card.stageElapsedMs = Date.now() - new Date(currentStageEntry.startedAt).getTime();
        }
      }

      // Place in the right column
      const col = columnMap.get(job.status);
      if (col) {
        col.jobs.push(card);
      } else {
        // Failed jobs go in a special column
        const failedCol = columnMap.get(EventStatus.FAILED);
        if (failedCol) failedCol.jobs.push(card);
      }
    } catch {
      // Skip unreadable jobs
    }
  }

  return {
    columns: columns.filter(c => c.jobs.length > 0 || ALWAYS_SHOW_STAGES.has(c.stage)),
    orchestratorRunning: running,
    timestamp: new Date().toISOString(),
  };
}

// ── Kanban types ──

export interface KanbanCard {
  jobId: string;
  eventId: string;
  status: EventStatus | string;
  currentStage: EventStatus | string;
  stages: Array<{
    stage: string;
    status: string;
    agentName: string;
    startedAt: string | null;
    completedAt: string | null;
    error: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
  currentStageStatus: string;
  error: string | null;
  elapsedMs: number;
  stageElapsedMs?: number;
  clientName?: string;
}

export interface KanbanColumn {
  stage: EventStatus;
  label: string;
  agent: string;
  jobs: KanbanCard[];
}

export interface KanbanBoard {
  columns: KanbanColumn[];
  orchestratorRunning: boolean;
  timestamp: string;
}

// ── Stage metadata ──

const KANBAN_STAGES = [
  EventStatus.QUEUED,
  EventStatus.PREPROCESSING,
  EventStatus.TRANSCRIBING,
  EventStatus.SECTIONING,
  EventStatus.REDACTING,
  EventStatus.ASSEMBLING,
  EventStatus.REVIEWING,
  EventStatus.COMPLETED,
  EventStatus.FAILED,
];

const ALWAYS_SHOW_STAGES = new Set([
  EventStatus.PREPROCESSING,
  EventStatus.TRANSCRIBING,
  EventStatus.REDACTING,
  EventStatus.ASSEMBLING,
  EventStatus.REVIEWING,
  EventStatus.COMPLETED,
]);

const STAGE_LABELS: Record<string, string> = {
  [EventStatus.DETECTED]: '🔍 Detected',
  [EventStatus.QUEUED]: '📥 Queued',
  [EventStatus.PREPROCESSING]: '🎛️ Chucho - Preprocessing',
  [EventStatus.TRANSCRIBING]: '🎤 Jaime - Transcribing',
  [EventStatus.SECTIONING]: '📋 Jaime - Sectioning',
  [EventStatus.REDACTING]: '✍️ Lina - Redacting',
  [EventStatus.ASSEMBLING]: '📄 Fannery - Assembling',
  [EventStatus.REVIEWING]: '👁️ Gloria - Reviewing',
  [EventStatus.COMPLETED]: '✅ Completed',
  [EventStatus.FAILED]: '❌ Failed',
};

const STAGE_AGENTS: Record<string, string> = {
  [EventStatus.DETECTED]: 'yulieth',
  [EventStatus.QUEUED]: 'yulieth',
  [EventStatus.PREPROCESSING]: 'chucho',
  [EventStatus.TRANSCRIBING]: 'jaime',
  [EventStatus.SECTIONING]: 'jaime',
  [EventStatus.REDACTING]: 'lina',
  [EventStatus.ASSEMBLING]: 'fannery',
  [EventStatus.REVIEWING]: 'gloria',
  [EventStatus.COMPLETED]: 'supervisor',
  [EventStatus.FAILED]: 'supervisor',
};
