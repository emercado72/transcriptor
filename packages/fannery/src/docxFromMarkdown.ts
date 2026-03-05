/**
 * docxFromMarkdown — Renders an edited Markdown string back into a DOCX
 *
 * This is the reverse of markdownRenderer.ts. It parses the acta markdown
 * (with headings, bold, lists, tables, interventions) and generates a
 * properly styled DOCX that matches the Urapanes template format.
 *
 * Used by Gloria's review workflow: user edits the markdown → Gloria calls
 * this to re-render the DOCX for the human editor's final touches.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  VerticalAlign,
  Header,
  Footer,
  PageNumber,
  PageBreak,
} from 'docx';
import { createLogger } from '@transcriptor/shared';
import {
  FONT,
  BODY_SIZE,
  HEADER_FOOTER_SIZE,
  LINE_SPACING,
  AFTER_PARAGRAPH,
  MARGIN_TWIPS,
  NUMBERING_CONFIG,
} from './documentSetup.js';

const logger = createLogger('fannery:docxFromMd');

/**
 * Convert an edited acta markdown string into a DOCX buffer.
 * Preserves the same styling used by assembleActa (Calibri 11pt, justified, 1.08 spacing).
 */
export async function renderMarkdownAsDocx(markdown: string): Promise<Buffer> {
  const paragraphs = markdown.split(/\n\n+/);
  const children: (Paragraph | Table)[] = [];
  let inAnnex = false; // Track whether we're past the # ANEXOS heading

  for (const raw of paragraphs) {
    const p = raw.trim();
    if (!p) continue;

    // Detect ANEXOS section start
    if (p.startsWith('# ') && /ANEXOS/i.test(p)) {
      inAnnex = true;
    }

    // Detail voting table detection: tables with 'Unidad' + 'Propietario' in header
    // These should only appear in the annex, not inline in the body
    if (!inAnnex && p.startsWith('|') && isDetailVotingTable(p)) {
      // Replace with italic reference to annex
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: 'Ver anexo de acta de votación detallada.',
              italics: true,
              size: BODY_SIZE,
              font: FONT,
            }),
          ],
          alignment: AlignmentType.JUSTIFIED,
          spacing: { after: AFTER_PARAGRAPH, line: LINE_SPACING },
        }),
      );
      continue;
    }

    // Skip "Acta detallada de votación" bold headings in the body — they belong in the annex
    if (!inAnnex && /^\*\*Acta detallada|^\*\*ACTA DE VOTACION/i.test(p)) {
      continue;
    }

    // Page break before each ### question heading in the annex
    if (inAnnex && p.startsWith('### ')) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }

    const rendered = parseParagraph(p);
    children.push(...rendered);
  }

  const doc = new Document({
    numbering: NUMBERING_CONFIG,
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: {
              top: MARGIN_TWIPS,
              bottom: MARGIN_TWIPS,
              left: MARGIN_TWIPS,
              right: MARGIN_TWIPS,
              header: 709,
              footer: 709,
            },
          },
        },
        headers: {
          default: new Header({
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
          }),
        },
        footers: {
          default: new Footer({
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
          }),
        },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  logger.info(`DOCX rendered from markdown: ${buffer.length} bytes, ${children.length} elements`);
  return Buffer.from(buffer);
}

// ── Parse a single "paragraph block" (double-newline separated) ──

function parseParagraph(text: string): (Paragraph | Table)[] {
  // Horizontal rule → page break (used before ANEXOS)
  if (text === '---') {
    return [new Paragraph({ children: [new PageBreak()] })];
  }

  // H1: # HEADING
  if (text.startsWith('# ')) {
    const heading = text.slice(2).trim();
    return [
      new Paragraph({
        children: parseInlineFormatting(heading, true),
        alignment: AlignmentType.CENTER,
        spacing: { before: 600, after: AFTER_PARAGRAPH * 2, line: LINE_SPACING },
      }),
    ];
  }

  // H2: ## HEADING  (section titles)
  if (text.startsWith('## ')) {
    const heading = text.slice(3).trim();
    return [
      new Paragraph({
        children: parseInlineFormatting(heading.toUpperCase(), true),
        alignment: AlignmentType.JUSTIFIED,
        spacing: { before: 480, after: AFTER_PARAGRAPH, line: LINE_SPACING },
      }),
    ];
  }

  // H3: ### HEADING  (sub-section)
  if (text.startsWith('### ')) {
    const heading = text.slice(4).trim();
    return [
      new Paragraph({
        children: parseInlineFormatting(heading, true),
        alignment: AlignmentType.JUSTIFIED,
        spacing: { before: 400, after: AFTER_PARAGRAPH, line: LINE_SPACING },
      }),
    ];
  }

  // Bold-only line = section heading (matches markdownRenderer pattern)
  if (text.startsWith('**') && text.endsWith('**') && !text.includes('\n')) {
    const inner = text.slice(2, -2);
    return [
      new Paragraph({
        children: [
          new TextRun({
            text: inner,
            bold: true,
            size: BODY_SIZE,
            font: FONT,
          }),
        ],
        alignment: AlignmentType.JUSTIFIED,
        spacing: { before: 360, after: AFTER_PARAGRAPH, line: LINE_SPACING },
      }),
    ];
  }

  // Blockquote: > text  (voting questions)
  if (text.startsWith('> ')) {
    const inner = text.slice(2).trim();
    return [
      new Paragraph({
        children: parseInlineFormatting(inner, false),
        alignment: AlignmentType.JUSTIFIED,
        spacing: { after: AFTER_PARAGRAPH, line: LINE_SPACING },
      }),
    ];
  }

  // List items: - item (may be multiline)
  if (text.startsWith('- ')) {
    const lines = text.split('\n');
    return lines.map((line) => {
      const content = line.replace(/^-\s*/, '').trim();
      const isBold = content.startsWith('**') && content.endsWith('**');
      const clean = isBold ? content.slice(2, -2) : content;
      return new Paragraph({
        children: parseInlineFormatting(clean, isBold),
        numbering: { reference: 'bullet-list', level: 0 },
        spacing: { after: 60, line: LINE_SPACING },
      });
    });
  }

  // Table: | col1 | col2 | ...
  if (text.startsWith('|')) {
    return [parseMarkdownTable(text)];
  }

  // Intervention pattern: **Speaker (Unidad X):** text  OR  **Speaker:** text
  const interventionMatch = text.match(/^\*\*(.+?):\*\*\s*([\s\S]*)$/);
  if (interventionMatch) {
    const speaker = interventionMatch[1];
    const body = interventionMatch[2].trim();
    return [
      new Paragraph({
        children: [
          new TextRun({
            text: `${speaker}: `,
            bold: true,
            size: BODY_SIZE,
            font: FONT,
          }),
          ...parseInlineFormatting(body, false),
        ],
        alignment: AlignmentType.JUSTIFIED,
        spacing: { after: AFTER_PARAGRAPH, line: LINE_SPACING },
      }),
    ];
  }

  // Regular paragraph (may contain inline **bold** and *italic*)
  return [
    new Paragraph({
      children: parseInlineFormatting(text, false),
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: AFTER_PARAGRAPH, line: LINE_SPACING },
    }),
  ];
}

// ── Parse inline **bold** and *italic* into TextRun[] ──

function parseInlineFormatting(text: string, allBold: boolean): TextRun[] {
  if (allBold || !text.includes('*')) {
    return [
      new TextRun({ text, bold: allBold, size: BODY_SIZE, font: FONT }),
    ];
  }

  const runs: TextRun[] = [];

  // Process **bold** first, then *italic* within non-bold segments
  const boldParts = text.split(/\*\*/);
  for (let i = 0; i < boldParts.length; i++) {
    const segment = boldParts[i];
    if (segment === '') continue;

    if (i % 2 === 1) {
      // Inside **bold**
      runs.push(new TextRun({ text: segment, bold: true, size: BODY_SIZE, font: FONT }));
    } else {
      // Outside bold — check for *italic*
      const italicParts = segment.split(/\*/);
      for (let j = 0; j < italicParts.length; j++) {
        if (italicParts[j] === '') continue;
        if (j % 2 === 1) {
          runs.push(new TextRun({ text: italicParts[j], italics: true, size: BODY_SIZE, font: FONT }));
        } else {
          runs.push(new TextRun({ text: italicParts[j], size: BODY_SIZE, font: FONT }));
        }
      }
    }
  }

  return runs.length > 0
    ? runs
    : [new TextRun({ text, size: BODY_SIZE, font: FONT })];
}

// ── Parse a markdown table into a docx Table ──

/**
 * Detect whether a markdown table block is a detail voting table.
 * Detail tables have headers containing 'Unidad' and 'Propietario' (or 'Coef').
 * These should only render in the annex, not inline in the body.
 */
function isDetailVotingTable(tableBlock: string): boolean {
  const firstLine = tableBlock.split('\n')[0] || '';
  const lower = firstLine.toLowerCase();
  return (
    lower.includes('unidad') &&
    (lower.includes('propietario') || lower.includes('coef'))
  );
}

// ── Annex-style table constants for docxFromMarkdown ──
const MD_TABLE_FONT_SIZE = 16;           // 8pt
const MD_TABLE_HEADER_FILL = '1F4E79';   // Dark blue
const MD_TABLE_HEADER_COLOR = 'FFFFFF';  // White
const MD_TABLE_ALT_FILL = 'D6E4F0';      // Light blue zebra
const MD_TABLE_TOTALS_FILL = 'D9D9D9';   // Gray totals

function mdTableBorders() {
  return {
    top: { style: BorderStyle.SINGLE, size: 4, space: 0, color: 'auto' },
    bottom: { style: BorderStyle.SINGLE, size: 4, space: 0, color: 'auto' },
    left: { style: BorderStyle.SINGLE, size: 4, space: 0, color: 'auto' },
    right: { style: BorderStyle.SINGLE, size: 4, space: 0, color: 'auto' },
  };
}

function parseMarkdownTable(tableStr: string): Table {
  const lines = tableStr.split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 2) {
    return new Table({
      rows: [
        new TableRow({
          children: [
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: tableStr, size: BODY_SIZE, font: FONT })] })],
            }),
          ],
        }),
      ],
    });
  }

  const parseRow = (line: string) =>
    line.split('|').slice(1, -1).map((c) => c.trim());

  const headers = parseRow(lines[0]);
  const dataLines = lines.slice(2);
  const colCount = headers.length;
  const colWidth = Math.floor(5000 / colCount); // distribute evenly

  // Header row — dark blue bg, white bold text
  const headerRow = new TableRow({
    tableHeader: true,
    height: { value: 300, rule: 'atLeast' as any },
    children: headers.map(
      (h) =>
        new TableCell({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: 0, line: 240 },
              children: [
                new TextRun({ text: strip(h), bold: true, size: MD_TABLE_FONT_SIZE, font: FONT, color: MD_TABLE_HEADER_COLOR }),
              ],
            }),
          ],
          width: { size: colWidth, type: WidthType.DXA },
          borders: mdTableBorders(),
          shading: { fill: MD_TABLE_HEADER_FILL, color: MD_TABLE_HEADER_FILL, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
        }),
    ),
  });

  // Data rows with zebra striping + centered value columns
  const dataRows = dataLines.map((line, rowIdx) => {
    const cells = parseRow(line);
    const isAlt = rowIdx % 2 === 1;
    // Detect totals row (contains bold TOTALES or Total general)
    const isTotals = cells.some(c => /\*\*TOTAL|Total general/i.test(c));
    const rowFill = isTotals ? MD_TABLE_TOTALS_FILL : (isAlt ? MD_TABLE_ALT_FILL : 'FFFFFF');

    return new TableRow({
      height: { value: 260, rule: 'atLeast' as any },
      children: Array.from({ length: colCount }, (_, idx) => {
        const cellText = cells[idx] || '';
        const hasBold = cellText.includes('**');
        const cleanText = strip(cellText);
        // Center all columns except the first (label column)
        return new TableCell({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: 0, line: 240 },
              children: [
                new TextRun({ text: cleanText, bold: hasBold || isTotals, size: MD_TABLE_FONT_SIZE, font: FONT, color: '000000' }),
              ],
            }),
          ],
          width: { size: colWidth, type: WidthType.DXA },
          borders: mdTableBorders(),
          shading: { fill: rowFill, color: rowFill, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
        });
      }),
    });
  });

  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: 5000, type: WidthType.PERCENTAGE },
  });
}

/** Strip markdown bold/italic markers from text */
function strip(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
}
