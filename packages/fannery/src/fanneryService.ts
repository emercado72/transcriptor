/**
 * Fannery Service — Job-level document assembly
 *
 * Orchestrates DOCX assembly for a job:
 *   1. Read Lina's redacted sections from data/jobs/<jobId>/redacted/
 *   2. Load template config and voting data (if available)
 *   3. Assemble the DOCX document via docx library
 *   4. Save locally to data/jobs/<jobId>/output/
 *   5. Optionally upload to Google Drive
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createLogger, getRedisClient } from '@transcriptor/shared';
import type { SectionFile, VotingPackage, TemplateConfig, PipelineJob } from '@transcriptor/shared';
import {
  getQuestionList,
  getVotingDetail,
  getElectionResults,
  getAttendanceList,
  getQuorumSnapshots,
  getOfficers,
  queryTecnoreuniones,
} from '@transcriptor/robinson';
import { assembleActa, loadTemplate, formatSpanishDate } from './documentAssembler.js';
import type { CoverInfo } from './documentSetup.js';
import { renderActaAsMarkdown } from './markdownRenderer.js';
import { renderMarkdownAsPdf } from './pdfRenderer.js';
import { enrichSectionsWithVotingData } from './markdownParser.js';
import {
  initFanneryProgress,
  updateFanneryProgress,
  markFanneryAssemblyComplete,
  markFanneryFailed,
} from './progressTracker.js';

const logger = createLogger('fannery:service');

export interface FanneryResult {
  jobId: string;
  documentPath: string;
  documentSizeBytes: number;
  markdownPath: string;
  sectionsAssembled: number;
  driveFileId: string | null;
}

// ── Path helpers ──

function getProjectRoot(): string {
  return path.resolve(import.meta.dirname, '../../..');
}

function getJobPaths(jobId: string) {
  const root = getProjectRoot();
  const jobDir = path.join(root, 'data', 'jobs', jobId);
  return {
    jobDir,
    redactedDir: path.join(jobDir, 'redacted'),
    outputDir: path.join(jobDir, 'output'),
  };
}

// ── Main entry point ──

export async function processJob(jobId: string): Promise<FanneryResult> {
  const { redactedDir, outputDir } = getJobPaths(jobId);
  logger.info(`Assembling document for job ${jobId}`);

  initFanneryProgress(jobId);
  updateFanneryProgress(jobId, { status: 'assembling' });

  // Ensure output dir exists
  await fs.mkdir(outputDir, { recursive: true });

  // ──────────────────────────────────────────────
  // Step 1: Load Lina's redacted sections
  // ──────────────────────────────────────────────
  const sectionFiles = await loadRedactedSections(redactedDir);
  if (sectionFiles.length === 0) {
    const err = `No redacted sections found in ${redactedDir}`;
    markFanneryFailed(jobId, err);
    throw new Error(err);
  }
  logger.info(`Loaded ${sectionFiles.length} redacted section(s)`);

  // ──────────────────────────────────────────────
  // Step 2: Load template config
  // ──────────────────────────────────────────────
  const templateConfig = loadTemplateForJob(jobId);
  logger.info(`Using template: ${templateConfig.templateId}`);

  // ──────────────────────────────────────────────
  // Step 3: Load voting data (if available from Robinson)
  // ──────────────────────────────────────────────
  const votingData = await loadVotingData(jobId);
  if (votingData.summaries.length > 0) {
    logger.info(`Loaded ${votingData.summaries.length} voting summaries`);
  } else {
    logger.info('No voting data available — proceeding without tables');
  }

  // ──────────────────────────────────────────────
  // Step 3.5: Parse markdown and inject voting data (LLM semantic matching)
  // ──────────────────────────────────────────────
  const enrichedSections = await enrichSectionsWithVotingData(sectionFiles, votingData);
  logger.info(`Enriched sections: ${enrichedSections.reduce((n, s) => n + s.content.length, 0)} content blocks total`);

  // ──────────────────────────────────────────────
  // Step 4: Load manifest metadata for file naming
  // ──────────────────────────────────────────────
  const manifest = loadRedactedManifest(redactedDir);
  const buildingName = await resolveBuildingName(jobId) || 'Acta';
  const assemblyDate = await resolveAssemblyDate(jobId) || new Date();
  const dateStr = assemblyDate.toISOString().split('T')[0];
  const baseName = `Acta_${buildingName.replace(/\s+/g, '_')}_${dateStr}`;
  const docFileName = `${baseName}.docx`;
  const mdFileName = `${baseName}.md`;
  const pdfFileName = `${baseName}.pdf`;

  // ──────────────────────────────────────────────
  // Step 5a: Generate Markdown preview
  // ──────────────────────────────────────────────
  logger.info('Generating Markdown preview...');
  const markdown = renderActaAsMarkdown(enrichedSections, votingData);
  const mdPath = path.join(outputDir, mdFileName);
  await fs.writeFile(mdPath, markdown, 'utf-8');
  logger.info(`Markdown saved: ${mdPath} (${markdown.length} chars)`);

  // ──────────────────────────────────────────────
  // Step 5b: Assemble the DOCX
  // ──────────────────────────────────────────────
  logger.info('Assembling DOCX document...');
  const coverInfo: CoverInfo = {
    buildingName: buildingName || 'Acta',
    assemblyType: 'ASAMBLEA GENERAL ORDINARIA DE PROPIETARIOS.',
    dateString: formatSpanishDate(assemblyDate),
  };
  const buffer = await assembleActa(enrichedSections, votingData, templateConfig, coverInfo);
  logger.info(`DOCX assembled: ${buffer.length} bytes`);

  // ──────────────────────────────────────────────
  // Step 5c: Generate PDF from Markdown
  // ──────────────────────────────────────────────
  logger.info('Generating PDF...');
  let pdfPath: string | null = null;
  try {
    const pdfBuffer = await renderMarkdownAsPdf(markdown);
    pdfPath = path.join(outputDir, pdfFileName);
    await fs.writeFile(pdfPath, pdfBuffer);
    logger.info(`PDF saved: ${pdfPath} (${pdfBuffer.length} bytes)`);
  } catch (err) {
    logger.warn(`PDF generation failed (non-fatal): ${(err as Error).message}`);
  }

  // ──────────────────────────────────────────────
  // Step 6: Save locally
  // ──────────────────────────────────────────────
  const localPath = path.join(outputDir, docFileName);
  await fs.writeFile(localPath, buffer);
  logger.info(`Document saved: ${localPath}`);

  // Save assembly manifest
  const assemblyManifest = {
    jobId,
    assembledAt: new Date().toISOString(),
    fileName: docFileName,
    filePath: localPath,
    markdownFileName: mdFileName,
    markdownPath: mdPath,
    markdownSizeBytes: Buffer.byteLength(markdown, 'utf-8'),
    pdfFileName: pdfPath ? pdfFileName : null,
    pdfPath: pdfPath,
    sizeBytes: buffer.length,
    sectionsAssembled: sectionFiles.length,
    templateId: templateConfig.templateId,
    votingQuestions: votingData.summaries.length,
    globalSpeakers: manifest?.globalSpeakers || [],
    identifiedSpeakers: manifest?.identifiedSpeakers || {},
  };
  await fs.writeFile(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify(assemblyManifest, null, 2),
    'utf-8',
  );

  // ──────────────────────────────────────────────
  // Step 7a: Upload assembly output to S3
  // ──────────────────────────────────────────────
  try {
    const { uploadJobStage } = await import('@transcriptor/shared');
    await uploadJobStage(jobId, 'output', outputDir);
    logger.info(`Uploaded assembly output to S3 for job ${jobId}`);
  } catch (e) {
    logger.error(`S3 upload failed for output: ${(e as Error).message}`);
  }

  // ──────────────────────────────────────────────
  // Step 7b: Upload to Google Drive (if configured)
  // ──────────────────────────────────────────────
  let driveFileId: string | null = null;
  // TODO: implement Google Drive upload when credentials are configured
  // try {
  //   updateFanneryProgress(jobId, { status: 'uploading' });
  //   const env = getEnvConfig();
  //   if (env.googleClientId && env.googleRefreshToken) {
  //     driveFileId = await saveToGoogleDrive(buffer, eventFolder, docFileName);
  //   }
  // } catch (err) { ... }

  // ── Done ──
  markFanneryAssemblyComplete(jobId, {
    inputSections: sectionFiles.length,
    documentSizeBytes: buffer.length,
    outputPath: localPath,
    markdownPath: mdPath,
    pdfPath,
    driveFileId,
    driveFileName: driveFileId ? docFileName : null,
  });

  logger.info(`Job ${jobId} complete: ${docFileName} (${buffer.length} bytes, ${sectionFiles.length} sections) + ${mdFileName}`);

  return {
    jobId,
    documentPath: localPath,
    documentSizeBytes: buffer.length,
    markdownPath: mdPath,
    sectionsAssembled: sectionFiles.length,
    driveFileId,
  };
}

// ── Helpers ──

async function loadRedactedSections(redactedDir: string): Promise<SectionFile[]> {
  if (!existsSync(redactedDir)) {
    return [];
  }

  const files = await fs.readdir(redactedDir);
  const sectionFiles = files
    .filter(f => f.endsWith('.json') && f !== 'manifest.json')
    .sort();

  const sections: SectionFile[] = [];
  for (const file of sectionFiles) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(redactedDir, file), 'utf-8'));
      if (data.sectionId && data.content) {
        sections.push(data as SectionFile);
      }
    } catch {
      logger.warn(`Skipping non-section file: ${file}`);
    }
  }

  return sections.sort((a, b) => a.order - b.order);
}

function loadTemplateForJob(_jobId: string): TemplateConfig {
  // Try loading from config
  const root = getProjectRoot();
  const configPath = path.join(root, 'config', 'template.json');
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8')) as TemplateConfig;
    } catch {
      logger.warn('Failed to load template config, using default');
    }
  }
  return loadTemplate('default');
}

function loadVotingData(jobId: string): Promise<VotingPackage> {
  return loadVotingDataFromRobinson(jobId);
}

const EMPTY_VOTING: VotingPackage = {
  summaries: [],
  details: [],
  elections: [],
  attendance: [],
  quorum: [],
  officers: {
    president: '[Por identificar]',
    secretary: '[Por identificar]',
    verificadores: [],
  },
};

/**
 * Load voting data from Robinson via Tecnoreuniones DB.
 * Reads idAsamblea from the PipelineJob stored in Redis.
 */
async function loadVotingDataFromRobinson(jobId: string): Promise<VotingPackage> {
  try {
    // Get idAsamblea from pipeline job in Redis
    const redis = getRedisClient();
    const raw = await redis.get(`transcriptor:pipeline:${jobId}`);
    if (!raw) {
      logger.warn(`No pipeline job found in Redis for ${jobId} — skipping voting data`);
      return EMPTY_VOTING;
    }

    const pipelineJob = JSON.parse(raw) as PipelineJob;
    const idAsamblea = pipelineJob.idAsamblea;
    if (!idAsamblea) {
      logger.warn(`No idAsamblea on pipeline job ${jobId} — skipping voting data`);
      return EMPTY_VOTING;
    }

    const eventId = String(idAsamblea);
    logger.info(`Loading voting data from Robinson: idAsamblea=${idAsamblea}`);

    // Fetch all voting data in parallel
    const [summaries, attendance, quorum, officerRoles] = await Promise.all([
      getQuestionList(eventId),
      getAttendanceList(eventId).catch((err) => {
        logger.warn(`Failed to fetch attendance: ${(err as Error).message}`);
        return [] as import('@transcriptor/shared').AttendanceRecord[];
      }),
      getQuorumSnapshots(eventId).catch((err) => {
        logger.warn(`Failed to fetch quorum: ${(err as Error).message}`);
        return [] as import('@transcriptor/shared').QuorumSnapshot[];
      }),
      getOfficers(eventId).catch((err) => {
        logger.warn(`Failed to fetch officers: ${(err as Error).message}`);
        return EMPTY_VOTING.officers;
      }),
    ]);

    logger.info(`Robinson voting data: ${summaries.length} questions, ${attendance.length} attendees, ${quorum.length} quorum snapshots`);

    // Fetch detail and election results for each question
    const details: import('@transcriptor/shared').VotingDetail[] = [];
    const elections: import('@transcriptor/shared').ElectionResult[] = [];

    for (const summary of summaries) {
      try {
        const detail = await getVotingDetail(eventId, summary.questionId);
        details.push(detail);
      } catch (err) {
        logger.warn(`Failed to fetch voting detail for question ${summary.questionId}: ${(err as Error).message}`);
      }

      // Election-type questions
      if (summary.questionType === 'election') {
        try {
          const election = await getElectionResults(eventId, summary.questionId);
          elections.push(election);
        } catch (err) {
          logger.warn(`Failed to fetch election results for question ${summary.questionId}: ${(err as Error).message}`);
        }
      }
    }

    return {
      summaries,
      details,
      elections,
      attendance,
      quorum,
      officers: officerRoles,
    };
  } catch (err) {
    logger.error(`Failed to load voting data from Robinson: ${(err as Error).message}`);
    return EMPTY_VOTING;
  }
}

interface RedactedManifest {
  globalSpeakers?: string[];
  identifiedSpeakers?: Record<string, string>;
}

function loadRedactedManifest(redactedDir: string): RedactedManifest | null {
  const manifestPath = path.join(redactedDir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as RedactedManifest;
  } catch {
    return null;
  }
}

/**
 * Resolve the actual assembly date from Tecnoreuniones DB.
 * Uses the earliest quorum snapshot timestamp (fhoperacion) as the true event date.
 * Falls back to null if no data is available.
 */
async function resolveAssemblyDate(jobId: string): Promise<Date | null> {
  try {
    const redis = getRedisClient();
    const raw = await redis.get(`transcriptor:pipeline:${jobId}`);
    if (!raw) return null;
    const pipelineJob = JSON.parse(raw) as PipelineJob;
    const idAsamblea = pipelineJob.idAsamblea;
    if (!idAsamblea) return null;

    const rows = await queryTecnoreuniones(
      'SELECT fhoperacion FROM quorumRespuestas WHERE idAsamblea = ? ORDER BY fhoperacion ASC LIMIT 1',
      [idAsamblea],
    );
    if (rows.length > 0 && rows[0].fhoperacion) {
      const date = new Date(rows[0].fhoperacion as string);
      logger.info(`Resolved assembly date: ${date.toISOString().split('T')[0]} (from quorum data)`);
      return date;
    }
    return null;
  } catch (err) {
    logger.warn(`Failed to resolve assembly date: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Resolve a human-friendly building name from the pipeline job metadata.
 * Falls back to 'Acta' if no clientName is available.
 */
async function resolveBuildingName(jobId: string): Promise<string | null> {
  try {
    const redis = getRedisClient();
    const raw = await redis.get(`transcriptor:pipeline:${jobId}`);
    if (!raw) return null;
    const pipelineJob = JSON.parse(raw) as PipelineJob;
    if (pipelineJob.clientName) {
      // Title-case: "PORTAL VALPARAISO" → "Portal Valparaiso"
      return pipelineJob.clientName
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return null;
  } catch {
    return null;
  }
}
