/**
 * Speaker Reconciler — LLM-based cross-chunk diarization alignment
 *
 * Uses an LLM (OpenRouter / Claude) to analyze text at chunk boundaries and
 * speaker characteristics to build a unified speaker mapping across all chunks.
 *
 * ⚠️  This is the expensive path — each call costs API credits.
 *     Prefer speakerReconcilerRedis.ts for production unless you need
 *     the LLM's reasoning for ambiguous cases.
 */

import OpenAI from 'openai';
import { createLogger, getEnvConfig } from '@transcriptor/shared';
import type {
  ChunkTranscript,
  SpeakerMap,
  ReconciliationResult,
  TranscriptSegment,
} from './speakerReconciler.js';

const logger = createLogger('lina:speakerReconciler:llm');

// ── Helpers ──

function getClient(): OpenAI {
  const env = getEnvConfig();
  return new OpenAI({
    apiKey: env.openrouterApiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://transcriptor.app',
      'X-Title': 'Transcriptor - Lina Speaker Reconciler',
    },
  });
}

function getModel(): string {
  const env = getEnvConfig();
  return env.openrouterModel;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Extract the last N segments of a chunk and the first N of the next */
function extractBoundaryContext(
  chunks: ChunkTranscript[],
  boundarySegments: number = 5,
): string[] {
  const boundaries: string[] = [];

  for (let i = 0; i < chunks.length - 1; i++) {
    const curr = chunks[i];
    const next = chunks[i + 1];

    const tail = curr.segments.slice(-boundarySegments);
    const head = next.segments.slice(0, boundarySegments);

    let ctx = `=== BOUNDARY: Chunk ${i} → Chunk ${i + 1} ===\n`;
    ctx += `\nEND of Chunk ${i} (last ${tail.length} segments):\n`;
    for (const seg of tail) {
      const ts = formatTime(seg.start);
      ctx += `  [${seg.speaker}] (${ts}): ${seg.text.substring(0, 200)}\n`;
    }
    ctx += `\nSTART of Chunk ${i + 1} (first ${head.length} segments):\n`;
    for (const seg of head) {
      const ts = formatTime(seg.start);
      ctx += `  [${seg.speaker}] (${ts}): ${seg.text.substring(0, 200)}\n`;
    }
    boundaries.push(ctx);
  }

  return boundaries;
}

/** Build a fingerprint summary for each speaker in each chunk */
function extractSpeakerFingerprints(chunks: ChunkTranscript[]): string {
  let result = '';

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const speakerData: Record<string, {
      wordCount: number;
      segmentCount: number;
      firstAppearance: number;
      lastAppearance: number;
      selfIntros: string[];
      samples: string[];
    }> = {};

    for (const seg of chunk.segments) {
      if (!speakerData[seg.speaker]) {
        speakerData[seg.speaker] = {
          wordCount: 0,
          segmentCount: 0,
          firstAppearance: seg.start,
          lastAppearance: seg.end,
          selfIntros: [],
          samples: [],
        };
      }
      const sd = speakerData[seg.speaker];
      sd.wordCount += seg.text.split(/\s+/).length;
      sd.segmentCount++;
      sd.lastAppearance = seg.end;

      // Detect self-introductions
      const introPatterns = [
        /mi nombre es\s+([^,.]+)/i,
        /quien les habla(?:\s+es)?\s+([^,.]+)/i,
        /soy\s+([^,.]+?)(?:\s*,|\s+del?\s+)/i,
        /me llamo\s+([^,.]+)/i,
        /buenos d[ií]as.*?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+)/,
        /apartamento\s+(\d[\d\-]*)/i,
        /torre\s+(\d+)/i,
        /bloque\s+(\d+)/i,
      ];

      for (const p of introPatterns) {
        const m = seg.text.match(p);
        if (m) {
          sd.selfIntros.push(seg.text.substring(0, 150));
          break;
        }
      }

      // Keep first 2 text samples
      if (sd.samples.length < 2) {
        sd.samples.push(seg.text.substring(0, 120));
      }
    }

    result += `\n=== CHUNK ${i} (${formatTime(0)} to ${formatTime(chunk.durationSeconds)}) ===\n`;
    const sorted = Object.entries(speakerData).sort((a, b) => b[1].wordCount - a[1].wordCount);
    for (const [spk, info] of sorted) {
      result += `\n  ${spk}: ${info.wordCount} words, ${info.segmentCount} segments`;
      result += ` (${formatTime(info.firstAppearance)} - ${formatTime(info.lastAppearance)})\n`;
      if (info.selfIntros.length > 0) {
        result += `    Self-introductions:\n`;
        for (const intro of info.selfIntros.slice(0, 3)) {
          result += `      → "${intro}"\n`;
        }
      }
      result += `    Samples:\n`;
      for (const sample of info.samples) {
        result += `      → "${sample}"\n`;
      }
    }
  }

  return result;
}

// ── System Prompts ──

const RECONCILIATION_SYSTEM_PROMPT = `You are a speaker diarization reconciler for Colombian property assembly (propiedad horizontal) recordings.

The audio was split into chunks before diarization, so each chunk has independent speaker labels (Speaker A, Speaker B, etc.). The SAME person may have DIFFERENT labels across chunks.

Your job: Create a unified speaker mapping by analyzing:
1. **Boundary continuity** — who was speaking at the end of chunk N is often the same person speaking at the start of chunk N+1 (the audio was cut mid-conversation)
2. **Self-introductions** — people say their name, apartment number, tower/building
3. **Role patterns** — the assembly president moderates, the administrator reports, the fiscal auditor reads reports
4. **Vocabulary and speech patterns** — formal vs informal, technical language
5. **Topic continuity** — same topic + same role = likely same speaker

IMPORTANT RULES:
- The assembly typically has a few key recurring speakers: the president/moderator (directs the meeting), the administrator (reports on building management), the fiscal auditor (reads financial reports), and various property owners who intervene.
- A speaker who was talking at the END of chunk N and the text continues at the START of chunk N+1 is DEFINITELY the same person.
- Not every speaker appears in every chunk.
- Use global labels like "Moderator", "Administrator", "Revisor_Fiscal", or "Propietario_[Name]" when you can identify them. Otherwise use "Speaker_1", "Speaker_2", etc.

Respond ONLY with valid JSON matching this schema:
{
  "chunkMaps": [
    { "Speaker A": "Global_Label", "Speaker B": "Global_Label", ... },
    ...one object per chunk...
  ],
  "globalSpeakers": ["Global_Label_1", "Global_Label_2", ...],
  "identifiedSpeakers": {
    "Global_Label": "Real name or role description"
  },
  "confidence": 0.85,
  "reasoning": "Brief explanation of key mapping decisions"
}`;

const HYBRID_SYSTEM_PROMPT = `You are a speaker diarization ENHANCER for Colombian property assembly (propiedad horizontal) recordings.

You are operating in HYBRID MODE. A deterministic fingerprinting system has already produced a speaker mapping that includes roster-verified property owner identifications. These identifications are confirmed against the building's official property registry and are GROUND TRUTH.

Your job is to ENHANCE the existing mapping, NOT replace it:

1. **PRESERVE** all roster-verified speaker names. These are confirmed property owners matched by unit number and/or name from the official resident database.
2. **IDENTIFY ROLES** for unnamed speakers (e.g., "Speaker_1", "Speaker_2"):
   - The assembly MODERATOR (presidente de la asamblea) — directs the meeting, calls votes, manages interventions
   - The ADMINISTRATOR (administrador/a) — reports on building management, budgets, maintenance
   - The REVISOR FISCAL (revisor/a fiscal) — reads financial reports, auditor
   - The SECRETARY (secretario/a) — takes notes, reads documents
3. **RESOLVE anonymous speakers** using semantic clues from their text samples and boundary context.
4. **DO NOT rename** speakers that already have roster-verified labels (they contain real names).

IMPORTANT RULES:
- If a speaker was identified as "Propietario_Name_Unit" by Redis, KEEP that exact label.
- Only rename speakers with generic labels like "Speaker_1", "Speaker_2", etc.
- The assembly typically has 3-5 key recurring speakers + intermittent property owner interventions.
- Confidence should reflect your certainty about the ADDITIONAL identifications you made (not the roster-verified ones).

Respond ONLY with valid JSON matching this schema:
{
  "chunkMaps": [
    { "Speaker A": "Global_Label", "Speaker B": "Global_Label", ... },
    ...one object per chunk...
  ],
  "globalSpeakers": ["Global_Label_1", "Global_Label_2", ...],
  "identifiedSpeakers": {
    "Global_Label": "Real name or role description"
  },
  "confidence": 0.85,
  "reasoning": "Brief explanation of role identifications and what you changed vs kept from Redis"
}`;

// ── Main Function ──

export async function reconcileSpeakersLLM(
  chunks: ChunkTranscript[],
  redisContext?: ReconciliationResult,
): Promise<ReconciliationResult> {
  logger.info(`LLM reconciliation: ${chunks.length} chunks${redisContext ? ' (hybrid mode — Redis context provided)' : ''}`);

  // Build analysis data
  const boundaries = extractBoundaryContext(chunks);
  const fingerprints = extractSpeakerFingerprints(chunks);

  let userPrompt = `Analyze these ${chunks.length} audio chunks from a Colombian property assembly recording and create a unified speaker mapping.

## Boundary Context (where chunks were split)
${boundaries.join('\n\n')}

## Speaker Fingerprints Per Chunk
${fingerprints}`;

  // In hybrid mode, provide Redis deterministic results as ground truth
  if (redisContext) {
    userPrompt += `

## Deterministic Analysis (from Redis fingerprinting — treat as ground truth)

The following speaker mapping was produced by a deterministic fingerprinting system. It has been verified against the building's resident roster database.

**IMPORTANT**: You MUST preserve all roster-verified identifications below. These are confirmed matches against the property registry. Your job is to ENHANCE the mapping by:
1. Identifying roles (Moderator, Administrator, Revisor Fiscal) for speakers that Redis could not name.
2. Resolving any remaining anonymous "Speaker_N" labels based on semantic analysis.
3. Keeping the same chunkMaps structure — only rename anonymous speakers, never rename roster-verified ones.

### Current Chunk Maps
${JSON.stringify(redisContext.chunkMaps, null, 2)}

### Identified Speakers (roster-verified — DO NOT change these)
${JSON.stringify(redisContext.identifiedSpeakers, null, 2)}

### Global Speakers
${JSON.stringify(redisContext.globalSpeakers)}

### Redis Confidence: ${redisContext.confidence.toFixed(2)}
### Redis Reasoning: ${redisContext.reasoning}`;
  }

  userPrompt += `

Now produce the unified speaker mapping JSON.`;

  const client = getClient();
  const model = getModel();
  logger.info(`Using model: ${model} for speaker reconciliation`);

  const response = await client.chat.completions.create({
    model,
    max_tokens: 4096,
    temperature: 0.1,
    messages: [
      { role: 'system', content: redisContext ? HYBRID_SYSTEM_PROMPT : RECONCILIATION_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });

  const content = response.choices[0]?.message?.content || '';

  // Parse the JSON response
  let mapping: {
    chunkMaps: SpeakerMap[];
    globalSpeakers: string[];
    identifiedSpeakers: Record<string, string>;
    confidence: number;
    reasoning: string;
  };

  try {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
    const jsonStr = jsonMatch[1]?.trim() || content.trim();
    mapping = JSON.parse(jsonStr);
  } catch (err) {
    logger.error('Failed to parse LLM reconciliation response', { content });
    throw new Error(`Speaker reconciliation failed: invalid JSON response — ${(err as Error).message}`);
  }

  if (!mapping.chunkMaps || mapping.chunkMaps.length !== chunks.length) {
    throw new Error(
      `Speaker reconciliation returned ${mapping.chunkMaps?.length ?? 0} chunk maps, expected ${chunks.length}`,
    );
  }

  // Apply the mapping to produce merged segments
  const mergedSegments = applyMappingAndMerge(chunks, mapping.chunkMaps);

  logger.info(
    `LLM reconciliation complete: ${mapping.globalSpeakers.length} global speakers, ` +
    `confidence ${mapping.confidence}, identified: ${Object.keys(mapping.identifiedSpeakers).length}`,
  );
  logger.info(`Reasoning: ${mapping.reasoning}`);

  for (const [globalId, name] of Object.entries(mapping.identifiedSpeakers)) {
    logger.info(`  ${globalId} → ${name}`);
  }

  return {
    chunkMaps: mapping.chunkMaps,
    globalSpeakers: mapping.globalSpeakers,
    identifiedSpeakers: mapping.identifiedSpeakers,
    mergedSegments,
    confidence: mapping.confidence,
    reasoning: mapping.reasoning,
  };
}

// ── Shared helpers (also used by the router) ──

function applyMappingAndMerge(
  chunks: ChunkTranscript[],
  chunkMaps: SpeakerMap[],
): TranscriptSegment[] {
  const merged: TranscriptSegment[] = [];
  let timeOffset = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const map = chunkMaps[i];

    for (const seg of chunk.segments) {
      merged.push({
        start: seg.start + timeOffset,
        end: seg.end + timeOffset,
        speaker: map[seg.speaker] || seg.speaker,
        text: seg.text,
      });
    }

    timeOffset += chunk.durationSeconds;
  }

  return merged;
}
