import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  Table,
  PageBreak,
} from 'docx';
import { createLogger, uploadFile, initDriveClient, getEnvConfig } from '@transcriptor/shared';
import type {
  SectionFile,
  VotingPackage,
  TemplateConfig,
  EventFolder,
  ContentBlock,
} from '@transcriptor/shared';
import { QuestionType } from '@transcriptor/shared';
import {
  setupPageProperties,
  setupHeader,
  setupFooter,
  buildCoverBlock,
  buildAnnexReference,
  NUMBERING_CONFIG,
  FONT,
  BODY_SIZE,
  LINE_SPACING,
  AFTER_PARAGRAPH,
  type DocxDocument,
  type CoverInfo,
} from './documentSetup.js';
import {
  renderParagraph,
  renderIntervention,
  renderListItem,
  renderVotingQuestion,
  renderSignatureBlock,
} from './contentRenderer.js';
import {
  buildSummaryTable,
  buildElectionTable,
  buildDetailVotingTable,
  buildAnnexSummaryTable,
} from './tableBuilder.js';

const logger = createLogger('fannery:assembler');

// ── Spanish month names for cover date ──
const SPANISH_MONTHS = [
  'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
  'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE',
];

function formatSpanishDate(date: Date): string {
  const month = SPANISH_MONTHS[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  return `${month} ${day} DE ${year}`;
}

export async function assembleActa(
  sectionFiles: SectionFile[],
  votingData: VotingPackage,
  templateConfig: TemplateConfig,
  coverInfo?: CoverInfo,
): Promise<Buffer> {
  logger.info(`Assembling acta with ${sectionFiles.length} sections`);

  const pageProps = setupPageProperties(templateConfig);
  const header = setupHeader(templateConfig);
  const footer = setupFooter(templateConfig);

  const children: (Paragraph | Table)[] = [];

  // ── Cover block (Urapanes 4-line pattern) ──
  if (coverInfo) {
    children.push(...buildCoverBlock(coverInfo));
  }

  // Sort sections by order
  const sorted = [...sectionFiles].sort((a, b) => a.order - b.order);

  // Track whether we're inside the "ORDEN DEL DÍA" section
  let inOrdenDelDia = false;

  for (const section of sorted) {
    const isEncabezado = section.sectionStyle === 'encabezado';
    const isFirma = section.sectionStyle === 'firma';

    // Skip the default "Transcripción Completa" title if we have a cover
    if (coverInfo && section.sectionTitle.toLowerCase().includes('transcripción completa')) {
      // Don't emit the old title — cover block replaces it
      // But still emit content blocks
      for (const block of section.content) {
        const rendered = renderBlock(block, templateConfig, votingData, inOrdenDelDia);

        // Detect ORDEN DEL DÍA section start/end
        if (block.type === 'paragraph' && block.bold) {
          const upper = block.text.toUpperCase().replace(/\*\*/g, '');
          if (upper.includes('ORDEN DEL DÍA') || upper.includes('ORDEN DEL DIA')) {
            inOrdenDelDia = true;
          } else if (inOrdenDelDia) {
            // Any other bold paragraph exits the agenda
            inOrdenDelDia = false;
          }
        }
        // List items stay in agenda mode; non-list items after agenda exit it
        if (inOrdenDelDia && block.type !== 'listItem' && block.type !== 'paragraph') {
          inOrdenDelDia = false;
        }

        children.push(...rendered);
      }
      continue;
    }

    // Section title — rendered as bold justified paragraph (Urapanes style)
    if (!isEncabezado) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: section.sectionTitle.toUpperCase(),
              bold: true,
              size: BODY_SIZE,
              font: FONT,
            }),
          ],
          alignment: AlignmentType.JUSTIFIED,
          spacing: {
            before: isFirma ? 480 : AFTER_PARAGRAPH,
            after: AFTER_PARAGRAPH,
            line: LINE_SPACING,
          },
        }),
      );
    }

    // Add section content
    for (const block of section.content) {
      // Detect ORDEN DEL DÍA section
      if (block.type === 'paragraph' && block.bold) {
        const upper = block.text.toUpperCase().replace(/\*\*/g, '');
        if (upper.includes('ORDEN DEL DÍA') || upper.includes('ORDEN DEL DIA')) {
          inOrdenDelDia = true;
        } else if (inOrdenDelDia) {
          inOrdenDelDia = false;
        }
      }
      if (inOrdenDelDia && block.type !== 'listItem' && block.type !== 'paragraph') {
        inOrdenDelDia = false;
      }

      const rendered = renderBlock(block, templateConfig, votingData, inOrdenDelDia);
      children.push(...rendered);
    }
  }

  // ── Annex section: Detailed voting tables ──
  const annexDetails = votingData.details.filter((d) => d.votes.length > 0);
  if (annexDetails.length > 0) {
    // Page break before annexes
    children.push(
      new Paragraph({
        children: [new PageBreak()],
      }),
    );

    // Annex title
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: 'ANEXOS',
            bold: true,
            size: BODY_SIZE,
            font: FONT,
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: AFTER_PARAGRAPH, line: LINE_SPACING },
      }),
    );

    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: 'ACTAS DETALLADAS DE VOTACIÓN',
            bold: true,
            size: BODY_SIZE,
            font: FONT,
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: AFTER_PARAGRAPH * 2, line: LINE_SPACING },
      }),
    );

    for (const detail of annexDetails) {
      // Find the question text and summary from summaries
      const summary = votingData.summaries.find((s) => s.questionId === detail.questionId);
      const questionText = summary?.questionText || `Pregunta ${detail.questionId}`;

      // Detailed voting table (includes title, question row, headers, data, totals)
      children.push(buildDetailVotingTable(detail, questionText, summary));

      // Spacing between detail and summary tables
      children.push(
        new Paragraph({
          children: [],
          spacing: { after: 200 },
        }),
      );

      // Consolidated results summary table (if summary data available)
      if (summary) {
        children.push(buildAnnexSummaryTable(summary));
      }

      // Spacing after each voting section
      children.push(
        new Paragraph({
          children: [],
          spacing: { after: AFTER_PARAGRAPH * 3 },
        }),
      );
    }

    logger.info(`Annex section added: ${annexDetails.length} detailed voting tables`);
  }

  const doc = new Document({
    numbering: NUMBERING_CONFIG,
    sections: [
      {
        properties: {
          page: pageProps.page,
        },
        headers: { default: header },
        footers: { default: footer },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  logger.info(`Document assembled: ${buffer.length} bytes`);
  return Buffer.from(buffer);
}

function renderBlock(
  block: ContentBlock,
  templateConfig: TemplateConfig,
  votingData: VotingPackage,
  inAgenda: boolean,
): (Paragraph | Table)[] {
  switch (block.type) {
    case 'paragraph':
      return [renderParagraph(block, templateConfig)];
    case 'intervention':
      return [renderIntervention(block, templateConfig)];
    case 'listItem':
      // Use agenda numbering for items inside ORDEN DEL DÍA
      return [renderListItem(block, templateConfig, inAgenda ? 'agenda-numbering' : null)];
    case 'votingQuestion':
      return [renderVotingQuestion(block, templateConfig)];
    case 'votingAnnouncement':
      return [
        new Paragraph({
          children: [
            new TextRun({
              text: block.text,
              bold: block.bold,
              size: BODY_SIZE,
              font: FONT,
            }),
          ],
          alignment: AlignmentType.JUSTIFIED,
          spacing: {
            after: AFTER_PARAGRAPH,
            line: LINE_SPACING,
          },
        }),
      ];
    case 'votingResults': {
      // Find the voting summary for this question
      const summary = votingData.summaries.find((s) => s.questionId === block.questionId);
      if (!summary) {
        // Placeholder when data is missing
        return [
          new Paragraph({
            children: [
              new TextRun({
                text: `[Insertar Tabla Pregunta ${block.questionId}]`,
                bold: true,
                color: 'FF0000',
                size: BODY_SIZE,
                font: FONT,
              }),
            ],
            spacing: { before: 200, after: AFTER_PARAGRAPH },
          }),
        ];
      }

      const elements: (Paragraph | Table)[] = [];

      // Add results heading above the table
      elements.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `Resultados de la votación:`,
              bold: true,
              size: BODY_SIZE,
              font: FONT,
            }),
          ],
          spacing: { before: 200, after: 80 },
        }),
      );

      // Check if this is an election question
      const election = votingData.elections.find((e) => e.questionId === block.questionId);
      if (election && election.candidates.length > 0) {
        elements.push(buildElectionTable(election));
      } else if (summary.questionType === QuestionType.ELECTION) {
        elements.push(buildSummaryTable(summary));
      } else {
        // Standard summary table (Respuestas, Coeficientes%, Asistentes%, Nominal)
        elements.push(buildSummaryTable(summary));
      }

      // ── NO detail voting table in body (Urapanes pattern) ──
      // Instead, add "Ver anexo de acta de votación detallada."
      elements.push(buildAnnexReference());

      // Add spacing after table
      elements.push(
        new Paragraph({
          children: [],
          spacing: { after: AFTER_PARAGRAPH },
        }),
      );

      return elements;
    }
    default:
      return [];
  }
}

export function loadTemplate(templateId: string): TemplateConfig {
  // Default template — Urapanes format
  return {
    templateId,
    fontFamily: 'Calibri',
    fontSize: 11,
    titleFontSize: 11,      // Same as body in Urapanes (no separate title size)
    margins: { top: 0.79, bottom: 0.79, left: 0.79, right: 0.79 },
    headerText: 'Tecnoreuniones.com',
    footerText: 'Página {PAGE} de {TOTAL}',
    lineSpacing: 1.08,      // 259/240
  };
}

export async function writeSectionToDoc(
  _doc: DocxDocument,
  _sectionFile: SectionFile,
  _templateConfig: TemplateConfig,
): Promise<void> {
  // Sections are rendered inline in assembleActa
  logger.info('writeSectionToDoc called — sections rendered in assembleActa');
}

export async function saveToGoogleDrive(
  buffer: Buffer,
  eventFolder: EventFolder,
  fileName: string,
): Promise<string> {
  logger.info(`Saving to Google Drive: ${fileName}`);
  const { writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');

  const tempPath = path.join(tmpdir(), fileName);
  writeFileSync(tempPath, buffer);

  const env = getEnvConfig();
  const drive = initDriveClient({
    clientId: env.googleClientId,
    clientSecret: env.googleClientSecret,
    redirectUri: env.googleRedirectUri,
  });

  const fileId = await uploadFile(drive, tempPath, eventFolder.folderId, fileName);
  logger.info(`Saved to Google Drive: ${fileId}`);
  return fileId;
}

export { formatSpanishDate };
