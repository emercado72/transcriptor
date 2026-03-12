import {
  Paragraph,
  TextRun,
  AlignmentType,
} from 'docx';
import { createLogger } from '@transcriptor/shared';
import type {
  ParagraphBlock,
  InterventionBlock,
  ListItemBlock,
  VotingQuestionBlock,
  OfficerRoles,
  TemplateConfig,
} from '@transcriptor/shared';
import { FONT, BODY_SIZE, LINE_SPACING, AFTER_PARAGRAPH } from './documentSetup.js';

const logger = createLogger('fannery:renderer');

export function renderParagraph(block: ParagraphBlock, _templateConfig: TemplateConfig): Paragraph {
  // Parse inline **bold** markdown into separate TextRuns
  const textRuns = parseInlineBold(block.text, block.bold);

  return new Paragraph({
    children: textRuns,
    alignment: AlignmentType.JUSTIFIED,
    spacing: {
      after: AFTER_PARAGRAPH,
      line: LINE_SPACING,
    },
  });
}

/**
 * Parse inline **bold** markdown within text into separate TextRuns.
 * If the entire block is already bold, all runs are bold.
 */
function parseInlineBold(
  text: string,
  blockBold: boolean,
): TextRun[] {
  if (blockBold || !text.includes('**')) {
    return [
      new TextRun({ text, bold: blockBold, size: BODY_SIZE, font: FONT }),
    ];
  }

  const runs: TextRun[] = [];
  const parts = text.split(/\*\*/);
  // parts alternate: normal, bold, normal, bold, ...
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue;
    runs.push(
      new TextRun({
        text: parts[i],
        bold: i % 2 === 1, // odd indices are inside ** **
        size: BODY_SIZE,
        font: FONT,
      }),
    );
  }
  return runs.length > 0
    ? runs
    : [new TextRun({ text, size: BODY_SIZE, font: FONT })];
}

export function renderIntervention(block: InterventionBlock, _templateConfig: TemplateConfig): Paragraph {
  const speakerText = block.unit
    ? `${block.speaker} (Unidad ${block.unit}): `
    : `${block.speaker}: `;

  return new Paragraph({
    children: [
      new TextRun({
        text: speakerText,
        bold: true,
        size: BODY_SIZE,
        font: FONT,
      }),
      ...parseInlineBold(block.text, false),
    ],
    alignment: AlignmentType.JUSTIFIED,
    spacing: {
      after: AFTER_PARAGRAPH,
      line: LINE_SPACING,
    },
  });
}

/**
 * Render a list item. Uses Word numbering when a reference is provided,
 * otherwise falls back to indented paragraph (legacy).
 */
export function renderListItem(
  block: ListItemBlock,
  _templateConfig: TemplateConfig,
  numberingRef: string | null,
): Paragraph {
  const paragraphOptions: Record<string, unknown> = {
    children: parseInlineBold(block.text, block.bold),
    spacing: {
      after: AFTER_PARAGRAPH,
      line: LINE_SPACING,
    },
    alignment: AlignmentType.JUSTIFIED,
  };

  if (numberingRef) {
    paragraphOptions.numbering = { reference: numberingRef, level: 0 };
  } else {
    paragraphOptions.indent = { left: 720, hanging: 360 };
  }

  return new Paragraph(paragraphOptions as any);
}

export function renderVotingQuestion(block: VotingQuestionBlock, _templateConfig: TemplateConfig): Paragraph {
  // If no question text available, show placeholder in red
  if (!block.text || block.text.trim() === '') {
    return new Paragraph({
      children: [
        new TextRun({
          text: `[Insertar Texto Pregunta ${block.questionId}]`,
          bold: true,
          color: 'FF0000',
          size: BODY_SIZE,
          font: FONT,
        }),
      ],
      spacing: { before: 240, after: AFTER_PARAGRAPH, line: LINE_SPACING },
    });
  }

  return new Paragraph({
    children: [
      new TextRun({
        text: `Pregunta ${block.questionId}: `,
        bold: true,
        size: BODY_SIZE,
        font: FONT,
      }),
      new TextRun({
        text: `"${block.text}"`,
        bold: false,
        italics: true,
        size: BODY_SIZE,
        font: FONT,
      }),
    ],
    spacing: {
      before: 240,
      after: AFTER_PARAGRAPH,
      line: LINE_SPACING,
    },
  });
}

export function renderSignatureBlock(officers: OfficerRoles, _templateConfig: TemplateConfig): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  // Spacing
  paragraphs.push(new Paragraph({ children: [], spacing: { before: 600 } }));

  // "En constancia firman:"
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: 'En constancia firman:', bold: true, size: BODY_SIZE, font: FONT })],
      spacing: { after: 400 },
    }),
  );

  // President
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: '________________________', size: BODY_SIZE, font: FONT })],
      spacing: { before: 400 },
    }),
  );
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: officers.president, bold: true, size: BODY_SIZE, font: FONT })],
    }),
  );
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: 'Presidente de la Asamblea', size: BODY_SIZE, font: FONT })],
      spacing: { after: 300 },
    }),
  );

  // Secretary
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: '________________________', size: BODY_SIZE, font: FONT })],
      spacing: { before: 400 },
    }),
  );
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: officers.secretary, bold: true, size: BODY_SIZE, font: FONT })],
    }),
  );
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: 'Secretario(a) de la Asamblea', size: BODY_SIZE, font: FONT })],
      spacing: { after: 300 },
    }),
  );

  // Verificadores
  for (const verificador of officers.verificadores) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: '________________________', size: BODY_SIZE, font: FONT })],
        spacing: { before: 400 },
      }),
    );
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: verificador, bold: true, size: BODY_SIZE, font: FONT })],
      }),
    );
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: 'Verificador(a) de Quórum', size: BODY_SIZE, font: FONT })],
        spacing: { after: 300 },
      }),
    );
  }

  return paragraphs;
}
