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
    openaiClient = new OpenAI({ apiKey: env.openaiApiKey });
  }
  return openaiClient;
}

export async function redactSection(
  rawSection: RawSection,
  _templateConfig: TemplateConfig,
  context: RedactionContext,
): Promise<SectionFile> {
  logger.info(`Redacting section: ${rawSection.sectionId}`);

  const prompt = buildSectionPrompt(rawSection, _templateConfig, context);
  const client = getClient();

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const redactedText = response.choices[0]?.message?.content || '';

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

  return `
${superPrompt}

${contextBlock}
${glossaryBlock}

## Instrucciones para esta sección
**Sección:** ${rawSection.sectionTitle} (${rawSection.sectionStyle})
**Orden:** ${rawSection.order}

${instructions}
${exampleBlock}

## Texto transcrito (entrada)
${rawSection.rawText}

## Tu tarea
Redacta esta sección en formato de acta formal. Devuelve SOLO el texto redactado, sin explicaciones adicionales.
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
