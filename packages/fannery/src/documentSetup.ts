import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  Header,
  Footer,
  PageNumber,
  NumberFormat,
  convertInchesToTwip,
  LevelFormat,
  LevelSuffix,
} from 'docx';
import { createLogger } from '@transcriptor/shared';
import type { TemplateConfig } from '@transcriptor/shared';

const logger = createLogger('fannery:setup');

export type DocxDocument = Document;

// ── Urapanes constants (exported for other modules) ──
export const FONT = 'Calibri';
export const BODY_SIZE = 22;        // 11pt in half-points
export const HEADER_FOOTER_SIZE = 18; // 9pt
export const COVER_TITLE_SIZE = 24; // 12pt
export const LINE_SPACING = 259;    // 259/240 = 1.08 (Word modern default)
export const AFTER_PARAGRAPH = 160; // 8pt in twips
export const MARGIN_TWIPS = 1134;   // 2.0 cm all sides

export interface SectionProperties {
  page: {
    size: { width: number; height: number };
    margin: { top: number; bottom: number; left: number; right: number; header: number; footer: number };
  };
}

export interface StyleDefinitions {
  styles: object[];
}

/**
 * Numbering definitions for the document:
 * - 'agenda-numbering': numbered list for Orden del Día items (1. 2. 3. ...)
 * - 'development-numbering': numbered list for development section headings
 * - 'bullet-list': bullet list for notes/references
 */
export const NUMBERING_CONFIG = {
  config: [
    {
      reference: 'agenda-numbering',
      levels: [
        {
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: AlignmentType.LEFT,
          suffix: LevelSuffix.TAB,
          style: {
            paragraph: {
              indent: { left: 720, hanging: 360 },
            },
            run: {
              font: FONT,
              size: BODY_SIZE,
            },
          },
        },
      ],
    },
    {
      reference: 'development-numbering',
      levels: [
        {
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: AlignmentType.LEFT,
          suffix: LevelSuffix.TAB,
          style: {
            paragraph: {
              indent: { left: 720, hanging: 360 },
            },
            run: {
              font: FONT,
              size: BODY_SIZE,
              bold: true,
            },
          },
        },
      ],
    },
    {
      reference: 'bullet-list',
      levels: [
        {
          level: 0,
          format: LevelFormat.BULLET,
          text: '\u2022',
          alignment: AlignmentType.LEFT,
          suffix: LevelSuffix.TAB,
          style: {
            paragraph: {
              indent: { left: 720, hanging: 360 },
            },
            run: {
              font: FONT,
              size: BODY_SIZE,
            },
          },
        },
      ],
    },
  ],
};

export function createDocument(templateConfig: TemplateConfig): DocxDocument {
  logger.info('Creating document');

  return new Document({
    styles: {
      default: {
        document: {
          run: {
            font: FONT,
            size: BODY_SIZE,
          },
          paragraph: {
            spacing: { after: AFTER_PARAGRAPH, line: LINE_SPACING },
            alignment: AlignmentType.JUSTIFIED,
          },
        },
      },
    },
    numbering: NUMBERING_CONFIG,
    sections: [],
  });
}

export function setupPageProperties(_templateConfig: TemplateConfig): SectionProperties {
  return {
    page: {
      size: {
        width: 12240,  // US Letter
        height: 15840,
      },
      margin: {
        top: MARGIN_TWIPS,
        bottom: MARGIN_TWIPS,
        left: MARGIN_TWIPS,
        right: MARGIN_TWIPS,
        header: 709,  // 1.25 cm
        footer: 709,
      },
    },
  };
}

export function setupHeader(_templateConfig: TemplateConfig): Header {
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({
            text: 'Tecnoreuniones.com',
            size: HEADER_FOOTER_SIZE,
            font: FONT,
          }),
        ],
      }),
    ],
  });
}

export function setupFooter(_templateConfig: TemplateConfig): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            children: ['Página ', PageNumber.CURRENT, ' de ', PageNumber.TOTAL_PAGES],
            size: HEADER_FOOTER_SIZE,
            font: FONT,
          }),
        ],
      }),
    ],
  });
}

// ── Cover block builder ──

export interface CoverInfo {
  buildingName: string;   // e.g. "PORTAL VALPARAISO"
  assemblyType: string;   // e.g. "ASAMBLEA GENERAL ORDINARIA DE PROPIETARIOS."
  dateString: string;     // e.g. "MARZO 3 DE 2026"
}

/**
 * Build the 4-line cover block (Urapanes pattern):
 *   CONJUNTO RESIDENCIAL {NAME}                (bold, 12pt, centered, after=0)
 *   ASAMBLEA GENERAL ORDINARIA DE PROPIETARIOS. (bold, 11pt, centered, after=0)
 *   {DATE}                                      (bold, 11pt, centered, after=0)
 *   ACTA DE ASAMBLEA                            (bold, 11pt, centered, after=0)
 *   [empty paragraph]
 */
export function buildCoverBlock(cover: CoverInfo): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  // Line 1: Building name (12pt bold centered)
  paragraphs.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 0, line: LINE_SPACING },
      children: [
        new TextRun({
          text: `CONJUNTO RESIDENCIAL ${cover.buildingName.toUpperCase()}`,
          bold: true,
          size: COVER_TITLE_SIZE,
          font: FONT,
        }),
      ],
    }),
  );

  // Line 2: Assembly type (11pt bold centered)
  paragraphs.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 0, line: LINE_SPACING },
      children: [
        new TextRun({
          text: cover.assemblyType.toUpperCase(),
          bold: true,
          size: BODY_SIZE,
          font: FONT,
        }),
      ],
    }),
  );

  // Line 3: Date (11pt bold centered)
  paragraphs.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 0, line: LINE_SPACING },
      children: [
        new TextRun({
          text: cover.dateString.toUpperCase(),
          bold: true,
          size: BODY_SIZE,
          font: FONT,
        }),
      ],
    }),
  );

  // Line 4: "ACTA DE ASAMBLEA" (11pt bold centered)
  paragraphs.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 0, line: LINE_SPACING },
      children: [
        new TextRun({
          text: 'ACTA DE ASAMBLEA',
          bold: true,
          size: BODY_SIZE,
          font: FONT,
        }),
      ],
    }),
  );

  // Empty separator paragraph
  paragraphs.push(
    new Paragraph({
      children: [],
      spacing: { after: AFTER_PARAGRAPH },
    }),
  );

  return paragraphs;
}

/**
 * Build a "Ver anexo" bullet note (10pt, bullet list).
 */
export function buildAnnexReference(): Paragraph {
  return new Paragraph({
    numbering: { reference: 'bullet-list', level: 0 },
    alignment: AlignmentType.JUSTIFIED,
    spacing: { after: AFTER_PARAGRAPH, line: LINE_SPACING },
    children: [
      new TextRun({
        text: 'Ver anexo de acta de votación detallada.',
        size: 20, // 10pt
        font: FONT,
      }),
    ],
  });
}

export function setupStyles(templateConfig: TemplateConfig): StyleDefinitions {
  return {
    styles: [
      {
        id: 'Title',
        name: 'Title',
        basedOn: 'Normal',
        next: 'Normal',
        run: {
          font: FONT,
          size: COVER_TITLE_SIZE,
          bold: true,
        },
        paragraph: {
          alignment: AlignmentType.CENTER,
          spacing: { after: 0 },
        },
      },
      {
        id: 'SectionTitle',
        name: 'Section Title',
        basedOn: 'Normal',
        run: {
          bold: true,
          size: BODY_SIZE,
          font: FONT,
        },
        paragraph: {
          spacing: { before: 0, after: AFTER_PARAGRAPH },
          alignment: AlignmentType.JUSTIFIED,
        },
      },
    ],
  };
}
