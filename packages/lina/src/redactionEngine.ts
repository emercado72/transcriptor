import OpenAI from 'openai';
import { createLogger, getEnvConfig } from '@transcriptor/shared';
import type {
  SectionFile,
  SectionMetadata,
  EventMetadata,
  OfficerRoles,
  GlossaryEntry,
  VotingSummary,
  ClientConfig,
  TemplateConfig,
  ContentBlock,
  SectionStyle,
} from '@transcriptor/shared';
import {
  loadSuperPrompt,
  buildContextBlock,
  buildSectionInstructions,
  buildGlossaryBlock,
  buildExampleBlock,
  buildSpeakerRosterBlock,
  buildVotingQuestionsBlock,
} from './promptBuilder.js';

const logger = createLogger('lina:redaction');

// ── Types ──
export interface RawSection {
  sectionId: string;
  sectionTitle: string;
  sectionStyle: SectionStyle;
  order: number;
  rawText: string;
}

export interface RedactionContext {
  eventMetadata: EventMetadata;
  officers: OfficerRoles;
  glossary: GlossaryEntry[];
  questionList: VotingSummary[];
  clientConfig: ClientConfig;
  /** Reconciled speaker map: globalLabel → resolved name (e.g. "Speaker_03" → "Sandra Forero (Unidad 9-119)") */
  identifiedSpeakers: Record<string, string>;
  /** Full attendance roster from Robinson */
  attendanceRoster: { unit: string; tower: string; ownerName: string; delegateName: string }[];
}

export interface RedactionValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  completeness: number;
}

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    const env = getEnvConfig();
    openaiClient = new OpenAI({
      apiKey: env.openrouterApiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://transcriptor.app',
        'X-Title': 'Transcriptor - Lina',
      },
    });
  }
  return openaiClient;
}

function getModel(): string {
  const env = getEnvConfig();
  return env.linaModel || env.openrouterModel;
}

export async function redactSection(
  rawSection: RawSection,
  _templateConfig: TemplateConfig,
  context: RedactionContext,
): Promise<SectionFile> {
  logger.info(`Redacting section: ${rawSection.sectionId}`);

  const client = getClient();
  const model = getModel();
  logger.info(`Using model: ${model} via OpenRouter`);

  // ── Split large sections into chunks for multi-pass redaction ──
  const MAX_CHARS_PER_CHUNK = 12_000; // ~3K tokens of input per chunk
  const rawLines = rawSection.rawText.split('\n');
  const chunks: string[] = [];
  let currentChunk = '';

  for (const line of rawLines) {
    if (currentChunk.length + line.length + 1 > MAX_CHARS_PER_CHUNK && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = line;
    } else {
      currentChunk += (currentChunk ? '\n' : '') + line;
    }
  }
  if (currentChunk) chunks.push(currentChunk);

  logger.info(`Section ${rawSection.sectionId}: ${rawSection.rawText.length} chars → ${chunks.length} chunk(s)`);

  // ── Redact each chunk ──
  const redactedParts: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkSection: RawSection = {
      ...rawSection,
      rawText: chunk,
    };

    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    const chunkContext = chunks.length > 1
      ? `\n\n## Nota de continuidad\nEsta es la parte ${i + 1} de ${chunks.length} de esta sección.${
          isFirst ? ' Comienza la sección.' : ' Continúa la sección anterior, NO repitas encabezados ni preámbulos.'
        }${isLast ? ' Es la parte final.' : ' Hay más partes después.'}\nRedacta SOLO el contenido de esta parte. No resumas — redacta TODA la información presente en esta parte.`
      : '';

    const prompt = buildSectionPrompt(chunkSection, _templateConfig, context) + chunkContext;

    logger.info(`Redacting chunk ${i + 1}/${chunks.length} (${chunk.length} chars)`);

    const response = await client.chat.completions.create({
      model,
      max_tokens: 16_384,
      messages: [
        { role: 'user', content: prompt },
      ],
    });

    const text = response.choices[0]?.message?.content || '';
    const finishReason = response.choices[0]?.finish_reason;
    logger.info(`Chunk ${i + 1}/${chunks.length}: ${text.length} chars, finish_reason=${finishReason}`);

    if (finishReason === 'length') {
      logger.warn(`Chunk ${i + 1} was truncated by max_tokens — output may be incomplete`);
    }

    redactedParts.push(text);
  }

  const redactedText = redactedParts.join('\n\n');
  logger.info(`Section ${rawSection.sectionId} redacted: ${redactedText.length} chars from ${chunks.length} chunk(s)`);

  const content: ContentBlock[] = [
    {
      type: 'paragraph',
      bold: false,
      text: redactedText,
    },
  ];

  const metadata: SectionMetadata = {
    agent: 'lina',
    timestamp: new Date().toISOString(),
    confidence: 0.85,
    flags: [],
  };

  return {
    sectionId: rawSection.sectionId,
    sectionTitle: rawSection.sectionTitle,
    sectionStyle: rawSection.sectionStyle,
    order: rawSection.order,
    content,
    metadata,
  };
}

export async function redactAllSections(
  rawSections: RawSection[],
  templateConfig: TemplateConfig,
  context: RedactionContext,
): Promise<SectionFile[]> {
  logger.info(`Redacting ${rawSections.length} sections`);

  // Process sections sequentially to respect API rate limits
  const results: SectionFile[] = [];
  for (const section of rawSections) {
    const result = await redactSection(section, templateConfig, context);
    results.push(result);
  }

  return results;
}

export function buildSectionPrompt(
  rawSection: RawSection,
  _templateConfig: TemplateConfig,
  context: RedactionContext,
): string {
  const superPrompt = loadSuperPrompt();
  const contextBlock = buildContextBlock(context.eventMetadata, context.officers);
  const instructions = buildSectionInstructions(rawSection.sectionStyle);
  const glossaryBlock = buildGlossaryBlock(context.glossary);
  const exampleBlock = buildExampleBlock(rawSection.sectionStyle);
  const speakerBlock = buildSpeakerRosterBlock(context.identifiedSpeakers, context.attendanceRoster);
  const votingQuestionsBlock = buildVotingQuestionsBlock(context.questionList);

  return `
${superPrompt}

${contextBlock}
${glossaryBlock}
${speakerBlock}
${votingQuestionsBlock}

## Instrucciones para esta sección
**Sección:** ${rawSection.sectionTitle} (${rawSection.sectionStyle})
**Orden:** ${rawSection.order}

${instructions}
${exampleBlock}

## Texto transcrito (entrada)
${rawSection.rawText}

## Tu tarea
Redacta esta sección en formato de acta formal. Usa los nombres completos y unidades del roster de asistentes para identificar a los propietarios — NO uses [VERIFICAR]. Devuelve SOLO el texto redactado, sin explicaciones adicionales.
`.trim();
}

export function validateRedaction(
  sectionFile: SectionFile,
  rawSection: RawSection,
): RedactionValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check that content is not empty
  if (sectionFile.content.length === 0) {
    errors.push('Redacted section has no content');
  }

  // Check for placeholder markers
  const fullText = sectionFile.content
    .map((block) => ('text' in block ? block.text : ''))
    .join(' ');

  if (fullText.includes('[VERIFICAR]')) {
    warnings.push('Section contains [VERIFICAR] markers that need human review');
  }

  // Check completeness: compare redacted length vs raw length
  const completeness = Math.min(1, fullText.length / (rawSection.rawText.length * 0.5));

  if (completeness < 0.3) {
    warnings.push('Redacted section appears significantly shorter than source');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    completeness: Math.round(completeness * 100) / 100,
  };
}
