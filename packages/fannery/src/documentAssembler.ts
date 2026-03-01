import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
} from 'docx';
import { createLogger, uploadFile, initDriveClient, getEnvConfig } from '@transcriptor/shared';
import type {
  SectionFile,
  VotingPackage,
  TemplateConfig,
  EventFolder,
  ContentBlock,
} from '@transcriptor/shared';
import {
  createDocument,
  setupPageProperties,
  setupHeader,
  setupFooter,
  type DocxDocument,
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
} from './tableBuilder.js';

const logger = createLogger('fannery:assembler');

export async function assembleActa(
  sectionFiles: SectionFile[],
  votingData: VotingPackage,
  templateConfig: TemplateConfig,
): Promise<Buffer> {
  logger.info(`Assembling acta with ${sectionFiles.length} sections`);

  const pageProps = setupPageProperties(templateConfig);
  const header = setupHeader(templateConfig);
  const footer = setupFooter(templateConfig);

  const children: Paragraph[] = [];

  // Sort sections by order
  const sorted = [...sectionFiles].sort((a, b) => a.order - b.order);

  for (const section of sorted) {
    // Add section title
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: section.sectionTitle,
            bold: true,
            size: (templateConfig.titleFontSize || 14) * 2,
          }),
        ],
        alignment: AlignmentType.LEFT,
        spacing: { before: 240, after: 120 },
      }),
    );

    // Add section content
    for (const block of section.content) {
      const rendered = renderBlock(block, templateConfig, votingData);
      children.push(...rendered);
    }
  }

  const doc = new Document({
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
): Paragraph[] {
  switch (block.type) {
    case 'paragraph':
      return [renderParagraph(block, templateConfig)];
    case 'intervention':
      return [renderIntervention(block, templateConfig)];
    case 'listItem':
      return [renderListItem(block, templateConfig, null)];
    case 'votingQuestion':
      return [renderVotingQuestion(block, templateConfig)];
    case 'votingAnnouncement':
      return [
        new Paragraph({
          children: [new TextRun({ text: block.text, bold: block.bold })],
          spacing: { after: 120 },
        }),
      ];
    case 'votingResults': {
      // Find the voting summary for this question
      const summary = votingData.summaries.find((s) => s.questionId === block.questionId);
      if (summary) {
        // Tables need to be added at the section level, return a placeholder
        return [
          new Paragraph({
            children: [
              new TextRun({
                text: `[Tabla de resultados: ${block.questionId}]`,
                italics: true,
              }),
            ],
          }),
        ];
      }
      return [];
    }
    default:
      return [];
  }
}

export function loadTemplate(templateId: string): TemplateConfig {
  // Default template
  return {
    templateId,
    fontFamily: 'Arial',
    fontSize: 11,
    titleFontSize: 14,
    margins: { top: 1, bottom: 1, left: 1.25, right: 1.25 },
    headerText: 'Tecnoreuniones.com',
    footerText: 'Página {PAGE} de {TOTAL}',
    lineSpacing: 1.15,
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
