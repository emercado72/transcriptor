/**
 * Agent Manifests — Self-descriptions for the Agent Registry
 *
 * Each agent announces its identity, capabilities, and tools
 * so the Supervisor can intelligently orchestrate and answer questions.
 */

import type { AgentManifest } from '@transcriptor/shared';

const BASE_URL = '';  // same process, relative URLs

export function buildManifests(mode: string): AgentManifest[] {
  const manifests: AgentManifest[] = [
    {
      agentId: 'yulieth',
      name: 'Yulieth',
      description: 'Drive Watcher & Job Queue. Monitors a Google Drive folder for new audio files, detects event folders, resolves assembly metadata via Robinson, downloads audio, and enqueues jobs into the pipeline.',
      version: '0.1.0',
      status: 'online',
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      capabilities: [
        { name: 'drive-watch', description: 'Poll Google Drive for new event folders with audio files' },
        { name: 'job-enqueue', description: 'Create pipeline jobs from detected Drive folders', pipelineStage: 'queued' },
        { name: 'audio-download', description: 'Download audio files from Drive to local storage' },
      ],
      tools: [
        { name: 'drive-scan', description: 'Scan a Drive folder for event subfolders with audio', endpoint: '/api/agents/yulieth/drive-scan', method: 'POST', async: false, inputSchema: { folderId: 'string' }, outputSchema: { folders: 'DetectedFolder[]' } },
        { name: 'enqueue', description: 'Enqueue a detected folder into the pipeline', endpoint: '/api/agents/yulieth/enqueue', method: 'POST', async: false, inputSchema: { folderId: 'string' }, outputSchema: { jobId: 'string' } },
        { name: 'get-queue', description: 'List detected folders and their status', endpoint: '/api/agents/yulieth/queue', method: 'GET', async: false, inputSchema: {}, outputSchema: { folders: 'DetectedFolder[]', stats: 'QueueStats' } },
        { name: 'get-config', description: 'Get Yulieth configuration', endpoint: '/api/agents/yulieth/config', method: 'GET', async: false, inputSchema: {}, outputSchema: { driveFolderId: 'string', audioExtensions: 'string[]', autoQueue: 'boolean' } },
        { name: 'update-config', description: 'Update Yulieth configuration', endpoint: '/api/agents/yulieth/config', method: 'PUT', async: false, inputSchema: { driveFolderId: 'string?', audioExtensions: 'string[]?', autoQueue: 'boolean?' }, outputSchema: { config: 'YuliethConfig' } },
      ],
      callback: { type: 'redis-pubsub', channel: 'agent:yulieth:events' },
      healthCheck: { endpoint: '/api/health', intervalMs: 30000 },
    },

    {
      agentId: 'robinson',
      name: 'Robinson',
      description: 'Data Layer for Tecnoreuniones. Connects to the Tecnoreuniones MySQL database to extract assembly metadata, voting questions, attendance rosters, voting results, and quorum calculations.',
      version: '0.1.0',
      status: 'online',
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      capabilities: [
        { name: 'assembly-lookup', description: 'Find assembly by name, date, or ID in Tecnoreuniones' },
        { name: 'voting-data', description: 'Extract voting questions, options, and results' },
        { name: 'attendance-roster', description: 'Get property owner roster with coefficients and attendance' },
      ],
      tools: [
        { name: 'resolve-assembly', description: 'Find matching assembly from audio filename hint', endpoint: '/api/agents/robinson/resolve', method: 'POST', async: false, inputSchema: { hint: 'string' }, outputSchema: { idAsamblea: 'number', cliente: 'string' } },
        { name: 'get-voting', description: 'Get all voting data for an assembly', endpoint: '/api/agents/robinson/voting', method: 'GET', async: false, inputSchema: { idAsamblea: 'number' }, outputSchema: { questions: 'VotingSummary[]' } },
        { name: 'get-roster', description: 'Get attendance roster for an assembly', endpoint: '/api/agents/robinson/roster', method: 'GET', async: false, inputSchema: { idAsamblea: 'number' }, outputSchema: { roster: 'RosterRecord[]', quorum: 'QuorumInfo' } },
      ],
      callback: { type: 'redis-pubsub', channel: 'agent:robinson:events' },
      healthCheck: { endpoint: '/api/health', intervalMs: 30000 },
    },

    {
      agentId: 'chucho',
      name: 'Chucho',
      description: 'Audio Preprocessor. Takes raw audio from Yulieth and converts to mono 16kHz, then splits long files into 30-minute chunks for efficient transcription. Uses FFmpeg.',
      version: '0.1.0',
      status: 'online',
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      capabilities: [
        { name: 'audio-preprocessing', description: 'Convert audio to mono 16kHz FLAC', pipelineStage: 'preprocessing' },
        { name: 'audio-splitting', description: 'Split long audio into 30-min chunks for parallel processing' },
      ],
      tools: [
        { name: 'get-progress', description: 'Get preprocessing progress for all jobs', endpoint: '/api/agents/chucho/queue', method: 'GET', async: false, inputSchema: {}, outputSchema: { jobs: 'ChuchoJobProgress[]' } },
      ],
      callback: { type: 'redis-pubsub', channel: 'agent:chucho:events' },
      healthCheck: { endpoint: '/api/health', intervalMs: 30000 },
    },

    {
      agentId: 'jaime',
      name: 'Jaime',
      description: 'Transcription & Sectioning. Runs Faster-Whisper (GPU) for speech-to-text and Pyannote for speaker diarization, then uses an LLM to segment the transcript into thematic sections matching the assembly agenda.',
      version: '0.1.0',
      status: 'online',
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      capabilities: [
        { name: 'transcription', description: 'Speech-to-text using Faster-Whisper with GPU acceleration', pipelineStage: 'transcribing' },
        { name: 'diarization', description: 'Speaker identification using Pyannote with GPU' },
        { name: 'sectioning', description: 'LLM-based thematic segmentation of transcripts', pipelineStage: 'sectioning' },
      ],
      tools: [
        { name: 'get-progress', description: 'Get transcription progress for all jobs', endpoint: '/api/agents/jaime/queue', method: 'GET', async: false, inputSchema: {}, outputSchema: { jobs: 'JaimeJobProgress[]' } },
        { name: 'get-transcript', description: 'Get raw transcript for a job', endpoint: '/api/agents/jaime/transcript/:jobId', method: 'GET', async: false, inputSchema: { jobId: 'string' }, outputSchema: { utterances: 'Utterance[]', speakers: 'string[]' } },
      ],
      callback: { type: 'redis-pubsub', channel: 'agent:jaime:events' },
      healthCheck: { endpoint: '/api/health', intervalMs: 30000 },
    },

    {
      agentId: 'lina',
      name: 'Lina',
      description: 'AI Redaction Engine. Takes transcript sections from Jaime and transforms them into formal legal narrative (acta) using Claude via OpenRouter. Reconciles speaker identities, applies Colombian legal terminology (Ley 675/2001), and maintains factual accuracy.',
      version: '0.1.0',
      status: 'online',
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      capabilities: [
        { name: 'redaction', description: 'Transform transcript sections into formal minutes narrative', pipelineStage: 'redacting' },
        { name: 'speaker-reconciliation', description: 'Unify speaker labels across audio chunks using LLM' },
      ],
      tools: [
        { name: 'get-progress', description: 'Get redaction progress for all jobs', endpoint: '/api/agents/lina/queue', method: 'GET', async: false, inputSchema: {}, outputSchema: { jobs: 'LinaJobProgress[]' } },
        { name: 'preview', description: 'Get markdown preview of redacted sections', endpoint: '/api/agents/lina/preview/:jobId', method: 'GET', async: false, inputSchema: { jobId: 'string' }, outputSchema: { markdown: 'string', sections: 'number' } },
      ],
      callback: { type: 'redis-pubsub', channel: 'agent:lina:events' },
      healthCheck: { endpoint: '/api/health', intervalMs: 30000 },
    },

    {
      agentId: 'fannery',
      name: 'Fannery',
      description: 'Document Assembly. Takes redacted sections from Lina and assembles them into a formatted .docx document with cover page, headers/footers, numbered sections, voting result tables, signature blocks, and proper legal formatting.',
      version: '0.1.0',
      status: 'online',
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      capabilities: [
        { name: 'assembly', description: 'Assemble redacted sections into .docx document', pipelineStage: 'assembling' },
        { name: 'pdf-render', description: 'Render markdown to PDF for preview' },
        { name: 'voting-tables', description: 'Build formatted voting result tables from Robinson data' },
      ],
      tools: [
        { name: 'get-progress', description: 'Get assembly progress for all jobs', endpoint: '/api/agents/fannery/queue', method: 'GET', async: false, inputSchema: {}, outputSchema: { jobs: 'FanneryJobProgress[]' } },
        { name: 'reprocess', description: 'Re-run document assembly for a job', endpoint: '/api/agents/fannery/reprocess/:jobId', method: 'POST', async: true, inputSchema: { jobId: 'string' }, outputSchema: { ok: 'boolean' } },
        { name: 'get-template', description: 'Get the document template configuration', endpoint: '/api/agents/fannery/template', method: 'GET', async: false, inputSchema: {}, outputSchema: { template: 'DocumentTemplate' } },
        { name: 'update-template', description: 'Update the document template', endpoint: '/api/agents/fannery/template', method: 'PUT', async: false, inputSchema: { template: 'DocumentTemplate' }, outputSchema: { updated: 'boolean' } },
      ],
      callback: { type: 'redis-pubsub', channel: 'agent:fannery:events' },
      healthCheck: { endpoint: '/api/health', intervalMs: 30000 },
    },

    {
      agentId: 'gloria',
      name: 'Gloria',
      description: 'Review & Approval. Runs LLM-based quality review on assembled documents, checking for factual inconsistencies, voting mismatches, missing content, and numerical errors. Provides a review dashboard for human verification.',
      version: '0.1.0',
      status: 'online',
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      capabilities: [
        { name: 'review', description: 'LLM-powered quality review of assembled documents', pipelineStage: 'reviewing' },
        { name: 'dashboard', description: 'Serve the Transcriptor web dashboard' },
      ],
      tools: [
        { name: 'start-review', description: 'Start LLM review for a job', endpoint: '/api/review/start/:jobId', method: 'POST', async: true, inputSchema: { jobId: 'string' }, outputSchema: { reviewId: 'string' } },
        { name: 'get-review', description: 'Get review results for a job', endpoint: '/api/review/:jobId', method: 'GET', async: false, inputSchema: { jobId: 'string' }, outputSchema: { items: 'ReviewItem[]', stats: 'ReviewStats' } },
        { name: 'get-prompts', description: 'List all agent chat prompts', endpoint: '/api/agents/prompts', method: 'GET', async: false, inputSchema: {}, outputSchema: { prompts: 'Record<string, PromptInfo>' } },
        { name: 'update-prompt', description: 'Update an agent chat prompt', endpoint: '/api/agents/:agentId/prompt', method: 'PUT', async: false, inputSchema: { agentId: 'string', prompt: 'string' }, outputSchema: { updated: 'boolean' } },
      ],
      callback: { type: 'redis-pubsub', channel: 'agent:gloria:events' },
      healthCheck: { endpoint: '/api/health', intervalMs: 30000 },
    },

    {
      agentId: 'supervisor',
      name: 'Supervisor',
      description: 'Pipeline Orchestrator. Manages the pipeline state machine, dispatches work to agents at each stage, tracks job progress, and handles error recovery. Queries the Agent Registry to understand system capabilities.',
      version: '0.1.0',
      status: 'online',
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      capabilities: [
        { name: 'orchestration', description: 'Drive jobs through pipeline stages' },
        { name: 'state-management', description: 'Track and persist pipeline job state in Redis' },
        { name: 'agent-discovery', description: 'Query the Agent Registry for system capabilities' },
      ],
      tools: [
        { name: 'get-pipeline', description: 'Get pipeline overview of all jobs', endpoint: '/api/pipeline', method: 'GET', async: false, inputSchema: {}, outputSchema: { activeJobs: 'number', jobs: 'PipelineJob[]' } },
        { name: 'get-kanban', description: 'Get kanban board view of all jobs', endpoint: '/api/pipeline/kanban', method: 'GET', async: false, inputSchema: {}, outputSchema: { columns: 'KanbanColumn[]' } },
        { name: 'get-registry', description: 'Get all registered agent manifests', endpoint: '/api/agents/registry', method: 'GET', async: false, inputSchema: {}, outputSchema: { agents: 'AgentManifest[]' } },
        { name: 'get-registry-summary', description: 'Get human-readable summary of all agents for LLM context', endpoint: '/api/agents/registry/summary', method: 'GET', async: false, inputSchema: {}, outputSchema: { summary: 'string' } },
      ],
      callback: { type: 'redis-pubsub', channel: 'agent:supervisor:events' },
      healthCheck: { endpoint: '/api/health', intervalMs: 30000 },
    },
  ];

  // Fisher only in local mode
  if (mode === 'local') {
    manifests.push({
      agentId: 'fisher',
      name: 'Fisher',
      description: 'GPU Worker Provisioner. Creates and manages ephemeral GPU instances on Linode for transcription workloads. Provisions, monitors heartbeat/resources, backs up results to local machine, and destroys workers when done.',
      version: '0.1.0',
      status: 'online',
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      capabilities: [
        { name: 'worker-provisioning', description: 'Create GPU instances on Linode via StackScript' },
        { name: 'worker-monitoring', description: 'Monitor GPU/RAM/disk metrics and Gloria health via SSH' },
        { name: 'job-backup', description: 'Rsync job results from remote worker to local machine' },
        { name: 'worker-lifecycle', description: 'Full elastic flow: provision, process, backup, destroy' },
      ],
      tools: [
        { name: 'get-status', description: 'Get Fisher status including worker state and heartbeats', endpoint: '/api/agents/fisher/status', method: 'GET', async: false, inputSchema: {}, outputSchema: { worker: 'WorkerInfo', heartbeats: 'WorkerHeartbeat[]' } },
        { name: 'provision', description: 'Create a new GPU worker instance', endpoint: '/api/agents/fisher/provision', method: 'POST', async: true, inputSchema: {}, outputSchema: { ip: 'string' } },
        { name: 'process-folder', description: 'Full elastic flow: provision worker, enqueue folder, monitor, backup, destroy', endpoint: '/api/agents/fisher/process-folder', method: 'POST', async: true, inputSchema: { driveFolderId: 'string', subfolderId: 'string' }, outputSchema: { jobId: 'string' } },
        { name: 'backup-and-destroy', description: 'Backup all jobs from worker and destroy it', endpoint: '/api/agents/fisher/backup-and-destroy', method: 'POST', async: true, inputSchema: {}, outputSchema: { backups: 'BackupResult[]' } },
        { name: 'destroy', description: 'Destroy the current worker instance', endpoint: '/api/agents/fisher/destroy', method: 'POST', async: false, inputSchema: {}, outputSchema: { ok: 'boolean' } },
        { name: 'get-heartbeats', description: 'Get heartbeat data for all workers', endpoint: '/api/agents/fisher/heartbeats', method: 'GET', async: false, inputSchema: {}, outputSchema: { heartbeats: 'WorkerHeartbeat[]' } },
      ],
      callback: { type: 'redis-pubsub', channel: 'agent:fisher:events' },
      healthCheck: { endpoint: '/api/agents/fisher/status', intervalMs: 30000 },
    });
  }

  return manifests;
}
