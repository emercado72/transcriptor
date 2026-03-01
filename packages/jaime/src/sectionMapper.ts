import { createLogger, SectionStyle } from '@transcriptor/shared';
import type { VotingSummary, AttendanceRecord } from '@transcriptor/shared';
import type { ScribeTranscript, ScribeUtterance } from './transcriptionManager.js';

const logger = createLogger('jaime:sectionMapper');

// ── Types ──
export interface RawSection {
  sectionId: string;
  sectionTitle: string;
  sectionStyle: SectionStyle;
  order: number;
  rawText: string;
  utterances: ScribeUtterance[];
  startTime: number;
  endTime: number;
}

export interface MappingContext {
  previousSection?: string;
  questionList: VotingSummary[];
  attendanceList: AttendanceRecord[];
}

export interface VotingSegment {
  questionId: string;
  startTime: number;
  endTime: number;
  utterances: ScribeUtterance[];
}

export interface RawIntervention {
  speaker: string;
  text: string;
  startTime: number;
  endTime: number;
}

export interface SpeakerMatch {
  speaker: string;
  unit: string | null;
  confidence: number;
  matchedRecord: AttendanceRecord | null;
}

// ── Section boundary patterns ──
const SECTION_PATTERNS: { pattern: RegExp; style: SectionStyle; title: string }[] = [
  { pattern: /orden\s+del\s+d[ií]a/i, style: SectionStyle.ORDEN_DEL_DIA, title: 'Orden del Día' },
  { pattern: /pre[aá]mbulo/i, style: SectionStyle.PREAMBULO, title: 'Preámbulo' },
  { pattern: /verificaci[oó]n\s+(?:de\s+)?qu[oó]rum/i, style: SectionStyle.PARAGRAPH_BOLD, title: 'Verificación de Quórum' },
  { pattern: /elecci[oó]n\s+de\s+(presidente|secretario|verificador)/i, style: SectionStyle.VOTING_QUESTION, title: 'Elección de Mesa Directiva' },
  { pattern: /lectura\s+(?:y\s+)?aprobaci[oó]n\s+del\s+acta/i, style: SectionStyle.PARAGRAPH_NORMAL, title: 'Lectura y Aprobación del Acta Anterior' },
  { pattern: /informes?\s+(?:de\s+)?gesti[oó]n/i, style: SectionStyle.PARAGRAPH_NORMAL, title: 'Informe de Gestión' },
  { pattern: /estados?\s+financieros?/i, style: SectionStyle.PARAGRAPH_NORMAL, title: 'Estados Financieros' },
  { pattern: /presupuesto/i, style: SectionStyle.PARAGRAPH_NORMAL, title: 'Presupuesto' },
  { pattern: /proposiciones?\s+y\s+varios/i, style: SectionStyle.PARAGRAPH_NORMAL, title: 'Proposiciones y Varios' },
  { pattern: /cierre|clausura/i, style: SectionStyle.FIRMA, title: 'Cierre de la Asamblea' },
];

export function mapTranscriptToSections(
  transcript: ScribeTranscript,
  questionList: VotingSummary[],
): RawSection[] {
  logger.info('Mapping transcript to sections');
  const sections: RawSection[] = [];
  let currentSectionStyle: SectionStyle | null = null;
  let currentSectionId: string | null = null;
  let currentSectionData: Partial<RawSection> | null = null;
  let order = 0;

  for (const utterance of transcript.utterances) {
    const detected: SectionStyle = identifySectionType(utterance.text, {
      previousSection: currentSectionId ?? undefined,
      questionList,
      attendanceList: [],
    });

    if (detected !== currentSectionStyle) {
      if (currentSectionData && currentSectionData.rawText) {
        sections.push(currentSectionData as RawSection);
      }

      order++;
      const sectionId: string = `${String(order).padStart(2, '0')}_${detected}`;
      currentSectionId = sectionId;
      currentSectionStyle = detected;
      currentSectionData = {
        sectionId,
        sectionTitle: SECTION_PATTERNS.find((p) => p.style === detected)?.title || String(detected),
        sectionStyle: detected,
        order,
        rawText: utterance.text,
        utterances: [utterance],
        startTime: utterance.startTime,
        endTime: utterance.endTime,
      };
    } else if (currentSectionData) {
      currentSectionData.rawText += ' ' + utterance.text;
      currentSectionData.utterances = [...(currentSectionData.utterances || []), utterance];
      currentSectionData.endTime = utterance.endTime;
    }
  }

  // Push last section
  if (currentSectionData && currentSectionData.rawText) {
    sections.push(currentSectionData as RawSection);
  }

  logger.info(`Mapped ${sections.length} sections`);
  return sections;
}

export function identifySectionType(text: string, _context: MappingContext): SectionStyle {
  for (const { pattern, style } of SECTION_PATTERNS) {
    if (pattern.test(text)) {
      return style;
    }
  }
  return SectionStyle.PARAGRAPH_NORMAL;
}

export function extractAgendaItems(transcript: ScribeTranscript): string[] {
  const items: string[] = [];
  let inAgenda = false;

  for (const utterance of transcript.utterances) {
    if (/orden\s+del\s+d[ií]a/i.test(utterance.text)) {
      inAgenda = true;
      continue;
    }
    if (inAgenda) {
      if (/punto\s+(?:n[uú]mero\s+)?\d+|primer[oa]?|segund[oa]?|tercer[oa]?/i.test(utterance.text)) {
        items.push(utterance.text.trim());
      } else if (items.length > 0 && !/^\d/.test(utterance.text.trim())) {
        // End of agenda
        break;
      }
    }
  }

  return items;
}

export function matchVotingSegments(
  transcript: ScribeTranscript,
  questions: VotingSummary[],
): VotingSegment[] {
  logger.info(`Matching voting segments for ${questions.length} questions`);
  const segments: VotingSegment[] = [];

  for (const question of questions) {
    const keywords = question.questionText.toLowerCase().split(/\s+/).slice(0, 5);

    for (let i = 0; i < transcript.utterances.length; i++) {
      const text = transcript.utterances[i].text.toLowerCase();
      const matchCount = keywords.filter((kw) => text.includes(kw)).length;

      if (matchCount >= Math.min(3, keywords.length)) {
        const endIdx = Math.min(i + 10, transcript.utterances.length - 1);
        segments.push({
          questionId: question.questionId,
          startTime: transcript.utterances[i].startTime,
          endTime: transcript.utterances[endIdx].endTime,
          utterances: transcript.utterances.slice(i, endIdx + 1),
        });
        break;
      }
    }
  }

  return segments;
}

export function extractInterventions(sectionText: string): RawIntervention[] {
  const interventions: RawIntervention[] = [];
  // Pattern: "Speaker Name:" or "SPEAKER NAME:" at start of line
  const pattern = /(?:^|\n)\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ\s]+?):\s*(.+?)(?=(?:\n\s*[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ\s]+?:)|$)/gs;

  let match;
  while ((match = pattern.exec(sectionText)) !== null) {
    interventions.push({
      speaker: match[1].trim(),
      text: match[2].trim(),
      startTime: 0,
      endTime: 0,
    });
  }

  return interventions;
}

export function identifySpeaker(
  text: string,
  attendanceList: AttendanceRecord[],
): SpeakerMatch {
  const normalizedText = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  let bestMatch: SpeakerMatch = {
    speaker: text,
    unit: null,
    confidence: 0,
    matchedRecord: null,
  };

  for (const record of attendanceList) {
    const normalizedName = record.ownerName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const nameParts = normalizedName.split(/\s+/);
    const matchedParts = nameParts.filter((part) => normalizedText.includes(part));
    const confidence = matchedParts.length / nameParts.length;

    if (confidence > bestMatch.confidence) {
      bestMatch = {
        speaker: record.ownerName,
        unit: record.unit,
        confidence,
        matchedRecord: record,
      };
    }
  }

  return bestMatch;
}
