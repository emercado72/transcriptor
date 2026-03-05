import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@transcriptor/shared';
import type { ScribeTranscript, ScribeUtterance } from './transcriptionManager.js';
import { parseProgressLine } from './progressTracker.js';

const logger = createLogger('jaime:localTranscriber');

// ── Types ──
export interface LocalTranscriberOptions {
  model?: string;       // tiny, base, small, medium, large-v3
  language?: string;    // es, en, auto
  minSpeakers?: number;
  maxSpeakers?: number;
  device?: string;      // auto, cpu, or cuda (auto = detect GPU availability)
}

interface AudioTranscriberSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

interface AudioTranscriberOutput {
  audio_file: string;
  duration_seconds: number;
  num_speakers: number;
  model_used: string;
  speaker_mapping: Record<string, string> | null;
  segments: AudioTranscriberSegment[];
}

// ── Config ──
function getAudioTranscriberPath(): string {
  const envPath = process.env.AUDIO_TRANSCRIBER_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // Default: sibling project in Dropbox/work
  const defaultPath = path.resolve(__dirname, '..', '..', '..', '..', 'audio-transcriber');
  if (existsSync(defaultPath)) {
    return defaultPath;
  }

  throw new Error(
    'audio-transcriber project not found.\n'
    + 'Set AUDIO_TRANSCRIBER_PATH in .env.local or ensure it exists at:\n'
    + `  ${defaultPath}`
  );
}

function getPythonCommand(): string {
  if (process.env.PYTHON_COMMAND) return process.env.PYTHON_COMMAND;

  // Prefer the venv python inside audio-transcriber
  const venvPython = path.join(getAudioTranscriberPath(), 'venv', 'bin', 'python');
  if (existsSync(venvPython)) {
    return venvPython;
  }

  return 'python3';
}

// ── Main Function ──
export async function transcribeLocal(
  audioPath: string,
  options: LocalTranscriberOptions = {},
  progressCtx?: { jobId: string; segmentIndex: number },
): Promise<ScribeTranscript> {
  const transcriverDir = getAudioTranscriberPath();
  const pythonCmd = getPythonCommand();
  const mainScript = path.join(transcriverDir, 'main.py');

  if (!existsSync(mainScript)) {
    throw new Error(`audio-transcriber main.py not found at: ${mainScript}`);
  }

  const model = options.model || process.env.LOCAL_WHISPER_MODEL || 'medium';
  const language = options.language || 'es';
  const device = options.device || process.env.LOCAL_WHISPER_DEVICE || 'auto';

  // Build output path — use a temp dir inside audio-transcriber/output
  const outputDir = path.join(transcriverDir, 'output');
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const expectedJsonOutput = path.join(outputDir, `${baseName}_transcript.json`);

  // Build CLI args
  const args = [
    mainScript,
    audioPath,
    '--model', model,
    '--language', language,
    '--device', device,
    '--output-dir', outputDir,
    '--format', 'json',
    '--skip-preprocess',
  ];

  if (options.minSpeakers) {
    args.push('--min-speakers', String(options.minSpeakers));
  }
  if (options.maxSpeakers) {
    args.push('--max-speakers', String(options.maxSpeakers));
  }

  logger.info(`Running local transcription: ${pythonCmd} ${args.join(' ')}`);
  logger.info(`Model: ${model}, Language: ${language}, Device: ${device}`);

  // Progress callback for stdout line parsing
  const onStdoutLine = progressCtx
    ? (line: string) => parseProgressLine(progressCtx.jobId, progressCtx.segmentIndex, line)
    : undefined;

  // Run audio-transcriber as subprocess
  await runPythonProcess(pythonCmd, args, onStdoutLine);

  // Read and parse the JSON output
  if (!existsSync(expectedJsonOutput)) {
    throw new Error(`Expected JSON output not found: ${expectedJsonOutput}`);
  }

  const rawJson = readFileSync(expectedJsonOutput, 'utf-8');
  const result = JSON.parse(rawJson) as AudioTranscriberOutput;

  logger.info(
    `Local transcription complete: ${result.segments.length} segments, `
    + `${result.num_speakers} speakers, ${result.duration_seconds}s`
  );

  // Map to ScribeTranscript format
  return mapToScribeTranscript(result, audioPath);
}

// ── Subprocess Runner ──
function runPythonProcess(command: string, args: string[], onStdoutLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        KMP_DUPLICATE_LIB_OK: 'TRUE',
        OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || '4',
      },
    });

    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        logger.info(`[audio-transcriber] ${line}`);
        if (onStdoutLine) onStdoutLine(line);
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        logger.warn(`[audio-transcriber:stderr] ${line}`);
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(
          `audio-transcriber exited with code ${code}\n${stderr}`
        ));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start audio-transcriber: ${err.message}`));
    });
  });
}

// ── Mapper ──
function mapToScribeTranscript(
  result: AudioTranscriberOutput,
  audioPath: string,
): ScribeTranscript {
  const utterances: ScribeUtterance[] = result.segments.map((seg) => ({
    speaker: seg.speaker,
    text: seg.text,
    startTime: seg.start,
    endTime: seg.end,
  }));

  return {
    jobId: `local_${Date.now()}`,
    text: result.segments.map((s) => s.text).join(' '),
    utterances,
    duration: result.duration_seconds,
    language: 'es',
  };
}
