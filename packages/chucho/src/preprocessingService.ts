/**
 * Chucho — Audio Preprocessing Service
 *
 * Responsibilities:
 *   1. Read raw audio files from data/jobs/<jobId>/raw/
 *   2. Preprocess each file: mono → normalize → convert to FLAC
 *   3. Optionally split long files at silence boundaries
 *   4. Output processed segments to data/jobs/<jobId>/processed/
 *   5. Advance pipeline stage via Supervisor
 *
 * Chucho does NOT download from Drive (that's Yulieth's job).
 * Chucho does NOT transcribe (that's Jaime's job).
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { createLogger } from '@transcriptor/shared';
import {
  preprocessAudio,
  convertToMono,
  splitAtSilence,
  getAudioInfo,
  estimateTranscriptionCost,
  type AudioInfo,
  type CostEstimate,
} from './audioProcessor.js';

const logger = createLogger('chucho:service');

// Maximum segment duration before splitting (seconds)
const MAX_SEGMENT_DURATION = 1800; // 30 minutes

export interface PreprocessingResult {
  jobId: string;
  inputFiles: string[];
  processedFiles: string[];
  totalDuration: number;
  totalSegments: number;
  costEstimate: CostEstimate;
  errors: string[];
}

/**
 * Get the standard job directory paths.
 * Convention: data/jobs/<jobId>/raw/ and data/jobs/<jobId>/processed/
 */
export function getJobPaths(jobId: string): { rawDir: string; processedDir: string; jobDir: string } {
  // Resolve from project root (3 levels up from packages/chucho/src/)
  const projectRoot = path.resolve(import.meta.dirname, '../../..');
  const jobDir = path.join(projectRoot, 'data', 'jobs', jobId);
  return {
    jobDir,
    rawDir: path.join(jobDir, 'raw'),
    processedDir: path.join(jobDir, 'processed'),
  };
}

/**
 * Run the full preprocessing pipeline for a job.
 *
 * Reads all audio files from data/jobs/<jobId>/raw/,
 * preprocesses them, and outputs to data/jobs/<jobId>/processed/.
 */
export async function processJob(jobId: string): Promise<PreprocessingResult> {
  const { rawDir, processedDir } = getJobPaths(jobId);
  logger.info(`Processing job ${jobId}: raw=${rawDir}, processed=${processedDir}`);

  // Ensure processed dir exists
  await fs.mkdir(processedDir, { recursive: true });

  // List raw audio files
  let rawFiles: string[];
  try {
    const entries = await fs.readdir(rawDir);
    rawFiles = entries
      .filter(f => isAudioFile(f))
      .map(f => path.join(rawDir, f))
      .sort();
  } catch (err) {
    logger.error(`Cannot read raw directory for job ${jobId}`, err as Error);
    return {
      jobId,
      inputFiles: [],
      processedFiles: [],
      totalDuration: 0,
      totalSegments: 0,
      costEstimate: { durationMinutes: 0, estimatedCostUsd: 0, provider: 'ElevenLabs Scribe' },
      errors: [`Cannot read raw directory: ${(err as Error).message}`],
    };
  }

  if (rawFiles.length === 0) {
    logger.warn(`No audio files found in ${rawDir} for job ${jobId}`);
    return {
      jobId,
      inputFiles: [],
      processedFiles: [],
      totalDuration: 0,
      totalSegments: 0,
      costEstimate: { durationMinutes: 0, estimatedCostUsd: 0, provider: 'ElevenLabs Scribe' },
      errors: ['No audio files found in raw directory'],
    };
  }

  logger.info(`Found ${rawFiles.length} raw audio file(s) for job ${jobId}`);

  const allProcessedFiles: string[] = [];
  const errors: string[] = [];
  let totalDuration = 0;

  for (const rawFile of rawFiles) {
    try {
      const result = await processOneFile(rawFile, processedDir, jobId);
      allProcessedFiles.push(...result.outputFiles);
      totalDuration += result.duration;
      logger.info(`Processed ${path.basename(rawFile)}: ${result.duration.toFixed(1)}s → ${result.outputFiles.length} segment(s)`);
    } catch (err) {
      const msg = `Failed to process ${path.basename(rawFile)}: ${(err as Error).message}`;
      logger.error(msg, err as Error);
      errors.push(msg);
    }
  }

  const costEstimate = estimateTranscriptionCost({
    duration: totalDuration,
    channels: 1,
    sampleRate: 16000,
    format: 'flac',
    fileSizeBytes: 0,
  });

  const result: PreprocessingResult = {
    jobId,
    inputFiles: rawFiles,
    processedFiles: allProcessedFiles,
    totalDuration,
    totalSegments: allProcessedFiles.length,
    costEstimate,
    errors,
  };

  // Write a manifest file for downstream agents (Jaime)
  const manifestPath = path.join(processedDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(result, null, 2), 'utf-8');
  logger.info(`Manifest written: ${manifestPath}`);

  logger.info(`Job ${jobId} preprocessing complete: ${allProcessedFiles.length} segments, ${totalDuration.toFixed(1)}s total, est. $${costEstimate.estimatedCostUsd}`);
  return result;
}

/**
 * Process a single raw audio file:
 *   1. Preprocess (mono → normalize → FLAC)
 *   2. If duration > MAX_SEGMENT_DURATION, split at silence
 */
async function processOneFile(
  inputPath: string,
  outputDir: string,
  jobId: string,
): Promise<{ outputFiles: string[]; duration: number }> {
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const processedPath = path.join(outputDir, `${baseName}.flac`);

  // Step 1: Convert to mono 16kHz FLAC (skip loudness normalization — saves time)
  const monoPath = processedPath.replace(/(\.\w+)$/, '_mono.flac');
  await convertToMono(inputPath, monoPath);
  const info = await getAudioInfo(monoPath);

  // Step 2: If too long, split into 30-min segments
  if (info.duration > MAX_SEGMENT_DURATION) {
    logger.info(`File ${baseName} is ${(info.duration / 60).toFixed(1)}min — splitting into ${Math.ceil(info.duration / MAX_SEGMENT_DURATION)} chunks`);
    const segments = await splitAtSilence(monoPath, outputDir, MAX_SEGMENT_DURATION);

    // Remove the unsplit mono file to save space
    try {
      await fs.unlink(monoPath);
    } catch {
      // ignore
    }

    return { outputFiles: segments, duration: info.duration };
  }

  // Short file — rename mono to final
  await fs.rename(monoPath, processedPath);
  return { outputFiles: [processedPath], duration: info.duration };
}

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.wma', '.mp4', '.webm']);

function isAudioFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return AUDIO_EXTS.has(ext);
}

/**
 * Clean up intermediate files (_mono.flac, _normalized.flac) from processed dir.
 * These are large temporary files generated during preprocessing.
 * Keeps only the final _partNNN.flac segments and manifest.json.
 */
export async function cleanupIntermediateFiles(jobId: string): Promise<{ removed: string[]; savedBytes: number }> {
  const { processedDir } = getJobPaths(jobId);
  const removed: string[] = [];
  let savedBytes = 0;

  try {
    const entries = await fs.readdir(processedDir);
    for (const entry of entries) {
      if (entry.endsWith('_mono.flac') || entry.endsWith('_normalized.flac')) {
        const filePath = path.join(processedDir, entry);
        const stat = await fs.stat(filePath);
        savedBytes += stat.size;
        await fs.unlink(filePath);
        removed.push(entry);
        logger.info(`Removed intermediate file: ${entry} (${(stat.size / 1024 / 1024).toFixed(0)} MB)`);
      }
    }
    if (removed.length > 0) {
      logger.info(`Cleaned up ${removed.length} intermediate files for job ${jobId}, saved ${(savedBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
    }
  } catch (err) {
    logger.warn(`Failed to clean intermediate files for job ${jobId}: ${(err as Error).message}`);
  }

  return { removed, savedBytes };
}

/**
 * Clean up raw audio files after a job is fully complete.
 * Keeps only the processed directory.
 */
export async function cleanupRawFiles(jobId: string): Promise<void> {
  const { rawDir } = getJobPaths(jobId);
  try {
    await fs.rm(rawDir, { recursive: true, force: true });
    logger.info(`Cleaned up raw files for job ${jobId}`);
  } catch (err) {
    logger.warn(`Failed to clean raw files for job ${jobId}: ${(err as Error).message}`);
  }
}
