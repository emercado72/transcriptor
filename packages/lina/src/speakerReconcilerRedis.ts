/**
 * Speaker Reconciler — Deterministic Redis-backed cross-chunk diarization alignment
 *
 * Zero-cost alternative to the LLM reconciler. Uses boundary continuity,
 * speaker fingerprinting (regex-based name/role detection), and word-count
 * heuristics to align speaker labels across chunks.
 *
 * Speaker mapping is cached in Redis per job so incremental reconciliation
 * is possible if chunks arrive one at a time.
 *
 * Algorithm:
 *   1. For each chunk boundary, match the last speaker of chunk N with
 *      the first speaker of chunk N+1 (boundary continuity — most reliable signal)
 *   2. Build per-speaker fingerprints: self-introductions, word count,
 *      segment count, role keywords
 *   3. For speakers not matched by boundary, use fingerprint similarity
 *      (Jaccard on intro patterns + word-count ratio) to find best match
 *   4. Assign remaining unmatched speakers new global IDs
 *   5. Store the final mapping in Redis: `speaker:map:{jobId}`
 */

import { createLogger, getRedisClient, tokenOverlapRatio } from '@transcriptor/shared';
import type {
  ChunkTranscript,
  SpeakerMap,
  ReconciliationResult,
  TranscriptSegment,
} from './speakerReconciler.js';
import type { RosterIndex, RosterEntry } from './rosterLookup.js';
import { loadRoster, buildRosterIndex, lookupByUnit, lookupByName, formatRosterLabel } from './rosterLookup.js';

const logger = createLogger('lina:speakerReconciler:redis');

// ── Redis key helpers ──

function speakerMapKey(jobId: string): string {
  return `speaker:map:${jobId}`;
}

// ── Speaker Fingerprint ──

interface SpeakerFingerprint {
  /** Local label within this chunk (e.g. "Speaker A") */
  localLabel: string;
  chunkIndex: number;
  wordCount: number;
  segmentCount: number;
  firstAppearance: number;
  lastAppearance: number;
  /** Detected self-introduction names */
  detectedNames: string[];
  /** Detected apartment / unit references */
  detectedUnits: string[];
  /** Detected role keywords */
  detectedRoles: Set<string>;
  /** First few text samples for fallback comparison */
  samples: string[];
  /** Roster match resolved from unit or name lookup */
  rosterMatch?: RosterEntry;
}

// ── Introduction & Role Detection ──

const INTRO_PATTERNS: { pattern: RegExp; group: number }[] = [
  // Only match explicit self-introductions with proper noun names (2+ capitalized words)
  { pattern: /mi nombre es\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,5})/i, group: 1 },
  { pattern: /quien les habla(?:\s+es)?\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,5})/i, group: 1 },
  { pattern: /me llamo\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,5})/i, group: 1 },
  { pattern: /soy\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,5})\s*(?:,|del?\s)/i, group: 1 },
];

/** Words that look like names but are not — filter these out */
const NAME_BLACKLIST = new Set([
  'propietario', 'propietaria', 'residente', 'señor', 'señora', 'doctor', 'doctora',
  'presidente', 'administrador', 'administradora', 'secretario', 'secretaria',
  'revisor', 'fiscal', 'abogado', 'abogada', 'consejero', 'consejera',
  'buenos', 'buenas', 'después', 'antes', 'primero', 'segundo', 'parte',
  'uno', 'una', 'dos', 'tres', 'cuatro', 'cinco',
]);

/** Validate a detected name: must be 2+ proper words, not blacklisted, reasonable length */
function isValidName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 5 || trimmed.length > 60) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < 2) return false;
  // At least the first word must be capitalized
  if (!/^[A-ZÁÉÍÓÚÑ]/.test(words[0])) return false;
  // First word must not be blacklisted
  if (NAME_BLACKLIST.has(words[0].toLowerCase())) return false;
  // Must not contain too many lowercase-only words (likely a sentence fragment)
  const lowercaseWords = words.filter(w => /^[a-záéíóúñ]/.test(w));
  if (lowercaseWords.length > words.length * 0.5) return false;
  return true;
}

/**
 * Self-referencing unit patterns — the speaker says "my apartment" / "I live in".
 * CRITICAL: Must require first-person possessive or self-identification context.
 * Without this, the moderator's roll-call ("apartamento 532 torre 12") would
 * pollute their fingerprint with dozens of other people's unit numbers.
 */
const SELF_UNIT_PATTERNS: RegExp[] = [
  // "mi apartamento 302" / "nuestro apartamento 5"
  /(?:mi|nuestro|nuestra)\s+(?:apartamento|apto\.?)\s+(\d[\d\-]*)/i,
  // "vivo en el apartamento 302" / "vivo en torre 5"
  /vivo en\s+(?:el |la )?(?:apartamento|apto\.?|torre)\s+(\d[\d\-]*)/i,
  // "pertenezco al apartamento 302"
  /pertenezco al?\s+(?:apartamento|apto\.?)\s+(\d[\d\-]*)/i,
  // "soy de la torre 5 apartamento 302" / "soy del apartamento 302"
  /soy\s+(?:de\s+(?:la\s+)?(?:torre)\s+(\d+))?(?:\s+(?:apartamento|apto\.?)\s+(\d[\d\-]*))?/i,
  // Self-introduction with unit: "Diana Aldana, torre 2 apartamento 301" (name + unit in same sentence)
  // Only match if a name intro pattern preceded this in the same segment
];

/**
 * Max number of distinct units a single speaker can have before we consider
 * their unit list unreliable (likely a moderator reading roll call).
 */
const MAX_RELIABLE_UNITS = 2;

/**
 * Role detection — FIRST-PERSON only.
 * The speaker must be claiming the role themselves, not just mentioning it.
 * E.g., "soy el presidente" ✓  vs  "el presidente dijo" ✗
 */
const ROLE_SELF_PATTERNS: { pattern: RegExp; role: string }[] = [
  { pattern: /(?:^|\. )(?:yo )?(?:soy|como) (?:el |la )?presidente/i, role: 'Moderador' },
  { pattern: /(?:^|\. )(?:yo )?presido esta (?:asamblea|reunión)/i, role: 'Moderador' },
  { pattern: /(?:^|\. )les doy la bienvenida/i, role: 'Moderador' },
  { pattern: /(?:^|\. )(?:yo )?(?:soy|como) (?:el |la )?administradora?/i, role: 'Administrador' },
  { pattern: /(?:^|\. )(?:yo )?(?:soy|como) (?:el |la )?revisor(?:a)? fiscal/i, role: 'Revisor_Fiscal' },
  { pattern: /(?:^|\. )(?:yo )?(?:soy|como|actúo como) (?:el |la )?secretari[oa] de (?:esta |la )?(?:asamblea|reunión)/i, role: 'Secretario' },
  { pattern: /(?:^|\. )en (?:mi|nuestra) calidad de revisor/i, role: 'Revisor_Fiscal' },
  { pattern: /(?:^|\. )en (?:mi|nuestra) calidad de administrador/i, role: 'Administrador' },
  { pattern: /(?:^|\. )procedo a dar lectura del? informe/i, role: 'Revisor_Fiscal' },
];

function buildFingerprint(
  chunkIndex: number,
  localLabel: string,
  segments: TranscriptSegment[],
): SpeakerFingerprint {
  const fp: SpeakerFingerprint = {
    localLabel,
    chunkIndex,
    wordCount: 0,
    segmentCount: 0,
    firstAppearance: Infinity,
    lastAppearance: -Infinity,
    detectedNames: [],
    detectedUnits: [],
    detectedRoles: new Set(),
    samples: [],
  };

  for (const seg of segments) {
    if (seg.speaker !== localLabel) continue;

    fp.wordCount += seg.text.split(/\s+/).length;
    fp.segmentCount++;
    if (seg.start < fp.firstAppearance) fp.firstAppearance = seg.start;
    if (seg.end > fp.lastAppearance) fp.lastAppearance = seg.end;

    // Detect introductions — strict: validated proper names only
    for (const { pattern, group } of INTRO_PATTERNS) {
      const m = seg.text.match(pattern);
      if (m && m[group]) {
        const name = m[group].trim();
        if (isValidName(name) && !fp.detectedNames.includes(name)) {
          fp.detectedNames.push(name);
        }
      }
    }

    // Detect self-referencing unit numbers — first-person possessive only
    for (const pat of SELF_UNIT_PATTERNS) {
      const m = seg.text.match(pat);
      if (m) {
        for (let g = 1; g <= 2; g++) {
          if (m[g]) {
            const unit = m[g].trim();
            if (!fp.detectedUnits.includes(unit)) {
              fp.detectedUnits.push(unit);
            }
          }
        }
      }
    }

    // If the speaker introduced themselves by name in this segment,
    // also capture any unit number mentioned in the same sentence
    // (e.g. "Diana Aldana, torre 2 apartamento 301")
    if (fp.detectedNames.length > 0) {
      const towerMatch = seg.text.match(/torre\s+(\d+)/i);
      const aptMatch = seg.text.match(/(?:apartamento|apto\.?)\s+(\d[\d\-]*)/i);
      if (towerMatch?.[1] && !fp.detectedUnits.includes(towerMatch[1])) {
        fp.detectedUnits.push(towerMatch[1]);
      }
      if (aptMatch?.[1] && !fp.detectedUnits.includes(aptMatch[1])) {
        fp.detectedUnits.push(aptMatch[1]);
      }
    }

    // Detect roles — FIRST-PERSON self-identification only
    for (const { pattern, role } of ROLE_SELF_PATTERNS) {
      if (pattern.test(seg.text)) {
        fp.detectedRoles.add(role);
      }
    }

    // Keep first 3 text samples
    if (fp.samples.length < 3) {
      fp.samples.push(seg.text.substring(0, 120));
    }
  }

  // Post-loop: if the speaker mentions too many distinct units,
  // they're likely a moderator reading roll call — discard unit data
  if (fp.detectedUnits.length > MAX_RELIABLE_UNITS) {
    fp.detectedUnits = [];
  }

  return fp;
}

// ── Matching Logic ──

/**
 * Score how likely two fingerprints represent the same person.
 * Returns 0..1 (1 = very likely same person).
 *
 * Scoring philosophy:
 *   - Name match is DECISIVE (0.95) — if both said their name and it matches, it's them
 *   - Name mismatch is a HARD PENALTY (→ 0) — different names = different people
 *   - Unit match is strong (0.85) — same apartment across chunks
 *   - Role match alone is WEAK (0.3) — many speakers mention roles in passing
 *   - Word count / segment count are tie-breakers only
 */
function fingerprintSimilarity(a: SpeakerFingerprint, b: SpeakerFingerprint): number {
  // ── Roster match: if both matched the same roster entry, definitive ──
  if (a.rosterMatch && b.rosterMatch) {
    if (a.rosterMatch.unitCode === b.rosterMatch.unitCode) {
      return 0.95; // Same roster entry — same person
    }
    return 0.0; // Different roster entries — different people
  }

  // If one has roster match and the other has a name, check if they align
  if (a.rosterMatch && b.detectedNames.length > 0) {
    const rosterName = a.rosterMatch.ownerName.toLowerCase();
    const nameMatch = b.detectedNames.some(n => {
      const tokens = n.toLowerCase().split(/\s+/);
      return tokens.some(t => t.length >= 3 && rosterName.includes(t));
    });
    if (nameMatch) return 0.9;
  }
  if (b.rosterMatch && a.detectedNames.length > 0) {
    const rosterName = b.rosterMatch.ownerName.toLowerCase();
    const nameMatch = a.detectedNames.some(n => {
      const tokens = n.toLowerCase().split(/\s+/);
      return tokens.some(t => t.length >= 3 && rosterName.includes(t));
    });
    if (nameMatch) return 0.9;
  }

  // ── Hard signals: name match or mismatch ──
  if (a.detectedNames.length > 0 && b.detectedNames.length > 0) {
    const nameOverlap = a.detectedNames.some(na =>
      b.detectedNames.some(nb => {
        const la = na.toLowerCase();
        const lb = nb.toLowerCase();
        // Exact match or one contains the other ("León Seidler" ≈ "León Seidler Díaz")
        return la === lb || la.includes(lb) || lb.includes(la);
      }),
    );
    if (nameOverlap) return 0.95; // Definitive match
    return 0.0; // Both have names but they're different → definitely not the same
  }

  // ── Strong signal: matching unit numbers ──
  if (a.detectedUnits.length > 0 && b.detectedUnits.length > 0) {
    const matchingUnits = a.detectedUnits.filter(ua =>
      b.detectedUnits.some(ub => ua === ub),
    );
    if (matchingUnits.length >= 2) {
      // Compound match (e.g. tower 5 + apt 302) — very strong
      return 0.85;
    }
    // Single unit match is weak — tower numbers and common apt numbers
    // are frequently shared (e.g. many people mention "torre 5" or "302")
    // Don't use it as a positive signal on its own
  }

  // ── Moderate signal: matching self-identified role ──
  // Only relevant if both speakers self-identified (not just mentioned a role)
  let roleScore = 0;
  if (a.detectedRoles.size > 0 && b.detectedRoles.size > 0) {
    const roleOverlap = [...a.detectedRoles].some(r => b.detectedRoles.has(r));
    if (roleOverlap) {
      roleScore = 0.3; // Baseline from role match alone
    }
  }

  // ── Weak signals: word count and segment count similarity ──
  let volumeScore = 0;
  if (a.wordCount > 50 && b.wordCount > 50) {
    const ratio = Math.min(a.wordCount, b.wordCount) / Math.max(a.wordCount, b.wordCount);
    volumeScore = ratio * 0.15; // Max 0.15 from word count alone
  }

  let segmentScore = 0;
  if (a.segmentCount > 3 && b.segmentCount > 3) {
    const ratio = Math.min(a.segmentCount, b.segmentCount) / Math.max(a.segmentCount, b.segmentCount);
    segmentScore = ratio * 0.1; // Max 0.1 from segment count
  }

  // Combined score — capped at 1.0
  return Math.min(1.0, roleScore + volumeScore + segmentScore);
}

/**
 * Enrich a fingerprint with roster data: match by unit or by detected name.
 */
function enrichFingerprintFromRoster(fp: SpeakerFingerprint, index: RosterIndex): void {
  // Strategy 1: Match by unit (tower + apartment)
  if (fp.detectedUnits.length >= 2) {
    // Need at least 2 units to form a tower+apt pair
    const towerUnits: { tower: string; apt: string }[] = [];

    // If we have exactly 2 units, they might be tower + apt
    if (fp.detectedUnits.length === 2) {
      towerUnits.push(
        { tower: fp.detectedUnits[0], apt: fp.detectedUnits[1] },
        { tower: fp.detectedUnits[1], apt: fp.detectedUnits[0] },
      );
    }

    for (const { tower, apt } of towerUnits) {
      const match = lookupByUnit(index, tower, apt);
      if (match) {
        fp.rosterMatch = match;
        logger.info(
          `  Roster match by unit: ${fp.localLabel} (chunk ${fp.chunkIndex}) → ` +
          `${match.ownerName} (T${match.tower} Apt ${match.unit})`,
        );
        return;
      }
    }
  }

  // Strategy 2: Match by detected name
  if (fp.detectedNames.length > 0) {
    for (const name of fp.detectedNames) {
      const matches = lookupByName(index, name);
      if (matches.length > 0 && matches[0].score >= 0.5) {
        fp.rosterMatch = matches[0].entry;
        logger.info(
          `  Roster match by name: ${fp.localLabel} (chunk ${fp.chunkIndex}) ` +
          `"${name}" → ${matches[0].entry.ownerName} (T${matches[0].entry.tower} Apt ${matches[0].entry.unit}, ` +
          `score=${matches[0].score.toFixed(2)})`,
        );
        return;
      }
    }
  }

  // Strategy 3: Scan text samples for roster name mentions
  // (speaker didn't introduce themselves but was addressed by name)
  // Common Spanish words that happen to be names — skip these
  const STOP_WORDS = new Set([
    'blanco', 'julio', 'laura', 'alba', 'luz', 'rosa', 'angel', 'leon',
    'cruz', 'victor', 'pilar', 'carmen', 'gloria', 'esperanza', 'mercedes',
    'sol', 'del', 'los', 'las', 'uno', 'una', 'por', 'con', 'para', 'que',
    'como', 'todo', 'esta', 'este', 'eso', 'ese', 'ella', 'ellos',
  ]);

  for (const sample of fp.samples) {
    const words = sample.split(/\s+/).map(w => w.replace(/[.,;:!?()]/g, ''));
    // Look for 2-word name fragments that match roster entries
    for (let w = 0; w < words.length - 1; w++) {
      const w1 = words[w].toLowerCase();
      const w2 = words[w + 1].toLowerCase();
      // Skip if either word is a stop word or too short
      if (STOP_WORDS.has(w1) || STOP_WORDS.has(w2)) continue;
      if (w1.length < 4 || w2.length < 4) continue;
      const twoWord = `${words[w]} ${words[w + 1]}`;
      const matches = lookupByName(index, twoWord);
      if (matches.length === 1 && matches[0].score >= 0.7) {
        // Only accept if it's an unambiguous single match with high confidence
        fp.rosterMatch = matches[0].entry;
        logger.info(
          `  Roster match by text scan: ${fp.localLabel} (chunk ${fp.chunkIndex}) ` +
          `"${twoWord}" → ${matches[0].entry.ownerName} (T${matches[0].entry.tower} Apt ${matches[0].entry.unit}, ` +
          `score=${matches[0].score.toFixed(2)})`,
        );
        return;
      }
    }
  }
}

/**
 * Assign a readable global label for a speaker based on fingerprint.
 */
function assignGlobalLabel(
  fp: SpeakerFingerprint,
  usedLabels: Set<string>,
  globalCounter: { value: number },
): string {
  // Prefer roster-based labels (most authoritative)
  if (fp.rosterMatch) {
    const label = formatRosterLabel(fp.rosterMatch);
    if (!usedLabels.has(label)) {
      usedLabels.add(label);
      return label;
    }
    // If label collision, add unit suffix
    const labelWithUnit = `${label}_T${fp.rosterMatch.tower}_${fp.rosterMatch.unit}`;
    if (!usedLabels.has(labelWithUnit)) {
      usedLabels.add(labelWithUnit);
      return labelWithUnit;
    }
  }

  // Then prefer name-based labels from self-introduction (most specific / unique)
  if (fp.detectedNames.length > 0) {
    const name = fp.detectedNames[0]
      .split(/\s+/)
      .filter(w => w.length > 1)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('_');
    if (name.length > 2) {
      const label = `Propietario_${name}`;
      if (!usedLabels.has(label)) {
        usedLabels.add(label);
        return label;
      }
    }
  }

  // Then try role-based label (only if self-identified)
  for (const role of fp.detectedRoles) {
    if (!usedLabels.has(role)) {
      usedLabels.add(role);
      return role;
    }
  }

  // Fallback to numbered speaker
  let label: string;
  do {
    globalCounter.value++;
    label = `Speaker_${globalCounter.value}`;
  } while (usedLabels.has(label));

  usedLabels.add(label);
  return label;
}

// ── Main Function ──

export async function reconcileSpeakersRedis(
  chunks: ChunkTranscript[],
  jobId?: string,
): Promise<ReconciliationResult> {
  logger.info(`Redis reconciliation: ${chunks.length} chunks`);

  // ────────────────────────────────────────────
  // Step 1: Build fingerprints for all speakers in all chunks
  // ────────────────────────────────────────────
  const allFingerprints: SpeakerFingerprint[][] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const uniqueSpeakers = [...new Set(chunk.segments.map(s => s.speaker))];
    const fps = uniqueSpeakers.map(label => buildFingerprint(i, label, chunk.segments));
    allFingerprints.push(fps);
    logger.info(
      `Chunk ${i}: ${fps.length} speakers — ` +
      fps.map(fp => {
        const tags: string[] = [];
        if (fp.detectedNames.length) tags.push(`name=${fp.detectedNames[0]}`);
        if (fp.detectedUnits.length) tags.push(`unit=${fp.detectedUnits[0]}`);
        if (fp.detectedRoles.size) tags.push(`role=${[...fp.detectedRoles][0]}`);
        return `${fp.localLabel}(${fp.wordCount}w${tags.length ? ', ' + tags.join(', ') : ''})`;
      }).join(', '),
    );
  }

  // ────────────────────────────────────────────
  // Step 1.5: Roster enrichment — match fingerprints against resident roster
  // ────────────────────────────────────────────
  let rosterIndex: RosterIndex | null = null;

  if (jobId) {
    try {
      const redis = getRedisClient();
      const pipelineRaw = await redis.get(`transcriptor:pipeline:${jobId}`);
      if (pipelineRaw) {
        const pipeline = JSON.parse(pipelineRaw);
        if (pipeline.idAsamblea) {
          logger.info(`Loading roster for assembly ${pipeline.idAsamblea} (${pipeline.clientName || 'unknown'})`);
          const entries = await loadRoster(pipeline.idAsamblea);
          rosterIndex = buildRosterIndex(entries);

          // Enrich fingerprints with roster matches
          for (const fps of allFingerprints) {
            for (const fp of fps) {
              enrichFingerprintFromRoster(fp, rosterIndex);
            }
          }
        } else {
          logger.info('Pipeline has no idAsamblea — skipping roster enrichment');
        }
      }
    } catch (err) {
      logger.warn(`Roster enrichment failed (non-fatal): ${(err as Error).message}`);
    }
  }

  // ────────────────────────────────────────────
  // Step 2: Build chunk maps via boundary continuity + fingerprint matching
  // ────────────────────────────────────────────
  const chunkMaps: SpeakerMap[] = [];
  const usedLabels = new Set<string>();
  const globalCounter = { value: 0 };
  const identifiedSpeakers: Record<string, string> = {};

  // Map from globalLabel → the fingerprint that established it (for cross-chunk matching)
  const globalFingerprintIndex: Map<string, SpeakerFingerprint> = new Map();

  // Process chunk 0 — all speakers get new global labels
  const chunk0Map: SpeakerMap = {};
  for (const fp of allFingerprints[0]) {
    const globalLabel = assignGlobalLabel(fp, usedLabels, globalCounter);
    chunk0Map[fp.localLabel] = globalLabel;
    globalFingerprintIndex.set(globalLabel, fp);

    // Record identified speaker names
    if (fp.rosterMatch) {
      identifiedSpeakers[globalLabel] = `${fp.rosterMatch.ownerName} (T${fp.rosterMatch.tower} Apt ${fp.rosterMatch.unit})`;
    } else if (fp.detectedNames.length > 0) {
      identifiedSpeakers[globalLabel] = fp.detectedNames[0];
    } else if (fp.detectedRoles.size > 0) {
      identifiedSpeakers[globalLabel] = [...fp.detectedRoles][0];
    }
  }
  chunkMaps.push(chunk0Map);

  // Process remaining chunks
  for (let i = 1; i < chunks.length; i++) {
    const chunkMap: SpeakerMap = {};
    const matched = new Set<string>(); // globalLabels already used in this chunk
    const fps = allFingerprints[i];

    // ── 2a: Boundary continuity ──
    // The speaker at the end of chunk i-1 is likely the same as the speaker
    // at the start of chunk i (audio was cut mid-conversation)
    const prevChunk = chunks[i - 1];
    const currChunk = chunks[i];

    if (prevChunk.segments.length > 0 && currChunk.segments.length > 0) {
      const lastSpeakerPrev = prevChunk.segments[prevChunk.segments.length - 1].speaker;
      const firstSpeakerCurr = currChunk.segments[0].speaker;

      const prevGlobal = chunkMaps[i - 1][lastSpeakerPrev];
      if (prevGlobal && !chunkMap[firstSpeakerCurr]) {
        chunkMap[firstSpeakerCurr] = prevGlobal;
        matched.add(prevGlobal);
        logger.info(
          `  Chunk ${i}: boundary match "${firstSpeakerCurr}" → "${prevGlobal}" ` +
          `(continued from chunk ${i - 1} "${lastSpeakerPrev}")`,
        );
      }
    }

    // ── 2b: Fingerprint matching for remaining speakers ──
    for (const fp of fps) {
      if (chunkMap[fp.localLabel]) continue; // already matched by boundary

      // Compare against all known global fingerprints
      let bestMatch: { globalLabel: string; score: number } | null = null;

      for (const [globalLabel, globalFp] of globalFingerprintIndex) {
        if (matched.has(globalLabel)) continue; // already assigned in this chunk

        const score = fingerprintSimilarity(fp, globalFp);
        if (score > 0.6 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { globalLabel, score };
        }
      }

      if (bestMatch) {
        chunkMap[fp.localLabel] = bestMatch.globalLabel;
        matched.add(bestMatch.globalLabel);
        logger.info(
          `  Chunk ${i}: fingerprint match "${fp.localLabel}" → "${bestMatch.globalLabel}" ` +
          `(score=${bestMatch.score.toFixed(2)})`,
        );
      } else {
        // New speaker — assign a new global label
        const globalLabel = assignGlobalLabel(fp, usedLabels, globalCounter);
        chunkMap[fp.localLabel] = globalLabel;
        matched.add(globalLabel);
        globalFingerprintIndex.set(globalLabel, fp);

        if (fp.rosterMatch) {
          identifiedSpeakers[globalLabel] = `${fp.rosterMatch.ownerName} (T${fp.rosterMatch.tower} Apt ${fp.rosterMatch.unit})`;
        } else if (fp.detectedNames.length > 0) {
          identifiedSpeakers[globalLabel] = fp.detectedNames[0];
        } else if (fp.detectedRoles.size > 0) {
          identifiedSpeakers[globalLabel] = [...fp.detectedRoles][0];
        }

        logger.info(
          `  Chunk ${i}: new speaker "${fp.localLabel}" → "${globalLabel}"`,
        );
      }
    }

    // Update global fingerprints with data from this chunk (merge info)
    for (const fp of fps) {
      const globalLabel = chunkMap[fp.localLabel];
      if (globalLabel) {
        const existing = globalFingerprintIndex.get(globalLabel);
        if (existing) {
          // Merge fingerprint data for better matching in future chunks
          existing.wordCount += fp.wordCount;
          existing.segmentCount += fp.segmentCount;
          if (fp.lastAppearance > existing.lastAppearance) {
            existing.lastAppearance = fp.lastAppearance;
          }
          for (const name of fp.detectedNames) {
            if (!existing.detectedNames.includes(name)) {
              existing.detectedNames.push(name);
            }
          }
          for (const unit of fp.detectedUnits) {
            if (!existing.detectedUnits.includes(unit)) {
              existing.detectedUnits.push(unit);
            }
          }
          for (const role of fp.detectedRoles) {
            existing.detectedRoles.add(role);
          }
        }
      }
    }

    chunkMaps.push(chunkMap);
  }

  // ────────────────────────────────────────────
  // Step 3: Apply mapping and merge segments
  // ────────────────────────────────────────────
  const mergedSegments = applyMappingAndMerge(chunks, chunkMaps);
  const globalSpeakers = [...usedLabels];

  // Compute a confidence score based on how many speakers were matched vs new
  const totalSpeakersAcrossChunks = allFingerprints.reduce((s, fps) => s + fps.length, 0);
  const newSpeakersIntroduced = globalSpeakers.length;
  // If we consolidated well, totalSpeakers >> globalSpeakers → high confidence
  const confidence = totalSpeakersAcrossChunks > 0
    ? Math.min(1, Math.max(0.3, 1 - (newSpeakersIntroduced / totalSpeakersAcrossChunks)))
    : 1.0;

  const rosterMatchCount = allFingerprints
    .flat()
    .filter(fp => fp.rosterMatch)
    .length;

  const reasoning =
    `Deterministic reconciliation: ${chunks.length} chunks, ` +
    `${totalSpeakersAcrossChunks} local speakers → ${globalSpeakers.length} global speakers. ` +
    `${Object.keys(identifiedSpeakers).length} identified by name/role` +
    (rosterIndex ? ` (${rosterMatchCount} via roster)` : '') + '. ' +
    `Method: boundary continuity + fingerprint matching (names, units, roles, word-count ratio)` +
    (rosterIndex ? ' + roster enrichment' : '') + '.';

  logger.info(`Redis reconciliation complete: ${globalSpeakers.length} global speakers, confidence ${confidence.toFixed(2)}`);
  logger.info(`Reasoning: ${reasoning}`);
  for (const [globalId, name] of Object.entries(identifiedSpeakers)) {
    logger.info(`  ${globalId} → ${name}`);
  }

  // ────────────────────────────────────────────
  // Step 4: Cache the result in Redis
  // ────────────────────────────────────────────
  if (jobId) {
    try {
      const redis = getRedisClient();
      const cacheData = {
        chunkMaps,
        globalSpeakers,
        identifiedSpeakers,
        confidence,
        reasoning,
        reconciledAt: new Date().toISOString(),
      };
      await redis.set(speakerMapKey(jobId), JSON.stringify(cacheData), 'EX', 86400 * 7); // 7 days TTL
      logger.info(`Speaker map cached in Redis: ${speakerMapKey(jobId)}`);
    } catch (err) {
      logger.warn('Failed to cache speaker map in Redis (non-fatal)', err);
    }
  }

  return {
    chunkMaps,
    globalSpeakers,
    identifiedSpeakers,
    mergedSegments,
    confidence,
    reasoning,
  };
}

/**
 * Load a previously cached speaker map from Redis.
 * Returns null if no cached result exists.
 */
export async function loadCachedSpeakerMap(jobId: string): Promise<ReconciliationResult | null> {
  try {
    const redis = getRedisClient();
    const raw = await redis.get(speakerMapKey(jobId));
    if (!raw) return null;

    const cached = JSON.parse(raw);
    logger.info(`Loaded cached speaker map from Redis: ${speakerMapKey(jobId)}`);

    // The cached result doesn't include mergedSegments (too large to cache).
    // Caller must re-apply the mapping if needed.
    return {
      chunkMaps: cached.chunkMaps,
      globalSpeakers: cached.globalSpeakers,
      identifiedSpeakers: cached.identifiedSpeakers,
      mergedSegments: [], // Must be re-applied by caller
      confidence: cached.confidence,
      reasoning: cached.reasoning + ' (loaded from cache)',
    };
  } catch (err) {
    logger.warn('Failed to load cached speaker map from Redis', err);
    return null;
  }
}

// ── Helpers ──

/** Seconds from each chunk boundary to check for duplicates. */
const BOUNDARY_ZONE_S = 60;
/** Minimum token overlap ratio to flag a segment as duplicate. */
const DEDUP_THRESHOLD = 0.7;

function applyMappingAndMerge(
  chunks: ChunkTranscript[],
  chunkMaps: SpeakerMap[],
): TranscriptSegment[] {
  const merged: TranscriptSegment[] = [];
  let timeOffset = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const map = chunkMaps[i];

    let segments = chunk.segments;

    // Dedup segments near the boundary with the previous chunk
    if (i > 0) {
      const prevChunk = chunks[i - 1];
      const prevDuration = prevChunk.durationSeconds;
      const boundaryStart = prevDuration - BOUNDARY_ZONE_S;
      const prevBoundary = prevChunk.segments.filter(s => s.start >= boundaryStart);

      if (prevBoundary.length > 0) {
        const duplicateIndices = new Set<number>();

        for (let si = 0; si < segments.length; si++) {
          const seg = segments[si];
          if (seg.start > BOUNDARY_ZONE_S) break;

          for (const prevSeg of prevBoundary) {
            const similarity = tokenOverlapRatio(prevSeg.text, seg.text);
            if (similarity >= DEDUP_THRESHOLD) {
              duplicateIndices.add(si);
              logger.info(
                `Lina boundary dedup chunk ${i}: dropping seg@${seg.start.toFixed(1)}s ` +
                `(sim=${similarity.toFixed(2)}) "${seg.text.slice(0, 60)}…"`,
              );
              break;
            }
          }
        }

        if (duplicateIndices.size > 0) {
          logger.info(`Lina boundary dedup chunk ${i}: removed ${duplicateIndices.size} segment(s)`);
          segments = segments.filter((_, idx) => !duplicateIndices.has(idx));
        }
      }
    }

    for (const seg of segments) {
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
