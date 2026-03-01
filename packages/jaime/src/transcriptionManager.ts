import axios from 'axios';
import { createLogger, getEnvConfig } from '@transcriptor/shared';

const logger = createLogger('jaime:transcription');

// ── Types ──
export type ScribeJobId = string;

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
