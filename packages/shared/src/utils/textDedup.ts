/**
 * Text deduplication utilities for transcript chunk boundary handling.
 *
 * When audio is split into segments and transcribed independently,
 * speech at chunk boundaries can appear in both segments.
 * These functions detect and measure that overlap so callers can trim it.
 */

/**
 * Normalize text for comparison: lowercase, strip punctuation, trim.
 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[.,;:!?¿¡()"'«»—–\-]/g, '').trim();
}

/**
 * Compute token overlap ratio between two texts.
 *
 * Tokenizes both strings, filters insignificant tokens (≤2 chars),
 * and returns `intersection / min(|A|, |B|)`.
 *
 * Using min() as denominator (instead of union) makes this detect
 * "B is a subset of A" — which is the typical duplicate pattern
 * where a shorter boundary utterance is fully contained in a longer one.
 *
 * @returns 0..1 where 1 means near-identical token sets.
 */
export function tokenOverlapRatio(textA: string, textB: string): number {
  const tokensA = new Set(normalize(textA).split(/\s+/).filter(t => t.length > 2));
  const tokensB = new Set(normalize(textB).split(/\s+/).filter(t => t.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let overlap = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) overlap++;
  }

  return overlap / Math.min(tokensA.size, tokensB.size);
}

/**
 * Find the longest suffix of textA that matches a prefix of textB,
 * aligned on word boundaries.
 *
 * This detects the classic overlap pattern where the end of one chunk's
 * transcription repeats at the start of the next chunk.
 *
 * @param minWords  Minimum overlap length to consider (default 4).
 *                  Prevents false matches on short common phrases.
 * @param maxWords  Maximum words to check (default 30). Caps search cost.
 * @returns Number of overlapping words, or 0 if no significant overlap found.
 */
export function findWordOverlap(
  textA: string,
  textB: string,
  minWords: number = 4,
  maxWords: number = 30,
): number {
  const wordsA = normalize(textA).split(/\s+/);
  const wordsB = normalize(textB).split(/\s+/);
  const maxCheck = Math.min(wordsA.length, wordsB.length, maxWords);

  for (let len = maxCheck; len >= minWords; len--) {
    const suffixA = wordsA.slice(-len).join(' ');
    const prefixB = wordsB.slice(0, len).join(' ');
    if (suffixA === prefixB) return len;
  }

  return 0;
}
