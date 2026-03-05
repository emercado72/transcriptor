import OpenAI from 'openai';
import { createLogger, SectionStyle, getEnvConfig } from '@transcriptor/shared';
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

// ── LLM client (same OpenRouter setup as Gloria) ──
let llmClient: OpenAI | null = null;
function getLLMClient(): OpenAI {
  if (!llmClient) {
    const env = getEnvConfig();
    llmClient = new OpenAI({
      apiKey: env.openrouterApiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: { 'HTTP-Referer': 'https://transcriptor.local', 'X-Title': 'Transcriptor' },
    });
  }
  return llmClient;
}
function getLLMModel(): string {
  return getEnvConfig().openrouterModel || 'anthropic/claude-sonnet-4';
}

// ── LLM segmentation plan types ──
interface SegmentPlan {
  sections: Array<{
    title: string;
    style: string;
    startUtteranceIndex: number;
    endUtteranceIndex: number;
  }>;
}

const STYLE_MAP: Record<string, SectionStyle> = {
  encabezado:      SectionStyle.ENCABEZADO,
  preambulo:       SectionStyle.PREAMBULO,
  ordenDelDia:     SectionStyle.ORDEN_DEL_DIA,
  paragraphNormal: SectionStyle.PARAGRAPH_NORMAL,
  paragraphBold:   SectionStyle.PARAGRAPH_BOLD,
  intervention:    SectionStyle.INTERVENTION,
  votingQuestion:  SectionStyle.VOTING_QUESTION,
  votingResults:   SectionStyle.VOTING_RESULTS,
  votingAnnouncement: SectionStyle.VOTING_ANNOUNCEMENT,
  firma:           SectionStyle.FIRMA,
};

/**
 * Use an LLM to segment a transcript into logical acta sections.
 * Sends a condensed index (utterance number + first 80 chars of text) to keep
 * the prompt small, then receives a plan of [startIdx, endIdx] per section.
 * Falls back to the regex-based heuristic if the LLM call fails.
 */
async function llmSegmentTranscript(
  utterances: ScribeUtterance[],
  questionList: VotingSummary[],
): Promise<SegmentPlan | null> {
  try {
    const client = getLLMClient();
    const model = getLLMModel();

    // Build a compact index: "N|speaker|first 80 chars"
    const index = utterances
      .map((u, i) => `${i}|${u.speaker}|${u.text.slice(0, 80).replace(/\n/g, ' ')}`)
      .join('\n');

    const questionBlock = questionList.length > 0
      ? `\nPreguntas de votación registradas (en orden):\n${questionList.map(q => `- Q${q.questionId}: ${q.questionText}`).join('\n')}`
      : '';

    const systemPrompt = `Eres un experto en actas de asamblea de propiedad horizontal colombiana.
Recibirás un índice de utterances de una transcripción de asamblea (formato: índice|hablante|texto).
Tu tarea: identificar las secciones temáticas del acta y devolver un plan de segmentación en JSON.

Secciones típicas de un acta (usa EXACTAMENTE estos valores en el campo "style"):
- encabezado: título y datos del evento (generalmente no hay utterances explícitos, omitir si no aplica)
- preambulo: apertura, verificación de quórum, declaración de inicio
- ordenDelDia: lectura y aprobación del orden del día
- paragraphNormal: puntos del orden del día, informes, debates (la mayoría del contenido)
- votingQuestion: cuando se somete algo a votación (apertura de la votación)
- firma: cierre, firmas, despedida

Reglas:
1. Cada sección debe tener al menos 3 utterances salvo preambulo y firma
2. El acta típicamente tiene 8-15 puntos de orden del día — identifícalos como secciones paragraphNormal separadas
3. Agrupa utterances consecutivos del mismo tema en la misma sección
4. Los utterances de votación y su anuncio de resultado van juntos en una sección votingQuestion
5. Devuelve SOLO JSON válido, sin markdown, sin explicaciones

Formato de respuesta:
{
  "sections": [
    {"title": "Apertura y Verificación de Quórum", "style": "preambulo", "startUtteranceIndex": 0, "endUtteranceIndex": 12},
    {"title": "Orden del Día", "style": "ordenDelDia", "startUtteranceIndex": 13, "endUtteranceIndex": 18},
    ...
  ]
}`;

    const userPrompt = `Índice de utterances (${utterances.length} total):
${index}
${questionBlock}

Genera el plan de segmentación. Cubre TODOS los utterances del 0 al ${utterances.length - 1}.`;

    logger.info(`LLM segmentation: sending ${utterances.length} utterances to ${model}`);

    const response = await client.chat.completions.create({
      model,
      max_tokens: 4000,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() || '';
    const clean = raw.replace(/```json\n?|\n?```/g, '').trim();
    const plan = JSON.parse(clean) as SegmentPlan;

    logger.info(`LLM segmentation: received ${plan.sections.length} sections`);
    return plan;
  } catch (err) {
    logger.error(`LLM segmentation failed: ${(err as Error).message} — falling back to regex`);
    return null;
  }
}

// ── Regex fallback (original approach) ──
const SECTION_PATTERNS: { pattern: RegExp; style: SectionStyle; title: string }[] = [
  { pattern: /orden\s+del\s+d[ií]a/i,                              style: SectionStyle.ORDEN_DEL_DIA,      title: 'Orden del Día' },
  { pattern: /pre[aá]mbulo/i,                                       style: SectionStyle.PREAMBULO,           title: 'Preámbulo' },
  { pattern: /verificaci[oó]n\s+(?:de\s+)?qu[oó]rum/i,             style: SectionStyle.PARAGRAPH_BOLD,      title: 'Verificación de Quórum' },
  { pattern: /elecci[oó]n\s+de\s+(presidente|secretario|verificador)/i, style: SectionStyle.VOTING_QUESTION, title: 'Elección de Mesa Directiva' },
  { pattern: /lectura\s+(?:y\s+)?aprobaci[oó]n\s+del\s+acta/i,    style: SectionStyle.PARAGRAPH_NORMAL,   title: 'Lectura y Aprobación del Acta Anterior' },
  { pattern: /informes?\s+(?:de\s+)?gesti[oó]n/i,                  style: SectionStyle.PARAGRAPH_NORMAL,   title: 'Informe de Gestión' },
  { pattern: /estados?\s+financieros?/i,                            style: SectionStyle.PARAGRAPH_NORMAL,   title: 'Estados Financieros' },
  { pattern: /presupuesto/i,                                        style: SectionStyle.PARAGRAPH_NORMAL,   title: 'Presupuesto' },
  { pattern: /proposiciones?\s+y\s+varios/i,                        style: SectionStyle.PARAGRAPH_NORMAL,   title: 'Proposiciones y Varios' },
  { pattern: /cierre|clausura/i,                                    style: SectionStyle.FIRMA,               title: 'Cierre de la Asamblea' },
];

function regexSegment(utterances: ScribeUtterance[]): SegmentPlan {
  const sections: SegmentPlan['sections'] = [];
  let currentStyle: SectionStyle = SectionStyle.PARAGRAPH_NORMAL;
  let currentTitle = 'Contenido General';
  let sectionStart = 0;

  for (let i = 0; i < utterances.length; i++) {
    const detected = identifySectionType(utterances[i].text, { questionList: [], attendanceList: [] });
    if (detected !== currentStyle && i > sectionStart) {
      sections.push({ title: currentTitle, style: currentStyle, startUtteranceIndex: sectionStart, endUtteranceIndex: i - 1 });
      sectionStart = i;
    }
    const matched = SECTION_PATTERNS.find(p => p.style === detected);
    currentStyle = detected;
    currentTitle = matched?.title || 'Contenido General';
  }
  sections.push({ title: currentTitle, style: currentStyle, startUtteranceIndex: sectionStart, endUtteranceIndex: utterances.length - 1 });
  return { sections };
}

// ── Main export: async LLM-first segmentation ──
export async function mapTranscriptToSections(
  transcript: ScribeTranscript,
  questionList: VotingSummary[],
): Promise<RawSection[]> {
  logger.info(`Segmenting transcript: ${transcript.utterances.length} utterances`);

  const utterances = transcript.utterances;
  if (utterances.length === 0) return [];

  // Try LLM first, fall back to regex
  let plan = await llmSegmentTranscript(utterances, questionList);
  if (!plan || plan.sections.length < 2) {
    logger.warn('LLM plan insufficient, using regex fallback');
    plan = regexSegment(utterances);
  }

  // Build RawSection[] from the plan
  const sections: RawSection[] = [];
  for (let i = 0; i < plan.sections.length; i++) {
    const seg = plan.sections[i];
    const start = Math.max(0, seg.startUtteranceIndex);
    const end = Math.min(utterances.length - 1, seg.endUtteranceIndex);
    const segUtterances = utterances.slice(start, end + 1);
    if (segUtterances.length === 0) continue;

    const style = STYLE_MAP[seg.style] ?? SectionStyle.PARAGRAPH_NORMAL;
    const order = i + 1;
    const sectionId = `${String(order).padStart(2, '0')}_${style}`;

    sections.push({
      sectionId,
      sectionTitle: seg.title,
      sectionStyle: style,
      order,
      rawText: segUtterances.map(u => `${u.speaker}: ${u.text}`).join('\n'),
      utterances: segUtterances,
      startTime: segUtterances[0].startTime,
      endTime: segUtterances[segUtterances.length - 1].endTime,
    });
  }

  logger.info(`Segmentation complete: ${sections.length} sections`);
  return sections;
}

// ── Kept for backwards compat (sync callers in QA) ──
export function identifySectionType(text: string, _context: MappingContext): SectionStyle {
  for (const { pattern, style } of SECTION_PATTERNS) {
    if (pattern.test(text)) return style;
  }
  return SectionStyle.PARAGRAPH_NORMAL;
}

export function extractAgendaItems(transcript: ScribeTranscript): string[] {
  const items: string[] = [];
  let inAgenda = false;
  for (const utterance of transcript.utterances) {
    if (/orden\s+del\s+d[ií]a/i.test(utterance.text)) { inAgenda = true; continue; }
    if (inAgenda) {
      if (/punto\s+(?:n[uú]mero\s+)?\d+|primer[oa]?|segund[oa]?|tercer[oa]?/i.test(utterance.text)) {
        items.push(utterance.text.trim());
      } else if (items.length > 0 && !/^\d/.test(utterance.text.trim())) break;
    }
  }
  return items;
}

export function matchVotingSegments(transcript: ScribeTranscript, questions: VotingSummary[]): VotingSegment[] {
  logger.info(`Matching voting segments for ${questions.length} questions`);
  const segments: VotingSegment[] = [];
  for (const question of questions) {
    const keywords = question.questionText.toLowerCase().split(/\s+/).slice(0, 5);
    for (let i = 0; i < transcript.utterances.length; i++) {
      const text = transcript.utterances[i].text.toLowerCase();
      const matchCount = keywords.filter(kw => text.includes(kw)).length;
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
  const pattern = /(?:^|\n)\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ\s]+?):\s*(.+?)(?=(?:\n\s*[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ\s]+?:)|$)/gs;
  let match;
  while ((match = pattern.exec(sectionText)) !== null) {
    interventions.push({ speaker: match[1].trim(), text: match[2].trim(), startTime: 0, endTime: 0 });
  }
  return interventions;
}

export function identifySpeaker(text: string, attendanceList: AttendanceRecord[]): SpeakerMatch {
  const normalizedText = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let bestMatch: SpeakerMatch = { speaker: text, unit: null, confidence: 0, matchedRecord: null };
  for (const record of attendanceList) {
    const normalizedName = record.ownerName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const nameParts = normalizedName.split(/\s+/);
    const matchedParts = nameParts.filter(part => normalizedText.includes(part));
    const confidence = matchedParts.length / nameParts.length;
    if (confidence > bestMatch.confidence) {
      bestMatch = { speaker: record.ownerName, unit: record.unit, confidence, matchedRecord: record };
    }
  }
  return bestMatch;
}
