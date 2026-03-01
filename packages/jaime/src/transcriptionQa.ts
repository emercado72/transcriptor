import { createLogger, loadGlossary } from '@transcriptor/shared';
import type { AttendanceRecord, ClientConfig, GlossaryEntry } from '@transcriptor/shared';
import type { RawSection } from './sectionMapper.js';

const logger = createLogger('jaime:qa');

// ── Types ──
export interface QaReport {
  overallScore: number;
  sectionScores: { sectionId: string; score: number; flags: string[] }[];
  nonsenseFlags: NonsenseFlag[];
  nameValidations: NameValidation[];
  totalFlags: number;
}

export interface NonsenseFlag {
  word: string;
  context: string;
  position: number;
  severity: 'low' | 'medium' | 'high';
}

export interface CorrectionSuggestion {
  original: string;
  suggested: string;
  context: string;
  confidence: number;
  source: 'glossary' | 'attendance' | 'pattern';
}

export interface NameValidation {
  foundName: string;
  matchedName: string | null;
  unit: string | null;
  confidence: number;
  valid: boolean;
}

export interface UnitValidation {
  foundUnit: string;
  valid: boolean;
  suggestion: string | null;
}

export function analyzeTranscriptionQuality(sections: RawSection[]): QaReport {
  logger.info(`Analyzing transcription quality for ${sections.length} sections`);

  const sectionScores = sections.map((section) => {
    const flags: string[] = [];
    let score = 100;

    // Check for very short sections
    if (section.rawText.length < 50) {
      flags.push('section_too_short');
      score -= 20;
    }

    // Check for repetitive text
    const words = section.rawText.split(/\s+/);
    const uniqueWords = new Set(words.map((w) => w.toLowerCase()));
    const uniqueRatio = uniqueWords.size / words.length;
    if (uniqueRatio < 0.3) {
      flags.push('highly_repetitive');
      score -= 30;
    }

    // Check for encoding issues
    if (/[�\uFFFD]/.test(section.rawText)) {
      flags.push('encoding_issues');
      score -= 15;
    }

    return {
      sectionId: section.sectionId,
      score: Math.max(0, score),
      flags,
    };
  });

  const overallScore = sectionScores.reduce((sum, s) => sum + s.score, 0) / sectionScores.length;

  return {
    overallScore: Math.round(overallScore),
    sectionScores,
    nonsenseFlags: [],
    nameValidations: [],
    totalFlags: sectionScores.reduce((sum, s) => sum + s.flags.length, 0),
  };
}

export function detectNonsenseWords(text: string, glossary: GlossaryEntry[]): NonsenseFlag[] {
  const flags: NonsenseFlag[] = [];
  const words = text.split(/\s+/);

  // Common patterns for mis-transcriptions
  const suspiciousPatterns = [
    /^[a-z]{1,2}$/,      // Very short words
    /(.)\1{3,}/,           // Repeated characters
    /[^aeiouáéíóú\s]{5,}/i, // Too many consonants in a row
  ];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(word) && word.length > 1) {
        // Check if it's in the glossary (known term)
        const isKnown = glossary.some(
          (g) => g.term.toLowerCase() === word.toLowerCase(),
        );
        if (!isKnown) {
          const contextStart = Math.max(0, i - 3);
          const contextEnd = Math.min(words.length, i + 4);
          flags.push({
            word,
            context: words.slice(contextStart, contextEnd).join(' '),
            position: i,
            severity: word.length <= 2 ? 'low' : 'medium',
          });
        }
        break;
      }
    }
  }

  return flags;
}

export function suggestCorrections(
  flags: NonsenseFlag[],
  glossary: GlossaryEntry[],
): CorrectionSuggestion[] {
  const suggestions: CorrectionSuggestion[] = [];

  for (const flag of flags) {
    // Try to find similar terms in glossary
    for (const entry of glossary) {
      const distance = levenshteinDistance(
        flag.word.toLowerCase(),
        entry.term.toLowerCase(),
      );
      if (distance <= 2 && distance < flag.word.length * 0.4) {
        suggestions.push({
          original: flag.word,
          suggested: entry.replacement || entry.term,
          context: flag.context,
          confidence: 1 - distance / flag.word.length,
          source: 'glossary',
        });
        break;
      }
    }
  }

  return suggestions;
}

export function validateProperNames(
  text: string,
  attendanceList: AttendanceRecord[],
): NameValidation[] {
  const validations: NameValidation[] = [];
  // Simple capitalized word sequence detection
  const namePattern = /[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,3}/g;
  let match;

  while ((match = namePattern.exec(text)) !== null) {
    const foundName = match[0];
    let bestMatch: { name: string; unit: string; confidence: number } | null = null;

    for (const record of attendanceList) {
      const normalized1 = foundName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const normalized2 = record.ownerName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const parts1 = normalized1.split(/\s+/);
      const parts2 = normalized2.split(/\s+/);
      const commonParts = parts1.filter((p) => parts2.includes(p));
      const confidence = commonParts.length / Math.max(parts1.length, parts2.length);

      if (confidence > 0.5 && (!bestMatch || confidence > bestMatch.confidence)) {
        bestMatch = { name: record.ownerName, unit: record.unit, confidence };
      }
    }

    validations.push({
      foundName,
      matchedName: bestMatch?.name || null,
      unit: bestMatch?.unit || null,
      confidence: bestMatch?.confidence || 0,
      valid: bestMatch !== null && bestMatch.confidence >= 0.7,
    });
  }

  return validations;
}

export function validateUnitNumbers(text: string, clientConfig: ClientConfig): UnitValidation[] {
  const validations: UnitValidation[] = [];
  const unitPattern = /(?:apartamento|apto|unidad|local|oficina|casa)\s*(?:n[oº°]?\s*)?(\d{1,4}[A-Za-z]?)/gi;
  let match;

  while ((match = unitPattern.exec(text)) !== null) {
    const unit = match[1];
    const unitNum = parseInt(unit, 10);
    const maxUnit = clientConfig.towers * clientConfig.unitsPerTower;
    const valid = unitNum > 0 && unitNum <= maxUnit;

    validations.push({
      foundUnit: unit,
      valid,
      suggestion: valid ? null : `Unit ${unit} exceeds building capacity (${maxUnit} units)`,
    });
  }

  return validations;
}

export function applyCorrections(text: string, corrections: CorrectionSuggestion[]): string {
  let result = text;
  // Sort by position (longest first to avoid overlap issues)
  const sorted = [...corrections].sort((a, b) => b.original.length - a.original.length);

  for (const correction of sorted) {
    if (correction.confidence >= 0.7) {
      result = result.replace(new RegExp(escapeRegex(correction.original), 'g'), correction.suggested);
    }
  }

  return result;
}

// ── Helpers ──
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
