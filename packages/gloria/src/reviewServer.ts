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

  // ── Agent Chat endpoint ──
  app.post('/api/agents/:agentId/chat', async (req, res) => {
    try {
      const { agentId } = req.params;
      const { message } = req.body as { message: string };
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message is required' });
      }
      const reply = await handleAgentChat(agentId, message);
      res.json({ reply });
    } catch (err) {
      logger.error('Error in agent chat', err as Error);
      res.status(500).json({ error: 'Chat request failed' });
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

// ── Agent Chat handler ──

async function handleAgentChat(agentId: string, message: string): Promise<string> {
  logger.info(`Chat request for agent ${agentId}: ${message.substring(0, 100)}`);

  switch (agentId) {
    case 'robinson':
      return handleRobinsonChat(message);
    case 'yulieth':
      return handleGenericChat('Yulieth', 'Drive Watcher & Job Queue', message);
    case 'chucho':
      return handleGenericChat('Chucho', 'Audio Preprocessor', message);
    case 'jaime':
      return handleGenericChat('Jaime', 'Transcription & Sectioning', message);
    case 'lina':
      return handleGenericChat('Lina', 'AI Redaction Engine', message);
    case 'fannery':
      return handleGenericChat('Fannery', 'Document Assembly', message);
    case 'gloria':
      return handleGloriaChat(message);
    case 'supervisor':
      return handleSupervisorChat(message);
    default:
      return `Unknown agent: ${agentId}`;
  }
}

// ── Robinson: live queries against Tecnoreuniones ──

async function handleRobinsonChat(message: string): Promise<string> {
  // Dynamic import to avoid circular dependency at module load time
  const adapter = await import('@transcriptor/robinson');
  const {
    callService,
    fetchActiveAssemblies,
    fetchAssemblyMetadata,
    fetchAttendanceList,
    fetchQuestionList,
    fetchVotingResults,
    fetchAssemblyStatus,
    fetchAdminInfo,
    fetchQuorumSnapshot,
    fetchVotingScrutiny,
    adminLogin,
    setAssemblyContext,
    getToken,
    mapAttendance,
  } = adapter;

  const msg = message.toLowerCase();

  try {
    // ── Active assemblies ──
    if (msg.includes('active') && (msg.includes('assembl') || msg.includes('asamblea'))) {
      const assemblies = await fetchActiveAssemblies();
      if (!assemblies.length) return 'No active assemblies found at this time.';
      const lines = assemblies.map((a: Record<string, unknown>) =>
        `• **${a.cliente}** (ID: ${a.idAsamblea}, logo: ${a.logo})`
      );
      return `Found ${assemblies.length} active assemblies:\n\n${lines.join('\n')}`;
    }

    // ── Login ──
    if (msg.includes('login') || msg.includes('log in') || msg.includes('authenticate')) {
      const userMatch = message.match(/user(?:name)?[:\s]+(\S+)/i);
      const usuario = userMatch?.[1] || 'admin';
      const result = await adminLogin(usuario);
      return `✅ Logged in successfully.\n\n• Assembly ID: **${result.idAsamblea}**\n• Token: \`${result.token.substring(0, 20)}…\``;
    }

    // ── Assembly metadata ──
    if (msg.includes('metadata') || msg.includes('info') || msg.includes('assembly') || msg.includes('asamblea')) {
      const idMatch = message.match(/(?:id|asamblea|assembly)\s*[:#]?\s*(\d+)/i);
      if (!idMatch) return 'Please specify an assembly ID. Example: "assembly info id 123"';
      const id = Number(idMatch[1]);
      let token: string;
      try { token = getToken(); } catch { await adminLogin('admin'); }
      setAssemblyContext(id);
      const meta = await fetchAssemblyMetadata(id);
      const fields = Object.entries(meta)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `• **${k}**: ${v}`)
        .join('\n');
      return `Assembly **${id}** metadata:\n\n${fields}`;
    }

    // ── Attendance ──
    if (msg.includes('attendance') || msg.includes('attendees') || msg.includes('asistentes') || msg.includes('delegate')) {
      const idMatch = message.match(/(?:id|asamblea|assembly)\s*[:#]?\s*(\d+)/i);
      if (!idMatch) return 'Please specify an assembly ID. Example: "attendance for assembly 123"';
      const id = Number(idMatch[1]);
      try { getToken(); } catch { await adminLogin('admin'); }
      setAssemblyContext(id);
      const raw = await fetchAttendanceList(id);
      const records = mapAttendance(raw);
      if (!records.length) return `No attendance records found for assembly ${id}.`;
      const present = records.filter((r) => r.status !== 'absent');
      const absent = records.filter((r) => r.status === 'absent');
      const lines = present.slice(0, 20).map((r) =>
        `• ${r.ownerName} (${r.unit}) — ${r.status} — coef: ${r.coefficientExpected}`
      );
      let reply = `Assembly **${id}** attendance: **${present.length}** present, **${absent.length}** absent, **${records.length}** total.\n\n${lines.join('\n')}`;
      if (present.length > 20) reply += `\n\n…and ${present.length - 20} more.`;
      return reply;
    }

    // ── Quorum ──
    if (msg.includes('quorum') || msg.includes('status')) {
      const idMatch = message.match(/(?:id|asamblea|assembly)\s*[:#]?\s*(\d+)/i);
      if (!idMatch) return 'Please specify an assembly ID. Example: "quorum for assembly 123"';
      const id = Number(idMatch[1]);
      try { getToken(); } catch { await adminLogin('admin'); }
      setAssemblyContext(id);
      const status = await fetchAssemblyStatus(id);
      const fields = Object.entries(status)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `• **${k}**: ${v}`)
        .join('\n');
      return `Assembly **${id}** status:\n\n${fields}`;
    }

    // ── Questions ──
    if (msg.includes('question') || msg.includes('pregunta') || msg.includes('voting') || msg.includes('votaci')) {
      const idMatch = message.match(/(?:id|asamblea|assembly)\s*[:#]?\s*(\d+)/i);
      if (!idMatch) return 'Please specify an assembly ID. Example: "questions for assembly 123"';
      const id = Number(idMatch[1]);
      try { getToken(); } catch { await adminLogin('admin'); }
      setAssemblyContext(id);
      const questions = await fetchQuestionList(id);
      if (!questions.length) return `No questions found for assembly ${id}.`;
      const lines = questions.map((q: Record<string, unknown>) =>
        `• **Q${q.idPregunta}**: ${q.encabezadoPregunta} (options: ${q.opciones}, active: ${q.activa ? 'yes' : 'no'})`
      );
      return `Assembly **${id}** has ${questions.length} questions:\n\n${lines.join('\n')}`;
    }

    // ── Voting results ──
    if (msg.includes('result') || msg.includes('resultado') || msg.includes('scrutiny') || msg.includes('escrutinio')) {
      const asmMatch = message.match(/(?:asamblea|assembly)\s*[:#]?\s*(\d+)/i);
      const qMatch = message.match(/(?:question|pregunta|q)\s*[:#]?\s*(\d+)/i);
      if (!asmMatch) return 'Please specify an assembly ID. Example: "results for assembly 123 question 1"';
      const asmId = Number(asmMatch[1]);
      try { getToken(); } catch { await adminLogin('admin'); }
      setAssemblyContext(asmId);
      if (qMatch) {
        const qId = Number(qMatch[1]);
        const results = await fetchVotingResults(asmId, qId);
        if (!results.length) return `No voting results found for assembly ${asmId} question ${qId}.`;
        const lines = results.map((r: Record<string, unknown>) =>
          `• **${r.texto}**: ${r.conteo} votes, nominal: ${r.nominal}, coef: ${r.coeficiente}`
        );
        return `Voting results for assembly **${asmId}** question **${qId}**:\n\n${lines.join('\n')}`;
      }
      return 'Please also specify a question ID. Example: "results for assembly 123 question 1"';
    }

    // ── Raw service call ──
    if (msg.includes('service') || msg.includes('servicio')) {
      const svcMatch = message.match(/service\s*(\d+)/i);
      if (!svcMatch) return 'Please specify a service number. Example: "call service 9"';
      const svcId = Number(svcMatch[1]);
      const params: Record<string, string | number> = {};
      try { params.token = getToken(); } catch { /* no token yet */ }
      const asmMatch = message.match(/(?:asamblea|assembly|id)\s*[:#]?\s*(\d+)/i);
      if (asmMatch) params.idAsamblea = Number(asmMatch[1]);
      const qMatch = message.match(/(?:question|pregunta)\s*[:#]?\s*(\d+)/i);
      if (qMatch) params.idPregunta = Number(qMatch[1]);
      const data = await callService(svcId, params);
      const json = JSON.stringify(data, null, 2);
      return `Service **${svcId}** response:\n\n\`\`\`json\n${json.substring(0, 2000)}\n\`\`\`${json.length > 2000 ? '\n\n…truncated' : ''}`;
    }

    // ── Help / fallback ──
    return `I can query Tecnoreuniones for you. Try:\n\n` +
      `• **"active assemblies"** — list assemblies in progress\n` +
      `• **"login"** — authenticate with the API\n` +
      `• **"assembly info id 123"** — get metadata for an assembly\n` +
      `• **"attendance for assembly 123"** — attendee list\n` +
      `• **"quorum for assembly 123"** — quorum & status\n` +
      `• **"questions for assembly 123"** — list voting questions\n` +
      `• **"results for assembly 123 question 1"** — voting results\n` +
      `• **"call service 9"** — raw service call`;

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('Robinson chat error', { error: errMsg });
    return `❌ Error: ${errMsg}`;
  }
}

// ── Gloria: draft/review queries from local DB ──

async function handleGloriaChat(message: string): Promise<string> {
  const msg = message.toLowerCase();
  try {
    if (msg.includes('draft') || msg.includes('pending') || msg.includes('review')) {
      const drafts = await getDraftList();
      if (!drafts.length) return 'No drafts pending review at the moment.';
      const lines = drafts.map((d) => `• **${d.buildingName}** (${d.jobId}) — ${d.sectionCount} sections, ${d.flagCount} flags`);
      return `${drafts.length} draft(s) pending review:\n\n${lines.join('\n')}`;
    }
    return `I handle review and approval. Try:\n\n• **"pending drafts"** — list drafts awaiting review\n• **"draft status"** — check review progress`;
  } catch (err) {
    return `❌ Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Supervisor: pipeline overview from local DB ──

async function handleSupervisorChat(message: string): Promise<string> {
  const msg = message.toLowerCase();
  try {
    if (msg.includes('pipeline') || msg.includes('status') || msg.includes('overview') || msg.includes('jobs')) {
      const overview = await getPipelineOverview();
      return `Pipeline overview:\n\n` +
        `• **Active**: ${overview.activeJobs}\n` +
        `• **Queued**: ${overview.queuedJobs}\n` +
        `• **Completed**: ${overview.completedJobs}\n` +
        `• **Failed**: ${overview.failedJobs}\n\n` +
        (overview.recentJobs.length
          ? `Recent jobs:\n${overview.recentJobs.slice(0, 5).map((j) => `• ${j.buildingName} — ${j.status}`).join('\n')}`
          : 'No recent jobs.');
    }
    return `I orchestrate the pipeline. Try:\n\n• **"pipeline status"** — overview of all jobs\n• **"recent jobs"** — last processed events`;
  } catch (err) {
    return `❌ Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Generic handler for agents without live backends yet ──

function handleGenericChat(name: string, role: string, message: string): Promise<string> {
  return Promise.resolve(
    `Hi! I'm **${name}** (${role}). My chat backend isn't connected yet, but I'll be able to answer questions about my work soon.\n\n` +
    `You asked: "${message.substring(0, 200)}"\n\n` +
    `For now, you can see my status and stats in the detail panel below.`
  );
}
