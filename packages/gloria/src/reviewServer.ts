import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    // Set 2.5 min server-side timeout for LLM tool loops
    req.setTimeout(150_000);
    res.setTimeout(150_000);

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
      if (!res.headersSent) {
        res.status(500).json({ error: 'Chat request failed' });
      }
    }
  });

  // ── Serve dashboard static files ──
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dashboardDist = path.resolve(__dirname, '../../dashboard/dist');
  app.use(express.static(dashboardDist));
  // SPA fallback: any non-API route serves index.html
  app.get('*', (_req, res) => {
    res.sendFile(path.join(dashboardDist, 'index.html'));
  });

  app.listen(serverPort, () => {
    logger.info(`Gloria review server running on http://localhost:${serverPort}`);
    logger.info(`Dashboard served from ${dashboardDist}`);
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
      name: 'fetch_assembly_metadata',
      description: 'Get full metadata for a specific assembly (asamblea), including client name, date, location, type, and configuration.',
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
      name: 'fetch_assembly_status',
      description: 'Get current assembly status including quorum percentages, attendee counts, state (EN CURSO/REGISTRO/TERMINADA), and operational data.',
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
      description: 'Get the attendance/delegate list for an assembly. Returns all property owners, their units, representation type (P=present, D=delegate, C=consolidated), check-in times, and coefficients.',
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
      description: 'List all voting questions (preguntas) for an assembly, including their text, number of options, whether active, and the option texts. Uses direct database query.',
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
          opciones: { type: 'number', description: 'Number of selectable options. 1 = single choice (default), >1 = multiple choice.' },
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
      name: 'fetch_last_answered_question',
      description: 'Get the last question that was answered/voted on in an assembly. Returns the question details.',
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
      name: 'run_sql_query',
      description: 'Run a read-only SQL SELECT query directly on the Tecnoreuniones MySQL database. Use this for custom queries not covered by other tools. Key tables: asambleas, residentes, preguntas, preguntasOpciones, respuestas, respuestasmultiples, asistentes, delegados, sesiones, poderes, quorumRespuestas. Key views: listadelegados, escrutiniovotacion, estadoasamblea, representados, cuestionario.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'The SQL SELECT query to execute. Only SELECT, SHOW, and DESCRIBE are allowed.' },
          params: {
            type: 'array',
            items: { type: 'string' },
            description: 'Parameterized values for ? placeholders in the query.',
          },
        },
        required: ['sql'],
      },
    },
  },
];

// ── Yulieth-specific Tool Definitions ──

const YULIETH_OWN_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'check_queue_status',
      description: 'Check the current status of the BullMQ job queue: how many jobs are pending, processing, completed, and failed.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_drive_folders',
      description: 'Scan the configured Google Drive root folder for event folders and list audio/voting files detected in each.',
      parameters: {
        type: 'object',
        properties: {
          rootFolderId: { type: 'string', description: 'The Google Drive folder ID to scan. If omitted, uses the configured default.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pipeline_jobs',
      description: 'Query the local PostgreSQL database for pipeline jobs. Returns recent jobs with their current stage, event info, and timestamps.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter by status (detected, queued, preprocessing, transcribing, sectioning, redacting, assembling, reviewing, completed, failed). If omitted, returns all.' },
          limit: { type: 'number', description: 'Max number of jobs to return. Default 20.' },
        },
        required: [],
      },
    },
  },
];

// ── Google Workspace Tool Definitions ──

const GOOGLE_WORKSPACE_TOOLS: ChatCompletionTool[] = [
  // ── Drive ──
  {
    type: 'function',
    function: {
      name: 'gw_drive_list_files',
      description: 'List files in a Google Drive folder. Returns file name, type, size, dates, and links.',
      parameters: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: 'The Google Drive folder ID to list.' },
          maxResults: { type: 'number', description: 'Maximum number of files to return. Default 50.' },
        },
        required: ['folderId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gw_drive_search',
      description: 'Search for files across Google Drive by name. Returns matching files with metadata.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search text to find in file names.' },
          maxResults: { type: 'number', description: 'Maximum results. Default 20.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gw_drive_get_file',
      description: 'Get metadata for a specific Google Drive file by its ID.',
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'The Google Drive file ID.' },
        },
        required: ['fileId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gw_drive_create_folder',
      description: 'Create a new folder in Google Drive.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name for the new folder.' },
          parentId: { type: 'string', description: 'Parent folder ID. If omitted, creates in root.' },
        },
        required: ['name'],
      },
    },
  },
  // ── Docs ──
  {
    type: 'function',
    function: {
      name: 'gw_docs_get_content',
      description: 'Read the full text content of a Google Doc. Returns title and body text.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'The Google Document ID (from the URL).' },
        },
        required: ['documentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gw_docs_create',
      description: 'Create a new Google Doc with an optional initial body text.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title of the new document.' },
          bodyText: { type: 'string', description: 'Optional initial text content.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gw_docs_append',
      description: 'Append text to the end of an existing Google Doc.',
      parameters: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: 'The Google Document ID.' },
          text: { type: 'string', description: 'Text to append.' },
        },
        required: ['documentId', 'text'],
      },
    },
  },
  // ── Sheets ──
  {
    type: 'function',
    function: {
      name: 'gw_sheets_read',
      description: 'Read data from a Google Sheets range. Returns a 2D array of cell values.',
      parameters: {
        type: 'object',
        properties: {
          spreadsheetId: { type: 'string', description: 'The Spreadsheet ID (from the URL).' },
          range: { type: 'string', description: 'The A1-notation range, e.g. "Sheet1!A1:D10" or "Sheet1".' },
        },
        required: ['spreadsheetId', 'range'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gw_sheets_write',
      description: 'Write data to a Google Sheets range (overwrites existing data).',
      parameters: {
        type: 'object',
        properties: {
          spreadsheetId: { type: 'string', description: 'The Spreadsheet ID.' },
          range: { type: 'string', description: 'The A1-notation range to write to.' },
          values: {
            type: 'array',
            items: { type: 'array', items: { type: 'string' } },
            description: 'A 2D array of values (rows × columns).',
          },
        },
        required: ['spreadsheetId', 'range', 'values'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gw_sheets_append',
      description: 'Append rows to the end of a Google Sheet.',
      parameters: {
        type: 'object',
        properties: {
          spreadsheetId: { type: 'string', description: 'The Spreadsheet ID.' },
          range: { type: 'string', description: 'The sheet name or range, e.g. "Sheet1".' },
          rows: {
            type: 'array',
            items: { type: 'array', items: { type: 'string' } },
            description: 'Rows to append (2D array).',
          },
        },
        required: ['spreadsheetId', 'range', 'rows'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gw_sheets_create',
      description: 'Create a new Google Spreadsheet with optional header row.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title of the new spreadsheet.' },
          headers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional column headers for the first row.',
          },
        },
        required: ['title'],
      },
    },
  },
  // ── Calendar ──
  {
    type: 'function',
    function: {
      name: 'gw_calendar_list_events',
      description: 'List upcoming calendar events. Returns summary, dates, location, attendees.',
      parameters: {
        type: 'object',
        properties: {
          calendarId: { type: 'string', description: 'Calendar ID. Default "primary".' },
          maxResults: { type: 'number', description: 'Max events to return. Default 20.' },
          timeMin: { type: 'string', description: 'Earliest event time (ISO 8601). Default now.' },
          timeMax: { type: 'string', description: 'Latest event time (ISO 8601). If omitted, no upper limit.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gw_calendar_create_event',
      description: 'Create a new calendar event with optional attendees and location.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Event title/summary.' },
          start: { type: 'string', description: 'Start date-time in ISO 8601 format.' },
          end: { type: 'string', description: 'End date-time in ISO 8601 format.' },
          description: { type: 'string', description: 'Event description.' },
          location: { type: 'string', description: 'Event location.' },
          attendees: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of attendee email addresses.',
          },
          calendarId: { type: 'string', description: 'Calendar ID. Default "primary".' },
        },
        required: ['summary', 'start', 'end'],
      },
    },
  },
  // ── Gmail ──
  {
    type: 'function',
    function: {
      name: 'gw_gmail_list_messages',
      description: 'List recent emails. Supports Gmail search queries like "from:user@example.com", "subject:asamblea", "is:unread", "in:inbox".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Gmail search query. Default "in:inbox". Examples: "from:info@tecnoreuniones.com", "subject:acta is:unread".' },
          maxResults: { type: 'number', description: 'Max messages to return. Default 20.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gw_gmail_read_message',
      description: 'Read the full content of a specific email by its message ID.',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'The Gmail message ID (from gw_gmail_list_messages).' },
        },
        required: ['messageId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gw_gmail_send',
      description: 'Send an email from the configured Tecnoreuniones account.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address.' },
          subject: { type: 'string', description: 'Email subject line.' },
          body: { type: 'string', description: 'Plain-text email body.' },
          cc: { type: 'string', description: 'CC email address (optional).' },
          bcc: { type: 'string', description: 'BCC email address (optional).' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
];

// Yulieth gets her own tools + Robinson's Tecnoreuniones tools + Google Workspace tools
const YULIETH_TOOLS: ChatCompletionTool[] = [
  ...YULIETH_OWN_TOOLS,
  ...TECNOREUNIONES_TOOLS,
  ...GOOGLE_WORKSPACE_TOOLS,
];

// ── Tool Executor (Robinson) ──

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const adapter = await import('@transcriptor/robinson');

  try {
    switch (name) {
      case 'fetch_active_assemblies': {
        const data = await adapter.fetchActiveAssemblies();
        return JSON.stringify(data, null, 2);
      }
      case 'fetch_assembly_metadata': {
        const id = args.idAsamblea as number;
        const data = await adapter.dbFetchAssemblyMetadata(id);
        return JSON.stringify(data ?? { info: 'No metadata found for assembly ' + id }, null, 2);
      }
      case 'fetch_assembly_status': {
        const id = args.idAsamblea as number;
        const data = await adapter.dbFetchAssemblyStatus(id);
        return JSON.stringify(data ?? { info: 'No status found for assembly ' + id }, null, 2);
      }
      case 'fetch_attendance_list': {
        const id = args.idAsamblea as number;
        const raw = await adapter.dbFetchAttendanceList(id);
        const present = raw.filter(r => r.fhultimoingreso != null);
        return JSON.stringify({
          total: raw.length,
          present: present.length,
          absent: raw.length - present.length,
          records: raw.slice(0, 50), // Limit to avoid token overflow
        }, null, 2);
      }
      case 'fetch_question_list': {
        const id = args.idAsamblea as number;
        const data = await adapter.dbFetchQuestions(id);
        return JSON.stringify(data, null, 2);
      }
      case 'fetch_voting_results': {
        const asmId = args.idAsamblea as number;
        const qId = args.idPregunta as number;
        const opts = (args.opciones as number) || 1;
        const data = await adapter.dbFetchVotingResults(asmId, qId, opts);
        return JSON.stringify(data, null, 2);
      }
      case 'fetch_voting_scrutiny': {
        const asmId = args.idAsamblea as number;
        const qId = args.idPregunta as number;
        const data = await adapter.dbFetchVotingScrutiny(asmId, qId);
        const json = JSON.stringify(data, null, 2);
        return json.length > 4000 ? json.substring(0, 4000) + '\n...truncated' : json;
      }
      case 'fetch_quorum_snapshot': {
        const asmId = args.idAsamblea as number;
        const qId = args.idPregunta as number;
        const data = await adapter.dbFetchQuorumSnapshot(asmId, qId);
        return JSON.stringify(data ?? { info: 'No quorum snapshot for this question' }, null, 2);
      }
      case 'fetch_last_answered_question': {
        const id = args.idAsamblea as number;
        const data = await adapter.dbFetchLastAnsweredQuestion(id);
        return JSON.stringify(data ?? { info: 'No answered questions found for assembly ' + id }, null, 2);
      }
      case 'run_sql_query': {
        const sql = args.sql as string;
        const params = ((args.params || []) as string[]).map(p => isNaN(Number(p)) ? p : Number(p));
        const data = await adapter.queryTecnoreuniones(sql, params);
        const json = JSON.stringify(data, null, 2);
        return json.length > 4000 ? json.substring(0, 4000) + '\n...truncated (' + data.length + ' total rows)' : json;
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: msg, note: 'This tool call failed. Do NOT retry it — report the error to the user and continue with other data you have.' });
  }
}

// ── Tool Executor (Yulieth) ──

async function executeYuliethTool(name: string, args: Record<string, unknown>): Promise<string> {
  // Yulieth's own tools
  switch (name) {
    case 'check_queue_status': {
      try {
        const yulieth = await import('@transcriptor/yulieth');
        const stats = await yulieth.getQueueStatus();
        return JSON.stringify(stats, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Queue status unavailable: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    case 'check_drive_folders': {
      try {
        const yulieth = await import('@transcriptor/yulieth');
        const folderId = (args.rootFolderId as string) || 'default';
        const folders = await yulieth.checkForNewEvents(folderId);
        return JSON.stringify(folders, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Drive scan unavailable: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    case 'get_pipeline_jobs': {
      try {
        const db = getDb();
        const status = args.status as string | undefined;
        const limit = (args.limit as number) || 20;
        let result;
        if (status) {
          result = await db.execute(sql`
            SELECT pj.job_id, pj.event_id, pj.status, pj.created_at, pj.updated_at,
                   e.building_name
            FROM pipeline_jobs pj
            LEFT JOIN events e ON pj.event_id = e.event_id
            WHERE pj.status = ${status}
            ORDER BY pj.updated_at DESC
            LIMIT ${limit}
          `);
        } else {
          result = await db.execute(sql`
            SELECT pj.job_id, pj.event_id, pj.status, pj.created_at, pj.updated_at,
                   e.building_name
            FROM pipeline_jobs pj
            LEFT JOIN events e ON pj.event_id = e.event_id
            ORDER BY pj.updated_at DESC
            LIMIT ${limit}
          `);
        }
        return JSON.stringify(result.rows, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Pipeline query failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // ── Google Workspace: Drive ──
    case 'gw_drive_list_files': {
      try {
        const gw = await import('@transcriptor/shared');
        const data = await gw.gwDriveListFiles(args.folderId as string, (args.maxResults as number) || 50);
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Drive list failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    case 'gw_drive_search': {
      try {
        const gw = await import('@transcriptor/shared');
        const data = await gw.gwDriveSearch(args.query as string, (args.maxResults as number) || 20);
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Drive search failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    case 'gw_drive_get_file': {
      try {
        const gw = await import('@transcriptor/shared');
        const data = await gw.gwDriveGetFile(args.fileId as string);
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Drive get file failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    case 'gw_drive_create_folder': {
      try {
        const gw = await import('@transcriptor/shared');
        const data = await gw.gwDriveCreateFolder(args.name as string, args.parentId as string | undefined);
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Drive create folder failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // ── Google Workspace: Docs ──
    case 'gw_docs_get_content': {
      try {
        const gw = await import('@transcriptor/shared');
        const data = await gw.gwDocsGetContent(args.documentId as string);
        const json = JSON.stringify(data, null, 2);
        return json.length > 6000 ? json.substring(0, 6000) + '\n...truncated' : json;
      } catch (err) {
        return JSON.stringify({ error: `Docs read failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    case 'gw_docs_create': {
      try {
        const gw = await import('@transcriptor/shared');
        const data = await gw.gwDocsCreate(args.title as string, args.bodyText as string | undefined);
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Docs create failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    case 'gw_docs_append': {
      try {
        const gw = await import('@transcriptor/shared');
        await gw.gwDocsAppend(args.documentId as string, args.text as string);
        return JSON.stringify({ success: true, message: 'Text appended successfully.' });
      } catch (err) {
        return JSON.stringify({ error: `Docs append failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // ── Google Workspace: Sheets ──
    case 'gw_sheets_read': {
      try {
        const gw = await import('@transcriptor/shared');
        const data = await gw.gwSheetsRead(args.spreadsheetId as string, args.range as string);
        const json = JSON.stringify(data, null, 2);
        return json.length > 6000 ? json.substring(0, 6000) + '\n...truncated' : json;
      } catch (err) {
        return JSON.stringify({ error: `Sheets read failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    case 'gw_sheets_write': {
      try {
        const gw = await import('@transcriptor/shared');
        const data = await gw.gwSheetsWrite(args.spreadsheetId as string, args.range as string, args.values as string[][]);
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Sheets write failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    case 'gw_sheets_append': {
      try {
        const gw = await import('@transcriptor/shared');
        const data = await gw.gwSheetsAppend(args.spreadsheetId as string, args.range as string, args.rows as string[][]);
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Sheets append failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    case 'gw_sheets_create': {
      try {
        const gw = await import('@transcriptor/shared');
        const data = await gw.gwSheetsCreate(args.title as string, args.headers as string[] | undefined);
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Sheets create failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // ── Google Workspace: Calendar ──
    case 'gw_calendar_list_events': {
      try {
        const gw = await import('@transcriptor/shared');
        const data = await gw.gwCalendarListEvents(
          (args.calendarId as string) || 'primary',
          (args.maxResults as number) || 20,
          args.timeMin as string | undefined,
          args.timeMax as string | undefined,
        );
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Calendar list failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    case 'gw_calendar_create_event': {
      try {
        const gw = await import('@transcriptor/shared');
        const data = await gw.gwCalendarCreateEvent(
          args.summary as string,
          args.start as string,
          args.end as string,
          {
            description: args.description as string | undefined,
            location: args.location as string | undefined,
            attendees: args.attendees as string[] | undefined,
            calendarId: args.calendarId as string | undefined,
          },
        );
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Calendar create event failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    // ── Google Workspace: Gmail ──
    case 'gw_gmail_list_messages': {
      try {
        const gw = await import('@transcriptor/shared');
        const data = await gw.gwGmailListMessages(
          (args.query as string) || 'in:inbox',
          (args.maxResults as number) || 20,
        );
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Gmail list failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    case 'gw_gmail_read_message': {
      try {
        const gw = await import('@transcriptor/shared');
        const data = await gw.gwGmailReadMessage(args.messageId as string);
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Gmail read failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    case 'gw_gmail_send': {
      try {
        const gw = await import('@transcriptor/shared');
        const data = await gw.gwGmailSend(
          args.to as string,
          args.subject as string,
          args.body as string,
          { cc: args.cc as string | undefined, bcc: args.bcc as string | undefined },
        );
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Gmail send failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    default:
      // Delegate all Robinson/Tecnoreuniones tools to Robinson's executor
      return executeTool(name, args);
  }
}

// ── Agent System Prompts ──

const AGENT_SYSTEM_PROMPTS: Record<string, string> = {
  robinson: `You are **Robinson**, the Data Extraction Agent in the Transcriptor multi-agent system for Colombian property assembly (propiedad horizontal) minutes.

Your role: You connect to the **Tecnoreuniones** platform to extract real-time assembly data. You have direct read-only access to the Tecnoreuniones MySQL database and can query any table or view.

## Database Schema

### Key Tables
| Table | Description |
|-------|-------------|
| asambleas | Assembly/event master data (idAsamblea, cliente, estado, permiteRegistro, permiteVotoMora, etc.) |
| residentes | Unit owners — idAsamblea, idtorre, idunidad, nombrePropietario1, nombrePropietario2, coeficiente, nominal, mora, clave |
| preguntas | Voting questions — idAsamblea, idPregunta, texto, tipo, activa, opciones, fhPregunta, fhcierre |
| preguntasOpciones | Question option texts — idAsamblea, idPregunta, idOpcion, texto |
| respuestas | Single-choice votes — idAsamblea, idPregunta, idTorre, idUnidad, respuesta |
| respuestasmultiples | Multi-choice votes — same structure as respuestas |
| asistentes | Registered attendees — idAsamblea, idUsuario, tipoRepresentacion (P=present, D=delegate, C=consolidated), fhultimoingreso, coeficiente, ultimarespuesta |
| delegados | Delegation relationships — idAsamblea, idDelegante, idDelegado |
| sesiones | Active sessions — token, idUsuario, idAsamblea, ip |
| poderes | Power of representation between units |
| quorumRespuestas | Quorum snapshots at question close — idAsamblea, idPregunta, quorum, asistentes, fhoperacion, listaAsistentes |
| administradores | Assembly administrators |

### Key Views
| View | Description |
|------|-------------|
| listadelegados | Attendance list with delegation info (used by service 3) |
| escrutiniovotacion | Voting scrutiny per question (used by service 1002) |
| estadoasamblea | Assembly status dashboard — quorum, attendee counts, state |
| representados | Represented units per user |
| cuestionario | Active questionnaire |

## Available Tools
- **fetch_active_assemblies**: List active assemblies (no params needed)
- **fetch_assembly_metadata**: Get assembly config from \`asambleas\` table
- **fetch_assembly_status**: Get quorum/status from \`estadoasamblea\` view
- **fetch_attendance_list**: Get attendance from \`listadelegados\` view
- **fetch_question_list**: Get questions + options from \`preguntas\` + \`preguntasOpciones\`
- **fetch_voting_results**: Get aggregated vote counts with coefficients
- **fetch_voting_scrutiny**: Get per-unit voting detail from \`escrutiniovotacion\`
- **fetch_quorum_snapshot**: Get quorum at question close time
- **fetch_last_answered_question**: Get the last voted question in an assembly
- **run_sql_query**: Run any SELECT query directly on the database

## CRITICAL RULES
1. **ALWAYS call ALL the tools you need in a SINGLE response using parallel tool calls.** NEVER call them one by one.
2. **NEVER retry a tool that returned an error.** Report it and continue with other data.
3. After receiving tool results, write your final answer immediately — do NOT make more tool calls.
4. Present results in Markdown with tables, bold labels, and bullet points.
5. Assembly IDs are numeric (e.g., 2, 26009, 26036).
6. Data is in Spanish. You can respond in Spanish or English depending on the user's language.
7. Summarize large datasets instead of dumping everything.
8. For complex queries not covered by the predefined tools, use **run_sql_query** with proper parameterized queries.`,

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

  yulieth: `You are **Yulieth**, the Drive Watcher & Job Queue Agent in the Transcriptor multi-agent system for Colombian property assembly (propiedad horizontal) minutes.

Your role: You are the **intake point** of the entire pipeline. You monitor Google Drive folders for new assembly audio recordings, validate incoming files, create pipeline jobs, and manage the BullMQ job queue. You also have **full access to Tecnoreuniones' Google Workspace** (Drive, Docs, Sheets, Calendar, and Gmail).

## Your Own Capabilities
- **check_queue_status**: See how many jobs are pending, processing, completed, or failed in the BullMQ queue.
- **check_drive_folders**: Scan a Google Drive folder for event subfolders with audio/voting files.
- **get_pipeline_jobs**: Query the local PostgreSQL database for pipeline job history (filter by status, see recent activity).

## Google Workspace — Drive, Docs, Sheets, Calendar, Gmail
You are connected to Tecnoreuniones' Google Workspace account. You can read, create, and manage files across all Google services:

### Drive
- **gw_drive_list_files**: List files in a Drive folder.
- **gw_drive_search**: Search for files by name across the entire Drive.
- **gw_drive_get_file**: Get metadata for a specific file.
- **gw_drive_create_folder**: Create a new folder.

### Google Docs
- **gw_docs_get_content**: Read a Google Doc's full text content.
- **gw_docs_create**: Create a new Google Doc (optionally with initial text).
- **gw_docs_append**: Append text to an existing Google Doc.

### Google Sheets
- **gw_sheets_read**: Read cell data from a spreadsheet range.
- **gw_sheets_write**: Write/overwrite data in a spreadsheet range.
- **gw_sheets_append**: Append rows to the end of a spreadsheet.
- **gw_sheets_create**: Create a new spreadsheet (optionally with headers).

### Google Calendar
- **gw_calendar_list_events**: List upcoming calendar events.
- **gw_calendar_create_event**: Create a new calendar event with optional attendees.

### Gmail
- **gw_gmail_list_messages**: Search and list emails (supports Gmail query syntax: "from:", "subject:", "is:unread", etc.).
- **gw_gmail_read_message**: Read the full content of a specific email.
- **gw_gmail_send**: Send an email from the Tecnoreuniones account.

## Robinson Delegation — Tecnoreuniones Data Access
You have full access to **Robinson's** data tools for querying the Tecnoreuniones MySQL database:

- **fetch_active_assemblies**: List all currently active assemblies.
- **fetch_assembly_metadata**: Get full metadata for a specific assembly.
- **fetch_assembly_status**: Get quorum, attendee counts, and assembly state.
- **fetch_attendance_list**: Get the attendance/delegate list.
- **fetch_question_list**: List all voting questions and their options.
- **fetch_voting_results**: Get aggregated voting results.
- **fetch_voting_scrutiny**: Get per-unit voting detail.
- **fetch_quorum_snapshot**: Get quorum at question close time.
- **fetch_last_answered_question**: Get the last voted question.
- **run_sql_query**: Run any read-only SELECT query on the Tecnoreuniones MySQL database.

### Tecnoreuniones Database Schema (for run_sql_query)
| Table | Description |
|-------|-------------|
| asambleas | Assembly master data (idAsamblea, cliente, estado, permiteRegistro, etc.) |
| residentes | Unit owners — idAsamblea, idtorre, idunidad, nombrePropietario1, coeficiente, mora |
| preguntas | Voting questions — idAsamblea, idPregunta, texto, tipo, activa, opciones |
| preguntasOpciones | Question option texts — idAsamblea, idPregunta, idRespuesta, texto |
| respuestas | Single-choice votes |
| respuestasmultiples | Multi-choice votes |
| asistentes | Registered attendees — tipoRepresentacion (P/D/C), fhultimoingreso, coeficiente |
| delegados | Delegation relationships |
| sesiones | Active sessions |
| poderes | Power of representation between units |
| quorumRespuestas | Quorum snapshots at question close |

### Key Views
| View | Description |
|------|-------------|
| listadelegados | Attendance list with delegation info |
| escrutiniovotacion | Per-unit voting scrutiny |
| estadoasamblea | Assembly status dashboard |
| representados | Represented units per user |
| cuestionario | Active questionnaire |

## CRITICAL RULES
1. **Use ALL the tools you need in a SINGLE response using parallel tool calls.** NEVER call them one by one.
2. **NEVER retry a tool that returned an error.** Report it and continue with other data.
3. After receiving tool results, write your final answer immediately — do NOT make more tool calls.
4. Present results in Markdown with tables, bold labels, and bullet points.
5. Data is in Spanish. You can respond in Spanish or English depending on the user's language.
6. For Tecnoreuniones assembly data → use Robinson's tools.
7. For Google Drive/Docs/Sheets/Calendar/Gmail → use Google Workspace tools.
8. For pipeline/queue status → use your own tools.
9. If Google credentials are not configured, tell the user they need to set up GOOGLE_SERVICE_ACCOUNT_KEY_FILE or OAuth2 credentials.`,

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

  // Robinson and Yulieth get tools; other agents get pure conversation
  const isRobinson = agentId === 'robinson';
  const isYulieth = agentId === 'yulieth';
  const agentTools = isRobinson ? TECNOREUNIONES_TOOLS : isYulieth ? YULIETH_TOOLS : undefined;
  const agentToolExecutor = isYulieth ? executeYuliethTool : executeTool;

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
      tools: agentTools,
      temperature: 0.3,
      max_tokens: 4096,
    });

    let choice = response.choices[0];
    if (!choice) return 'No response from LLM.';

    // Tool-calling loop (Robinson & Yulieth, max 10 iterations)
    let iterations = 0;
    while (choice.finish_reason === 'tool_calls' && choice.message.tool_calls && iterations < 10) {
      iterations++;
      logger.info(`${agentId} tool call iteration ${iterations}`, {
        tools: choice.message.tool_calls.map(tc => tc.function.name),
      });

      // Sanitize assistant message before adding to history.
      // Groq returns content:null on tool_calls, which can cause 400 errors
      // on the follow-up request. We must ensure content is either a string or omitted.
      const assistantMsg: ChatCompletionMessageParam = {
        role: 'assistant' as const,
        tool_calls: choice.message.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      };
      // Only include content if it's a non-empty string
      if (typeof choice.message.content === 'string' && choice.message.content.length > 0) {
        (assistantMsg as unknown as Record<string, unknown>).content = choice.message.content;
      }
      messages.push(assistantMsg);

      // Execute each tool call and add results
      for (const toolCall of choice.message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments || '{}');
        } catch (parseErr) {
          logger.error(`Failed to parse tool arguments for ${toolCall.function.name}`, {
            raw: toolCall.function.arguments,
            error: String(parseErr),
          });
        }
        logger.info(`Executing tool: ${toolCall.function.name}`, { args });
        const result = await agentToolExecutor(toolCall.function.name, args);
        // Groq requires content to be a non-empty string
        const toolContent = (typeof result === 'string' && result.length > 0)
          ? result
          : '{"result": "no data returned"}';
        messages.push({
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content: toolContent,
        });
      }

      // Follow-up LLM call with tool results
      try {
        const followUp = await client.chat.completions.create({
          model,
          messages,
          tools: agentTools,
          temperature: 0.3,
          max_tokens: 4096,
        });

        choice = followUp.choices[0];
        if (!choice) return 'No response from LLM after tool execution.';
      } catch (followUpErr) {
        const errDetail = followUpErr instanceof Error ? followUpErr.message : String(followUpErr);
        logger.error('Groq follow-up call failed', {
          error: errDetail,
          messageCount: messages.length,
          lastMessages: messages.slice(-3).map(m => ({ role: m.role, hasContent: 'content' in m && !!m.content })),
        });
        // If the follow-up fails, try to recover by summarizing tool results directly
        const toolResults = messages
          .filter(m => m.role === 'tool')
          .map(m => ('content' in m ? m.content : ''))
          .join('\n');
        return `Obtuve datos de Tecnoreuniones pero hubo un error al procesarlos con el LLM. Aquí los datos crudos:\n\n${toolResults.substring(0, 3000)}`;
      }
    }

    // If the loop ended because we hit max iterations (finish_reason is still 'tool_calls'),
    // force a final call WITHOUT tools to get a text summary.
    if (choice.finish_reason === 'tool_calls' || !choice.message.content) {
      logger.info('Forcing final text-only LLM call after tool loop');
      messages.push({
        role: 'user' as const,
        content: 'Please summarize all the data you have collected so far and present your answer. Do not make any more tool calls.',
      });
      const finalCall = await client.chat.completions.create({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 4096,
        // NO tools — force a text response
      });
      const finalChoice = finalCall.choices[0];
      return finalChoice?.message.content || 'No pude obtener una respuesta del modelo.';
    }

    return choice.message.content;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Agent ${agentId} chat error`, { error: errMsg });
    return `❌ Error: ${errMsg}`;
  }
}
