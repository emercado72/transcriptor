/**
 * Speaker Reconciler — Router
 *
 * Routes speaker reconciliation to one of two backends:
 *   - speakerReconcilerRedis.ts  (deterministic, zero-cost — DEFAULT)
 *   - speakerReconcilerLLM.ts    (LLM-based, costs API credits)
 *
 * Control via env var SPEAKER_RECONCILER_MODE:
 *   - "redis"  → deterministic (default)
 *   - "llm"    → LLM-based
 *   - "hybrid" → try Redis first, fall back to LLM if confidence < threshold
 *
 * All shared types and utility functions are exported from this file
 * so the rest of the codebase doesn't need to change imports.
 */

import { readFileSync } from 'node:fs';
import { createLogger } from '@transcriptor/shared';
import { reconcileSpeakersRedis } from './speakerReconcilerRedis.js';
import { reconcileSpeakersLLM } from './speakerReconcilerLLM.js';

const logger = createLogger('lina:speakerReconciler');

// ── Shared Types (re-exported for all consumers) ──

export interface TranscriptSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

export interface ChunkTranscript {
  chunkIndex: number;
  fileName: string;
  durationSeconds: number;
  numSpeakers: number;
  speakerMapping: Record<string, string> | null;
  segments: TranscriptSegment[];
}

/** Maps local speaker label → global speaker label, per chunk */
export interface SpeakerMap {
  [chunkLocalLabel: string]: string;
}

export interface ReconciliationResult {
  /** Per-chunk mappings: chunkMaps[0] = { "Speaker A": "Global_1", ... } */
  chunkMaps: SpeakerMap[];
  /** All unique global speaker IDs */
  globalSpeakers: string[];
  /** Named speakers identified from self-introductions or roles */
  identifiedSpeakers: Record<string, string>;
  /** The merged, relabeled transcript */
  mergedSegments: TranscriptSegment[];
  /** Confidence score 0-1 */
  confidence: number;
  /** Reasoning for the mapping decisions */
  reasoning: string;
}

// ── Reconciliation modes ──

export type ReconciliationMode = 'redis' | 'llm' | 'hybrid';

/** Minimum confidence for hybrid mode before falling back to LLM */
const HYBRID_CONFIDENCE_THRESHOLD = 0.5;

function getReconciliationMode(): ReconciliationMode {
  const mode = (process.env.SPEAKER_RECONCILER_MODE || 'redis').toLowerCase().trim();
  if (mode === 'llm' || mode === 'hybrid' || mode === 'redis') {
    return mode;
  }
  logger.warn(`Unknown SPEAKER_RECONCILER_MODE="${mode}", defaulting to "redis"`);
  return 'redis';
}

// ── Main Router ──

/**
 * Reconcile speaker labels across transcript chunks.
 *
 * Routes to Redis (deterministic) or LLM backend based on
 * SPEAKER_RECONCILER_MODE env var. Default: "redis".
 */
export async function reconcileSpeakers(
  chunks: ChunkTranscript[],
  jobId?: string,
): Promise<ReconciliationResult> {
  // Single-chunk shortcut — no reconciliation needed regardless of mode
  if (chunks.length <= 1) {
    logger.info('Only one chunk, no reconciliation needed');
    return {
      chunkMaps: [buildIdentityMap(chunks[0])],
      globalSpeakers: getUniqueSpeakers(chunks[0]),
      identifiedSpeakers: {},
      mergedSegments: chunks[0].segments,
      confidence: 1.0,
      reasoning: 'Single chunk — no cross-chunk reconciliation needed.',
    };
  }

  const mode = getReconciliationMode();
  logger.info(`Speaker reconciliation mode: ${mode} (${chunks.length} chunks)`);

  switch (mode) {
    case 'llm':
      return reconcileSpeakersLLM(chunks);

    case 'hybrid': {
      // Try deterministic first — produces roster-verified identifications
      const redisResult = await reconcileSpeakersRedis(chunks, jobId);

      // Count how many speakers are still anonymous (not roster-verified)
      const anonymousCount = redisResult.globalSpeakers.filter(
        (s) => /^Speaker_\d+$/i.test(s),
      ).length;

      if (anonymousCount === 0) {
        logger.info(
          `Hybrid mode: All ${redisResult.globalSpeakers.length} speakers identified by Redis — no LLM needed`,
        );
        return redisResult;
      }

      if (redisResult.confidence >= HYBRID_CONFIDENCE_THRESHOLD && anonymousCount <= 2) {
        logger.info(
          `Hybrid mode: Redis confidence ${redisResult.confidence.toFixed(2)} ≥ ${HYBRID_CONFIDENCE_THRESHOLD}, ` +
          `only ${anonymousCount} anonymous speaker(s) — using deterministic result`,
        );
        return redisResult;
      }

      logger.info(
        `Hybrid mode: ${anonymousCount} anonymous speakers, ` +
        `Redis confidence ${redisResult.confidence.toFixed(2)} — enhancing with LLM`,
      );
      // Pass Redis result as context so LLM preserves roster-verified names
      // and only resolves anonymous speakers + role identifications
      return reconcileSpeakersLLM(chunks, redisResult);
    }

    case 'redis':
    default:
      return reconcileSpeakersRedis(chunks, jobId);
  }
}

// ── Shared Utility Functions ──

/** Build an identity map (no remapping) for a single chunk */
function buildIdentityMap(chunk: ChunkTranscript): SpeakerMap {
  const map: SpeakerMap = {};
  for (const seg of chunk.segments) {
    if (!map[seg.speaker]) {
      map[seg.speaker] = seg.speaker;
    }
  }
  return map;
}

/** Get unique speaker labels from a chunk */
function getUniqueSpeakers(chunk: ChunkTranscript): string[] {
  return [...new Set(chunk.segments.map(s => s.speaker))];
}

/**
 * Load chunk transcripts from audio-transcriber output files.
 * Reads the JSON files produced by Pyannote + Whisper.
 */
export function loadChunkTranscripts(transcriptPaths: string[]): ChunkTranscript[] {
  return transcriptPaths.map((filePath, index) => {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    return {
      chunkIndex: index,
      fileName: raw.audio_file || filePath,
      durationSeconds: raw.duration_seconds || 0,
      numSpeakers: raw.num_speakers || 0,
      speakerMapping: raw.speaker_mapping || null,
      segments: (raw.segments || []).map((s: { start: number; end: number; speaker: string; text: string }) => ({
        start: s.start,
        end: s.end,
        speaker: s.speaker,
        text: s.text,
      })),
    };
  });
}

/**
 * Group consecutive segments by the same speaker (post-reconciliation).
 * After remapping, adjacent segments from the same global speaker are merged.
 */
export function groupConsecutiveSpeakers(segments: TranscriptSegment[]): TranscriptSegment[] {
  if (segments.length === 0) return [];

  const grouped: TranscriptSegment[] = [];
  let current = { ...segments[0] };

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.speaker === current.speaker) {
      current.end = seg.end;
      current.text += ' ' + seg.text;
    } else {
      grouped.push(current);
      current = { ...seg };
    }
  }
  grouped.push(current);

  logger.info(`Grouped ${segments.length} segments → ${grouped.length} speaker blocks`);
  return grouped;
}
