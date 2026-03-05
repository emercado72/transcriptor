import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { sql } from 'drizzle-orm';
import OpenAI from 'openai';
import { createLogger, getEnvConfig, getDb, gwDriveListFiles, getRedisClient, EventStatus } from '@transcriptor/shared';
import type { JobId, SectionId, EventFolder, ReviewItemStatus } from '@transcriptor/shared';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions.js';
import {
  analyzeDocument,
  getReviewSession,
  updateItemStatus,
  applyFix,
  restoreReviewSessions,
  loadTranscriptSegments,
  getAudioFileMap,
  saveDocument,
  exportDocument,
  getAllReviewSessions,
} from './reviewService.js';

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
  app.use(express.json({ limit: '5mb' }));

  // ── Routes ──

  // Health check
  // Runtime mode: 'local' (Mac Mini, Fisher active) or 'gpu-worker' (remote GPU, no Fisher)
  const RUNTIME_MODE = process.env.RUNTIME_MODE || 'local';
  logger.info(`Runtime mode: ${RUNTIME_MODE}`);

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', agent: 'gloria', mode: RUNTIME_MODE, timestamp: new Date().toISOString() });
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

  // ══════════════════════════════════════
  //  YULIETH CONFIG / QUEUE / WATCHER
  // ══════════════════════════════════════

  // Get Yulieth config
  app.get('/api/agents/yulieth/config', (_req, res) => {
    res.json(yuliethConfig);
  });

  // Update Yulieth config
  app.put('/api/agents/yulieth/config', (req, res) => {
    const body = req.body;
    if (body.driveFolderId !== undefined) yuliethConfig.driveFolderId = String(body.driveFolderId);
    if (body.pollIntervalSeconds !== undefined) yuliethConfig.pollIntervalSeconds = Math.max(30, Number(body.pollIntervalSeconds) || 60);
    if (body.autoQueue !== undefined) yuliethConfig.autoQueue = Boolean(body.autoQueue);
    if (body.audioExtensions !== undefined) yuliethConfig.audioExtensions = body.audioExtensions;
    if (body.votingExtensions !== undefined) yuliethConfig.votingExtensions = body.votingExtensions;
    saveYuliethConfig();
    logger.info('Yulieth config updated', yuliethConfig);
    res.json({ config: yuliethConfig });
  });

  // Start / Stop watcher
  app.post('/api/agents/yulieth/watcher', (req, res) => {
    const { action } = req.body;
    if (action === 'start') {
      if (!yuliethConfig.driveFolderId) {
        return res.status(400).json({ error: 'driveFolderId is required to start watcher' });
      }
      startYuliethWatcher();
      res.json({ isWatching: yuliethConfig.isWatching });
    } else if (action === 'stop') {
      stopYuliethWatcher();
      res.json({ isWatching: yuliethConfig.isWatching });
    } else {
      res.status(400).json({ error: 'action must be "start" or "stop"' });
    }
  });

  // Manual drive scan
  app.post('/api/agents/yulieth/drive-scan', async (req, res) => {
    try {
      const folderId = req.body.folderId || yuliethConfig.driveFolderId;
      if (!folderId) {
        return res.status(400).json({ error: 'No folderId provided' });
      }
      const folders = await scanDriveFolder(folderId);
      res.json({ folders });
    } catch (err) {
      logger.error('Drive scan error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get queue (detected folders + stats)
  app.get('/api/agents/yulieth/queue', async (_req, res) => {
    try {
      const data = await getYuliethQueue();
      res.json(data);
    } catch (err) {
      logger.error('Queue fetch error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Enqueue a detected folder
  app.post('/api/agents/yulieth/enqueue', async (req, res) => {
    try {
      const { folderId } = req.body;
      if (!folderId) {
        return res.status(400).json({ error: 'folderId required' });
      }
      const result = await enqueueDetectedFolder(folderId);
      res.json(result);
    } catch (err) {
      logger.error('Enqueue error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Pipeline Job Endpoints ──

  // Get pipeline status for a specific job
  app.get('/api/pipeline/:jobId', async (req, res) => {
    try {
      const supervisor = await import('@transcriptor/supervisor');
      const status = await supervisor.getPipelineStatus(req.params.jobId);
      if (!status) {
        return res.status(404).json({ error: 'Pipeline job not found' });
      }
      res.json(status);
    } catch (err) {
      logger.error('Pipeline status error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // List all active pipelines
  app.get('/api/pipelines', async (_req, res) => {
    try {
      const supervisor = await import('@transcriptor/supervisor');
      const pipelines = await supervisor.getActivePipelines();
      res.json(pipelines);
    } catch (err) {
      logger.error('Pipelines list error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Retry a failed pipeline stage via Supervisor's event bus
  app.post('/api/pipeline/:jobId/retry', async (req, res) => {
    try {
      const { jobId } = req.params;
      const { stage } = req.body; // e.g. 'preprocessing', 'transcribing'
      const { publishEvent } = await import('@transcriptor/shared');
      const supervisor = await import('@transcriptor/supervisor');

      // Verify pipeline exists
      const status = await supervisor.getPipelineStatus(jobId);
      if (!status) {
        return res.status(404).json({ error: 'Pipeline job not found' });
      }

      if (!stage) {
        return res.status(400).json({ error: 'stage is required (e.g. preprocessing, transcribing)' });
      }

      logger.info(`Manual retry requested for job ${jobId}, stage ${stage}`);

      // Publish retry event — Supervisor will handle it
      await publishEvent({
        type: 'job_retry',
        jobId,
        agent: 'gloria',
        timestamp: new Date().toISOString(),
        data: { stage },
      });

      res.json({ success: true, jobId, stage, message: `Retry for ${stage} queued to Supervisor` });
    } catch (err) {
      logger.error('Retry error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Supervisor Kanban Endpoint ──
  app.get('/api/supervisor/kanban', async (_req, res) => {
    try {
      const supervisor = await import('@transcriptor/supervisor');
      const kanban = await supervisor.getKanbanBoard();
      res.json(kanban);
    } catch (err) {
      logger.error('Kanban fetch error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Chucho Queue Endpoint ──
  app.get('/api/agents/chucho/queue', (_req, res) => {
    try {
      const jobs = getAllChuchoProgress();
      res.json({ jobs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Jaime Queue Endpoint ──
  app.get('/api/agents/jaime/queue', async (_req, res) => {
    try {
      const jaime = await import('@transcriptor/jaime');
      const jobs = await jaime.getAllJobProgress();
      res.json({ jobs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Lina Queue Endpoint ──
  app.get('/api/agents/lina/queue', async (_req, res) => {
    try {
      const lina = await import('@transcriptor/lina');
      const jobs = lina.getAllLinaProgress();
      res.json({ jobs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Lina Reprocess Endpoint ──
  app.post('/api/agents/lina/reprocess/:jobId', async (req, res) => {
    try {
      const { jobId } = req.params;
      const lina = await import('@transcriptor/lina');
      const { publishSuccess, publishFailure } = await import('@transcriptor/shared');

      const progress = lina.getAllLinaProgress().find(j => j.jobId === jobId);
      if (!progress) {
        return res.status(404).json({ error: 'Job not found in Lina queue' });
      }

      logger.info(`Reprocessing Lina job ${jobId} (previous status: ${progress.status})`);

      // Reset pipeline state to REDACTING so supervisor reports accurately
      try {
        const supervisor = await import('@transcriptor/supervisor');
        const { EventStatus } = await import('@transcriptor/shared');
        await supervisor.advanceStage(jobId, EventStatus.REDACTING);
        logger.info(`Pipeline ${jobId} reset to REDACTING for reprocess`);
      } catch (stateErr) {
        logger.warn(`Could not reset pipeline state for ${jobId}: ${(stateErr as Error).message}`);
      }

      res.json({ ok: true, message: `Reprocessing job ${jobId}` });

      // Run redaction asynchronously so the HTTP response is immediate
      setImmediate(async () => {
        try {
          const result = await lina.processJob(jobId);
          logger.info(
            `Lina reprocess done for ${jobId}: ${result.sectionsRedacted} sections redacted, ` +
            `${result.reconciliation.globalSpeakers.length} speakers reconciled`,
          );
          await publishSuccess('redaction_done', jobId, 'lina', {
            sectionsRedacted: result.sectionsRedacted,
            globalSpeakers: result.reconciliation.globalSpeakers.length,
            identifiedSpeakers: Object.keys(result.reconciliation.identifiedSpeakers).length,
            confidence: result.reconciliation.confidence,
            validationErrors: result.validationErrors.length,
            validationWarnings: result.validationWarnings.length,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`Lina reprocess failed for ${jobId}: ${msg}`);
          lina.markLinaFailed(jobId, msg);
          await publishFailure('redaction_failed', jobId, 'lina', msg);
        }
      });
    } catch (err) {
      logger.error('Lina reprocess error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });


  // ── Jaime Resection Endpoint — re-runs LLM segmentation on existing transcript ──
  app.post('/api/agents/jaime/resection/:jobId', async (req, res) => {
    try {
      const { jobId } = req.params;
      const fsSync = await import('node:fs');
      const fsAsync = await import('node:fs/promises');
      const nodePath = await import('node:path');
      const { getEnvConfig } = await import('@transcriptor/shared');

      const env = getEnvConfig();
      const projectRoot = nodePath.default.resolve(import.meta.dirname, '../../..');
      const dataDir = nodePath.default.join(projectRoot, 'data', 'jobs');
      const base = nodePath.default.join(dataDir, jobId);
      const transcriptPath = nodePath.default.join(base, 'transcript/transcript.json');
      const sectionsDir = nodePath.default.join(base, 'sections');

      if (!fsSync.existsSync(transcriptPath)) {
        return res.status(404).json({ error: `transcript.json not found for job ${jobId}` });
      }

      res.json({ ok: true, message: `Resectioning job ${jobId} with LLM segmenter` });

      setImmediate(async () => {
        try {
          logger.info(`Resectioning ${jobId}: loading transcript`);
          const raw = await fsAsync.default.readFile(transcriptPath, 'utf-8');
          const transcript = JSON.parse(raw);

          let questionList: any[] = [];
          try {
            const mRaw = await fsAsync.default.readFile(nodePath.default.join(base, 'processed/manifest.json'), 'utf-8');
            questionList = JSON.parse(mRaw).questionList || [];
          } catch { /* no questions */ }

          logger.info(`Resectioning ${jobId}: ${transcript.utterances.length} utterances, ${questionList.length} questions`);

          const jaime = await import('@transcriptor/jaime');
          const sections = await jaime.mapTranscriptToSections(transcript, questionList);

          // Clear old sections
          await fsAsync.default.mkdir(sectionsDir, { recursive: true });
          const oldFiles = await fsAsync.default.readdir(sectionsDir);
          for (const f of oldFiles) {
            await fsAsync.default.unlink(nodePath.default.join(sectionsDir, f));
          }

          // Write new sections
          for (const section of sections as any[]) {
            await fsAsync.default.writeFile(
              nodePath.default.join(sectionsDir, `${section.sectionId}.json`),
              JSON.stringify(section, null, 2)
            );
          }

          logger.info(`Resectioning ${jobId} complete: ${(sections as any[]).length} sections written`);

          // Reset pipeline state to sectioning complete so Lina can pick it up
          const supervisor = await import('@transcriptor/supervisor');
          const { EventStatus, publishSuccess } = await import('@transcriptor/shared');
          await supervisor.advanceStage(jobId, EventStatus.SECTIONING);
          await supervisor.markStageComplete(jobId, EventStatus.SECTIONING);
          logger.info(`Pipeline ${jobId} advanced to SECTIONING complete`);

          // Now trigger Lina
          await supervisor.advanceStage(jobId, EventStatus.REDACTING);
          await publishSuccess('transcription_done', jobId, 'jaime', {
            sectionCount: (sections as any[]).length,
          });
          logger.info(`Published transcription_done for ${jobId} — Lina should pick it up`);
        } catch (err) {
          logger.error(`Resectioning ${jobId} failed: ${(err as Error).message}`);
        }
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Gloria Queue Endpoint ──
  app.get('/api/agents/gloria/queue', async (_req, res) => {
    try {
      const sessions = getAllReviewSessions();
      // Enrich each session with clientName from the pipeline state
      const supervisor = await import('@transcriptor/supervisor');
      const jobs = await Promise.all(sessions.map(async (s) => {
        let clientName: string | undefined;
        try {
          const pipelineJob = await supervisor.loadState(s.jobId);
          clientName = pipelineJob?.clientName;
        } catch { /* not critical */ }
        return {
          jobId: s.jobId,
          clientName,
          status: s.status,
          startedAt: s.startedAt,
          completedAt: s.completedAt,
          error: s.error,
          stats: s.stats,
          itemCount: s.items.length,
        };
      }));
      res.json({ jobs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Fannery Queue Endpoint ──
  app.get('/api/agents/fannery/queue', async (_req, res) => {
    try {
      const fannery = await import('@transcriptor/fannery');
      const jobs = fannery.getAllFanneryProgress();
      res.json({ jobs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Fannery Document Download Endpoint ──
  app.get('/api/agents/fannery/download/:jobId', async (req, res) => {
    try {
      const { jobId } = req.params;
      const fannery = await import('@transcriptor/fannery');
      const progress = fannery.getAllFanneryProgress().find(j => j.jobId === jobId);

      if (!progress) {
        return res.status(404).json({ error: 'Job not found' });
      }
      if (progress.status !== 'completed' || !progress.assembly?.outputPath) {
        return res.status(400).json({ error: 'Document not available yet' });
      }

      const filePath = progress.assembly.outputPath;
      const fs = await import('fs');
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Document file not found on disk' });
      }

      const fileName = path.basename(filePath);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      logger.error('Fannery download error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });
  // Lina Section Preview Endpoint
  app.get("/api/agents/lina/preview/:jobId", async (req, res) => {
    try {
      const { jobId } = req.params;
      const path2 = await import("path");
      const fs2 = await import("fs");
      const redactedDir = path2.default.join(process.cwd(), "data", "jobs", jobId, "redacted");
      if (!fs2.default.existsSync(redactedDir)) return res.status(404).json({ error: "No redacted sections found" });
      const files = fs2.default.readdirSync(redactedDir).filter((f) => f.endsWith(".json") && f !== "manifest.json").sort();
      if (files.length === 0) return res.status(400).json({ error: "No sections redacted yet" });
      const sections = [];
      for (const file of files) {
        try {
          const raw = JSON.parse(fs2.default.readFileSync(path2.default.join(redactedDir, file), "utf-8"));
          const title = raw.sectionTitle || raw.sectionId || file.replace(".json", "");
          const text = (raw.content || []).map((b) => b.text || "").filter(Boolean).join("\n\n");
          sections.push("## " + title + "\n\n" + text);
        } catch {}
      }
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.send(sections.join("\n\n---\n\n"));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });


  // ── Fannery Markdown Preview Endpoint ──
  app.get('/api/agents/fannery/preview/:jobId', async (req, res) => {
    try {
      const { jobId } = req.params;
      const fannery = await import('@transcriptor/fannery');
      const progress = fannery.getAllFanneryProgress().find(j => j.jobId === jobId);

      if (!progress) {
        return res.status(404).json({ error: 'Job not found' });
      }
      if (progress.status !== 'completed' || !progress.assembly?.markdownPath) {
        return res.status(400).json({ error: 'Markdown preview not available yet' });
      }

      const mdPath = progress.assembly.markdownPath;
      const fs2 = await import('fs');
      if (!fs2.existsSync(mdPath)) {
        return res.status(404).json({ error: 'Markdown file not found on disk' });
      }

      const content = fs2.readFileSync(mdPath, 'utf-8');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.send(content);
    } catch (err) {
      logger.error('Fannery preview error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Fannery PDF Download Endpoint ──
  app.get('/api/agents/fannery/pdf/:jobId', async (req, res) => {
    try {
      const { jobId } = req.params;
      const fannery = await import('@transcriptor/fannery');
      const progress = fannery.getAllFanneryProgress().find(j => j.jobId === jobId);

      if (!progress) {
        return res.status(404).json({ error: 'Job not found' });
      }
      if (progress.status !== 'completed' || !progress.assembly?.pdfPath) {
        // Fallback: try to generate PDF on the fly from markdown
        if (progress.status === 'completed' && progress.assembly?.markdownPath) {
          const fs2 = await import('fs');
          if (fs2.existsSync(progress.assembly.markdownPath)) {
            const markdown = fs2.readFileSync(progress.assembly.markdownPath, 'utf-8');
            const pdfBuffer = await fannery.renderMarkdownAsPdf(markdown);
            const fileName = path.basename(progress.assembly.markdownPath).replace('.md', '.pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
            res.setHeader('Content-Type', 'application/pdf');
            res.send(Buffer.from(pdfBuffer));
            return;
          }
        }
        return res.status(400).json({ error: 'PDF not available yet' });
      }

      const pdfPath = progress.assembly.pdfPath;
      const fs2 = await import('fs');
      if (!fs2.existsSync(pdfPath)) {
        return res.status(404).json({ error: 'PDF file not found on disk' });
      }

      const fileName = path.basename(pdfPath);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      res.setHeader('Content-Type', 'application/pdf');
      fs2.createReadStream(pdfPath).pipe(res);
    } catch (err) {
      logger.error('Fannery PDF download error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Fannery Reprocess Endpoint ──
  app.post('/api/agents/fannery/reprocess/:jobId', async (req, res) => {
    try {
      const { jobId } = req.params;
      const fannery = await import('@transcriptor/fannery');
      const { publishSuccess, publishFailure } = await import('@transcriptor/shared');

      const progress = fannery.getAllFanneryProgress().find(j => j.jobId === jobId);
      if (!progress) {
        return res.status(404).json({ error: 'Job not found in Fannery queue' });
      }

      logger.info(`Reprocessing Fannery job ${jobId} (previous status: ${progress.status})`);

      // Reset pipeline state to ASSEMBLING so supervisor reports accurately
      try {
        const supervisor = await import('@transcriptor/supervisor');
        const { EventStatus } = await import('@transcriptor/shared');
        await supervisor.advanceStage(jobId, EventStatus.ASSEMBLING);
        logger.info(`Pipeline ${jobId} reset to ASSEMBLING for reprocess`);
      } catch (stateErr) {
        logger.warn(`Could not reset pipeline state for ${jobId}: ${(stateErr as Error).message}`);
      }

      res.json({ ok: true, message: `Reprocessing job ${jobId}` });

      // Run assembly asynchronously so the HTTP response is immediate
      setImmediate(async () => {
        try {
          const result = await fannery.processJob(jobId);
          logger.info(
            `Fannery reprocess done for ${jobId}: ${result.sectionsAssembled} sections, ` +
            `${result.documentSizeBytes} bytes`,
          );
          await publishSuccess('assembly_done', jobId, 'fannery', {
            sectionsAssembled: result.sectionsAssembled,
            documentSizeBytes: result.documentSizeBytes,
            documentPath: result.documentPath,
            driveFileId: result.driveFileId,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`Fannery reprocess failed for ${jobId}: ${msg}`);
          fannery.markFanneryFailed(jobId, msg);
          await publishFailure('assembly_failed', jobId, 'fannery', msg);
        }
      });
    } catch (err) {
      logger.error('Fannery reprocess error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -- Fisher GPU Worker Endpoints (local mode only) --
  if (RUNTIME_MODE === 'local') {
    let fisher: typeof import('@transcriptor/fisher') | null = null;

    const getFisher = async () => {
      if (!fisher) {
        fisher = await import('@transcriptor/fisher');
        fisher.initFisher();
      }
      return fisher;
    };

    app.get('/api/agents/fisher/status', async (_req, res) => {
      try {
        const f = await getFisher();
        res.json(f.getStatus());
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.get('/api/agents/fisher/heartbeats', async (_req, res) => {
      try {
        const f = await getFisher();
        res.json(f.getAllHeartbeats());
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post('/api/agents/fisher/provision', async (_req, res) => {
      try {
        const f = await getFisher();
        const ip = await f.provisionWorker();
        res.json({ ok: true, ip });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post('/api/agents/fisher/process-folder', async (req, res) => {
      try {
        const { driveFolderId, subfolderId } = req.body;
        if (!driveFolderId || !subfolderId) {
          return res.status(400).json({ error: 'driveFolderId and subfolderId required' });
        }
        const f = await getFisher();
        res.json({ ok: true, message: 'Fisher processing started' });
        f.processFolder(driveFolderId, subfolderId).catch((err: Error) => {
          logger.error('Fisher processFolder failed: ' + err.message);
        });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post('/api/agents/fisher/backup-and-destroy', async (_req, res) => {
      try {
        const f = await getFisher();
        const results = await f.backupAndDestroy();
        res.json({ ok: true, backups: results });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    app.post('/api/agents/fisher/destroy', async (_req, res) => {
      try {
        const f = await getFisher();
        await f.destroyWorker();
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    });

    logger.info('Fisher endpoints registered (local mode)');
  } else {
    logger.info('Fisher endpoints skipped (gpu-worker mode)');
  }

  // -- Agent Prompt Endpoints (view/edit system prompts at runtime) --
  // Prompts persist to config/agent-prompts.json and sync to S3

  const PROMPTS_FILE = path.resolve(import.meta.dirname, '../../../config/agent-prompts.json');

  function loadPromptsFromDisk(): void {
    try {
      if (fs.existsSync(PROMPTS_FILE)) {
        const raw = fs.readFileSync(PROMPTS_FILE, 'utf-8');
        const saved = JSON.parse(raw) as Record<string, string>;
        let count = 0;
        for (const [id, prompt] of Object.entries(saved)) {
          if (prompt && typeof prompt === 'string') {
            AGENT_SYSTEM_PROMPTS[id] = prompt;
            count++;
          }
        }
        logger.info(`Loaded ${count} saved prompt(s) from ${PROMPTS_FILE}`);
      }
    } catch (err) {
      logger.warn('Failed to load prompts from disk: ' + (err as Error).message);
    }
  }

  function savePromptsToDisk(): void {
    try {
      const dir = path.dirname(PROMPTS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(PROMPTS_FILE, JSON.stringify(AGENT_SYSTEM_PROMPTS, null, 2), 'utf-8');
      logger.info(`Prompts saved to ${PROMPTS_FILE}`);
    } catch (err) {
      logger.error('Failed to save prompts to disk: ' + (err as Error).message);
    }
  }

  async function syncPromptsToS3(): Promise<void> {
    try {
      const { execSync } = await import('child_process');
      execSync(
        `s3cmd put ${PROMPTS_FILE} s3://t2025-registry/transcriptor/agent-prompts.json --force 2>/dev/null`,
        { encoding: 'utf-8', timeout: 15_000 },
      );
      logger.info('Prompts synced to S3');
    } catch (err) {
      logger.warn('S3 sync failed (s3cmd not configured or unavailable): ' + (err as Error).message);
    }
  }

  async function loadPromptsFromS3(): Promise<void> {
    try {
      if (fs.existsSync(PROMPTS_FILE)) return; // local file takes priority
      const { execSync } = await import('child_process');
      execSync(
        `s3cmd get s3://t2025-registry/transcriptor/agent-prompts.json ${PROMPTS_FILE} --force 2>/dev/null`,
        { encoding: 'utf-8', timeout: 15_000 },
      );
      logger.info('Prompts downloaded from S3');
      loadPromptsFromDisk();
    } catch {
      // S3 not available or no saved prompts — use defaults
    }
  }

  // Load saved prompts on startup (disk first, then S3 fallback)
  loadPromptsFromDisk();
  void loadPromptsFromS3();

  app.get('/api/agents/:agentId/prompt', (req, res) => {
    const { agentId } = req.params;
    const prompt = AGENT_SYSTEM_PROMPTS[agentId];
    if (!prompt) {
      return res.status(404).json({ error: 'No prompt found for agent: ' + agentId });
    }
    res.json({ agentId, prompt });
  });

  app.put('/api/agents/:agentId/prompt', async (req, res) => {
    const { agentId } = req.params;
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt (string) required in body' });
    }
    AGENT_SYSTEM_PROMPTS[agentId] = prompt;
    savePromptsToDisk();
    logger.info('Prompt updated for agent: ' + agentId + ' (' + prompt.length + ' chars)');
    res.json({ agentId, updated: true, length: prompt.length });
    // Sync to S3 in background (don't block response)
    void syncPromptsToS3();
  });

  app.get('/api/agents/prompts', (_req, res) => {
    const prompts: Record<string, { agentId: string; length: number; preview: string }> = {};
    for (const [id, p] of Object.entries(AGENT_SYSTEM_PROMPTS)) {
      prompts[id] = { agentId: id, length: p.length, preview: p.slice(0, 120) + '...' };
    }
    res.json(prompts);
  });

  // -- Processing Prompts (the prompts agents send to Claude for actual work) --
  const PROCESSING_PROMPTS_FILE = path.resolve(import.meta.dirname, '../../../config/processing-prompts.json');

  // Registry of processing prompts with their source locations
  const PROCESSING_PROMPTS: Record<string, { label: string; prompt: string }> = {};

  function initProcessingPrompts(): void {
    // Default processing prompts (seeded from agent source code)
    // These get overridden by saved versions from disk/S3

    if (!PROCESSING_PROMPTS['jaime:segmentation']) {
      PROCESSING_PROMPTS['jaime:segmentation'] = {
        label: 'Jaime — Section Segmentation',
        prompt: `Eres un experto en actas de asamblea de propiedad horizontal colombiana.
Recibirás un índice de utterances de una transcripción de asamblea (formato: índice|hablante|texto).
Tu tarea: identificar las secciones temáticas del acta y devolver un plan de segmentación en JSON.

Secciones típicas de un acta (usa EXACTAMENTE estos valores en el campo "style"):
- preambulo: apertura, verificación de quórum, declaración de inicio
- ordenDelDia: lectura y aprobación del orden del día
- paragraphNormal: puntos del orden del día, informes, debates
- votingQuestion: cuando se somete algo a votación
- firma: cierre, firmas, despedida

Reglas:
1. Cada sección debe tener al menos 3 utterances salvo preambulo y firma
2. El acta típicamente tiene 8-15 puntos — identifícalos como secciones paragraphNormal separadas
3. Agrupa utterances consecutivos del mismo tema en la misma sección
4. Los utterances de votación y su anuncio de resultado van juntos en una sección votingQuestion
5. Devuelve SOLO JSON válido, sin markdown, sin explicaciones`,
      };
    }

    if (!PROCESSING_PROMPTS['lina:redaction']) {
      // Load from docs/prompts/superPrompt.md if it exists, otherwise use default
      const superPromptPath = path.resolve(import.meta.dirname, '../../../docs/prompts/superPrompt.md');
      let superPrompt = '';
      try {
        if (fs.existsSync(superPromptPath)) {
          superPrompt = fs.readFileSync(superPromptPath, 'utf-8');
        }
      } catch { /* use default */ }

      PROCESSING_PROMPTS['lina:redaction'] = {
        label: 'Lina — Redaction Super Prompt',
        prompt: superPrompt || `Eres un redactor profesional de actas de asamblea de propiedad horizontal en Colombia.
Tu trabajo es transformar transcripciones de audio en narrativa formal legal conforme a la Ley 675 de 2001.

Reglas:
1. Usa lenguaje formal y jurídico colombiano
2. Mantén la objetividad — no interpretes, narra los hechos
3. Identifica correctamente a los propietarios por nombre completo y unidad
4. Los resultados de votaciones deben reflejar exactamente los datos de Robinson
5. Usa el formato y estilo indicado para cada tipo de sección
6. Las cifras de coeficientes y quórum deben ser exactas
7. Respeta la terminología del glosario proporcionado
8. Los nombres propios de personas SIEMPRE en MAYÚSCULAS SOSTENIDAS`,
      };
    }

    if (!PROCESSING_PROMPTS['lina:reconciliation']) {
      PROCESSING_PROMPTS['lina:reconciliation'] = {
        label: 'Lina — Speaker Reconciliation',
        prompt: `You are a speaker diarization reconciler for Colombian property assembly recordings.
The audio was split into chunks before diarization, so each chunk has independent speaker labels.
Your job: Create a unified speaker mapping by analyzing boundary continuity, self-introductions, role patterns, vocabulary, and topic continuity.
Respond ONLY with valid JSON.`,
      };
    }

    // Load saved overrides from disk (these take priority)
    try {
      if (fs.existsSync(PROCESSING_PROMPTS_FILE)) {
        const saved = JSON.parse(fs.readFileSync(PROCESSING_PROMPTS_FILE, 'utf-8'));
        for (const [id, data] of Object.entries(saved as Record<string, { label: string; prompt: string }>)) {
          PROCESSING_PROMPTS[id] = data;
        }
        logger.info(`Loaded ${Object.keys(saved).length} processing prompt(s) from disk`);
      }
    } catch (err) {
      logger.warn('Failed to load processing prompts from disk: ' + (err as Error).message);
    }
  }

  function saveProcessingPromptsToDisk(): void {
    try {
      const dir = path.dirname(PROCESSING_PROMPTS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(PROCESSING_PROMPTS_FILE, JSON.stringify(PROCESSING_PROMPTS, null, 2), 'utf-8');
      logger.info(`Processing prompts saved to ${PROCESSING_PROMPTS_FILE}`);
    } catch (err) {
      logger.error('Failed to save processing prompts: ' + (err as Error).message);
    }
  }

  async function syncProcessingPromptsToS3(): Promise<void> {
    try {
      const { execSync } = await import('child_process');
      execSync(
        `s3cmd put ${PROCESSING_PROMPTS_FILE} s3://t2025-registry/transcriptor/processing-prompts.json --force 2>/dev/null`,
        { encoding: 'utf-8', timeout: 15_000 },
      );
      logger.info('Processing prompts synced to S3');
    } catch { /* s3cmd not available locally — fine */ }
  }

  initProcessingPrompts();

  app.get('/api/agents/:agentId/processing-prompt', (req, res) => {
    const { agentId } = req.params;
    // Find all processing prompts for this agent
    const matching = Object.entries(PROCESSING_PROMPTS)
      .filter(([key]) => key.startsWith(agentId + ':'))
      .map(([key, data]) => ({ key, ...data }));
    if (matching.length === 0) {
      return res.status(404).json({ error: 'No processing prompts for: ' + agentId });
    }
    res.json({ agentId, prompts: matching });
  });

  app.get('/api/processing-prompts', (_req, res) => {
    const list = Object.entries(PROCESSING_PROMPTS).map(([key, data]) => ({
      key,
      label: data.label,
      length: data.prompt.length,
      preview: data.prompt.slice(0, 120) + '...',
    }));
    res.json(list);
  });

  app.get('/api/processing-prompts/:key', (req, res) => {
    const data = PROCESSING_PROMPTS[req.params.key];
    if (!data) return res.status(404).json({ error: 'Not found: ' + req.params.key });
    res.json({ key: req.params.key, ...data });
  });

  app.put('/api/processing-prompts/:key', async (req, res) => {
    const { key } = req.params;
    const { prompt, label } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt (string) required' });
    }
    PROCESSING_PROMPTS[key] = { label: label || PROCESSING_PROMPTS[key]?.label || key, prompt };
    saveProcessingPromptsToDisk();
    logger.info('Processing prompt updated: ' + key + ' (' + prompt.length + ' chars)');
    res.json({ key, updated: true, length: prompt.length });
    void syncProcessingPromptsToS3();
  });

  // ══════════════════════════════════════
  //  GLORIA REVIEW ENDPOINTS
  // ══════════════════════════════════════

  // Start LLM review analysis for a job
  app.post('/api/review/start/:jobId', async (req, res) => {
    try {
      const { jobId } = req.params;

      // Check if a session already exists
      const existing = getReviewSession(jobId);
      if (existing && (existing.status === 'analyzing' || existing.status === 'ready' || existing.status === 'in_review')) {
        return res.json({ session: existing });
      }

      // Load the markdown content from Fannery's output
      const fannery = await import('@transcriptor/fannery');
      const progress = fannery.getAllFanneryProgress().find(j => j.jobId === jobId);

      let markdownContent: string;
      if (progress?.assembly?.markdownPath && fs.existsSync(progress.assembly.markdownPath)) {
        markdownContent = fs.readFileSync(progress.assembly.markdownPath, 'utf-8');
      } else {
        // Fallback: try to find markdown in output directory
        const outputDir = path.join(process.cwd(), 'data', 'jobs', jobId, 'output');
        if (!fs.existsSync(outputDir)) {
          return res.status(404).json({ error: 'No assembled document found for this job' });
        }
        const mdFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.md')).sort();
        if (mdFiles.length === 0) {
          return res.status(404).json({ error: 'No markdown output found' });
        }
        markdownContent = fs.readFileSync(path.join(outputDir, mdFiles[mdFiles.length - 1]), 'utf-8');
      }

      logger.info(`Starting review for job ${jobId} (${markdownContent.length} chars)`);

      // Start analysis asynchronously
      res.json({ status: 'analyzing', jobId, message: 'Review analysis started' });

      setImmediate(async () => {
        try {
          await analyzeDocument(jobId, markdownContent);
        } catch (err) {
          logger.error(`Review analysis failed for ${jobId}: ${(err as Error).message}`);
        }
      });
    } catch (err) {
      logger.error('Review start error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get review session status and items
  app.get('/api/review/:jobId', async (req, res) => {
    try {
      const session = getReviewSession(req.params.jobId);
      if (!session) {
        return res.status(404).json({ error: 'No review session found for this job' });
      }
      // Return session without full markdown content (too large for listing)
      const { markdownContent: _mc, ...sessionMeta } = session;
      res.json(sessionMeta);
    } catch (err) {
      logger.error('Review fetch error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get review items (kanban data)
  app.get('/api/review/:jobId/items', async (req, res) => {
    try {
      const session = getReviewSession(req.params.jobId);
      if (!session) {
        return res.status(404).json({ error: 'No review session found' });
      }
      res.json({ items: session.items, stats: session.stats });
    } catch (err) {
      logger.error('Review items error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get review document (markdown for preview)
  app.get('/api/review/:jobId/document', async (req, res) => {
    try {
      const session = getReviewSession(req.params.jobId);
      if (!session) {
        return res.status(404).json({ error: 'No review session found' });
      }
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.send(session.markdownContent);
    } catch (err) {
      logger.error('Review document error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Update review item status (move in kanban)
  app.patch('/api/review/:jobId/items/:itemId/status', async (req, res) => {
    try {
      const { jobId, itemId } = req.params;
      const { status } = req.body as { status: ReviewItemStatus };

      if (!['pending', 'reviewing', 'fixed', 'dismissed'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }

      const updated = updateItemStatus(jobId, itemId, status);
      if (!updated) {
        return res.status(404).json({ error: 'Item not found' });
      }
      res.json({ item: updated });
    } catch (err) {
      logger.error('Review status update error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Apply suggested fix (magic wand)
  app.post('/api/review/:jobId/items/:itemId/apply', async (req, res) => {
    try {
      const { jobId, itemId } = req.params;
      const result = await applyFix(jobId, itemId);
      res.json(result);
    } catch (err) {
      logger.error('Review apply fix error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Save edited document (full markdown replacement)
  app.put('/api/review/:jobId/document', async (req, res) => {
    try {
      const { jobId } = req.params;
      const { markdown } = req.body as { markdown: string };
      if (!markdown || typeof markdown !== 'string') {
        return res.status(400).json({ error: 'Missing "markdown" in request body' });
      }
      const result = await saveDocument(jobId, markdown);
      res.json(result);
    } catch (err) {
      logger.error('Save document error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Export document (re-render PDF from edited markdown)
  app.post('/api/review/:jobId/export', async (req, res) => {
    try {
      const result = await exportDocument(req.params.jobId);
      res.json(result);
    } catch (err) {
      logger.error('Export error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Download output file (docx, pdf, md)
  app.get('/api/review/:jobId/download/:filename', async (req, res) => {
    try {
      const { jobId, filename } = req.params;
      // Sanitize filename to prevent path traversal
      const safeName = path.basename(filename);
      const filePath = path.join(process.cwd(), 'data', 'jobs', jobId, 'output', safeName);

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
      }

      const ext = path.extname(safeName).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.pdf': 'application/pdf',
        '.md': 'text/markdown; charset=utf-8',
      };

      res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      logger.error('Download error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // List available output files for download
  app.get('/api/review/:jobId/files', async (req, res) => {
    try {
      const outputDir = path.join(process.cwd(), 'data', 'jobs', req.params.jobId, 'output');
      if (!fs.existsSync(outputDir)) {
        return res.json({ files: [] });
      }
      const files = fs.readdirSync(outputDir)
        .filter(f => /\.(docx|pdf|md)$/i.test(f))
        .map(f => ({
          name: f,
          ext: path.extname(f).toLowerCase().replace('.', ''),
          size: fs.statSync(path.join(outputDir, f)).size,
          url: `/api/review/${req.params.jobId}/download/${f}`,
        }));
      res.json({ files });
    } catch (err) {
      logger.error('Files list error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Serve audio segment for QC playback
  app.get('/api/review/:jobId/audio/:segmentFile', async (req, res) => {
    try {
      const { jobId, segmentFile } = req.params;
      const segDir = path.join(process.cwd(), 'data', 'jobs', jobId, 'processed');

      if (!fs.existsSync(segDir)) {
        return res.status(404).json({ error: 'No processed audio found' });
      }

      // Look for the segment file (flac/wav/mp3)
      const baseName = segmentFile.replace(/\.\w+$/, '');
      const candidates = fs.readdirSync(segDir).filter(f =>
        f.startsWith(baseName) && /\.(flac|wav|mp3|ogg)$/i.test(f)
      );

      if (candidates.length === 0) {
        return res.status(404).json({ error: 'Audio segment not found' });
      }

      const audioPath = path.join(segDir, candidates[0]);
      const ext = path.extname(candidates[0]).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.flac': 'audio/flac',
        '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg',
        '.ogg': 'audio/ogg',
      };

      res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
      fs.createReadStream(audioPath).pipe(res);
    } catch (err) {
      logger.error('Audio segment error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get transcript segments for the document (used for section→audio mapping)
  app.get('/api/review/:jobId/transcript-segments', async (req, res) => {
    try {
      const segments = loadTranscriptSegments(req.params.jobId);
      const audioFiles = getAudioFileMap(req.params.jobId);
      res.json({ segments, audioFiles });
    } catch (err) {
      logger.error('Transcript segments error', err as Error);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Serve audio file for playback with range-request support.
  // ?part=0 selects a specific processed chunk (default: 0)
  // Looks in raw/ first (mp3), then falls back to processed/ (flac chunks).
  app.get('/api/review/:jobId/audio-playback', async (req, res) => {
    try {
      const jobId = req.params.jobId;
      const partIdx = parseInt(String(req.query.part ?? '0'), 10);
      const jobBase = path.join(process.cwd(), 'data', 'jobs', jobId);

      // Try raw directory first (original mp3)
      const rawDir = path.join(jobBase, 'raw');
      let audioPath: string | null = null;

      if (fs.existsSync(rawDir)) {
        const rawFiles = fs.readdirSync(rawDir).filter(f =>
          /\.(mp3|wav|ogg|m4a)$/i.test(f),
        );
        if (rawFiles.length > 0) {
          audioPath = path.join(rawDir, rawFiles[0]);
        }
      }

      // Fallback: processed directory (flac chunks)
      if (!audioPath) {
        const procDir = path.join(jobBase, 'processed');
        if (!fs.existsSync(procDir)) {
          return res.status(404).json({ error: 'No audio found' });
        }
        const procFiles = fs.readdirSync(procDir)
          .filter(f => /\.(flac|wav|mp3|ogg)$/i.test(f))
          .sort();
        if (procFiles.length === 0) {
          return res.status(404).json({ error: 'No audio files found' });
        }
        const idx = Math.min(partIdx, procFiles.length - 1);
        audioPath = path.join(procDir, procFiles[idx]);
      }

      const stat = fs.statSync(audioPath);
      const ext = path.extname(audioPath).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.m4a': 'audio/mp4',
        '.flac': 'audio/flac',
      };
      const mime = mimeMap[ext] || 'application/octet-stream';

      // Support HTTP Range requests for seeking
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mime,
        });
        fs.createReadStream(audioPath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': mime,
          'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(audioPath).pipe(res);
      }
    } catch (err) {
      logger.error('Audio playback error', err as Error);
      res.status(500).json({ error: (err as Error).message });
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

    // ── Startup recovery: restore persisted state from Redis ──
    void (async () => {
      try {
        // Restore Yulieth's detected folders
        await restoreDetectedFolders();

        // Restore Chucho's progress (and detect crashed jobs)
        await restoreChuchoJobs();

        // Restore Jaime's progress (and detect crashed jobs)
        const jaime = await import('@transcriptor/jaime');
        const crashedJobs = await jaime.recoverJobs();

        // Restore Lina's progress
        const lina = await import('@transcriptor/lina');
        await lina.restoreLinaJobs();

        // Restore Fannery's progress
        const fannery = await import('@transcriptor/fannery');
        await fannery.restoreFanneryJobs();

        // ── Register agent dispatchers with Supervisor ──
        const supervisor = await import('@transcriptor/supervisor');
        const chucho = await import('@transcriptor/chucho');
        const { publishSuccess, publishFailure } = await import('@transcriptor/shared');

        // Report crashed Jaime jobs to supervisor
        if (crashedJobs.length > 0) {
          for (const job of crashedJobs) {
            const completedSegs = job.segments.filter(s => s.status === 'completed').length;
            const msg = `Transcription interrupted by restart (${completedSegs}/${job.totalSegments} segments completed). Needs retry.`;
            try {
              await supervisor.markStageFailed(job.jobId, EventStatus.TRANSCRIBING, msg);
              logger.warn(`Reported crashed Jaime job ${job.jobId} to supervisor`);
            } catch (err) {
              logger.error(`Failed to report crash for ${job.jobId}: ${(err as Error).message}`);
            }
          }
        }

        // Chucho dispatcher: convert to mono 16kHz + split into 30-min chunks (no loudness normalization)
        supervisor.registerDispatcher(EventStatus.PREPROCESSING, async (jobId: string) => {
          logger.info(`Dispatcher: Chucho preprocessing for ${jobId} (mono + split 30min)`);
          updateChuchoProgress(jobId, { status: 'preprocessing' });
          try {
            const chucho = await import('@transcriptor/chucho');
            const result = await chucho.processJob(jobId);

            if (result.errors.length > 0 && result.processedFiles.length === 0) {
              const msg = result.errors.join('; ');
              updateChuchoProgress(jobId, { status: 'failed', error: msg });
              await publishFailure('preprocessing_failed', jobId, 'chucho', msg);
            } else {
              logger.info(`Chucho: ${result.processedFiles.length} segments, ${(result.totalDuration / 60).toFixed(1)} min total`);
              updateChuchoProgress(jobId, {
                status: 'completed',
                processedFiles: result.processedFiles.length,
              });
              // Clean intermediate files (_mono, _normalized) to save disk
              await chucho.cleanupIntermediateFiles(jobId).catch(() => {});
              await publishSuccess('preprocessing_done', jobId, 'chucho', {
                processedFiles: result.processedFiles.length,
                totalDuration: result.totalDuration,
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            updateChuchoProgress(jobId, { status: 'failed', error: msg });
            await publishFailure('preprocessing_failed', jobId, 'chucho', msg);
          }
        });

        // Jaime dispatcher: runs transcription and publishes result
        supervisor.registerDispatcher(EventStatus.TRANSCRIBING, async (jobId: string) => {
          logger.info(`Dispatcher: starting Jaime transcription for ${jobId}`);
          // Update folder status if tracked
          for (const [, f] of detectedFolders) {
            if (f.jobId === jobId) { f.status = 'processing'; void persistDetectedFolders(); break; }
          }
          try {
            const result = await jaime.processJob(jobId);

            if (result.errors.length > 0 && result.sections.length === 0) {
              for (const [, f] of detectedFolders) {
                if (f.jobId === jobId) { f.status = 'error'; void persistDetectedFolders(); break; }
              }
              await publishFailure('transcription_failed', jobId, 'jaime', result.errors.join('; '));
            } else {
              logger.info(`Jaime: done for ${jobId}: ${result.sections.length} sections, provider=${result.provider}`);
              if (result.errors.length > 0) {
                logger.warn(`Jaime: completed with ${result.errors.length} warning(s)`);
              }
              await publishSuccess('transcription_done', jobId, 'jaime', {
                sections: result.sections.length,
                agendaItems: result.agendaItems.length,
                qaScore: result.qaReport.overallScore,
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            for (const [, f] of detectedFolders) {
              if (f.jobId === jobId) { f.status = 'error'; void persistDetectedFolders(); break; }
            }
            await publishFailure('transcription_failed', jobId, 'jaime', msg);
          }
        });

        // Lina dispatcher: runs speaker reconciliation + redaction
        supervisor.registerDispatcher(EventStatus.REDACTING, async (jobId: string) => {
          logger.info(`Dispatcher: starting Lina redaction for ${jobId}`);
          try {
            const result = await lina.processJob(jobId);
            logger.info(
              `Lina: done for ${jobId}: ${result.sectionsRedacted} sections redacted, ` +
              `${result.reconciliation.globalSpeakers.length} speakers reconciled (confidence ${result.reconciliation.confidence})`,
            );

            if (result.validationErrors.length > 0) {
              logger.warn(`Lina: ${result.validationErrors.length} validation error(s)`);
            }

            await publishSuccess('redaction_done', jobId, 'lina', {
              sectionsRedacted: result.sectionsRedacted,
              globalSpeakers: result.reconciliation.globalSpeakers.length,
              identifiedSpeakers: Object.keys(result.reconciliation.identifiedSpeakers).length,
              confidence: result.reconciliation.confidence,
              validationErrors: result.validationErrors.length,
              validationWarnings: result.validationWarnings.length,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`Lina: failed for ${jobId}: ${msg}`);
            lina.markLinaFailed(jobId, msg);
            await publishFailure('redaction_failed', jobId, 'lina', msg);
          }
        });

        // Fannery dispatcher: assembles DOCX document from redacted sections
        supervisor.registerDispatcher(EventStatus.ASSEMBLING, async (jobId: string) => {
          logger.info(`Dispatcher: starting Fannery assembly for ${jobId}`);
          try {
            const result = await fannery.processJob(jobId);
            logger.info(
              `Fannery: done for ${jobId}: ${result.sectionsAssembled} sections assembled, ` +
              `${result.documentSizeBytes} bytes`,
            );

            await publishSuccess('assembly_done', jobId, 'fannery', {
              sectionsAssembled: result.sectionsAssembled,
              documentSizeBytes: result.documentSizeBytes,
              documentPath: result.documentPath,
              driveFileId: result.driveFileId,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`Fannery: failed for ${jobId}: ${msg}`);
            fannery.markFanneryFailed(jobId, msg);
            await publishFailure('assembly_failed', jobId, 'fannery', msg);
          }
        });

        // Gloria dispatcher: runs LLM review analysis on assembled document
        supervisor.registerDispatcher(EventStatus.REVIEWING, async (jobId: string) => {
          logger.info(`Dispatcher: starting Gloria review for ${jobId}`);
          try {
            // Load markdown from Fannery output
            const progress = fannery.getAllFanneryProgress().find(j => j.jobId === jobId);
            let markdownContent: string | null = null;

            if (progress?.assembly?.markdownPath && fs.existsSync(progress.assembly.markdownPath)) {
              markdownContent = fs.readFileSync(progress.assembly.markdownPath, 'utf-8');
            } else {
              // Fallback: try output directory
              const outputDir = path.join(process.cwd(), 'data', 'jobs', jobId, 'output');
              if (fs.existsSync(outputDir)) {
                const mdFiles = fs.readdirSync(outputDir).filter((f: string) => f.endsWith('.md')).sort();
                if (mdFiles.length > 0) {
                  markdownContent = fs.readFileSync(path.join(outputDir, mdFiles[mdFiles.length - 1]), 'utf-8');
                }
              }
            }

            if (!markdownContent) {
              throw new Error('No markdown document found for review');
            }

            const session = await analyzeDocument(jobId, markdownContent);
            logger.info(
              `Gloria: review done for ${jobId}: ${session.stats.total} items found ` +
              `(${session.stats.critical} critical, ${session.stats.warning} warning)`,
            );

            // Don't auto-complete the pipeline — the review needs human approval
            // The pipeline stays at REVIEWING until manually completed
            logger.info(`Job ${jobId} awaiting human review (${session.stats.total} items)`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`Gloria: review failed for ${jobId}: ${msg}`);
            await publishFailure('review_failed', jobId, 'gloria', msg);
          }
        });

        // Restore review sessions from Redis
        await restoreReviewSessions();

        // ── Start the Supervisor orchestrator event loop ──
        supervisor.startOrchestrator();

        logger.info('Startup recovery complete — Supervisor orchestrator running');
      } catch (err) {
        logger.error(`Startup recovery failed: ${(err as Error).message}`);
      }
    })();
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
  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);

  // Read active pipelines from Redis via supervisor
  const supervisor = await import('@transcriptor/supervisor');
  const jobIds = await supervisor.listActiveJobs();

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
  for (const jobId of jobIds) {
    try {
      const job = await supervisor.loadState(jobId);
      if (job.status === 'completed' || job.status === 'failed') continue;
      const agent = stageToAgent[job.status];
      if (agent && !activeAgents.has(agent)) {
        activeAgents.set(agent, {
          jobId: job.jobId,
          eventId: job.eventId,
          updatedAt: job.updatedAt,
        });
      }
    } catch { /* skip unreadable jobs */ }
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
  // Read all pipelines from Redis and compute per-agent stats
  const supervisor = await import('@transcriptor/supervisor');
  const jobIds = await supervisor.listActiveJobs();

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  // Map stages to agents
  const stageAgent: Record<string, AgentId> = {
    detected: 'yulieth', queued: 'yulieth',
    preprocessing: 'chucho',
    transcribing: 'jaime', sectioning: 'jaime',
    redacting: 'lina',
    assembling: 'fannery',
    reviewing: 'gloria',
    completed: 'supervisor',
  };

  // Accumulators per agent
  const processed = new Map<AgentId, number>();
  const failed = new Map<AgentId, number>();
  const todayProcessed = new Map<AgentId, number>();
  const todayFailed = new Map<AgentId, number>();
  const durations = new Map<AgentId, number[]>();
  for (const id of AGENT_IDS) {
    processed.set(id, 0); failed.set(id, 0);
    todayProcessed.set(id, 0); todayFailed.set(id, 0);
    durations.set(id, []);
  }

  for (const jobId of jobIds) {
    try {
      const job = await supervisor.loadState(jobId);
      const createdMs = new Date(job.createdAt).getTime();
      if (createdMs < thirtyDaysAgo) continue;
      const isToday = createdMs >= todayMs;

      for (const stage of job.stages) {
        const agent = stageAgent[stage.stage];
        if (!agent) continue;

        if (stage.status === 'completed') {
          processed.set(agent, (processed.get(agent) || 0) + 1);
          if (isToday) todayProcessed.set(agent, (todayProcessed.get(agent) || 0) + 1);
          // Calculate duration if we have both timestamps
          if (stage.startedAt && stage.completedAt) {
            const dur = new Date(stage.completedAt).getTime() - new Date(stage.startedAt).getTime();
            durations.get(agent)!.push(dur);
          }
        } else if (stage.status === 'failed') {
          failed.set(agent, (failed.get(agent) || 0) + 1);
          if (isToday) todayFailed.set(agent, (todayFailed.get(agent) || 0) + 1);
        }
      }
    } catch { /* skip unreadable jobs */ }
  }

  return AGENT_IDS.map((id) => {
    const durs = durations.get(id) || [];
    const totalMs = durs.reduce((a, b) => a + b, 0);
    return {
      agentId: id,
      last30Days: {
        jobsProcessed: processed.get(id) || 0,
        jobsFailed: failed.get(id) || 0,
        averageDurationMs: durs.length > 0 ? Math.round(totalMs / durs.length) : 0,
        totalDurationMs: totalMs,
      },
      today: {
        jobsProcessed: todayProcessed.get(id) || 0,
        jobsFailed: todayFailed.get(id) || 0,
      },
    };
  });
}

async function getPipelineOverview(): Promise<PipelineOverviewInfo> {
  // Read all pipeline state from Redis
  const supervisor = await import('@transcriptor/supervisor');
  const jobIds = await supervisor.listActiveJobs();

  const counts: Record<string, number> = {};
  const allJobs: { jobId: string; eventId: string; status: string; createdAt: string; updatedAt: string }[] = [];

  for (const jobId of jobIds) {
    try {
      const job = await supervisor.loadState(jobId);
      counts[job.status] = (counts[job.status] || 0) + 1;
      allJobs.push({
        jobId: job.jobId,
        eventId: job.eventId,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      });
    } catch { /* skip */ }
  }

  // Sort by most recently updated and take top 10
  allJobs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const recent = allJobs.slice(0, 10);

  const activeStatuses = ['preprocessing', 'transcribing', 'sectioning', 'redacting', 'assembling', 'reviewing'];
  const activeJobs = activeStatuses.reduce((sum, s) => sum + (counts[s] || 0), 0);

  return {
    activeJobs,
    completedJobs: counts['completed'] || 0,
    failedJobs: counts['failed'] || 0,
    queuedJobs: (counts['detected'] || 0) + (counts['queued'] || 0),
    recentJobs: recent.map((r) => ({
      jobId: r.jobId,
      eventId: r.eventId,
      buildingName: 'Unknown', // TODO: resolve from config
      status: r.status,
      currentStage: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
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
          rootFolderId: { type: ['string', 'null'], description: 'The Google Drive folder ID to scan. If omitted or null, uses the configured default.' },
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
          status: { type: ['string', 'null'], description: 'Filter by status (detected, queued, preprocessing, transcribing, sectioning, redacting, assembling, reviewing, completed, failed). If omitted, returns all.' },
          limit: { type: ['number', 'null'], description: 'Max number of jobs to return. Default 20.' },
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
          maxResults: { type: ['number', 'null'], description: 'Maximum number of files to return. Default 50.' },
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
          maxResults: { type: ['number', 'null'], description: 'Maximum results. Default 20.' },
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
          parentId: { type: ['string', 'null'], description: 'Parent folder ID. If omitted, creates in root.' },
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
          bodyText: { type: ['string', 'null'], description: 'Optional initial text content.' },
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
          calendarId: { type: ['string', 'null'], description: 'Calendar ID. Default "primary".' },
          maxResults: { type: ['number', 'null'], description: 'Max events to return. Default 20.' },
          timeMin: { type: ['string', 'null'], description: 'Earliest event time (ISO 8601). Default now.' },
          timeMax: { type: ['string', 'null'], description: 'Latest event time (ISO 8601). If omitted, no upper limit.' },
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
          description: { type: ['string', 'null'], description: 'Event description.' },
          location: { type: ['string', 'null'], description: 'Event location.' },
          attendees: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of attendee email addresses.',
          },
          calendarId: { type: ['string', 'null'], description: 'Calendar ID. Default "primary".' },
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
          query: { type: ['string', 'null'], description: 'Gmail search query. Default "in:inbox". Examples: "from:info@tecnoreuniones.com", "subject:acta is:unread".' },
          maxResults: { type: ['number', 'null'], description: 'Max messages to return. Default 20.' },
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
          cc: { type: ['string', 'null'], description: 'CC email address (optional).' },
          bcc: { type: ['string', 'null'], description: 'BCC email address (optional).' },
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

// ── Supervisor Tools ──

const SUPERVISOR_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_active_pipelines',
      description: 'Get all active (non-completed, non-failed) pipeline jobs currently being processed by the system.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pipeline_status',
      description: 'Get the full status of a specific pipeline job, including all stages and their states.',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'The UUID of the pipeline job to check.' },
        },
        required: ['jobId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'init_pipeline',
      description: 'Initialize a new transcription pipeline for an event. Creates all stages from detection through completion.',
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'The event identifier (e.g., assembly ID or folder name).' },
          eventFolder: { type: 'string', description: 'The Google Drive folder path/ID for the event audio files.' },
        },
        required: ['eventId', 'eventFolder'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'advance_pipeline_stage',
      description: 'Advance a pipeline job to its next processing stage.',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'The UUID of the pipeline job.' },
          nextStage: {
            type: 'string',
            description: 'The stage to advance to.',
            enum: ['detected', 'queued', 'preprocessing', 'transcribing', 'sectioning', 'redacting', 'assembling', 'reviewing', 'completed'],
          },
        },
        required: ['jobId', 'nextStage'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_stage_complete',
      description: 'Mark a specific stage as completed for a pipeline job.',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'The UUID of the pipeline job.' },
          stage: {
            type: 'string',
            description: 'The stage to mark as complete.',
            enum: ['detected', 'queued', 'preprocessing', 'transcribing', 'sectioning', 'redacting', 'assembling', 'reviewing', 'completed'],
          },
        },
        required: ['jobId', 'stage'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_stage_failed',
      description: 'Mark a specific stage as failed for a pipeline job, recording the error message.',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'The UUID of the pipeline job.' },
          stage: {
            type: 'string',
            description: 'The stage that failed.',
            enum: ['detected', 'queued', 'preprocessing', 'transcribing', 'sectioning', 'redacting', 'assembling', 'reviewing'],
          },
          error: { type: 'string', description: 'Error message describing what went wrong.' },
        },
        required: ['jobId', 'stage', 'error'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'retry_failed_stage',
      description: 'Retry a failed stage for a pipeline job. Resets the stage status and re-queues it for processing.',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'The UUID of the pipeline job.' },
          stage: {
            type: 'string',
            description: 'The failed stage to retry.',
            enum: ['detected', 'queued', 'preprocessing', 'transcribing', 'sectioning', 'redacting', 'assembling', 'reviewing'],
          },
        },
        required: ['jobId', 'stage'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cleanup_completed_jobs',
      description: 'Remove completed and failed pipeline jobs older than a given number of days from Redis state.',
      parameters: {
        type: 'object',
        properties: {
          olderThanDays: { type: 'number', description: 'Clean up jobs older than this many days. Defaults to 7.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pipeline_overview',
      description: 'Get a high-level overview of all pipelines: active, completed, failed, queued counts and 10 most recent jobs.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_agent_statistics',
      description: 'Get processing statistics for all agents: jobs processed (last 30 days and today), failures, and performance.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_notification',
      description: 'Send a notification message for a pipeline job (logged; future: email/Slack).',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'The UUID of the pipeline job.' },
          message: { type: 'string', description: 'The notification message.' },
        },
        required: ['jobId', 'message'],
      },
    },
  },
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
        const folderId = (args.rootFolderId as string) || yuliethConfig.driveFolderId;
        if (!folderId) {
          return JSON.stringify({ error: 'No Drive folder configured. Set a folder ID in Yulieth\'s config panel first.' });
        }
        const folders = await scanDriveFolder(folderId);
        return JSON.stringify(folders, null, 2);
      } catch (err) {
        return JSON.stringify({ error: `Drive scan failed: ${err instanceof Error ? err.message : String(err)}` });
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

// ── Tool Executor (Supervisor) ──

async function executeSupervisorTool(name: string, args: Record<string, unknown>): Promise<string> {
  const supervisor = await import('@transcriptor/supervisor');

  try {
    switch (name) {
      case 'get_active_pipelines': {
        const pipelines = await supervisor.getActivePipelines();
        if (pipelines.length === 0) {
          return JSON.stringify({ message: 'No active pipelines at this moment.', count: 0 });
        }
        const summary = pipelines.map(p => ({
          jobId: p.jobId,
          eventId: p.eventId,
          status: p.status,
          stages: p.stages.map(s => ({
            stage: s.stage,
            status: s.status,
            agent: s.agentName,
            error: s.error || undefined,
          })),
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        }));
        return JSON.stringify({ count: pipelines.length, pipelines: summary }, null, 2);
      }

      case 'get_pipeline_status': {
        const jobId = args.jobId as string;
        const job = await supervisor.getPipelineStatus(jobId);
        return JSON.stringify(job, null, 2);
      }

      case 'init_pipeline': {
        const eventId = args.eventId as string;
        const eventFolderStr = args.eventFolder as string;
        const eventFolder: EventFolder = {
          folderId: eventFolderStr,
          folderName: eventFolderStr,
          audioFiles: [],
          votingFiles: [],
          path: eventFolderStr,
        };
        const job = await supervisor.initPipeline(eventId, eventFolder);
        return JSON.stringify({ message: 'Pipeline initialized successfully.', job }, null, 2);
      }

      case 'advance_pipeline_stage': {
        const jobId = args.jobId as string;
        const nextStage = args.nextStage as string;
        const stageEnum = EventStatus[nextStage.toUpperCase() as keyof typeof EventStatus] || nextStage;
        const job = await supervisor.advanceStage(jobId, stageEnum as EventStatus);
        return JSON.stringify({ message: `Pipeline advanced to ${nextStage}.`, job }, null, 2);
      }

      case 'mark_stage_complete': {
        const jobId = args.jobId as string;
        const stage = args.stage as string;
        const stageEnum = EventStatus[stage.toUpperCase() as keyof typeof EventStatus] || stage;
        const job = await supervisor.markStageComplete(jobId, stageEnum as EventStatus);
        return JSON.stringify({ message: `Stage ${stage} marked as complete.`, job }, null, 2);
      }

      case 'mark_stage_failed': {
        const jobId = args.jobId as string;
        const stage = args.stage as string;
        const error = args.error as string;
        const stageEnum = EventStatus[stage.toUpperCase() as keyof typeof EventStatus] || stage;
        const job = await supervisor.markStageFailed(jobId, stageEnum as EventStatus, error);
        return JSON.stringify({ message: `Stage ${stage} marked as failed.`, job }, null, 2);
      }

      case 'retry_failed_stage': {
        const jobId = args.jobId as string;
        const stage = args.stage as string;
        const stageEnum = EventStatus[stage.toUpperCase() as keyof typeof EventStatus] || stage;
        const job = await supervisor.retryStage(jobId, stageEnum as EventStatus);
        return JSON.stringify({ message: `Stage ${stage} queued for retry.`, job }, null, 2);
      }

      case 'cleanup_completed_jobs': {
        const days = (args.olderThanDays as number) || 7;
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const cleaned = await supervisor.cleanupCompletedJobs(cutoff);
        return JSON.stringify({ message: `Cleaned up ${cleaned} jobs older than ${days} days.`, cleaned }, null, 2);
      }

      case 'get_pipeline_overview': {
        const overview = await getPipelineOverview();
        return JSON.stringify(overview, null, 2);
      }

      case 'get_agent_statistics': {
        const stats = await getAgentStatistics();
        return JSON.stringify(stats, null, 2);
      }

      case 'send_notification': {
        const jobId = args.jobId as string;
        const message = args.message as string;
        await supervisor.sendNotification(jobId, message);
        return JSON.stringify({ message: `Notification sent for job ${jobId}: "${message}"` });
      }

      default:
        return JSON.stringify({ error: `Unknown supervisor tool: ${name}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: msg, note: 'This tool call failed. Report the error to the user.' });
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

  supervisor: `You are **Supervisor**, the Pipeline Orchestrator in the Transcriptor multi-agent system for Colombian property assembly (propiedad horizontal) minutes.

Your role: You coordinate the entire transcription pipeline — from audio detection in Google Drive through preprocessing, transcription, sectioning, redaction, document assembly, and final review. You track job progress, handle failures, retry stages, and provide system health overviews.

## Pipeline Stages (in order)
| Stage | Agent | What happens |
|-------|-------|-------------|
| detected | Yulieth | New audio folders detected in Google Drive |
| queued | Yulieth | Files downloaded from Drive to \`data/jobs/<jobId>/raw/\` and pipeline created in Redis |
| preprocessing | Chucho | Audio converted to mono, loudness-normalized, converted to FLAC, split if >1hr. Output: \`data/jobs/<jobId>/processed/\` |
| transcribing | Jaime | FLAC segments sent to ElevenLabs Scribe API for speech-to-text with diarization |
| sectioning | Jaime | Transcript divided into logical sections matching the assembly agenda |
| redacting | Lina | Sections redacted into formal legal-style minutes using Groq LLM |
| assembling | Fannery | Sections assembled into final .docx document with templates |
| reviewing | Gloria | QA review of final document by human via web dashboard |
| completed | Supervisor | Pipeline finished successfully |

## Architecture
- **Runtime**: Node.js + TypeScript monorepo (pnpm workspaces)
- **State**: Pipeline jobs stored in Redis (key: \`transcriptor:pipeline:<jobId>\`)
- **Queue**: BullMQ queue \`transcriptor-events\` on Redis
- **Database**: PostgreSQL 16 (pipeline_jobs, events tables)
- **Files**: Local filesystem under \`data/jobs/<jobId>/\` (raw/ and processed/ subdirectories)
- **Transcription**: ElevenLabs Scribe API ($0.11/min)
- **LLM**: Groq API with openai/gpt-oss-120b
- **Dashboard**: React served by Gloria on port 3001
- **NO cloud storage buckets** — all file processing is local

## Available Tools
- **get_active_pipelines**: List all active (in-progress) pipeline jobs
- **get_pipeline_status**: Get full status of a specific pipeline job by ID
- **init_pipeline**: Start a new transcription pipeline for an event
- **advance_pipeline_stage**: Move a pipeline job to the next stage
- **mark_stage_complete**: Mark a stage as successfully completed
- **mark_stage_failed**: Mark a stage as failed with an error message
- **retry_failed_stage**: Retry a stage that previously failed
- **cleanup_completed_jobs**: Remove old completed/failed jobs from Redis
- **get_pipeline_overview**: High-level overview (active, completed, failed, queued counts + recent jobs)
- **get_agent_statistics**: Processing stats per agent (last 30 days and today)
- **send_notification**: Send a notification message for a pipeline job

## CRITICAL RULES
1. **ALWAYS call ALL the tools you need in a SINGLE response using parallel tool calls.** NEVER call them one by one.
2. **NEVER retry a tool that returned an error.** Report it and continue with other data.
3. After receiving tool results, write your final answer immediately — do NOT make more tool calls.
4. Present results in Markdown with tables, bold labels, and bullet points.
5. When asked about system status, always call **get_pipeline_overview** and **get_active_pipelines** together.
6. When asked about agent performance, call **get_agent_statistics**.
7. Be concise and status-focused in your responses.
8. You can respond in Spanish or English depending on the user's language.`,

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

  chucho: `You are **Chucho**, the Audio Preprocessor Agent in the Transcriptor multi-agent system for Colombian property assembly (propiedad horizontal) minutes.

Your role: You take raw audio files downloaded by Yulieth from Google Drive and preprocess them using FFmpeg on the **local filesystem** — converting to mono, normalizing loudness, converting to FLAC format, and splitting long files into segments. You prepare audio for transcription by Jaime via the ElevenLabs Scribe API.

## How Your Pipeline Works
1. **Yulieth** detects audio folders on Google Drive and downloads the raw files to \`data/jobs/<jobId>/raw/\`
2. **You (Chucho)** pick up the raw files and process them:
   - Convert stereo → **mono** (single channel)
   - **Normalize loudness** using the EBU R128 loudnorm filter (target: -16 LUFS, true peak: -1.5 dB, LRA: 11)
   - Convert to **FLAC** format (lossless, well-supported by ElevenLabs)
   - If a file exceeds **1 hour**, split it into segments at silence boundaries
3. Processed files are saved to \`data/jobs/<jobId>/processed/\`
4. A **manifest.json** is written to the processed directory with:
   - List of all processed files
   - Total duration
   - Number of segments
   - Cost estimate ($0.11/minute for ElevenLabs Scribe)
5. Pipeline advances to the **transcribing** stage (Jaime takes over)

## File Locations (LOCAL filesystem — NOT cloud storage)
- Raw input: \`<project_root>/data/jobs/<jobId>/raw/\` (downloaded from Google Drive by Yulieth)
- Processed output: \`<project_root>/data/jobs/<jobId>/processed/\` (FLAC files ready for Jaime)
- Intermediate: \`*_mono.flac\`, \`*_normalized.flac\` (temporary, during processing)
- Manifest: \`<project_root>/data/jobs/<jobId>/processed/manifest.json\`

## Supported Input Formats
.mp3, .wav, .flac, .m4a, .ogg, .aac, .wma, .webm — any audio format FFmpeg can decode. Video files (.mp4) are excluded.

## Output Format
**FLAC** (Free Lossless Audio Codec) — mono, loudness-normalized. This is what ElevenLabs Scribe accepts with optimal quality.

## IMPORTANT
- There is **NO Google Cloud Storage bucket**. All processing is local.
- There is **NO GCS**, **NO gsutil**, **NO cloud buckets** involved.
- Files live on the local disk under the \`data/jobs/\` directory.
- You do NOT download from Google Drive — Yulieth does that before handing off to you.
- You do NOT transcribe — Jaime does that after you finish.

Be technical but accessible in your explanations. You can respond in Spanish or English depending on the user's language.`,

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

  // Robinson, Yulieth, and Supervisor get tools; other agents get pure conversation
  const isRobinson = agentId === 'robinson';
  const isYulieth = agentId === 'yulieth';
  const isSupervisor = agentId === 'supervisor';
  const agentTools = isRobinson ? TECNOREUNIONES_TOOLS
    : isYulieth ? YULIETH_TOOLS
    : isSupervisor ? SUPERVISOR_TOOLS
    : undefined;
  const agentToolExecutor = isYulieth ? executeYuliethTool
    : isSupervisor ? executeSupervisorTool
    : executeTool;

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

// ══════════════════════════════════════════════════
//  YULIETH CONFIG, WATCHER & QUEUE MANAGEMENT
// ══════════════════════════════════════════════════

interface YuliethConfigState {
  driveFolderId: string;
  pollIntervalSeconds: number;
  autoQueue: boolean;
  audioExtensions: string[];
  votingExtensions: string[];
  isWatching: boolean;
}

interface DetectedFolder {
  folderId: string;
  folderName: string;
  audioFiles: { id: string; name: string; size: number }[];
  votingFiles: { id: string; name: string; size: number }[];
  status: 'detected' | 'queued' | 'processing' | 'completed' | 'error';
  detectedAt: string;
  jobId?: string;
}

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.wma']);
const VOTING_EXTS = new Set(['.xlsx', '.csv', '.json', '.xls']);

// Persist config to a JSON file so it survives restarts
const __dirnameConfig = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.resolve(__dirnameConfig, '../../../config/yulieth-config.json');

function saveYuliethConfig(): void {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(yuliethConfig, null, 2), 'utf-8');
    logger.info(`Yulieth config saved to ${CONFIG_FILE}`);
  } catch (err) {
    logger.error('Failed to save Yulieth config', err as Error);
  }
}

function loadYuliethConfig(): Partial<YuliethConfigState> {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const data = JSON.parse(raw);
      logger.info(`Yulieth config loaded from ${CONFIG_FILE}`);
      return data;
    }
  } catch (err) {
    logger.error('Failed to load Yulieth config', err as Error);
  }
  return {};
}

const _savedConfig = loadYuliethConfig();

const yuliethConfig: YuliethConfigState = {
  driveFolderId: _savedConfig.driveFolderId ?? process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID ?? '',
  pollIntervalSeconds: _savedConfig.pollIntervalSeconds ?? 60,
  autoQueue: _savedConfig.autoQueue ?? false,
  audioExtensions: _savedConfig.audioExtensions ?? [...AUDIO_EXTS],
  votingExtensions: _savedConfig.votingExtensions ?? [...VOTING_EXTS],
  isWatching: false, // always start stopped
};

// Redis-persisted store of detected folders
const DETECTED_FOLDERS_KEY = 'gloria:detected_folders';
const detectedFolders = new Map<string, DetectedFolder>();
let watcherTimer: ReturnType<typeof setInterval> | null = null;

async function persistDetectedFolders(): Promise<void> {
  try {
    const redis = getRedisClient();
    const data = Object.fromEntries(detectedFolders);
    await redis.set(DETECTED_FOLDERS_KEY, JSON.stringify(data));
  } catch (err) {
    logger.warn(`Failed to persist detected folders: ${(err as Error).message}`);
  }
}

async function restoreDetectedFolders(): Promise<void> {
  try {
    const redis = getRedisClient();
    const raw = await redis.get(DETECTED_FOLDERS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as Record<string, DetectedFolder>;
    for (const [key, folder] of Object.entries(data)) {
      detectedFolders.set(key, folder);
    }
    logger.info(`Restored ${detectedFolders.size} detected folder(s) from Redis`);
  } catch (err) {
    logger.warn(`Failed to restore detected folders: ${(err as Error).message}`);
  }
}

/** Scan a Drive folder for subfolders containing audio/voting files */
async function scanDriveFolder(folderId: string): Promise<DetectedFolder[]> {
  logger.info(`Scanning Drive folder: ${folderId}`);

  const audioExts = new Set(yuliethConfig.audioExtensions.map(e => e.toLowerCase()));
  const votingExts = new Set(yuliethConfig.votingExtensions.map(e => e.toLowerCase()));

  // List root folder contents
  const rootFiles = await gwDriveListFiles(folderId, 100);
  const subfolders = rootFiles.filter(f => f.mimeType === 'application/vnd.google-apps.folder');

  const results: DetectedFolder[] = [];

  for (const subfolder of subfolders) {
    // Check if already tracked
    const existing = detectedFolders.get(subfolder.id);
    if (existing && existing.status !== 'detected') {
      results.push(existing);
      continue;
    }

    // List subfolder contents
    const contents = await gwDriveListFiles(subfolder.id, 100);
    const audioFiles = contents
      .filter(f => {
        const ext = f.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
        return audioExts.has(ext);
      })
      .map(f => ({ id: f.id, name: f.name, size: f.size }));

    const votingFiles = contents
      .filter(f => {
        const ext = f.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
        return votingExts.has(ext);
      })
      .map(f => ({ id: f.id, name: f.name, size: f.size }));

    const folder: DetectedFolder = {
      folderId: subfolder.id,
      folderName: subfolder.name,
      audioFiles,
      votingFiles,
      status: 'detected',
      detectedAt: new Date().toISOString(),
    };

    detectedFolders.set(subfolder.id, folder);
    results.push(folder);

    // Auto-enqueue if enabled
    if (yuliethConfig.autoQueue && folder.audioFiles.length > 0) {
      try {
        await enqueueDetectedFolder(subfolder.id);
        logger.info(`Auto-queued folder: ${subfolder.name}`);
      } catch (aqErr) {
        logger.error(`Auto-queue failed for ${subfolder.name}`, aqErr as Error);
      }
    }
  }

  logger.info(`Scan complete: ${results.length} event folders (${results.filter(f => f.status === 'detected').length} new)`);
  void persistDetectedFolders();
  return results;
}

/** Start the periodic Drive watcher */
function startYuliethWatcher(): void {
  if (watcherTimer) clearInterval(watcherTimer);

  yuliethConfig.isWatching = true;
  logger.info(`Yulieth watcher started: polling every ${yuliethConfig.pollIntervalSeconds}s`);

  // Immediate scan
  void scanDriveFolder(yuliethConfig.driveFolderId).catch(err => {
    logger.error('Watcher scan error', err as Error);
  });

  watcherTimer = setInterval(() => {
    void scanDriveFolder(yuliethConfig.driveFolderId).catch(err => {
      logger.error('Watcher scan error', err as Error);
    });
  }, yuliethConfig.pollIntervalSeconds * 1000);
}

/** Stop the periodic Drive watcher */
function stopYuliethWatcher(): void {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
  yuliethConfig.isWatching = false;
  logger.info('Yulieth watcher stopped');
}

/** Get queue data for the dashboard */
async function getYuliethQueue(): Promise<{ folders: DetectedFolder[]; stats: { pending: number; processing: number; completed: number; failed: number } }> {
  const folders = Array.from(detectedFolders.values())
    .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));

  const stats = {
    pending: folders.filter(f => f.status === 'detected' || f.status === 'queued').length,
    processing: folders.filter(f => f.status === 'processing').length,
    completed: folders.filter(f => f.status === 'completed').length,
    failed: folders.filter(f => f.status === 'error').length,
  };

  return { folders, stats };
}

// ══════════════════════════════════════════════════
//  CHUCHO PROGRESS TRACKER
// ══════════════════════════════════════════════════

interface ChuchoJobProgress {
  jobId: string;
  status: 'pending' | 'downloading' | 'preprocessing' | 'completed' | 'failed';
  totalFiles: number;
  processedFiles: number;
  currentFile: string | null;
  /** Download progress */
  downloadedFiles: number;
  totalDownloadFiles: number;
  /** Result info */
  totalSegments: number;
  totalDurationSec: number;
  costEstimate: number;
  startedAt: number;
  updatedAt: number;
  error: string | null;
}

const CHUCHO_PROGRESS_PREFIX = 'chucho:progress:';
const CHUCHO_ACTIVE_KEY = 'chucho:active_jobs';
const chuchoJobs = new Map<string, ChuchoJobProgress>();

// Debounce Redis writes for chucho (per-file download updates come fast)
const chuchoPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleChuchoPersist(jobId: string): void {
  if (chuchoPersistTimers.has(jobId)) return;
  chuchoPersistTimers.set(jobId, setTimeout(() => {
    chuchoPersistTimers.delete(jobId);
    const job = chuchoJobs.get(jobId);
    if (job) void persistChuchoJob(job);
  }, 2_000));
}

async function persistChuchoJob(job: ChuchoJobProgress): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.set(`${CHUCHO_PROGRESS_PREFIX}${job.jobId}`, JSON.stringify(job));
    if (job.status !== 'completed' && job.status !== 'failed') {
      await redis.sadd(CHUCHO_ACTIVE_KEY, job.jobId);
    } else {
      await redis.srem(CHUCHO_ACTIVE_KEY, job.jobId);
    }
  } catch (err) {
    logger.warn(`Failed to persist Chucho progress for ${job.jobId}: ${(err as Error).message}`);
  }
}

async function persistChuchoNow(job: ChuchoJobProgress): Promise<void> {
  const timer = chuchoPersistTimers.get(job.jobId);
  if (timer) { clearTimeout(timer); chuchoPersistTimers.delete(job.jobId); }
  await persistChuchoJob(job);
}

async function restoreChuchoJobs(): Promise<void> {
  try {
    const redis = getRedisClient();
    const activeIds = await redis.smembers(CHUCHO_ACTIVE_KEY);
    for (const jobId of activeIds) {
      const raw = await redis.get(`${CHUCHO_PROGRESS_PREFIX}${jobId}`);
      if (!raw) { await redis.srem(CHUCHO_ACTIVE_KEY, jobId); continue; }
      const job = JSON.parse(raw) as ChuchoJobProgress;
      // If it was mid-download or preprocessing when we crashed, mark it
      if (job.status === 'downloading' || job.status === 'preprocessing') {
        job.status = 'failed';
        job.error = 'Process crashed — Gloria was restarted while Chucho was processing';
        job.updatedAt = Date.now();
        await persistChuchoJob(job);
        logger.warn(`Chucho job ${jobId} was interrupted — marked as failed`);
      }
      chuchoJobs.set(jobId, job);
    }
    if (activeIds.length > 0) {
      logger.info(`Restored ${activeIds.length} Chucho job(s) from Redis`);
    }
  } catch (err) {
    logger.warn(`Failed to restore Chucho jobs: ${(err as Error).message}`);
  }
}

function initChuchoProgress(jobId: string, audioFileCount: number): void {
  const job: ChuchoJobProgress = {
    jobId,
    status: 'downloading',
    totalFiles: audioFileCount,
    processedFiles: 0,
    currentFile: null,
    downloadedFiles: 0,
    totalDownloadFiles: audioFileCount,
    totalSegments: 0,
    totalDurationSec: 0,
    costEstimate: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    error: null,
  };
  chuchoJobs.set(jobId, job);
  void persistChuchoNow(job);
}

function updateChuchoProgress(jobId: string, update: Partial<ChuchoJobProgress>): void {
  const job = chuchoJobs.get(jobId);
  if (!job) return;
  Object.assign(job, update, { updatedAt: Date.now() });
  // Immediate persist for status changes, debounced for download progress
  if (update.status) {
    void persistChuchoNow(job);
  } else {
    scheduleChuchoPersist(jobId);
  }
}

function getChuchoProgress(jobId: string): (ChuchoJobProgress & { elapsedMs: number }) | null {
  const job = chuchoJobs.get(jobId);
  if (!job) return null;
  return { ...job, elapsedMs: Date.now() - job.startedAt };
}

function getAllChuchoProgress(): (ChuchoJobProgress & { elapsedMs: number })[] {
  return [...chuchoJobs.values()].map(j => ({
    ...j,
    elapsedMs: Date.now() - j.startedAt,
  }));
}

// NOTE: kickOffJaime() has been removed.
// The Supervisor orchestrator now dispatches Jaime (and all other agents) via the event bus.

/**
 * Enqueue a detected folder for processing.
 * Yulieth downloads audio files, creates the pipeline, then publishes
 * a `files_ready` event for Supervisor to orchestrate the rest.
 */
async function enqueueDetectedFolder(folderId: string): Promise<{ success: boolean; jobId?: string }> {
  const folder = detectedFolders.get(folderId);
  if (!folder) {
    throw new Error(`Folder ${folderId} not found in detected folders`);
  }
  if (folder.status !== 'detected') {
    throw new Error(`Folder ${folderId} is already ${folder.status}`);
  }

  // 1. Resolve Tecnoreuniones assembly from audio file names or folder name
  const supervisor = await import('@transcriptor/supervisor');
  const robinson = await import('@transcriptor/robinson');

  let idAsamblea: number | undefined;
  let clientName: string | undefined;

  // Try audio file names first (most descriptive), then folder name
  const hints = [
    ...folder.audioFiles.map(f => f.name),
    folder.folderName,
  ];

  for (const hint of hints) {
    try {
      const resolved = await robinson.resolveAssemblyFromHint(hint);
      if (resolved) {
        idAsamblea = resolved.idAsamblea;
        clientName = resolved.cliente;
        logger.info(`Resolved assembly from "${hint}": idAsamblea=${idAsamblea} (${clientName})`);
        break;
      }
    } catch (err) {
      logger.warn(`Assembly resolution failed for hint "${hint}": ${(err as Error).message}`);
    }
  }

  if (!idAsamblea) {
    logger.warn(`Could not resolve Tecnoreuniones assembly for folder "${folder.folderName}" — pipeline will proceed without roster data`);
  }

  // 2. Create pipeline job via Supervisor
  const eventFolder: import('@transcriptor/shared').EventFolder = {
    folderId: folder.folderId,
    folderName: folder.folderName,
    audioFiles: folder.audioFiles.map(f => f.name),
    votingFiles: folder.votingFiles.map(f => f.name),
    path: folder.folderId,
  };

  const pipelineJob = await supervisor.initPipeline(folder.folderId, eventFolder, { idAsamblea, clientName });
  const jobId = pipelineJob.jobId;

  // Advance pipeline to QUEUED stage
  await supervisor.advanceStage(jobId, EventStatus.QUEUED);

  folder.status = 'queued';
  folder.jobId = jobId;
  logger.info(`Enqueued folder: ${folder.folderName} → pipeline ${jobId}`);
  void persistDetectedFolders();

  // 2. Download audio files from Drive to data/jobs/<jobId>/raw/ (async, non-blocking)
  initChuchoProgress(jobId, folder.audioFiles.length);

  void (async () => {
    try {
      const { gwDriveDownloadFile, publishSuccess, publishFailure } = await import('@transcriptor/shared');
      const rawDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..', 'data', 'jobs', jobId, 'raw');
      await fs.promises.mkdir(rawDir, { recursive: true });

      logger.info(`Yulieth: downloading ${folder.audioFiles.length} audio file(s) for job ${jobId}`);
      for (let i = 0; i < folder.audioFiles.length; i++) {
        const audioFile = folder.audioFiles[i];
        const destPath = path.join(rawDir, audioFile.name);
        updateChuchoProgress(jobId, { currentFile: audioFile.name });
        await gwDriveDownloadFile(audioFile.id, destPath);
        updateChuchoProgress(jobId, { downloadedFiles: i + 1 });
        logger.info(`Yulieth: downloaded ${audioFile.name} → ${destPath}`);
      }

      // Mark QUEUED stage complete
      await supervisor.markStageComplete(jobId, EventStatus.QUEUED);
      folder.status = 'processing';
      void persistDetectedFolders();

      logger.info(`Yulieth: downloads complete for job ${jobId} — notifying Supervisor`);

      // 3. Notify Supervisor: files are ready for preprocessing
      await publishSuccess('files_ready', jobId, 'yulieth', { folderId });
    } catch (dlErr) {
      const msg = dlErr instanceof Error ? dlErr.message : String(dlErr);
      const { publishFailure } = await import('@transcriptor/shared');
      await supervisor.markStageFailed(jobId, EventStatus.QUEUED, `Download failed: ${msg}`);
      await publishFailure('preprocessing_failed', jobId, 'yulieth', `Download failed: ${msg}`);
      folder.status = 'error';
      void persistDetectedFolders();
      logger.error(`Yulieth: download failed for job ${jobId}: ${msg}`);
    }
  })();

  return { success: true, jobId };
}

// ── Auto-start when run directly ──
startServer();
