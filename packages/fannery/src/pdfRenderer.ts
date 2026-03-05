/**
 * PDF Renderer — Converts the Markdown acta preview into a styled PDF
 *
 * Uses PDFKit to generate a professional-looking PDF from the markdown text
 * produced by markdownRenderer.ts. Handles:
 *   - Headings (H1–H4) with appropriate sizes and spacing
 *   - Bold / italic inline formatting
 *   - Tables (voting results, elections, attendance detail)
 *   - Lists (bullet and numbered)
 *   - Signature blocks
 *   - Blockquotes (for voting question text)
 *   - Page numbers and margins
 */

import PDFDocument from 'pdfkit';
import { createLogger } from '@transcriptor/shared';

const logger = createLogger('fannery:pdf');

// ── Layout constants ──

const PAGE_MARGIN_LEFT = 60;
const PAGE_MARGIN_RIGHT = 60;
const PAGE_MARGIN_TOP = 60;
const PAGE_MARGIN_BOTTOM = 70;
const PAGE_WIDTH = 595.28;   // A4 width in points
const PAGE_HEIGHT = 841.89;  // A4 height in points
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN_LEFT - PAGE_MARGIN_RIGHT;
const FOOTER_Y = PAGE_HEIGHT - 40;

// ── Font sizes ──
const FONT_H1 = 16;
const FONT_H2 = 14;
const FONT_H3 = 12;
const FONT_BODY = 10.5;
const FONT_TABLE = 7.5;
const FONT_FOOTER = 8;
const LINE_GAP = 4;

// ── Inline segment ──
interface Segment {
  text: string;
  bold: boolean;
  italic: boolean;
}

/**
 * Render markdown text as a PDF buffer.
 */
export async function renderMarkdownAsPdf(markdown: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: PAGE_MARGIN_TOP,
          bottom: PAGE_MARGIN_BOTTOM,
          left: PAGE_MARGIN_LEFT,
          right: PAGE_MARGIN_RIGHT,
        },
        info: {
          Title: 'Acta de Asamblea',
          Author: 'Transcriptor — Fannery',
          Creator: 'PDFKit',
        },
        bufferPages: true,
      });

      const chunks: Uint8Array[] = [];
      doc.on('data', (chunk: Uint8Array) => chunks.push(chunk));
      doc.on('end', () => {
        const buffer = Buffer.concat(chunks);
        logger.info(`PDF rendered: ${buffer.length} bytes`);
        resolve(buffer);
      });
      doc.on('error', reject);

      renderMarkdownLines(doc, markdown);

      // ── Page numbers ──
      const totalPages = doc.bufferedPageRange().count;
      for (let p = 0; p < totalPages; p++) {
        doc.switchToPage(p);
        doc.font('Helvetica')
          .fontSize(FONT_FOOTER)
          .fillColor('#94a3b8')
          .text(
            `Página ${p + 1} de ${totalPages}`,
            PAGE_MARGIN_LEFT,
            FOOTER_Y,
            { width: CONTENT_WIDTH, align: 'center' },
          );
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ══════════════════════════════════════════════════════════════
// Main line-by-line renderer
// ══════════════════════════════════════════════════════════════

/** Detect whether a table block is a detail voting table (Unidad + Propietario headers) */
function isDetailVotingTablePdf(tableLines: string[]): boolean {
  if (tableLines.length === 0) return false;
  const header = tableLines[0].toLowerCase();
  return header.includes('unidad') && (header.includes('propietario') || header.includes('coef'));
}

function renderMarkdownLines(doc: PDFKit.PDFDocument, markdown: string): void {
  const lines = markdown.split('\n');
  let i = 0;
  let inAnnex = false; // Track whether we're past the # ANEXOS heading

  while (i < lines.length) {
    const line = lines[i];

    // ── Heading ### ──
    if (line.startsWith('### ')) {
      // Page break before each question in the annex
      if (inAnnex) {
        doc.addPage();
      } else {
        ensureSpace(doc, 40);
        doc.moveDown(1.0);
      }
      writeParagraph(doc, line.slice(4), {
        fontSize: FONT_H3,
        font: 'Helvetica-Bold',
        color: '#334155',
        x: PAGE_MARGIN_LEFT,
        width: CONTENT_WIDTH,
      });
      doc.moveDown(0.4);
      i++;
      continue;
    }

    // ── Heading ## ──
    if (line.startsWith('## ')) {
      ensureSpace(doc, 50);
      doc.moveDown(1.2);
      // Horizontal rule before heading
      drawHLine(doc, doc.y, 0.5, '#cbd5e1');
      doc.moveDown(0.3);
      writeParagraph(doc, line.slice(3).toUpperCase(), {
        fontSize: FONT_H2,
        font: 'Helvetica-Bold',
        color: '#1e293b',
        x: PAGE_MARGIN_LEFT,
        width: CONTENT_WIDTH,
      });
      doc.moveDown(0.4);
      i++;
      continue;
    }

    // ── Heading # ──
    if (line.startsWith('# ')) {
      if (/ANEXOS/i.test(line)) inAnnex = true;
      ensureSpace(doc, 50);
      doc.moveDown(1);
      writeParagraph(doc, line.slice(2).toUpperCase(), {
        fontSize: FONT_H1,
        font: 'Helvetica-Bold',
        color: '#0f172a',
        x: PAGE_MARGIN_LEFT,
        width: CONTENT_WIDTH,
        align: 'center',
      });
      doc.moveDown(0.6);
      i++;
      continue;
    }

    // ── Horizontal rule ──
    if (line.trim() === '---') {
      ensureSpace(doc, 20);
      doc.moveDown(1);
      drawHLine(doc, doc.y, 1, '#475569');
      doc.moveDown(0.8);
      i++;
      continue;
    }

    // ── Signature underline ──
    if (line.trim().startsWith('______')) {
      ensureSpace(doc, 30);
      doc.moveDown(1.2);
      const yLine = doc.y;
      doc.save()
        .moveTo(PAGE_MARGIN_LEFT, yLine)
        .lineTo(PAGE_MARGIN_LEFT + 200, yLine)
        .lineWidth(0.8)
        .strokeColor('#1e293b')
        .stroke()
        .restore();
      doc.moveDown(0.2);
      i++;
      continue;
    }

    // ── Tables ──
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1]?.includes('---')) {
      const tableLines: string[] = [];
      let j = i;
      while (j < lines.length && lines[j].includes('|')) {
        tableLines.push(lines[j]);
        j++;
      }

      // If this is a detail voting table and we're NOT in the annex, skip it
      if (!inAnnex && isDetailVotingTablePdf(tableLines)) {
        // Render a reference to the annex instead
        doc.moveDown(0.3);
        writeParagraph(doc, 'Ver anexo de acta de votación detallada.', {
          fontSize: FONT_BODY,
          font: 'Helvetica-Oblique',
          color: '#64748b',
          x: PAGE_MARGIN_LEFT,
          width: CONTENT_WIDTH,
        });
        doc.moveDown(0.3);
        i = j;
        continue;
      }

      ensureSpace(doc, 60);
      doc.moveDown(0.4);
      renderTable(doc, tableLines);
      doc.moveDown(0.5);
      i = j;
      continue;
    }

    // ── Blockquotes ──
    if (line.startsWith('> ')) {
      ensureSpace(doc, 25);
      doc.moveDown(0.3);
      const quoteText = line.slice(2);
      const quoteX = PAGE_MARGIN_LEFT + 16;
      const quoteW = CONTENT_WIDTH - 20;
      const beforeY = doc.y;
      writeParagraph(doc, quoteText, {
        fontSize: FONT_BODY,
        font: 'Helvetica',
        color: '#334155',
        x: quoteX,
        width: quoteW,
      });
      const afterY = doc.y;
      // Draw left accent bar over the rendered height
      doc.save()
        .moveTo(PAGE_MARGIN_LEFT + 4, beforeY)
        .lineTo(PAGE_MARGIN_LEFT + 4, afterY)
        .lineWidth(2.5)
        .strokeColor('#6366f1')
        .stroke()
        .restore();
      doc.moveDown(0.3);
      i++;
      continue;
    }

    // ── Bullet list ──
    if (line.startsWith('- ')) {
      ensureSpace(doc, 16);
      const itemText = line.slice(2);
      const bulletIndent = 18;
      // Draw bullet character
      doc.font('Helvetica').fontSize(FONT_BODY).fillColor('#1e293b');
      doc.text('•', PAGE_MARGIN_LEFT, doc.y, { lineBreak: false });
      // Render item text indented
      writeParagraph(doc, itemText, {
        fontSize: FONT_BODY,
        font: 'Helvetica',
        color: '#1e293b',
        x: PAGE_MARGIN_LEFT + bulletIndent,
        width: CONTENT_WIDTH - bulletIndent,
      });
      i++;
      continue;
    }

    // ── Numbered list ──
    const numMatch = line.match(/^(\d+)\.\s(.*)/);
    if (numMatch) {
      ensureSpace(doc, 16);
      const numLabel = `${numMatch[1]}.`;
      const itemText = numMatch[2];
      const numIndent = 22;
      doc.font('Helvetica').fontSize(FONT_BODY).fillColor('#1e293b');
      doc.text(numLabel, PAGE_MARGIN_LEFT, doc.y, { lineBreak: false });
      writeParagraph(doc, itemText, {
        fontSize: FONT_BODY,
        font: 'Helvetica',
        color: '#1e293b',
        x: PAGE_MARGIN_LEFT + numIndent,
        width: CONTENT_WIDTH - numIndent,
      });
      i++;
      continue;
    }

    // ── Empty line ──
    if (line.trim() === '') {
      doc.moveDown(0.3);
      i++;
      continue;
    }

    // ── Skip "Acta detallada de votación" headings in the body — they belong in the annex ──
    if (!inAnnex && /^\*\*Acta detallada|\*\*ACTA DE VOTACION/i.test(line.trim())) {
      i++;
      continue;
    }

    // ── Regular paragraph ──
    ensureSpace(doc, 16);
    writeParagraph(doc, line, {
      fontSize: FONT_BODY,
      font: 'Helvetica',
      color: '#1e293b',
      x: PAGE_MARGIN_LEFT,
      width: CONTENT_WIDTH,
      align: 'justify',
    });
    doc.moveDown(0.15);
    i++;
  }
}

// ══════════════════════════════════════════════════════════════
// Rich text paragraph rendering (handles **bold** and *italic*)
// ══════════════════════════════════════════════════════════════

interface ParagraphOptions {
  fontSize: number;
  font: string;       // default font for non-formatted segments
  color: string;
  x: number;
  width: number;
  align?: 'left' | 'center' | 'right' | 'justify';
}

/**
 * Render a paragraph of text at the given position.
 * Handles inline **bold** and *italic* formatting correctly
 * by splitting the text into segments and rendering them
 * as a single text flow using doc.text with { continued }.
 *
 * KEY FIX: Always pass the explicit (x, y, { width }) on the
 * FIRST segment to anchor the text box, then subsequent segments
 * only use { continued: true } without re-specifying width so
 * PDFKit doesn't re-constrain the column.
 */
function writeParagraph(doc: PDFKit.PDFDocument, text: string, opts: ParagraphOptions): void {
  const segments = parseInlineFormatting(text);
  const defaultBold = opts.font.includes('Bold');

  doc.fillColor(opts.color);

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const isFirst = s === 0;
    const isLast = s === segments.length - 1;

    // Choose font
    if (seg.bold || defaultBold) {
      doc.font('Helvetica-Bold');
    } else if (seg.italic) {
      doc.font('Helvetica-Oblique');
    } else {
      doc.font('Helvetica');
    }
    doc.fontSize(opts.fontSize);

    if (isFirst && isLast) {
      // Single segment — render directly with full options
      doc.text(seg.text, opts.x, doc.y, {
        width: opts.width,
        lineGap: LINE_GAP,
        align: opts.align || 'left',
      });
    } else if (isFirst) {
      // First of many — anchor position and width, continue
      doc.text(seg.text, opts.x, doc.y, {
        width: opts.width,
        lineGap: LINE_GAP,
        continued: true,
      });
    } else if (isLast) {
      // Last segment — flush, no continued
      doc.text(seg.text, {
        lineGap: LINE_GAP,
        align: opts.align || 'left',
      });
    } else {
      // Middle segment — continue
      doc.text(seg.text, {
        lineGap: LINE_GAP,
        continued: true,
      });
    }
  }
}

// ══════════════════════════════════════════════════════════════
// Inline formatting parser
// ══════════════════════════════════════════════════════════════

function parseInlineFormatting(text: string): Segment[] {
  const segments: Segment[] = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), bold: false, italic: false });
    }
    if (match[2]) {
      segments.push({ text: match[2], bold: true, italic: false });
    } else if (match[3]) {
      segments.push({ text: match[3], bold: false, italic: true });
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), bold: false, italic: false });
  }

  if (segments.length === 0) {
    segments.push({ text, bold: false, italic: false });
  }

  return segments;
}

// ══════════════════════════════════════════════════════════════
// Table rendering
// ══════════════════════════════════════════════════════════════

function renderTable(doc: PDFKit.PDFDocument, tableLines: string[]): void {
  const parseRow = (row: string) =>
    row.split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1).map(c => c.trim());

  const headers = parseRow(tableLines[0]);
  const rows = tableLines.slice(2).map(parseRow);

  const numCols = headers.length;
  if (numCols === 0) return;

  const colWidths = calculateColumnWidths(doc, headers, rows, numCols);
  const tableWidth = colWidths.reduce((s, w) => s + w, 0);
  const tableX = PAGE_MARGIN_LEFT;
  const rowHeight = 18;
  const headerHeight = 22;
  const cellPad = 4;

  // For small tables, ensure the whole table fits on one page
  // For large tables (>20 rows), render with row-by-row page breaks
  const isLargeTable = rows.length > 20;
  if (!isLargeTable) {
    const estimatedHeight = headerHeight + rows.length * rowHeight + 10;
    ensureSpace(doc, estimatedHeight);
  } else {
    // At least fit the header + a few rows on the current page
    ensureSpace(doc, headerHeight + rowHeight * 3);
  }

  // ── Helper: draw the header row at the current doc.y ──
  function drawHeader(): number {
    const curY = doc.y;
    doc.save();
    doc.rect(tableX, curY, tableWidth, headerHeight).fill('#1F4E79');
    let xPos = tableX;
    for (let c = 0; c < numCols; c++) {
      doc.font('Helvetica-Bold')
        .fontSize(FONT_TABLE)
        .fillColor('#FFFFFF')
        .text(strip(headers[c]), xPos + cellPad, curY + 5, {
          width: colWidths[c] - cellPad * 2,
          align: 'center',
          lineBreak: false,
        });
      xPos += colWidths[c];
    }
    doc.restore();
    return curY + headerHeight;
  }

  let curY = drawHeader();

  // ── Data rows ──
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];

    // Page break check: if current row would exceed the page bottom, add a new page and re-draw header
    if (curY + rowHeight > PAGE_HEIGHT - PAGE_MARGIN_BOTTOM) {
      doc.addPage();
      curY = drawHeader();
    }

    // Detect totals row
    const isTotals = row.some(c => /TOTALES|Total general/i.test(strip(c || '')));

    // Row background: totals = gray, alternating = light blue / white
    doc.save();
    if (isTotals) {
      doc.rect(tableX, curY, tableWidth, rowHeight).fill('#D9D9D9');
    } else if (r % 2 === 1) {
      doc.rect(tableX, curY, tableWidth, rowHeight).fill('#D6E4F0');
    } else {
      doc.rect(tableX, curY, tableWidth, rowHeight).fill('#FFFFFF');
    }
    doc.restore();

    // Row border
    doc.save()
      .moveTo(tableX, curY + rowHeight)
      .lineTo(tableX + tableWidth, curY + rowHeight)
      .lineWidth(0.3)
      .strokeColor('#BFBFBF')
      .stroke()
      .restore();

    let xPos = tableX;
    for (let c = 0; c < numCols; c++) {
      const cellText = strip(row[c] || '');
      const cellBold = isTotals || (row[c] || '').includes('**');
      doc.font(cellBold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(FONT_TABLE)
        .fillColor('#1e293b')
        .text(cellText, xPos + cellPad, curY + 4, {
          width: colWidths[c] - cellPad * 2,
          align: 'center',
          lineBreak: false,
        });
      xPos += colWidths[c];
    }
    curY += rowHeight;
  }

  doc.y = curY + 4;
}

function calculateColumnWidths(
  doc: PDFKit.PDFDocument,
  headers: string[],
  rows: string[][],
  numCols: number,
): number[] {
  doc.font('Helvetica').fontSize(FONT_TABLE);

  const maxWidths: number[] = [];
  for (let c = 0; c < numCols; c++) {
    let maxW = doc.widthOfString(strip(headers[c])) + 16;
    for (const row of rows) {
      if (row[c]) {
        const w = doc.widthOfString(strip(row[c])) + 16;
        if (w > maxW) maxW = w;
      }
    }
    maxWidths.push(maxW);
  }

  const totalNatural = maxWidths.reduce((s, w) => s + w, 0);
  if (totalNatural <= CONTENT_WIDTH) {
    const scale = CONTENT_WIDTH / totalNatural;
    return maxWidths.map(w => w * scale);
  }
  const scale = CONTENT_WIDTH / totalNatural;
  return maxWidths.map(w => Math.max(w * scale, 30));
}

function strip(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
}

// ══════════════════════════════════════════════════════════════
// Drawing helpers
// ══════════════════════════════════════════════════════════════

function drawHLine(doc: PDFKit.PDFDocument, y: number, lineWidth: number, color: string): void {
  doc.save()
    .moveTo(PAGE_MARGIN_LEFT, y)
    .lineTo(PAGE_WIDTH - PAGE_MARGIN_RIGHT, y)
    .lineWidth(lineWidth)
    .strokeColor(color)
    .stroke()
    .restore();
}

function ensureSpace(doc: PDFKit.PDFDocument, neededPt: number): void {
  const remaining = PAGE_HEIGHT - PAGE_MARGIN_BOTTOM - doc.y;
  if (remaining < neededPt) {
    doc.addPage();
  }
}
