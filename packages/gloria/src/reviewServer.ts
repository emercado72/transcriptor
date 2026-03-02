import express from 'express';
import cors from 'cors';
import { sql } from 'drizzle-orm';
import OpenAI from 'openai';
import { createLogger, getEnvConfig, getDb } from '@transcriptor/shared';
import type { JobId, SectionId } from '@transcriptor/shared';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions.js';

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

// ── Groq LLM Client ──

let groqClient: OpenAI | null = null;

function getGroqClient(): OpenAI {
  if (!groqClient) {
    const env = getEnvConfig();
    if (!env.groqApiKey) {
      throw new Error('GROQ_API_KEY is not set in environment');
    }
    groqClient = new OpenAI({
      apiKey: env.groqApiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }
  return groqClient;
}

function getGroqModel(): string {
  return getEnvConfig().groqModel || 'openai/gpt-oss-120b';
}

// ── Tecnoreuniones Tool Definitions ──

const TECNOREUNIONES_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'fetch_active_assemblies',
      description: 'List all currently active assemblies (asambleas) in the Tecnoreuniones platform. No parameters required.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_login',
      description: 'Authenticate with the Tecnoreuniones API. Returns a session token and the default assembly ID. Must be called before most other operations.',
      parameters: {
        type: 'object',
        properties: {
          usuario: { type: 'string', description: 'Admin username. Defaults to "admin" if not specified.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_assembly_metadata',
      description: 'Get full metadata for a specific assembly (asamblea), including client name, date, location, type (ordinaria/extraordinaria), and configuration.',
      parameters: {
        type: 'object',
        properties: {
          idAsamblea: { type: 'number', description: 'The assembly ID number.' },
        },
        required: ['idAsamblea'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_attendance_list',
      description: 'Get the attendance/delegate list for an assembly. Returns all property owners, their units, representation type, check-in times, and coefficients.',
      parameters: {
        type: 'object',
        properties: {
          idAsamblea: { type: 'number', description: 'The assembly ID number.' },
        },
        required: ['idAsamblea'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_question_list',
      description: 'List all voting questions (preguntas) for an assembly, including their text, number of options, and whether they are active.',
      parameters: {
        type: 'object',
        properties: {
          idAsamblea: { type: 'number', description: 'The assembly ID number.' },
        },
        required: ['idAsamblea'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_voting_results',
      description: 'Get aggregated voting results for a specific question in an assembly. Returns vote counts, nominal values, and coefficient percentages per option.',
      parameters: {
        type: 'object',
        properties: {
          idAsamblea: { type: 'number', description: 'The assembly ID number.' },
          idPregunta: { type: 'number', description: 'The question ID number.' },
        },
        required: ['idAsamblea', 'idPregunta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_voting_scrutiny',
      description: 'Get detailed per-unit voting scrutiny for a question. Shows how each property owner voted, their coefficient, and timestamp.',
      parameters: {
        type: 'object',
        properties: {
          idAsamblea: { type: 'number', description: 'The assembly ID number.' },
          idPregunta: { type: 'number', description: 'The question ID number.' },
        },
        required: ['idAsamblea', 'idPregunta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_assembly_status',
      description: 'Get current assembly status including quorum percentages, attendee counts, state (open/closed), and operational data.',
      parameters: {
        type: 'object',
        properties: {
          idAsamblea: { type: 'number', description: 'The assembly ID number.' },
        },
        required: ['idAsamblea'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_quorum_snapshot',
      description: 'Get a quorum snapshot for a specific closed question, showing quorum percentage and attendee count at the time the question was closed.',
      parameters: {
        type: 'object',
        properties: {
          idAsamblea: { type: 'number', description: 'The assembly ID number.' },
          idPregunta: { type: 'number', description: 'The question ID number.' },
        },
        required: ['idAsamblea', 'idPregunta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_admin_info',
      description: 'Get information about the currently authenticated administrator.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'call_raw_service',
      description: 'Call any Tecnoreuniones service by its numeric ID with arbitrary parameters. Use this for services not covered by other tools.',
      parameters: {
        type: 'object',
        properties: {
          serviceId: { type: 'number', description: 'The Tecnoreuniones service number.' },
          params: {
            type: 'object',
            description: 'Key-value parameters to send to the service.',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['serviceId'],
      },
    },
  },
];

// ── Tool Executor ──

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const adapter = await import('@transcriptor/robinson');

  // Auto-login if needed for authenticated calls
  const ensureAuth = async () => {
    try { adapter.getToken(); } catch { await adapter.adminLogin('admin'); }
  };

  try {
    switch (name) {
      case 'fetch_active_assemblies': {
        const data = await adapter.fetchActiveAssemblies();
        return JSON.stringify(data, null, 2);
      }
      case 'admin_login': {
        const usuario = (args.usuario as string) || 'admin';
        const result = await adapter.adminLogin(usuario);
        return JSON.stringify(result);
      }
      case 'fetch_assembly_metadata': {
        await ensureAuth();
        const id = args.idAsamblea as number;
        adapter.setAssemblyContext(id);
        const data = await adapter.fetchAssemblyMetadata(id);
        return JSON.stringify(data ?? { info: 'no metadata returned' }, null, 2);
      }
      case 'fetch_attendance_list': {
        await ensureAuth();
        const id = args.idAsamblea as number;
        adapter.setAssemblyContext(id);
        const raw = await adapter.fetchAttendanceList(id);
        const mapped = adapter.mapAttendance(raw);
        return JSON.stringify({
          total: mapped.length,
          present: mapped.filter(r => r.status !== 'absent').length,
          absent: mapped.filter(r => r.status === 'absent').length,
          records: mapped.slice(0, 50), // Limit to avoid token overflow
        }, null, 2);
      }
      case 'fetch_question_list': {
        await ensureAuth();
        const id = args.idAsamblea as number;
        adapter.setAssemblyContext(id);
        const data = await adapter.fetchQuestionList(id);
        return JSON.stringify(data, null, 2);
      }
      case 'fetch_voting_results': {
        await ensureAuth();
        const asmId = args.idAsamblea as number;
        const qId = args.idPregunta as number;
        adapter.setAssemblyContext(asmId);
        const data = await adapter.fetchVotingResults(asmId, qId);
        return JSON.stringify(data, null, 2);
      }
      case 'fetch_voting_scrutiny': {
        await ensureAuth();
        const asmId = args.idAsamblea as number;
        const qId = args.idPregunta as number;
        adapter.setAssemblyContext(asmId);
        const data = await adapter.fetchVotingScrutiny(asmId, qId);
        return JSON.stringify(data, null, 2);
      }
      case 'fetch_assembly_status': {
        await ensureAuth();
        const id = args.idAsamblea as number;
        adapter.setAssemblyContext(id);
        const data = await adapter.fetchAssemblyStatus(id);
        return JSON.stringify(data ?? { info: 'no status returned' }, null, 2);
      }
      case 'fetch_quorum_snapshot': {
        await ensureAuth();
        const asmId = args.idAsamblea as number;
        const qId = args.idPregunta as number;
        const data = await adapter.fetchQuorumSnapshot(asmId, qId);
        return JSON.stringify(data ?? { info: 'no quorum snapshot available' }, null, 2);
      }
      case 'fetch_admin_info': {
        await ensureAuth();
        const data = await adapter.fetchAdminInfo();
        return JSON.stringify(data ?? { info: 'no admin info returned' }, null, 2);
      }
      case 'call_raw_service': {
        const svcId = args.serviceId as number;
        const params = (args.params || {}) as Record<string, string | number>;
        try { params['token'] = adapter.getToken(); } catch { /* ok */ }
        const data = await adapter.callService(svcId, params);
        const json = JSON.stringify(data, null, 2);
        return json.length > 4000 ? json.substring(0, 4000) + '\n...truncated' : json;
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: msg });
  }
}

// ── Agent System Prompts ──

const AGENT_SYSTEM_PROMPTS: Record<string, string> = {
  robinson: `You are **Robinson**, the Data Extraction Agent in the Transcriptor multi-agent system for Colombian property assembly (propiedad horizontal) minutes.

Your role: You connect to the **Tecnoreuniones** platform API to extract real-time assembly data — attendance lists, voting results, quorum snapshots, question lists, and assembly metadata.

You have access to tools that query the Tecnoreuniones API. Use them to answer user questions. When you need data:
1. You do NOT need to call admin_login — the system authenticates automatically.
2. Call the appropriate tool(s) with the correct assembly ID.
3. When you need multiple pieces of data, call ALL the tools you need in a SINGLE response (parallel tool calls) — do NOT call them one at a time.
4. Present the results clearly in Markdown with bullet points, bold labels, and tables where appropriate.

Important:
- Assembly IDs are numeric (e.g., 2, 26009).
- Always present data in a human-friendly format, not raw JSON.
- If a tool returns an error, skip that data and present what you have.
- You can understand Spanish and English. The data is in Spanish.
- Summarize large datasets instead of dumping everything.
- If the user asks something you can't answer with your tools, say so honestly.`,

  gloria: `You are **Gloria**, the Review & QA Agent in the Transcriptor system.

Your role: You review assembled draft minutes for quality, completeness, and accuracy before final delivery to the client.

You can answer questions about:
- Pending drafts awaiting review
- Review status and progress
- Quality standards and checks you perform
- The review workflow

Be professional, detail-oriented, and thorough in your responses.`,

  supervisor: `You are **Supervisor**, the Pipeline Orchestrator in the Transcriptor system.

Your role: You coordinate the entire pipeline — from audio detection through transcription, sectioning, redaction, assembly, and review. You track job progress and handle failures.

You can answer questions about:
- Pipeline status and active jobs
- Job queue and processing stages
- System health and agent coordination
- Error handling and retry strategies

Be concise and status-focused in your responses.`,

  yulieth: `You are **Yulieth**, the Drive Watcher & Job Queue Agent in the Transcriptor system.

Your role: You monitor Google Drive folders for new assembly audio recordings, detect new files, create pipeline jobs, and manage the job queue.

You can answer questions about:
- How file detection works
- Job queue management
- Google Drive integration
- File formats and naming conventions

Be helpful and explain your workflow clearly.`,

  chucho: `You are **Chucho**, the Audio Preprocessor Agent in the Transcriptor system.

Your role: You take raw assembly audio files and preprocess them — normalizing volume, splitting into segments, removing silence, and preparing audio for transcription.

You can answer questions about:
- Audio preprocessing pipeline
- Supported formats and codecs
- Segment splitting strategies
- Audio quality optimization

Be technical but accessible in your explanations.`,

  jaime: `You are **Jaime**, the Transcription & Sectioning Agent in the Transcriptor system.

Your role: You transcribe preprocessed audio segments using speech-to-text and then organize the transcript into logical sections matching the assembly agenda.

You can answer questions about:
- Transcription accuracy and speaker identification
- Section detection (agenda items, voting moments, discussions)
- How you handle overlapping speech
- The sectioning algorithm

Be detailed and precise in your responses.`,

  lina: `You are **Lina**, the AI Redaction Engine in the Transcriptor system.

Your role: You take sectioned transcripts and redact them into formal legal-style minutes (actas de asamblea), using proper Colombian property law language and format.

You can answer questions about:
- The redaction process and style
- Legal language standards
- How you handle voting results and quorum in the text
- Template formatting and glossary application

Be articulate and formal in your responses.`,

  fannery: `You are **Fannery**, the Document Assembly Agent in the Transcriptor system.

Your role: You take redacted sections and assemble them into the final Word document (.docx), applying templates, headers, footers, page numbers, and proper formatting.

You can answer questions about:
- Document assembly and formatting
- Template system and styles
- How sections are merged
- Final output specifications

Be organized and detail-oriented in your responses.`,
};

// ── LLM-Powered Chat Handler ──

async function handleAgentChat(agentId: string, message: string): Promise<string> {
  logger.info(`Chat request for agent ${agentId}: ${message.substring(0, 100)}`);

  const systemPrompt = AGENT_SYSTEM_PROMPTS[agentId];
  if (!systemPrompt) {
    return `Unknown agent: ${agentId}`;
  }

  // Robinson gets Tecnoreuniones tools; other agents get pure conversation
  const isRobinson = agentId === 'robinson';

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: message },
  ];

  try {
    const client = getGroqClient();
    const model = getGroqModel();

    // First LLM call
    const response = await client.chat.completions.create({
      model,
      messages,
      tools: isRobinson ? TECNOREUNIONES_TOOLS : undefined,
      temperature: 0.3,
      max_tokens: 4096,
    });

    let choice = response.choices[0];
    if (!choice) return 'No response from LLM.';

    // Tool-calling loop (Robinson only, max 10 iterations)
    let iterations = 0;
    while (choice.finish_reason === 'tool_calls' && choice.message.tool_calls && iterations < 10) {
      iterations++;
      logger.info(`Robinson tool call iteration ${iterations}`, {
        tools: choice.message.tool_calls.map(tc => tc.function.name),
      });

      // Add assistant message with tool calls
      messages.push(choice.message);

      // Execute each tool call and add results
      for (const toolCall of choice.message.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments || '{}');
        logger.info(`Executing tool: ${toolCall.function.name}`, { args });
        const result = await executeTool(toolCall.function.name, args);
        messages.push({
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content: result || '{"result": "no data returned"}',
        });
      }

      // Follow-up LLM call with tool results
      const followUp = await client.chat.completions.create({
        model,
        messages,
        tools: TECNOREUNIONES_TOOLS,
        temperature: 0.3,
        max_tokens: 4096,
      });

      choice = followUp.choices[0];
      if (!choice) return 'No response from LLM after tool execution.';
    }

    return choice.message.content || 'I processed your request but have no text response.';
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Agent ${agentId} chat error`, { error: errMsg });
    return `❌ Error: ${errMsg}`;
  }
}
