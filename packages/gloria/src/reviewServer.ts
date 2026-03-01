import express from 'express';
import cors from 'cors';
import { sql } from 'drizzle-orm';
import { createLogger, getEnvConfig, getDb } from '@transcriptor/shared';
import type { JobId, SectionId } from '@transcriptor/shared';

const logger = createLogger('gloria');

// ── Types ──
export interface DraftSummary {
  jobId: string;
  eventId: string;
  buildingName: string;
  status: string;
  createdAt: string;
  sectionCount: number;
  flagCount: number;
}

export interface DraftDetail {
  jobId: string;
  eventId: string;
  buildingName: string;
  status: string;
  sections: {
    sectionId: string;
    sectionTitle: string;
    content: object[];
    metadata: object;
    isApproved: boolean;
  }[];
  flags: string[];
}

export function startServer(port?: number): void {
  const app = express();
  const env = getEnvConfig();
  const serverPort = port || env.gloriaPort || 3001;

  app.use(cors());
  app.use(express.json());

  // ── Routes ──

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', agent: 'gloria', timestamp: new Date().toISOString() });
  });

  // List drafts pending review
  app.get('/api/drafts', async (_req, res) => {
    try {
      const drafts = await getDraftList();
      res.json(drafts);
    } catch (err) {
      logger.error('Error listing drafts', err as Error);
      res.status(500).json({ error: 'Failed to list drafts' });
    }
  });

  // Get draft detail
  app.get('/api/drafts/:jobId', async (req, res) => {
    try {
      const detail = await getDraftDetail(req.params.jobId as JobId);
      if (!detail) {
        return res.status(404).json({ error: 'Draft not found' });
      }
      res.json(detail);
    } catch (err) {
      logger.error('Error getting draft detail', err as Error);
      res.status(500).json({ error: 'Failed to get draft detail' });
    }
  });

  // Approve draft
  app.post('/api/drafts/:jobId/approve', async (req, res) => {
    try {
      await approveDraft(req.params.jobId as JobId);
      res.json({ status: 'approved' });
    } catch (err) {
      logger.error('Error approving draft', err as Error);
      res.status(500).json({ error: 'Failed to approve draft' });
    }
  });

  // Reject section
  app.post('/api/drafts/:jobId/sections/:sectionId/reject', async (req, res) => {
    try {
      const { comments } = req.body;
      await rejectSection(req.params.jobId as JobId, req.params.sectionId as SectionId, comments);
      res.json({ status: 'rejected' });
    } catch (err) {
      logger.error('Error rejecting section', err as Error);
      res.status(500).json({ error: 'Failed to reject section' });
    }
  });

  // ── Dashboard API endpoints ──

  // Agent statuses
  app.get('/api/agents/status', async (_req, res) => {
    try {
      const statuses = await getAgentStatuses();
      res.json(statuses);
    } catch (err) {
      logger.error('Error getting agent statuses', err as Error);
      res.status(500).json({ error: 'Failed to get agent statuses' });
    }
  });

  // Agent statistics (last 30 days)
  app.get('/api/agents/stats', async (_req, res) => {
    try {
      const stats = await getAgentStatistics();
      res.json(stats);
    } catch (err) {
      logger.error('Error getting agent stats', err as Error);
      res.status(500).json({ error: 'Failed to get agent stats' });
    }
  });

  // Pipeline overview
  app.get('/api/pipeline/overview', async (_req, res) => {
    try {
      const overview = await getPipelineOverview();
      res.json(overview);
    } catch (err) {
      logger.error('Error getting pipeline overview', err as Error);
      res.status(500).json({ error: 'Failed to get pipeline overview' });
    }
  });

  app.listen(serverPort, () => {
    logger.info(`Gloria review server running on http://localhost:${serverPort}`);
  });
}

export async function getDraftList(): Promise<DraftSummary[]> {
  logger.info('Fetching draft list');
  // TODO: Query database for pipeline jobs in 'reviewing' status
  return [];
}

export async function getDraftDetail(jobId: JobId): Promise<DraftDetail | null> {
  logger.info(`Fetching draft detail: ${jobId}`);
  // TODO: Query database for full draft data
  return null;
}

export async function approveDraft(jobId: JobId): Promise<void> {
  logger.info(`Approving draft: ${jobId}`);
  // TODO: Update pipeline status, trigger final delivery
}

export async function rejectSection(jobId: JobId, sectionId: SectionId, comments: string): Promise<void> {
  logger.info(`Rejecting section ${sectionId} of job ${jobId}: ${comments}`);
  // TODO: Mark section for re-processing, update pipeline
}

export async function getAudioSegment(
  _jobId: JobId,
  _startTime: number,
  _endTime: number,
): Promise<Buffer> {
  logger.info('Audio segment streaming not yet implemented');
  return Buffer.alloc(0);
}

// ── Dashboard data providers ──

type AgentId = 'yulieth' | 'robinson' | 'chucho' | 'jaime' | 'lina' | 'fannery' | 'gloria' | 'supervisor';

interface AgentStatusInfo {
  agentId: AgentId;
  state: 'idle' | 'processing' | 'error';
  currentJob: string | null;
  currentEvent: string | null;
  lastActivity: string | null;
  uptime: number;
}

interface AgentStatsInfo {
  agentId: AgentId;
  last30Days: {
    jobsProcessed: number;
    jobsFailed: number;
    averageDurationMs: number;
    totalDurationMs: number;
  };
  today: {
    jobsProcessed: number;
    jobsFailed: number;
  };
}

interface PipelineOverviewInfo {
  activeJobs: number;
  completedJobs: number;
  failedJobs: number;
  queuedJobs: number;
  recentJobs: {
    jobId: string;
    eventId: string;
    buildingName: string;
    status: string;
    currentStage: string;
    createdAt: string;
    updatedAt: string;
  }[];
}

const AGENT_IDS: AgentId[] = ['yulieth', 'robinson', 'chucho', 'jaime', 'lina', 'fannery', 'gloria', 'supervisor'];
const serverStartTime = Date.now();

async function getAgentStatuses(): Promise<AgentStatusInfo[]> {
  logger.info('Fetching agent statuses');
  const db = getDb();
  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);

  // Query active pipeline jobs to determine which agents are currently processing
  const activeJobs = await db.execute(sql`
    SELECT pj.job_id, pj.event_id, pj.status AS current_stage, pj.updated_at, e.building_name
    FROM pipeline_jobs pj
    LEFT JOIN events e ON pj.event_id = e.event_id
    WHERE pj.status NOT IN ('completed', 'failed')
    ORDER BY pj.updated_at DESC
  `);

  // Map pipeline stages to agents
  const stageToAgent: Record<string, AgentId> = {
    detected: 'yulieth',
    queued: 'yulieth',
    preprocessing: 'chucho',
    transcribing: 'jaime',
    sectioning: 'jaime',
    redacting: 'lina',
    assembling: 'fannery',
    reviewing: 'gloria',
  };

  const activeAgents = new Map<AgentId, { jobId: string; eventId: string; updatedAt: string }>();
  for (const r of activeJobs.rows) {
    const agent = stageToAgent[r.current_stage as string];
    if (agent && !activeAgents.has(agent)) {
      activeAgents.set(agent, {
        jobId: r.job_id as string,
        eventId: r.event_id as string,
        updatedAt: r.updated_at as string,
      });
    }
  }

  return AGENT_IDS.map((id) => {
    const active = activeAgents.get(id);
    return {
      agentId: id,
      state: active ? 'processing' as const : 'idle' as const,
      currentJob: active?.jobId ?? null,
      currentEvent: active?.eventId ?? null,
      lastActivity: active?.updatedAt ?? null,
      uptime: uptimeSeconds,
    };
  });
}

async function getAgentStatistics(): Promise<AgentStatsInfo[]> {
  logger.info('Fetching agent statistics');
  const db = getDb();

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // Query completed pipeline jobs per stage
  const monthlyRows = await db.execute(sql`
    SELECT
      pj.status AS final_status,
      pj.created_at,
      pj.updated_at,
      e.building_name
    FROM pipeline_jobs pj
    LEFT JOIN events e ON pj.event_id = e.event_id
    WHERE pj.created_at >= ${thirtyDaysAgo}
    ORDER BY pj.created_at DESC
  `);

  const monthlyResult = monthlyRows.rows as unknown as { final_status: string; created_at: string; updated_at: string; building_name: string }[];

  // For now, distribute job counts across agents based on completed stages
  const totalCompleted = monthlyResult.filter((r) => r.final_status === 'completed').length;
  const totalFailed = monthlyResult.filter((r) => r.final_status === 'failed').length;
  const todayCompleted = monthlyResult.filter(
    (r) => r.final_status === 'completed' && new Date(r.created_at) >= todayStart
  ).length;
  const todayFailed = monthlyResult.filter(
    (r) => r.final_status === 'failed' && new Date(r.created_at) >= todayStart
  ).length;

  // Each completed pipeline traverses all agents, so each agent processed the same count
  return AGENT_IDS.map((id) => ({
    agentId: id,
    last30Days: {
      jobsProcessed: id === 'supervisor' ? totalCompleted + totalFailed : totalCompleted,
      jobsFailed: id === 'supervisor' ? 0 : totalFailed,
      averageDurationMs: 0, // TODO: calculate from stage timestamps
      totalDurationMs: 0,
    },
    today: {
      jobsProcessed: id === 'supervisor' ? todayCompleted + todayFailed : todayCompleted,
      jobsFailed: id === 'supervisor' ? 0 : todayFailed,
    },
  }));
}

async function getPipelineOverview(): Promise<PipelineOverviewInfo> {
  logger.info('Fetching pipeline overview');
  const db = getDb();

  const countsRows = await db.execute(sql`
    SELECT status, COUNT(*)::int AS count FROM pipeline_jobs GROUP BY status
  `);

  const counts: Record<string, number> = {};
  for (const r of countsRows.rows) {
    counts[r.status as string] = r.count as number;
  }

  const activeStatuses = ['preprocessing', 'transcribing', 'sectioning', 'redacting', 'assembling'];
  const activeJobs = activeStatuses.reduce((sum, s) => sum + (counts[s] || 0), 0);

  const recentRows = await db.execute(sql`
    SELECT pj.job_id, pj.event_id, pj.status, pj.created_at, pj.updated_at,
           e.building_name
    FROM pipeline_jobs pj
    LEFT JOIN events e ON pj.event_id = e.event_id
    ORDER BY pj.updated_at DESC
    LIMIT 10
  `);

  return {
    activeJobs,
    completedJobs: counts['completed'] || 0,
    failedJobs: counts['failed'] || 0,
    queuedJobs: (counts['detected'] || 0) + (counts['queued'] || 0),
    recentJobs: recentRows.rows.map((r) => ({
      jobId: r.job_id as string,
      eventId: r.event_id as string,
      buildingName: (r.building_name as string) || 'Unknown',
      status: r.status as string,
      currentStage: r.status as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    })),
  };
}
