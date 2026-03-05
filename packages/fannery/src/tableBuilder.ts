import {
  Table,
  TableRow,
  TableCell,
  Paragraph,
  TextRun,
  WidthType,
  AlignmentType,
  BorderStyle,
  VerticalAlign,
  TableLayoutType,
  ShadingType,
} from 'docx';
import { createLogger } from '@transcriptor/shared';
import type {
  VotingSummary,
  ElectionResult,
  VotingDetail,
  AttendanceRecord,
} from '@transcriptor/shared';
import { FONT, BODY_SIZE } from './documentSetup.js';

const logger = createLogger('fannery:tables');

// ── Urapanes table constants ──
const TABLE_FONT_SIZE = BODY_SIZE;       // 11pt for table text (same as body)
const HEADER_FILL = 'D9D9D9';            // Gray header background
const BORDER_COLOR = 'auto';             // Auto border color
const BORDER_SIZE = 4;                   // Border size (quarter-points)
const CELL_MARGIN_LR = 70;              // Left/right cell margin in twips

// Annex table colors — matching sample design
const ANNEX_HEADER_FILL = '1F4E79';      // Dark blue header
const ANNEX_HEADER_FONT_COLOR = 'FFFFFF'; // White text for headers
const ANNEX_ALT_ROW_FILL = 'D6E4F0';     // Light blue alternating row
const ANNEX_TOTALS_FILL = 'D9D9D9';      // Gray for totals row
const ANNEX_QUESTION_FILL = 'E2EFDA';    // Light green for question row

// Summary table column widths (Urapanes proportions, pct units = 1/50 of %)
// Total = 5000 pct = 100%
const SUMMARY_COL_WIDTHS_PCT = [1070, 1453, 1316, 1162]; // Respuestas, Coef%, Asist%, Nominal

// Grid column widths in twips (for 9972 usable width)
const SUMMARY_GRID_COLS = [2132, 2895, 2620, 2315];

// Detail voting table: 6 columns with proportional widths (twips, ~9972 total)
// Unidad, Propietario, Respuesta, Coef.Prop, Coef.Quórum, Nominal
const DETAIL_COL_WIDTHS = [1100, 3200, 1800, 1400, 1400, 1072];

// Smaller font for dense 7-column annex/detail tables (8pt = 16 half-points)
const DETAIL_FONT_SIZE = 16;

/** Standard cell borders (Urapanes: all 4 sides, single, size 4, auto) */
function cellBorders() {
  return {
    top: { style: BorderStyle.SINGLE, size: BORDER_SIZE, space: 0, color: BORDER_COLOR },
    bottom: { style: BorderStyle.SINGLE, size: BORDER_SIZE, space: 0, color: BORDER_COLOR },
    left: { style: BorderStyle.SINGLE, size: BORDER_SIZE, space: 0, color: BORDER_COLOR },
    right: { style: BorderStyle.SINGLE, size: BORDER_SIZE, space: 0, color: BORDER_COLOR },
  };
}

/** Paragraph inside a table cell — single line spacing, no after */
function cellParagraph(text: string, bold: boolean): Paragraph {
  return new Paragraph({
    spacing: { after: 0, line: 240 },  // lineRule=auto, single spacing
    children: [
      new TextRun({
        text,
        bold,
        size: TABLE_FONT_SIZE,
        font: FONT,
        color: '000000',
      }),
    ],
  });
}

/** Paragraph for dense detail/annex tables — smaller font for 7-column fit */
function detailCellParagraph(text: string, bold: boolean, centered = false): Paragraph {
  return new Paragraph({
    spacing: { after: 0, line: 240 },
    alignment: centered ? AlignmentType.CENTER : undefined,
    children: [
      new TextRun({
        text,
        bold,
        size: DETAIL_FONT_SIZE,
        font: FONT,
        color: '000000',
      }),
    ],
  });
}

// ── Summary table (Urapanes format) ──

export function buildSummaryTable(votingSummary: VotingSummary): Table {
  logger.info(`Building summary table for question: ${votingSummary.questionId}`);

  const headers = ['Respuestas', 'Coeficientes %', 'Asistentes %', 'Nominal'];

  const headerRow = new TableRow({
    tableHeader: true,
    height: { value: 300, rule: 'atLeast' as any },
    children: headers.map((text, i) =>
      new TableCell({
        width: { size: SUMMARY_COL_WIDTHS_PCT[i], type: WidthType.DXA },
        borders: cellBorders(),
        shading: { fill: HEADER_FILL, color: HEADER_FILL, type: 'clear' as any },
        verticalAlign: VerticalAlign.BOTTOM,
        children: [cellParagraph(text, true)],
      }),
    ),
  });

  const dataRows = votingSummary.options.map((opt) => {
    const cells = [
      opt.label,
      `${opt.coefficientPct.toFixed(2)}%`,
      `${opt.attendeePct.toFixed(2)}%`,
      String(opt.nominal),
    ];
    return new TableRow({
      height: { value: 300, rule: 'atLeast' as any },
      children: cells.map((text, i) =>
        new TableCell({
          width: { size: SUMMARY_COL_WIDTHS_PCT[i], type: WidthType.DXA },
          borders: cellBorders(),
          verticalAlign: VerticalAlign.BOTTOM,
          children: [cellParagraph(text, false)],
        }),
      ),
    });
  });

  return new Table({
    width: { size: 5000, type: WidthType.PERCENTAGE },
    columnWidths: SUMMARY_GRID_COLS,
    rows: [headerRow, ...dataRows],
  });
}

// ── Election table (same Urapanes styling) ──

export function buildElectionTable(electionResult: ElectionResult): Table {
  logger.info(`Building election table for question: ${electionResult.questionId}`);

  const headers = ['Candidato', 'Unidad', 'Coeficiente Acumulado', 'Nominal Acumulado'];

  const headerRow = new TableRow({
    tableHeader: true,
    height: { value: 300, rule: 'atLeast' as any },
    children: headers.map((text, i) =>
      new TableCell({
        width: { size: SUMMARY_COL_WIDTHS_PCT[i], type: WidthType.DXA },
        borders: cellBorders(),
        shading: { fill: HEADER_FILL, color: HEADER_FILL, type: 'clear' as any },
        verticalAlign: VerticalAlign.BOTTOM,
        children: [cellParagraph(text, true)],
      }),
    ),
  });

  const dataRows = electionResult.candidates.map((c) => {
    const cells = [c.name, c.unit, `${c.coefficientSum.toFixed(4)}`, String(c.nominalSum)];
    return new TableRow({
      height: { value: 300, rule: 'atLeast' as any },
      children: cells.map((text, i) =>
        new TableCell({
          width: { size: SUMMARY_COL_WIDTHS_PCT[i], type: WidthType.DXA },
          borders: cellBorders(),
          verticalAlign: VerticalAlign.BOTTOM,
          children: [cellParagraph(text, false)],
        }),
      ),
    });
  });

  return new Table({
    width: { size: 5000, type: WidthType.PERCENTAGE },
    columnWidths: SUMMARY_GRID_COLS,
    rows: [headerRow, ...dataRows],
  });
}

// ── Detail voting table — redesigned annex format ──
// Matches the "ACTA DE VOTACION" format:
//   Title header → Question row → Column headers → Data rows (zebra) → Totales → Summary table

// Column widths for 7-column detail table: Unidad, Propietario, Respuestas, Coef.Prop, Coef.Quórum, Nominal, Hora
const DETAIL_7COL_WIDTHS = [900, 2800, 1400, 1200, 1200, 900, 1072];
const DETAIL_7COL_TOTAL = DETAIL_7COL_WIDTHS.reduce((a, b) => a + b, 0);

/** Helper: build a cell with annex header styling (dark blue bg, white bold text) */
function annexHeaderCell(text: string, width: number, alignment: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.CENTER): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: cellBorders(),
    shading: { fill: ANNEX_HEADER_FILL, color: ANNEX_HEADER_FILL, type: ShadingType.CLEAR },
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({
        alignment,
        spacing: { after: 0, line: 240 },
        children: [
          new TextRun({
            text,
            bold: true,
            size: DETAIL_FONT_SIZE,
            font: FONT,
            color: ANNEX_HEADER_FONT_COLOR,
          }),
        ],
      }),
    ],
  });
}

/** Helper: build a data cell with explicit shading for zebra striping */
function annexDataCell(text: string, width: number, isAlt: boolean, bold = false, centered = false): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: cellBorders(),
    shading: {
      fill: isAlt ? ANNEX_ALT_ROW_FILL : 'FFFFFF',
      color: isAlt ? ANNEX_ALT_ROW_FILL : 'FFFFFF',
      type: ShadingType.CLEAR,
    },
    verticalAlign: VerticalAlign.CENTER,
    children: [detailCellParagraph(text, bold, centered)],
  });
}

export function buildDetailVotingTable(votingDetail: VotingDetail, questionText: string, summary?: VotingSummary): Table {
  logger.info(`Building detail voting table: ${votingDetail.questionId} (${votingDetail.votes.length} votes)`);

  const rows: TableRow[] = [];

  // ── Row 1: Title header — "ACTA DE VOTACION" (merged across all columns) ──
  rows.push(
    new TableRow({
      height: { value: 400, rule: 'atLeast' as any },
      children: [
        new TableCell({
          width: { size: DETAIL_7COL_TOTAL, type: WidthType.DXA },
          columnSpan: 7,
          borders: cellBorders(),
          shading: { fill: ANNEX_HEADER_FILL, color: ANNEX_HEADER_FILL, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: 0, line: 240 },
              children: [
                new TextRun({
                  text: 'ACTA DE VOTACION',
                  bold: true,
                  size: TABLE_FONT_SIZE,
                  font: FONT,
                  color: ANNEX_HEADER_FONT_COLOR,
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  );

  // ── Row 2: Question text (merged, light green background) ──
  rows.push(
    new TableRow({
      height: { value: 500, rule: 'atLeast' as any },
      children: [
        new TableCell({
          width: { size: DETAIL_7COL_TOTAL, type: WidthType.DXA },
          columnSpan: 7,
          borders: cellBorders(),
          shading: { fill: ANNEX_QUESTION_FILL, color: ANNEX_QUESTION_FILL, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: 0, line: 240 },
              children: [
                new TextRun({
                  text: questionText.toUpperCase(),
                  bold: true,
                  size: DETAIL_FONT_SIZE,
                  font: FONT,
                  color: '000000',
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  );

  // ── Row 3: Column headers ──
  const headers = ['Unidad', 'Propietarios - Apoderados', 'Respuestas', 'Coeficiente\nPropietario', 'Coeficiente\nQuorum', 'Nomina\nl', 'Hora'];
  rows.push(
    new TableRow({
      tableHeader: true,
      height: { value: 400, rule: 'atLeast' as any },
      children: headers.map((text, i) =>
        annexHeaderCell(text, DETAIL_7COL_WIDTHS[i]),
      ),
    }),
  );

  // ── Data rows with alternating colors ──
  let totalCoefProp = 0;
  let totalCoefQuorum = 0;
  let totalNominal = 0;

  for (let rowIdx = 0; rowIdx < votingDetail.votes.length; rowIdx++) {
    const v = votingDetail.votes[rowIdx];
    const isAlt = rowIdx % 2 === 1;

    totalCoefProp += v.coefficientOwner;
    totalCoefQuorum += v.coefficientQuorum;
    totalNominal += v.nominal;

    // Format time: extract HH:MM:SS if available
    const timeStr = v.time ? formatVoteTime(v.time) : '';

    const cells = [
      v.unit,
      v.ownerName + (v.delegateName ? ` - ${v.delegateName}` : ' -'),
      v.response,
      `${v.coefficientOwner.toFixed(3)}%`,
      `${v.coefficientQuorum.toFixed(3)}%`,
      String(v.nominal),
      timeStr,
    ];

    // All columns centered
    rows.push(
      new TableRow({
        height: { value: 260, rule: 'atLeast' as any },
        children: cells.map((text, i) =>
          annexDataCell(text, DETAIL_7COL_WIDTHS[i], isAlt, false, true),
        ),
      }),
    );
  }

  // ── TOTALES footer row ──
  rows.push(
    new TableRow({
      height: { value: 350, rule: 'atLeast' as any },
      children: [
        // Empty cell (Unidad)
        new TableCell({
          width: { size: DETAIL_7COL_WIDTHS[0], type: WidthType.DXA },
          borders: cellBorders(),
          shading: { fill: ANNEX_TOTALS_FILL, color: ANNEX_TOTALS_FILL, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
          children: [detailCellParagraph('', false)],
        }),
        // "TOTALES" label
        new TableCell({
          width: { size: DETAIL_7COL_WIDTHS[1], type: WidthType.DXA },
          borders: cellBorders(),
          shading: { fill: ANNEX_TOTALS_FILL, color: ANNEX_TOTALS_FILL, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
          children: [detailCellParagraph('TOTALES', true)],
        }),
        // Empty (Respuestas)
        new TableCell({
          width: { size: DETAIL_7COL_WIDTHS[2], type: WidthType.DXA },
          borders: cellBorders(),
          shading: { fill: ANNEX_TOTALS_FILL, color: ANNEX_TOTALS_FILL, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
          children: [detailCellParagraph('', false)],
        }),
        // Total Coef Propietario
        new TableCell({
          width: { size: DETAIL_7COL_WIDTHS[3], type: WidthType.DXA },
          borders: cellBorders(),
          shading: { fill: ANNEX_TOTALS_FILL, color: ANNEX_TOTALS_FILL, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
          children: [detailCellParagraph(`${totalCoefProp.toFixed(2)}%`, true, true)],
        }),
        // Total Coef Quorum
        new TableCell({
          width: { size: DETAIL_7COL_WIDTHS[4], type: WidthType.DXA },
          borders: cellBorders(),
          shading: { fill: ANNEX_TOTALS_FILL, color: ANNEX_TOTALS_FILL, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
          children: [detailCellParagraph(`${totalCoefQuorum.toFixed(2)}%`, true, true)],
        }),
        // Total Nominal
        new TableCell({
          width: { size: DETAIL_7COL_WIDTHS[5], type: WidthType.DXA },
          borders: cellBorders(),
          shading: { fill: ANNEX_TOTALS_FILL, color: ANNEX_TOTALS_FILL, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
          children: [detailCellParagraph(String(totalNominal), true, true)],
        }),
        // Empty (Hora)
        new TableCell({
          width: { size: DETAIL_7COL_WIDTHS[6], type: WidthType.DXA },
          borders: cellBorders(),
          shading: { fill: ANNEX_TOTALS_FILL, color: ANNEX_TOTALS_FILL, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
          children: [detailCellParagraph('', false)],
        }),
      ],
    }),
  );

  return new Table({
    width: { size: 5000, type: WidthType.PERCENTAGE },
    columnWidths: DETAIL_7COL_WIDTHS,
    rows,
  });
}

// ── Summary results table (appended after detail table in annex) ──
// Shows consolidated results: Respuestas | Según Coeficientes | Según Asistentes | Según Nominal

export function buildAnnexSummaryTable(votingSummary: VotingSummary): Table {
  logger.info(`Building annex summary table for question: ${votingSummary.questionId}`);

  const summaryHeaders = ['Respuestas', 'Según Coeficientes', 'Según Asistentes', 'Según Nominal'];

  const rows: TableRow[] = [];

  // Header row
  rows.push(
    new TableRow({
      tableHeader: true,
      height: { value: 300, rule: 'atLeast' as any },
      children: summaryHeaders.map((text, i) =>
        new TableCell({
          width: { size: SUMMARY_COL_WIDTHS_PCT[i], type: WidthType.DXA },
          borders: cellBorders(),
          shading: { fill: ANNEX_HEADER_FILL, color: ANNEX_HEADER_FILL, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: 0, line: 240 },
              children: [
                new TextRun({
                  text,
                  bold: true,
                  size: DETAIL_FONT_SIZE,
                  font: FONT,
                  color: ANNEX_HEADER_FONT_COLOR,
                }),
              ],
            }),
          ],
        }),
      ),
    }),
  );

  // Data rows with alternating colors
  for (let i = 0; i < votingSummary.options.length; i++) {
    const opt = votingSummary.options[i];
    const isAlt = i % 2 === 1;
    const cells = [
      opt.label,
      `${opt.coefficientPct.toFixed(2)}%`,
      `${opt.attendeePct.toFixed(2)}%`,
      String(opt.nominal),
    ];
    rows.push(
      new TableRow({
        height: { value: 260, rule: 'atLeast' as any },
        children: cells.map((text, colIdx) =>
          new TableCell({
            width: { size: SUMMARY_COL_WIDTHS_PCT[colIdx], type: WidthType.DXA },
            borders: cellBorders(),
            shading: {
              fill: isAlt ? ANNEX_ALT_ROW_FILL : 'FFFFFF',
              color: isAlt ? ANNEX_ALT_ROW_FILL : 'FFFFFF',
              type: ShadingType.CLEAR,
            },
            verticalAlign: VerticalAlign.CENTER,
            children: [detailCellParagraph(text, false, true)],
          }),
        ),
      }),
    );
  }

  // Total general row
  const totalCoef = votingSummary.options.reduce((sum, o) => sum + o.coefficientPct, 0);
  const totalAtt = votingSummary.options.reduce((sum, o) => sum + o.attendeePct, 0);
  const totalNom = votingSummary.options.reduce((sum, o) => sum + o.nominal, 0);

  rows.push(
    new TableRow({
      height: { value: 300, rule: 'atLeast' as any },
      children: [
        new TableCell({
          width: { size: SUMMARY_COL_WIDTHS_PCT[0], type: WidthType.DXA },
          borders: cellBorders(),
          shading: { fill: ANNEX_TOTALS_FILL, color: ANNEX_TOTALS_FILL, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
          children: [detailCellParagraph('Total general', true)],
        }),
        new TableCell({
          width: { size: SUMMARY_COL_WIDTHS_PCT[1], type: WidthType.DXA },
          borders: cellBorders(),
          shading: { fill: ANNEX_TOTALS_FILL, color: ANNEX_TOTALS_FILL, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
          children: [detailCellParagraph(`${totalCoef.toFixed(2)}%`, true, true)],
        }),
        new TableCell({
          width: { size: SUMMARY_COL_WIDTHS_PCT[2], type: WidthType.DXA },
          borders: cellBorders(),
          shading: { fill: ANNEX_TOTALS_FILL, color: ANNEX_TOTALS_FILL, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
          children: [detailCellParagraph(`${totalAtt.toFixed(2)}%`, true, true)],
        }),
        new TableCell({
          width: { size: SUMMARY_COL_WIDTHS_PCT[3], type: WidthType.DXA },
          borders: cellBorders(),
          shading: { fill: ANNEX_TOTALS_FILL, color: ANNEX_TOTALS_FILL, type: ShadingType.CLEAR },
          verticalAlign: VerticalAlign.CENTER,
          children: [detailCellParagraph(String(totalNom), true, true)],
        }),
      ],
    }),
  );

  return new Table({
    width: { size: 5000, type: WidthType.PERCENTAGE },
    columnWidths: SUMMARY_GRID_COLS,
    rows,
  });
}

/** Format vote time — extract HH:MM:SS from ISO string or timestamp */
function formatVoteTime(timeStr: string): string {
  try {
    if (!timeStr) return '';
    // Try parsing as ISO date
    const d = new Date(timeStr);
    if (!isNaN(d.getTime())) {
      return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }
    // Already in HH:MM:SS format
    return timeStr;
  } catch {
    return timeStr;
  }
}

// ── Attendance table (same Urapanes styling) ──

export function buildAttendanceTable(attendanceList: AttendanceRecord[]): Table {
  logger.info(`Building attendance table: ${attendanceList.length} records`);

  const headers = ['Torre', 'Unidad', 'Propietario', 'Delegado', 'Coef. Esperado', 'Coef. Presente', 'Estado'];

  const statusLabels: Record<string, string> = {
    presentInRoom: 'Presencial',
    presentVirtual: 'Virtual',
    delegatedProxy: 'Poder',
    absent: 'Ausente',
  };

  const headerRow = new TableRow({
    tableHeader: true,
    height: { value: 300, rule: 'atLeast' as any },
    children: headers.map((text, i) =>
      new TableCell({
        width: { size: DETAIL_COL_WIDTHS[i], type: WidthType.DXA },
        borders: cellBorders(),
        shading: { fill: HEADER_FILL, color: HEADER_FILL, type: 'clear' as any },
        verticalAlign: VerticalAlign.BOTTOM,
        children: [detailCellParagraph(text, true)],
      }),
    ),
  });

  const dataRows = attendanceList.map((a) => {
    const cells = [
      String(a.tower),
      a.unit,
      a.ownerName,
      a.delegateName || '',
      `${a.coefficientExpected.toFixed(4)}`,
      `${a.coefficientPresent.toFixed(4)}`,
      statusLabels[a.status] || a.status,
    ];
    return new TableRow({
      height: { value: 300, rule: 'atLeast' as any },
      children: cells.map((text, i) =>
        new TableCell({
          width: { size: DETAIL_COL_WIDTHS[i], type: WidthType.DXA },
          borders: cellBorders(),
          verticalAlign: VerticalAlign.BOTTOM,
          children: [detailCellParagraph(text, false)],
        }),
      ),
    });
  });

  return new Table({
    width: { size: 5000, type: WidthType.PERCENTAGE },
    columnWidths: DETAIL_COL_WIDTHS,
    rows: [headerRow, ...dataRows],
  });
}
