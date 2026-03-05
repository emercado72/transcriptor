/**
 * Lina Service — Job-level processing
 *
 * Orchestrates the full redaction pipeline for a job:
 *   1. Load Jaime's transcript chunks from audio-transcriber output
 *   2. Reconcile speakers across chunks (cross-chunk diarization fix)
 *   3. Map reconciled transcript to sections (using Jaime's section mapper output)
 *   4. Redact each section into formal legal language
 *   5. Write output for Fannery
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createLogger, getRedisClient } from '@transcriptor/shared';
import type {
  GlossaryEntry,
  TemplateConfig,
  PipelineJob,
  EventMetadata,
  OfficerRoles,
  VotingSummary,
  AttendanceRecord,
} from '@transcriptor/shared';
import {
  getEventMetadata,
  getQuestionList,
  getAttendanceList,
  getOfficers,
  getRoster,
} from '@transcriptor/robinson';
import {
  reconcileSpeakers,
  groupConsecutiveSpeakers,
  loadChunkTranscripts,
} from './speakerReconciler.js';
import type { ReconciliationResult, TranscriptSegment } from './speakerReconciler.js';
import { redactAllSections, validateRedaction } from './redactionEngine.js';
import type { RawSection, RedactionContext } from './redactionEngine.js';
import {
  initLinaProgress,
  updateLinaProgress,
  markLinaReconciliation,
  markLinaRedactionComplete,
  markLinaFailed,
} from './progressTracker.js';

const logger = createLogger('lina:service');

export interface LinaResult {
  jobId: string;
  reconciliation: ReconciliationResult;
  sectionsRedacted: number;
  validationErrors: string[];
  validationWarnings: string[];
  outputDir: string;
}

// ── Path helpers ──

function getProjectRoot(): string {
  // packages/lina/src → ../../..
  return path.resolve(import.meta.dirname, '../../..');
}

function getJobPaths(jobId: string) {
  const root = getProjectRoot();
  const jobDir = path.join(root, 'data', 'jobs', jobId);
  return {
    jobDir,
    processedDir: path.join(jobDir, 'processed'),
    sectionsDir: path.join(jobDir, 'sections'),
    transcriptDir: path.join(jobDir, 'transcript'),
    redactedDir: path.join(jobDir, 'redacted'),
  };
}

function getAudioTranscriberOutputDir(): string {
  const envPath = process.env.AUDIO_TRANSCRIBER_PATH;
  if (envPath) return path.join(envPath, 'output');
  return path.resolve(getProjectRoot(), '..', 'audio-transcriber', 'output');
}

// ── Main entry point ──

export async function processJob(jobId: string): Promise<LinaResult> {
  const { processedDir, sectionsDir, transcriptDir, redactedDir } = getJobPaths(jobId);
  logger.info(`Processing job ${jobId}`);

  initLinaProgress(jobId);
  updateLinaProgress(jobId, { status: 'reconciling' });

  // Ensure output dirs exist
  await fs.mkdir(redactedDir, { recursive: true });
  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.mkdir(sectionsDir, { recursive: true });

  // ──────────────────────────────────────────────
  // Step 1: Locate transcript chunks
  // ──────────────────────────────────────────────
  const transcriptFiles = findTranscriptChunks(jobId, processedDir);
  logger.info(`Found ${transcriptFiles.length} transcript chunk(s)`);

  // ──────────────────────────────────────────────
  // Step 2: Load chunks and reconcile speakers
  // ──────────────────────────────────────────────
  const chunks = loadChunkTranscripts(transcriptFiles);
  logger.info(`Loaded ${chunks.length} chunk(s) with total ${chunks.reduce((s, c) => s + c.segments.length, 0)} segments`);

  const reconciliation = await reconcileSpeakers(chunks, jobId);
  logger.info(`Speaker reconciliation: ${reconciliation.globalSpeakers.length} global speakers, confidence ${reconciliation.confidence}`);

  markLinaReconciliation(jobId, {
    globalSpeakers: reconciliation.globalSpeakers.length,
    identifiedSpeakers: Object.keys(reconciliation.identifiedSpeakers).length,
    confidence: reconciliation.confidence,
    speakerNames: reconciliation.identifiedSpeakers,
  });

  // Group consecutive same-speaker segments after reconciliation
  const mergedSegments = groupConsecutiveSpeakers(reconciliation.mergedSegments);
  logger.info(`Merged transcript: ${mergedSegments.length} speaker blocks`);

  // Save the reconciled transcript
  const reconciledTranscriptPath = path.join(transcriptDir, 'transcript_reconciled.json');
  await fs.writeFile(reconciledTranscriptPath, JSON.stringify({
    jobId,
    reconciliation: {
      globalSpeakers: reconciliation.globalSpeakers,
      identifiedSpeakers: reconciliation.identifiedSpeakers,
      chunkMaps: reconciliation.chunkMaps,
      confidence: reconciliation.confidence,
      reasoning: reconciliation.reasoning,
    },
    segments: mergedSegments,
    totalDuration: chunks.reduce((s, c) => s + c.durationSeconds, 0),
  }, null, 2), 'utf-8');
  logger.info(`Saved reconciled transcript: ${reconciledTranscriptPath}`);

  // ──────────────────────────────────────────────
  // Step 3: Build sections from reconciled transcript
  // ──────────────────────────────────────────────
  // Check if Jaime already produced section files
  let rawSections: RawSection[];
  const existingSections = await loadExistingSections(sectionsDir);

  if (existingSections.length > 0) {
    logger.info(`Using ${existingSections.length} existing sections from Jaime`);
    // Re-map speaker labels in existing sections using reconciliation
    rawSections = remapSectionsWithReconciliation(existingSections, reconciliation);
  } else {
    logger.info('No existing sections found — building from reconciled transcript');
    rawSections = buildSectionsFromTranscript(mergedSegments);
  }

  logger.info(`${rawSections.length} sections ready for redaction`);

  // Save the raw sections (with reconciled speakers)
  for (const section of rawSections) {
    const sectionPath = path.join(sectionsDir, `${section.sectionId}.json`);
    await fs.writeFile(sectionPath, JSON.stringify(section, null, 2), 'utf-8');
  }

  // ──────────────────────────────────────────────
  // Step 4: Load context (glossary, event metadata) from Robinson
  // ──────────────────────────────────────────────
  const context = await loadRedactionContextFromRobinson(jobId, reconciliation.identifiedSpeakers);
  const templateConfig = loadTemplateConfig();

  // ──────────────────────────────────────────────
  // Step 5: Redact each section via LLM
  // ──────────────────────────────────────────────
  logger.info(`Starting redaction of ${rawSections.length} sections`);
  const redactedSections = await redactAllSections(rawSections, templateConfig, context);

  // ──────────────────────────────────────────────
  // Step 6: Validate and save output
  // ──────────────────────────────────────────────
  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  for (let i = 0; i < redactedSections.length; i++) {
    const validation = validateRedaction(redactedSections[i], rawSections[i]);
    if (!validation.valid) {
      allErrors.push(`Section ${rawSections[i].sectionId}: ${validation.errors.join(', ')}`);
    }
    allWarnings.push(...validation.warnings.map(w => `Section ${rawSections[i].sectionId}: ${w}`));

    // Save redacted section
    const outPath = path.join(redactedDir, `${redactedSections[i].sectionId}.json`);
    await fs.writeFile(outPath, JSON.stringify(redactedSections[i], null, 2), 'utf-8');
  }

  // Save a manifest for Fannery
  const manifest = {
    jobId,
    redactedAt: new Date().toISOString(),
    totalSections: redactedSections.length,
    globalSpeakers: reconciliation.globalSpeakers,
    identifiedSpeakers: reconciliation.identifiedSpeakers,
    speakerReconciliationConfidence: reconciliation.confidence,
    validationErrors: allErrors,
    validationWarnings: allWarnings,
    sections: redactedSections.map(s => ({
      sectionId: s.sectionId,
      sectionTitle: s.sectionTitle,
      sectionStyle: s.sectionStyle,
      order: s.order,
    })),
  };
  await fs.writeFile(
    path.join(redactedDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );

  logger.info(`Redaction complete: ${redactedSections.length} sections, ${allErrors.length} errors, ${allWarnings.length} warnings`);

  markLinaRedactionComplete(jobId, {
    totalSections: redactedSections.length,
    validationErrors: allErrors.length,
    validationWarnings: allWarnings.length,
    outputDir: redactedDir,
  });

  return {
    jobId,
    reconciliation,
    sectionsRedacted: redactedSections.length,
    validationErrors: allErrors,
    validationWarnings: allWarnings,
    outputDir: redactedDir,
  };
}

// ── Helpers ──

/**
 * Find transcript JSON files from the audio-transcriber output.
 * These are named like: <basename>_part000_transcript.json
 */
function findTranscriptChunks(jobId: string, processedDir: string): string[] {
  const outputDir = getAudioTranscriberOutputDir();

  // Read the manifest to get the original file names
  const manifestPath = path.join(processedDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const processedFiles: string[] = manifest.processedFiles || [];

  // Derive expected transcript file names from processed FLAC file names
  const transcriptFiles: string[] = [];

  for (const flacPath of processedFiles) {
    const baseName = path.basename(flacPath, '.flac');
    const expectedJson = path.join(outputDir, `${baseName}_transcript.json`);

    if (existsSync(expectedJson)) {
      transcriptFiles.push(expectedJson);
    } else {
      logger.warn(`Transcript file not found: ${expectedJson}`);
    }
  }

  if (transcriptFiles.length === 0) {
    // Try scanning the output dir directly
    const allFiles = readdirSync(outputDir) as string[];
    const jsonFiles = allFiles
      .filter((f: string) => f.endsWith('_transcript.json'))
      .sort()
      .map((f: string) => path.join(outputDir, f));

    if (jsonFiles.length > 0) {
      logger.info(`Found ${jsonFiles.length} transcript files by scanning output dir`);
      return jsonFiles;
    }

    throw new Error(`No transcript files found in ${outputDir}`);
  }

  return transcriptFiles.sort();
}

/**
 * Load existing section files from Jaime's output.
 */
async function loadExistingSections(sectionsDir: string): Promise<RawSection[]> {
  try {
    const files = await fs.readdir(sectionsDir);
    const sectionFiles = files
      .filter(f => f.endsWith('.json') && f !== 'qa_report.json')
      .sort();

    const sections: RawSection[] = [];
    for (const file of sectionFiles) {
      try {
        const data = JSON.parse(await fs.readFile(path.join(sectionsDir, file), 'utf-8'));
        if (data.sectionId && data.rawText) {
          sections.push(data as RawSection);
        }
      } catch {
        // Skip non-section files
      }
    }
    return sections;
  } catch {
    return [];
  }
}

/**
 * Re-map speaker labels in existing Jaime sections using the reconciliation result.
 * Jaime's sections may reference chunk-local speaker labels like "Speaker A" —
 * we replace them with the global reconciled labels.
 */
function remapSectionsWithReconciliation(
  sections: RawSection[],
  reconciliation: ReconciliationResult,
): RawSection[] {
  // Build a flat mapping from all possible local labels to global labels
  const flatMap: Record<string, string> = {};
  for (const chunkMap of reconciliation.chunkMaps) {
    for (const [local, global] of Object.entries(chunkMap)) {
      // If multiple chunks map "Speaker A" to different globals,
      // the last one wins — but for rawText replacement we'll use a more careful approach
      flatMap[local] = global;
    }
  }

  return sections.map(section => ({
    ...section,
    rawText: replaceSpeakerLabels(section.rawText, flatMap),
  }));
}

function replaceSpeakerLabels(text: string, mapping: Record<string, string>): string {
  let result = text;
  // Sort by length descending to avoid partial replacements (e.g., "Speaker A" before "Speaker")
  const sorted = Object.entries(mapping).sort((a, b) => b[0].length - a[0].length);
  for (const [local, global] of sorted) {
    result = result.replaceAll(local, global);
  }
  return result;
}

/**
 * Build sections from the reconciled transcript when Jaime hasn't produced section files.
 * Uses a simple approach: one section per "topic block" based on speaker patterns.
 */
function buildSectionsFromTranscript(segments: TranscriptSegment[]): RawSection[] {
  // For now, create a single section with the full transcript
  // This will be improved when we integrate with Jaime's sectionMapper
  const fullText = segments
    .map(s => `[${s.speaker}]: ${s.text}`)
    .join('\n');

  return [{
    sectionId: '01_fullTranscript',
    sectionTitle: 'Transcripción Completa',
    sectionStyle: 'paragraphNormal' as any,
    order: 1,
    rawText: fullText,
  }];
}

/**
 * Load glossary and build RedactionContext from Robinson + Redis pipeline state.
 */
async function loadRedactionContextFromRobinson(
  jobId: string,
  identifiedSpeakers: Record<string, string>,
): Promise<RedactionContext> {
  const root = getProjectRoot();

  // Load default glossary
  let glossary: GlossaryEntry[] = [];
  const glossaryPath = path.join(root, 'config', 'glossary', 'default.json');
  if (existsSync(glossaryPath)) {
    try {
      glossary = JSON.parse(readFileSync(glossaryPath, 'utf-8'));
      logger.info(`Loaded ${glossary.length} glossary entries`);
    } catch (e) {
      logger.warn('Failed to load glossary', e);
    }
  }

  // Read pipeline state from Redis to get idAsamblea
  let eventMeta: EventMetadata = {
    eventId: jobId,
    buildingName: '',
    buildingNit: '',
    city: '',
    date: new Date(),
    eventType: 'ordinaria',
    startTime: '',
    endTime: '',
  };
  let officerRoles: OfficerRoles = {
    president: '[Por identificar]',
    secretary: '[Por identificar]',
    verificadores: [],
  };
  let questionList: VotingSummary[] = [];
  let attendanceRoster: { unit: string; tower: string; ownerName: string; delegateName: string }[] = [];
  let clientName = '';

  try {
    logger.info(`loadRedactionContextFromRobinson: reading Redis pipeline state for ${jobId}`);
    const redis = getRedisClient();
    const raw = await redis.get(`transcriptor:pipeline:${jobId}`);

    if (raw) {
      const pipeline = JSON.parse(raw) as PipelineJob;
      clientName = pipeline.clientName || '';
      const idAsamblea = pipeline.idAsamblea;

      if (idAsamblea) {
        const eventId = String(idAsamblea);
        logger.info(`Loading redaction context from Robinson: idAsamblea=${idAsamblea} (${clientName})`);

        // Fetch metadata, questions, and attendance in parallel
        const [meta, questions, attendance, officers] = await Promise.all([
          getEventMetadata(eventId).catch((err: Error) => {
            logger.warn(`Failed to load event metadata: ${err.message}`);
            return null;
          }),
          getQuestionList(eventId).catch((err: Error) => {
            logger.warn(`Failed to load question list: ${err.message}`);
            return [] as VotingSummary[];
          }),
          getAttendanceList(eventId).catch((err: Error) => {
            logger.warn(`Failed to load attendance list: ${err.message}`);
            return [] as AttendanceRecord[];
          }),
          getOfficers(eventId).catch((err: Error) => {
            logger.warn(`Failed to load officers: ${err.message}`);
            return null;
          }),
        ]);

        if (meta) eventMeta = meta;
        if (questions.length > 0) questionList = questions;
        if (officers) officerRoles = officers;

        // Build attendance roster for the prompt — include ALL residents, not just present
        // The HTTP attendance service may have stale data for closed assemblies,
        // so also load the full roster from the DB as a fallback
        if (attendance.length > 0) {
          attendanceRoster = attendance
            .map(a => ({
              unit: a.unit,
              tower: String(a.tower),
              ownerName: a.ownerName,
              delegateName: a.delegateName || '',
            }));
          logger.info(`Loaded ${attendanceRoster.length} residents for redaction context`);
        }

        // Fallback: if the HTTP attendance service returned no/empty data,
        // load from Robinson's roster service (DB-backed, always reliable)
        if (attendanceRoster.length === 0) {
          try {
            const rosterRecords = await getRoster(eventId);
            if (rosterRecords.length > 0) {
              attendanceRoster = rosterRecords.map(r => ({
                unit: r.unit,
                tower: r.tower,
                ownerName: r.ownerName,
                delegateName: r.delegateName,
              }));
              logger.info(`Roster via Robinson: loaded ${attendanceRoster.length} residents`);
            }
          } catch (rosterErr) {
            logger.warn(`Robinson roster fallback failed: ${(rosterErr as Error).message}`);
          }
        }

        logger.info(`Robinson context loaded: ${clientName}, ${questionList.length} questions, ${attendanceRoster.length} attendees`);
      } else {
        logger.warn('Pipeline has no idAsamblea — using minimal context');
      }
    } else {
      logger.warn(`No pipeline state in Redis for ${jobId} — using minimal context`);
    }
  } catch (err) {
    logger.warn(`Failed to load Robinson context (non-fatal): ${(err as Error).message}`, { stack: (err as Error).stack });
  }

  return {
    eventMetadata: eventMeta,
    officers: officerRoles,
    glossary,
    questionList,
    clientConfig: {
      buildingName: eventMeta.buildingName || clientName,
      nit: eventMeta.buildingNit || '',
      towers: 0,
      unitsPerTower: 0,
      adminName: '',
      customTerms: [],
    },
    identifiedSpeakers,
    attendanceRoster,
  };
}

function loadTemplateConfig(): TemplateConfig {
  return {
    templateId: 'default',
    fontFamily: 'Arial',
    fontSize: 12,
    titleFontSize: 14,
    margins: { top: 2.54, bottom: 2.54, left: 3.18, right: 3.18 },
    headerText: '',
    footerText: '',
    lineSpacing: 1.15,
  };
}
