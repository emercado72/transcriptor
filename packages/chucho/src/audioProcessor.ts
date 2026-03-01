import ffmpeg from 'fluent-ffmpeg';
import path from 'node:path';
import { createLogger } from '@transcriptor/shared';

const logger = createLogger('chucho');

// ── Types ──
export enum AudioFormat {
  WAV = 'wav',
  FLAC = 'flac',
  MP3 = 'mp3',
}

export interface AudioInfo {
  duration: number;
  channels: number;
  sampleRate: number;
  format: string;
  fileSizeBytes: number;
}

export interface CostEstimate {
  durationMinutes: number;
  estimatedCostUsd: number;
  provider: string;
}

// Cost per minute for ElevenLabs Scribe
const SCRIBE_COST_PER_MINUTE = 0.11;

// ── Main Pipeline ──
export async function preprocessAudio(inputPath: string, outputPath: string): Promise<AudioInfo> {
  logger.info(`Preprocessing audio: ${inputPath}`);

  const monoPath = outputPath.replace(/(\.\w+)$/, '_mono$1');
  const normalizedPath = outputPath.replace(/(\.\w+)$/, '_normalized$1');

  await convertToMono(inputPath, monoPath);
  await normalizeAudio(monoPath, normalizedPath);
  await convertFormat(normalizedPath, outputPath, AudioFormat.FLAC);

  const info = await getAudioInfo(outputPath);
  logger.info(`Preprocessing complete: ${info.duration}s, ${info.channels}ch, ${info.sampleRate}Hz`);
  return info;
}

export function convertToMono(inputPath: string, outputPath: string): Promise<void> {
  logger.info(`Converting to mono: ${inputPath}`);
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioChannels(1)
      .output(outputPath)
      .on('end', () => {
        logger.info('Mono conversion complete');
        resolve();
      })
      .on('error', (err) => {
        logger.error('Mono conversion failed', err);
        reject(err);
      })
      .run();
  });
}

export function normalizeAudio(inputPath: string, outputPath: string): Promise<void> {
  logger.info(`Normalizing audio: ${inputPath}`);
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters('loudnorm=I=-16:TP=-1.5:LRA=11')
      .output(outputPath)
      .on('end', () => {
        logger.info('Audio normalization complete');
        resolve();
      })
      .on('error', (err) => {
        logger.error('Audio normalization failed', err);
        reject(err);
      })
      .run();
  });
}

export function convertFormat(inputPath: string, outputPath: string, format: AudioFormat): Promise<void> {
  logger.info(`Converting format to ${format}: ${inputPath}`);
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .format(format)
      .output(outputPath)
      .on('end', () => {
        logger.info(`Format conversion to ${format} complete`);
        resolve();
      })
      .on('error', (err) => {
        logger.error(`Format conversion to ${format} failed`, err);
        reject(err);
      })
      .run();
  });
}

export function splitAtSilence(
  inputPath: string,
  outputDir: string,
  maxDuration: number = 3600,
): Promise<string[]> {
  logger.info(`Splitting at silence: ${inputPath}, max ${maxDuration}s`);
  return new Promise((resolve, reject) => {
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outputPattern = path.join(outputDir, `${baseName}_part%03d.flac`);

    ffmpeg(inputPath)
      .outputOptions([
        '-f', 'segment',
        '-segment_time', String(maxDuration),
        '-reset_timestamps', '1',
      ])
      .output(outputPattern)
      .on('end', () => {
        // List the generated files
        const { readdirSync } = require('node:fs');
        const files = readdirSync(outputDir)
          .filter((f: string) => f.startsWith(`${baseName}_part`) && f.endsWith('.flac'))
          .map((f: string) => path.join(outputDir, f))
          .sort();
        logger.info(`Split into ${files.length} parts`);
        resolve(files);
      })
      .on('error', (err) => {
        logger.error('Split at silence failed', err);
        reject(err);
      })
      .run();
  });
}

export function getAudioInfo(filePath: string): Promise<AudioInfo> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        logger.error('ffprobe failed', err);
        return reject(err);
      }

      const audioStream = metadata.streams.find((s) => s.codec_type === 'audio');
      const info: AudioInfo = {
        duration: metadata.format.duration || 0,
        channels: audioStream?.channels || 1,
        sampleRate: audioStream?.sample_rate ? parseInt(String(audioStream.sample_rate), 10) : 44100,
        format: metadata.format.format_name || 'unknown',
        fileSizeBytes: metadata.format.size || 0,
      };

      resolve(info);
    });
  });
}

export function estimateTranscriptionCost(audioInfo: AudioInfo): CostEstimate {
  const durationMinutes = audioInfo.duration / 60;
  return {
    durationMinutes: Math.round(durationMinutes * 100) / 100,
    estimatedCostUsd: Math.round(durationMinutes * SCRIBE_COST_PER_MINUTE * 100) / 100,
    provider: 'ElevenLabs Scribe',
  };
}
