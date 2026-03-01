import {
  Table,
  TableRow,
  TableCell,
  Paragraph,
  TextRun,
  WidthType,
  AlignmentType,
  BorderStyle,
} from 'docx';
import { createLogger } from '@transcriptor/shared';
import type {
  VotingSummary,
  ElectionResult,
  VotingDetail,
  AttendanceRecord,
} from '@transcriptor/shared';

const logger = createLogger('fannery:tables');

export interface TableStyle {
  headerBold: boolean;
  fontSize: number;
  borderColor: string;
}

const DEFAULT_STYLE: TableStyle = {
  headerBold: true,
  fontSize: 18, // 9pt
  borderColor: '000000',
};

export function buildSummaryTable(votingSummary: VotingSummary): Table {
  logger.info(`Building summary table for question: ${votingSummary.questionId}`);

  const headerRow = buildTableHeader(
    ['Respuesta', 'Coeficientes %', 'Asistentes %', 'Nominal'],
    DEFAULT_STYLE,
  );

  const dataRows = votingSummary.options.map((opt) =>
    buildTableRow(
      [opt.label, `${opt.coefficientPct.toFixed(2)}%`, `${opt.attendeePct.toFixed(2)}%`, String(opt.nominal)],
      DEFAULT_STYLE,
    ),
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

export function buildElectionTable(electionResult: ElectionResult): Table {
  logger.info(`Building election table for question: ${electionResult.questionId}`);

  const headerRow = buildTableHeader(
    ['Candidato', 'Unidad', 'Coeficiente Acumulado', 'Nominal Acumulado'],
    DEFAULT_STYLE,
  );

  const dataRows = electionResult.candidates.map((c) =>
    buildTableRow(
      [c.name, c.unit, `${c.coefficientSum.toFixed(4)}`, String(c.nominalSum)],
      DEFAULT_STYLE,
    ),
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

export function buildDetailVotingTable(votingDetail: VotingDetail, questionText: string): Table {
  logger.info(`Building detail voting table: ${votingDetail.questionId} (${votingDetail.votes.length} votes)`);

  const headerRow = buildTableHeader(
    ['Unidad', 'Propietario', 'Delegado', 'Respuesta', 'Coef. Propietario', 'Coef. Quórum', 'Nominal'],
    DEFAULT_STYLE,
  );

  const dataRows = votingDetail.votes.map((v) =>
    buildTableRow(
      [
        v.unit,
        v.ownerName,
        v.delegateName,
        v.response,
        `${v.coefficientOwner.toFixed(4)}`,
        `${v.coefficientQuorum.toFixed(4)}`,
        String(v.nominal),
      ],
      DEFAULT_STYLE,
    ),
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

export function buildAttendanceTable(attendanceList: AttendanceRecord[]): Table {
  logger.info(`Building attendance table: ${attendanceList.length} records`);

  const headerRow = buildTableHeader(
    ['Torre', 'Unidad', 'Propietario', 'Delegado', 'Coef. Esperado', 'Coef. Presente', 'Estado'],
    DEFAULT_STYLE,
  );

  const statusLabels: Record<string, string> = {
    presentInRoom: 'Presencial',
    presentVirtual: 'Virtual',
    delegatedProxy: 'Poder',
    absent: 'Ausente',
  };

  const dataRows = attendanceList.map((a) =>
    buildTableRow(
      [
        String(a.tower),
        a.unit,
        a.ownerName,
        a.delegateName || '',
        `${a.coefficientExpected.toFixed(4)}`,
        `${a.coefficientPresent.toFixed(4)}`,
        statusLabels[a.status] || a.status,
      ],
      DEFAULT_STYLE,
    ),
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

export function buildTableHeader(columns: string[], style: TableStyle): TableRow {
  return new TableRow({
    children: columns.map(
      (col) =>
        new TableCell({
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: col,
                  bold: style.headerBold,
                  size: style.fontSize,
                }),
              ],
              alignment: AlignmentType.CENTER,
            }),
          ],
        }),
    ),
  });
}

export function buildTableRow(cells: string[], style: TableStyle): TableRow {
  return new TableRow({
    children: cells.map(
      (cell) =>
        new TableCell({
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: cell,
                  size: style.fontSize,
                }),
              ],
            }),
          ],
        }),
    ),
  });
}
