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

const logger = createLogger('fannery:renderer');

export function renderParagraph(block: ParagraphBlock, _templateConfig: TemplateConfig): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text: block.text,
        bold: block.bold,
      }),
    ],
    spacing: { after: 120 },
  });
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
      }),
      new TextRun({
        text: block.text,
      }),
    ],
    spacing: { after: 120 },
  });
}

export function renderListItem(
  block: ListItemBlock,
  _templateConfig: TemplateConfig,
  _numbering: unknown,
): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text: block.text,
        bold: block.bold,
      }),
    ],
    spacing: { after: 60 },
  });
}

export function renderVotingQuestion(block: VotingQuestionBlock, _templateConfig: TemplateConfig): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text: block.text,
        bold: true,
      }),
    ],
    spacing: { before: 200, after: 120 },
  });
}

export function renderSignatureBlock(officers: OfficerRoles, _templateConfig: TemplateConfig): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  // Spacing
  paragraphs.push(new Paragraph({ children: [], spacing: { before: 600 } }));

  // "En constancia firman:"
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: 'En constancia firman:', bold: true })],
      spacing: { after: 400 },
    }),
  );

  // President
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: '________________________' })],
      spacing: { before: 400 },
    }),
  );
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: officers.president, bold: true })],
    }),
  );
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: 'Presidente de la Asamblea' })],
      spacing: { after: 300 },
    }),
  );

  // Secretary
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: '________________________' })],
      spacing: { before: 400 },
    }),
  );
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: officers.secretary, bold: true })],
    }),
  );
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: 'Secretario(a) de la Asamblea' })],
      spacing: { after: 300 },
    }),
  );

  // Verificadores
  for (const verificador of officers.verificadores) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: '________________________' })],
        spacing: { before: 400 },
      }),
    );
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: verificador, bold: true })],
      }),
    );
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: 'Verificador(a) de Quórum' })],
        spacing: { after: 300 },
      }),
    );
  }

  return paragraphs;
}
