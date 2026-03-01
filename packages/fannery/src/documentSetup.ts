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
} from 'docx';
import { createLogger } from '@transcriptor/shared';
import type { TemplateConfig } from '@transcriptor/shared';

const logger = createLogger('fannery:setup');

export type DocxDocument = Document;

export interface SectionProperties {
  page: {
    size: { width: number; height: number };
    margin: { top: number; bottom: number; left: number; right: number };
  };
}

export interface StyleDefinitions {
  styles: object[];
}

export function createDocument(templateConfig: TemplateConfig): DocxDocument {
  logger.info('Creating document');

  return new Document({
    styles: {
      default: {
        document: {
          run: {
            font: templateConfig.fontFamily || 'Arial',
            size: (templateConfig.fontSize || 11) * 2,
          },
          paragraph: {
            spacing: { line: (templateConfig.lineSpacing || 1.15) * 240 },
          },
        },
      },
    },
    sections: [],
  });
}

export function setupPageProperties(templateConfig: TemplateConfig): SectionProperties {
  const margins = templateConfig.margins || { top: 1, bottom: 1, left: 1.25, right: 1.25 };
  return {
    page: {
      size: {
        width: convertInchesToTwip(8.5),
        height: convertInchesToTwip(11),
      },
      margin: {
        top: convertInchesToTwip(margins.top),
        bottom: convertInchesToTwip(margins.bottom),
        left: convertInchesToTwip(margins.left),
        right: convertInchesToTwip(margins.right),
      },
    },
  };
}

export function setupHeader(templateConfig: TemplateConfig): Header {
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({
            text: templateConfig.headerText || 'Tecnoreuniones.com',
            size: 18, // 9pt
            font: templateConfig.fontFamily || 'Arial',
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
            size: 18, // 9pt
          }),
        ],
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
          font: templateConfig.fontFamily || 'Arial',
          size: (templateConfig.titleFontSize || 14) * 2,
          bold: true,
        },
        paragraph: {
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
        },
      },
      {
        id: 'SectionTitle',
        name: 'Section Title',
        basedOn: 'Normal',
        run: {
          bold: true,
          size: (templateConfig.fontSize || 11) * 2,
        },
        paragraph: {
          spacing: { before: 240, after: 120 },
        },
      },
    ],
  };
}
