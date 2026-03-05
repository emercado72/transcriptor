import axios from 'axios';
import { createLogger, getEnvConfig } from '@transcriptor/shared';
import { transcribeLocal } from './localTranscriber.js';
import type { LocalTranscriberOptions } from './localTranscriber.js';

const logger = createLogger('jaime:transcription');

// ── Types ──
export type ScribeJobId = string;

export type TranscriptionProvider = 'elevenlabs' | 'local';

export interface ScribeOptions {
  language?: string;
  diarization?: boolean;
  timestamps?: boolean;
}

export interface ScribeStatus {
  jobId: ScribeJobId;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress?: number;
}

export interface ScribeUtterance {
  speaker: string;
  text: string;
  startTime: number;
  endTime: number;
}

export interface ScribeTranscript {
  jobId: ScribeJobId;
  text: string;
  utterances: ScribeUtterance[];
  duration: number;
  language: string;
}

// ── Provider Detection ──
export function getTranscriptionProvider(): TranscriptionProvider {
  const provider = process.env.TRANSCRIPTION_PROVIDER?.toLowerCase();
  if (provider === 'local') return 'local';
  if (provider === 'elevenlabs') return 'elevenlabs';

  // Auto-detect: if no ElevenLabs key is set, default to local
  const env = getEnvConfig();
  if (!env.elevenLabsApiKey) {
    logger.info('No ELEVENLABS_API_KEY set, defaulting to local transcription');
    return 'local';
  }

  return 'elevenlabs';
}

// ── Unified Transcription Entry Point ──
export async function transcribeAudio(
  audioPath: string,
  options: ScribeOptions = {},
  progressCtx?: { jobId: string; segmentIndex: number },
): Promise<ScribeTranscript> {
  const provider = getTranscriptionProvider();
  logger.info(`Transcription provider: ${provider}`);

  if (provider === 'local') {
    const localOptions: LocalTranscriberOptions = {
      language: options.language || 'es',
      model: process.env.LOCAL_WHISPER_MODEL || 'medium',
      device: process.env.LOCAL_WHISPER_DEVICE || 'cpu',
      minSpeakers: process.env.LOCAL_MIN_SPEAKERS
        ? parseInt(process.env.LOCAL_MIN_SPEAKERS, 10)
        : undefined,
      maxSpeakers: process.env.LOCAL_MAX_SPEAKERS
        ? parseInt(process.env.LOCAL_MAX_SPEAKERS, 10)
        : undefined,
    };

    return transcribeLocal(audioPath, localOptions, progressCtx);
  }

  // ElevenLabs cloud flow
  const jobId = await submitToScribe(audioPath, options);

  // Poll until complete
  let status = await pollScribeStatus(jobId);
  while (status.status === 'queued' || status.status === 'processing') {
    const waitMs = status.status === 'queued' ? 5000 : 10000;
    logger.info(`Scribe job ${jobId}: ${status.status} (${status.progress ?? '?'}%), waiting ${waitMs / 1000}s...`);
    await new Promise((r) => setTimeout(r, waitMs));
    status = await pollScribeStatus(jobId);
  }

  if (status.status === 'failed') {
    throw new Error(`Scribe transcription failed for job: ${jobId}`);
  }

  return fetchScribeResult(jobId);
}

// ══════════════════════════════════════════════
// ElevenLabs Scribe API Functions (unchanged)
// ══════════════════════════════════════════════

const SCRIBE_BASE_URL = 'https://api.elevenlabs.io/v1';

function getHeaders(): Record<string, string> {
  const env = getEnvConfig();
  return {
    'xi-api-key': env.elevenLabsApiKey,
    'Content-Type': 'application/json',
  };
}

export async function submitToScribe(audioPath: string, options: ScribeOptions = {}): Promise<ScribeJobId> {
  logger.info(`Submitting to Scribe: ${audioPath}`);
  const { createReadStream } = await import('node:fs');
  const FormData = (await import('form-data')).default;

  const form = new FormData();
  form.append('audio', createReadStream(audioPath));
  form.append('language', options.language || 'es');
  if (options.diarization !== false) {
    form.append('diarization', 'true');
  }
  if (options.timestamps !== false) {
    form.append('timestamps', 'true');
  }

  const env = getEnvConfig();
  const response = await axios.post(`${SCRIBE_BASE_URL}/speech-to-text`, form, {
    headers: {
      ...form.getHeaders(),
      'xi-api-key': env.elevenLabsApiKey,
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const jobId = response.data.id || response.data.jobId;
  logger.info(`Scribe job submitted: ${jobId}`);
  return jobId;
}

export async function pollScribeStatus(scribeJobId: ScribeJobId): Promise<ScribeStatus> {
  logger.info(`Polling Scribe status: ${scribeJobId}`);
  const response = await axios.get(`${SCRIBE_BASE_URL}/speech-to-text/${scribeJobId}`, {
    headers: getHeaders(),
  });

  return {
    jobId: scribeJobId,
    status: response.data.status,
    progress: response.data.progress,
  };
}

export async function fetchScribeResult(scribeJobId: ScribeJobId): Promise<ScribeTranscript> {
  logger.info(`Fetching Scribe result: ${scribeJobId}`);
  const response = await axios.get(`${SCRIBE_BASE_URL}/speech-to-text/${scribeJobId}`, {
    headers: getHeaders(),
  });

  const data = response.data;
  return {
    jobId: scribeJobId,
    text: data.text || '',
    utterances: (data.utterances || []).map((u: Record<string, unknown>) => ({
      speaker: String(u.speaker || ''),
      text: String(u.text || ''),
      startTime: Number(u.start || u.startTime || 0),
      endTime: Number(u.end || u.endTime || 0),
    })),
    duration: Number(data.duration || 0),
    language: String(data.language || 'es'),
  };
}
