/**
 * Jaime — Transcription + QA + Sectioning Service
 *
 * Responsibilities:
 *   1. Receive preprocessed audio from Chucho (FLAC files in data/jobs/<jobId>/processed/)
 *   2. Transcribe audio using the configured provider (local or ElevenLabs)
 *   3. Run QA on the transcript (detect nonsense, validate names/units)
 *   4. Map transcript to assembly sections
 *   5. Output section files to data/jobs/<jobId>/sections/
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger, tokenOverlapRatio } from '@transcriptor/shared';
import type { VotingSummary, AttendanceRecord } from '@transcriptor/shared';
import { transcribeAudio, getTranscriptionProvider } from './transcriptionManager.js';
import type { ScribeOptions, ScribeTranscript } from './transcriptionManager.js';
import { mapTranscriptToSections, matchVotingSegments, extractAgendaItems } from './sectionMapper.js';
import type { RawSection } from './sectionMapper.js';
import { analyzeTranscriptionQuality, detectNonsenseWords, validateProperNames } from './transcriptionQa.js';
import type { QaReport } from './transcriptionQa.js';
import {
  initJobProgress,
  markSegmentStarted,
  markSegmentCompleted,
  markSegmentFailed,
  markJobDone,
} from './progressTracker.js';

const logger = createLogger('jaime:service');

const execFileAsync = promisify(execFile);

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.mp4', '.wma', '.webm']);

/**
 * Get audio duration using ffprobe.
 */
async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeout: 60000 });
    const duration = parseFloat(stdout.trim());
    return isNaN(duration) ? 0 : duration;
  } catch {
    return 0;
  }
}

/**
 * Build a manifest directly from raw audio files, bypassing Chucho.
 * Whisper and Pyannote can process MP4/MP3/etc directly.
 */
async function buildManifestFromRaw(rawDir: string, processedDir: string): Promise<{
  processedFiles: string[];
  totalDuration: number;
  segments: Array<{ duration: number }>;
}> {
  const entries = await fs.readdir(rawDir);
  const audioFiles = entries
    .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
    .sort()
    .map(f => path.join(rawDir, f));

  if (audioFiles.length === 0) {
    throw new Error(`No audio files found in ${rawDir}`);
  }

  const segments: Array<{ duration: number }> = [];
  let totalDuration = 0;

  for (const file of audioFiles) {
    const duration = await getAudioDuration(file);
    segments.push({ duration });
    totalDuration += duration;
    logger.info(`Raw audio: ${path.basename(file)} — ${(duration / 60).toFixed(1)} min`);
  }

  // Write manifest to processed dir so downstream agents can find it
  await fs.mkdir(processedDir, { recursive: true });
  const manifest = { processedFiles: audioFiles, totalDuration, segments };
  await fs.writeFile(path.join(processedDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  logger.info(`Built manifest from raw: ${audioFiles.length} files, ${(totalDuration / 60).toFixed(1)} min total`);

  return manifest;
}

export interface JaimeResult {
  jobId: string;
  provider: string;
  transcript: ScribeTranscript;
  sections: RawSection[];
  qaReport: QaReport;
  agendaItems: string[];
  errors: string[];
}

/**
 * Get the standard job directory paths.
 */
function getJobPaths(jobId: string) {
  const projectRoot = path.resolve(import.meta.dirname, '../../..');
  const jobDir = path.join(projectRoot, 'data', 'jobs', jobId);
  return {
    jobDir,
    rawDir: path.join(jobDir, 'raw'),
    processedDir: path.join(jobDir, 'processed'),
    sectionsDir: path.join(jobDir, 'sections'),
    transcriptDir: path.join(jobDir, 'transcript'),
  };
}

/**
 * Run Jaime's full pipeline for a job.
 *
 * Reads preprocessed audio from Chucho's output,
 * transcribes, runs QA, maps to sections, and writes output.
 */
export async function processJob(
  jobId: string,
  questionList: VotingSummary[] = [],
  attendanceList: AttendanceRecord[] = [],
  glossary: Array<{ term: string; replacement: string; context: string; clientId: string | null }> = [],
): Promise<JaimeResult> {
  const { rawDir, processedDir, sectionsDir, transcriptDir } = getJobPaths(jobId);
  const provider = getTranscriptionProvider();
  const errors: string[] = [];

  logger.info(`Processing job ${jobId} with provider: ${provider}`);

  // Ensure output dirs exist
  await fs.mkdir(sectionsDir, { recursive: true });
  await fs.mkdir(transcriptDir, { recursive: true });

  // 1. Read manifest — try Chucho's processed dir first, fall back to raw files
  const manifestPath = path.join(processedDir, 'manifest.json');
  let processedFiles: string[];
  let manifest: any;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    processedFiles = manifest.processedFiles;
    logger.info(`Found ${processedFiles.length} processed audio file(s) from Chucho`);
  } catch {
    logger.info('No Chucho manifest found — building manifest from raw audio files (bypass mode)');
    manifest = await buildManifestFromRaw(rawDir, processedDir);
    processedFiles = manifest.processedFiles;
  }

  if (processedFiles.length === 0) {
    throw new Error('No processed audio files found in manifest');
  }

  // Initialize progress tracker with file names and durations from manifest
  const fileNames = processedFiles.map(f => path.basename(f));
  const durations: number[] = (manifest.segments ?? []).map((s: { duration: number }) => s.duration);
  // If no per-segment durations, distribute total evenly
  if (durations.length === 0 && manifest.totalDuration) {
    const perSegment = manifest.totalDuration / processedFiles.length;
    for (let i = 0; i < processedFiles.length; i++) durations.push(perSegment);
  }
  initJobProgress(jobId, provider, fileNames, durations);

  // 2. Transcribe each audio file
  const allTranscripts: ScribeTranscript[] = [];
  for (let i = 0; i < processedFiles.length; i++) {
    const audioFile = processedFiles[i];
    logger.info(`Transcribing: ${path.basename(audioFile)}`);
    markSegmentStarted(jobId, i);
    try {
      const options: ScribeOptions = { language: 'es', diarization: true, timestamps: true };
      const transcript = await transcribeAudio(audioFile, options, { jobId, segmentIndex: i });
      allTranscripts.push(transcript);
      markSegmentCompleted(jobId, i);
      logger.info(`Transcribed ${path.basename(audioFile)}: ${transcript.utterances.length} utterances, ${transcript.duration}s`);
    } catch (err) {
      const msg = `Transcription failed for ${path.basename(audioFile)}: ${(err as Error).message}`;
      logger.error(msg);
      errors.push(msg);
      markSegmentFailed(jobId, i, msg);
    }
  }

  if (allTranscripts.length === 0) {
    markJobDone(jobId, 'failed');
    throw new Error('All transcriptions failed');
  }

  // 3. Merge transcripts if multiple files
  const mergedTranscript = mergeTranscripts(allTranscripts);

  // Save raw transcript
  const transcriptPath = path.join(transcriptDir, 'transcript.json');
  await fs.writeFile(transcriptPath, JSON.stringify(mergedTranscript, null, 2), 'utf-8');
  logger.info(`Raw transcript saved: ${transcriptPath}`);

  // Upload transcript to S3
  try {
    const { uploadJobStage } = await import('@transcriptor/shared');
    await uploadJobStage(jobId, 'transcript', transcriptDir);
    logger.info(`Uploaded transcript to S3 for job ${jobId}`);
  } catch (e) {
    logger.error(`S3 upload failed for transcript: ${(e as Error).message}`);
  }

  // 4. Run QA
  logger.info('Running transcription QA...');
  const sections = await mapTranscriptToSections(mergedTranscript, questionList);
  const qaReport = analyzeTranscriptionQuality(sections);
  logger.info(`QA complete: score=${qaReport.overallScore}, flags=${qaReport.totalFlags}`);

  // 5. Extract agenda items
  const agendaItems = extractAgendaItems(mergedTranscript);
  logger.info(`Extracted ${agendaItems.length} agenda items`);

  // 6. Match voting segments
  if (questionList.length > 0) {
    const votingSegments = matchVotingSegments(mergedTranscript, questionList);
    logger.info(`Matched ${votingSegments.length} voting segments`);
  }

  // 7. Write section files
  for (const section of sections) {
    const sectionPath = path.join(sectionsDir, `${section.sectionId}.json`);
    await fs.writeFile(sectionPath, JSON.stringify(section, null, 2), 'utf-8');
  }
  logger.info(`Wrote ${sections.length} section files to ${sectionsDir}`);

  // Upload sections to S3
  try {
    const { uploadJobStage } = await import('@transcriptor/shared');
    await uploadJobStage(jobId, 'sections', sectionsDir);
    logger.info(`Uploaded sections to S3 for job ${jobId}`);
  } catch (e) {
    logger.error(`S3 upload failed for sections: ${(e as Error).message}`);
  }

  // 8. Write QA report
  const qaPath = path.join(sectionsDir, 'qa_report.json');
  await fs.writeFile(qaPath, JSON.stringify(qaReport, null, 2), 'utf-8');

  const result: JaimeResult = {
    jobId,
    provider,
    transcript: mergedTranscript,
    sections,
    qaReport,
    agendaItems,
    errors,
  };

  logger.info(`Job ${jobId} complete: ${sections.length} sections, provider=${provider}`);
  markJobDone(jobId, 'completed');
  return result;
}

/**
 * Merge multiple transcripts (from split audio) into one continuous transcript.
 * Deduplicates utterances near chunk boundaries where overlapping speech
 * may have been transcribed in both adjacent segments.
 */
function mergeTranscripts(transcripts: ScribeTranscript[]): ScribeTranscript {
  if (transcripts.length === 1) return transcripts[0];

  let offset = 0;
  const allUtterances: typeof transcripts[0]['utterances'] = [];

  for (let i = 0; i < transcripts.length; i++) {
    const t = transcripts[i];
    let utterances = t.utterances;

    // Dedup against the tail of the previous transcript
    if (i > 0) {
      utterances = dedupBoundaryUtterances(
        transcripts[i - 1].utterances,
        transcripts[i - 1].duration,
        utterances,
      );
    }

    for (const u of utterances) {
      allUtterances.push({
        ...u,
        startTime: u.startTime + offset,
        endTime: u.endTime + offset,
      });
    }
    offset += t.duration;
  }

  return {
    jobId: transcripts[0].jobId,
    text: allUtterances.map(u => u.text).join(' '),
    utterances: allUtterances,
    duration: offset,
    language: transcripts[0].language,
  };
}

// ── Boundary dedup helpers ──

/** Seconds from each chunk boundary to check for duplicates. */
const BOUNDARY_ZONE_S = 60;
/** Minimum token overlap ratio to consider an utterance a duplicate. */
const DEDUP_THRESHOLD = 0.7;

import type { ScribeUtterance } from './transcriptionManager.js';

/**
 * Remove duplicate utterances near the boundary between two consecutive transcripts.
 *
 * Compares utterances near the END of prevTranscript (within BOUNDARY_ZONE of its duration)
 * with utterances near the START of nextTranscript (within BOUNDARY_ZONE of time 0).
 * Utterances in next that have high token overlap with any prev boundary utterance are dropped.
 */
function dedupBoundaryUtterances(
  prevUtterances: ScribeUtterance[],
  prevDuration: number,
  nextUtterances: ScribeUtterance[],
): ScribeUtterance[] {
  const boundaryStart = prevDuration - BOUNDARY_ZONE_S;
  const prevBoundary = prevUtterances.filter(u => u.startTime >= boundaryStart);

  if (prevBoundary.length === 0) return nextUtterances;

  const duplicateIndices = new Set<number>();

  for (let ni = 0; ni < nextUtterances.length; ni++) {
    const nextU = nextUtterances[ni];
    if (nextU.startTime > BOUNDARY_ZONE_S) break; // Past boundary zone

    for (const prevU of prevBoundary) {
      const similarity = tokenOverlapRatio(prevU.text, nextU.text);
      if (similarity >= DEDUP_THRESHOLD) {
        duplicateIndices.add(ni);
        logger.info(
          `Boundary dedup: dropping utterance at ${nextU.startTime.toFixed(1)}s ` +
          `(sim=${similarity.toFixed(2)} with prev@${prevU.startTime.toFixed(1)}s) ` +
          `"${nextU.text.slice(0, 60)}…"`,
        );
        break;
      }
    }
  }

  if (duplicateIndices.size > 0) {
    logger.info(`Boundary dedup: removed ${duplicateIndices.size} duplicate utterance(s)`);
  }

  return nextUtterances.filter((_, i) => !duplicateIndices.has(i));
}
