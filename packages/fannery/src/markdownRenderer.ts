/**
 * Markdown Renderer — Converts SectionFile[] into Markdown text
 *
 * Produces a previewable Markdown representation of the assembled acta,
 * mirroring the structure of the DOCX output.
 */

import { createLogger } from '@transcriptor/shared';
import type {
  SectionFile,
  ContentBlock,
  VotingPackage,
  VotingSummary,
  VotingDetail,
  ElectionResult,
  OfficerRoles,
} from '@transcriptor/shared';

const logger = createLogger('fannery:markdown');

/**
 * Render a complete acta as Markdown from sorted section files.
 */
export function renderActaAsMarkdown(
  sectionFiles: SectionFile[],
  votingData: VotingPackage,
): string {
  const sorted = [...sectionFiles].sort((a, b) => a.order - b.order);
  const lines: string[] = [];

  for (const section of sorted) {
    // Section title as heading
    lines.push(`## ${section.sectionTitle}`);
    lines.push('');

    for (const block of section.content) {
      const rendered = renderBlockToMarkdown(block, votingData);
      if (rendered) {
        lines.push(rendered);
        lines.push('');
      }
    }
  }

  // Signature block from officer roles
  if (votingData.officers) {
    lines.push(renderSignatureBlockMarkdown(votingData.officers));
  }

  // ── Annex section: Detailed voting tables ──
  const annexDetails = votingData.details.filter((d) => d.votes.length > 0);
  if (annexDetails.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('# ANEXOS');
    lines.push('');
    lines.push('## ACTAS DETALLADAS DE VOTACIÓN');
    lines.push('');

    for (const detail of annexDetails) {
      const summary = votingData.summaries.find((s) => s.questionId === detail.questionId);
      const questionText = summary?.questionText || `Pregunta ${detail.questionId}`;

      lines.push(`### Pregunta ${detail.questionId}: ${questionText}`);
      lines.push('');
      lines.push(`Total de votos registrados: ${detail.votes.length}`);
      lines.push('');
      lines.push(renderDetailVotingTableMarkdown(detail, questionText));
      lines.push('');

      // Consolidated summary results table
      if (summary) {
        lines.push(renderAnnexSummaryTableMarkdown(summary));
        lines.push('');
      }
    }

    logger.info(`Annex section added: ${annexDetails.length} detailed voting tables`);
  }

  const md = lines.join('\n').trim() + '\n';
  logger.info(`Rendered Markdown: ${md.length} chars, ${sorted.length} sections`);
  return md;
}

function renderBlockToMarkdown(
  block: ContentBlock,
  votingData: VotingPackage,
): string {
  switch (block.type) {
    case 'paragraph':
      return block.bold ? `**${block.text}**` : block.text;

    case 'intervention': {
      const speaker = block.unit
        ? `${block.speaker} (Unidad ${block.unit})`
        : block.speaker;
      return `**${speaker}:** ${block.text}`;
    }

    case 'listItem':
      return block.bold ? `- **${block.text}**` : `- ${block.text}`;

    case 'votingQuestion':
      return block.text && block.text.trim()
        ? `> **Pregunta ${block.questionId}:** *"${block.text}"*`
        : `> **[Insertar Texto Pregunta ${block.questionId}]**`;

    case 'votingAnnouncement':
      return block.bold ? `**${block.text}**` : `*${block.text}*`;

    case 'votingResults': {
      const summary = votingData.summaries.find(
        (s) => s.questionId === block.questionId,
      );
      if (!summary) {
        return `**[Insertar Tabla Pregunta ${block.questionId}]**`;
      }

      const parts: string[] = [];

      // Check for election results
      const election = votingData.elections.find(
        (e) => e.questionId === block.questionId,
      );
      if (election && election.candidates.length > 0) {
        parts.push(renderElectionTableMarkdown(election, summary.questionText));
      } else {
        parts.push(renderVotingTableMarkdown(summary));
      }

      // Detail tables are rendered in the annex section at the end of the document
      // (not inline within voting results)
      parts.push('');
      parts.push('*Ver anexo de acta de votación detallada.*');

      return parts.join('\n');
    }

    default:
      return '';
  }
}

function renderVotingTableMarkdown(summary: VotingSummary): string {
  const lines: string[] = [];
  lines.push(`**Resultados de la votación: ${summary.questionText}**`);
  lines.push('');
  lines.push('| Respuesta | Coeficientes % | Asistentes % | Nominal |');
  lines.push('|-----------|----------------|--------------|---------|');
  for (const opt of summary.options) {
    lines.push(
      `| ${opt.label} | ${opt.coefficientPct.toFixed(2)}% | ${opt.attendeePct.toFixed(2)}% | ${opt.nominal} |`,
    );
  }
  return lines.join('\n');
}

function renderElectionTableMarkdown(election: ElectionResult, questionText: string): string {
  const lines: string[] = [];
  lines.push(`**Resultados de la elección: ${questionText}**`);
  lines.push('');
  lines.push('| Candidato | Unidad | Coeficiente Acumulado | Nominal Acumulado |');
  lines.push('|-----------|--------|----------------------|-------------------|');
  for (const c of election.candidates) {
    lines.push(
      `| ${c.name} | ${c.unit} | ${c.coefficientSum.toFixed(4)} | ${c.nominalSum} |`,
    );
  }
  return lines.join('\n');
}

function renderDetailVotingTableMarkdown(detail: VotingDetail, questionText: string): string {
  const lines: string[] = [];
  lines.push(`**ACTA DE VOTACION: ${questionText}**`);
  lines.push('');
  lines.push('| Unidad | Propietarios - Apoderados | Respuestas | Coef. Propietario | Coef. Quórum | Nominal | Hora |');
  lines.push('|--------|---------------------------|------------|-------------------|--------------|---------|------|');

  let totalCoefProp = 0;
  let totalCoefQuorum = 0;
  let totalNominal = 0;

  for (const v of detail.votes) {
    const owner = v.ownerName + (v.delegateName ? ` - ${v.delegateName}` : ' -');
    const timeStr = v.time || '';
    totalCoefProp += v.coefficientOwner;
    totalCoefQuorum += v.coefficientQuorum;
    totalNominal += v.nominal;
    lines.push(
      `| ${v.unit} | ${owner} | ${v.response} | ${v.coefficientOwner.toFixed(3)}% | ${v.coefficientQuorum.toFixed(3)}% | ${v.nominal} | ${timeStr} |`,
    );
  }

  // Totals row
  lines.push(
    `| | **TOTALES** | | **${totalCoefProp.toFixed(2)}%** | **${totalCoefQuorum.toFixed(2)}%** | **${totalNominal}** | |`,
  );

  return lines.join('\n');
}

function renderAnnexSummaryTableMarkdown(summary: VotingSummary): string {
  const lines: string[] = [];
  lines.push('**Resultados Consolidados:**');
  lines.push('');
  lines.push('| Respuestas | Según Coeficientes | Según Asistentes | Según Nominal |');
  lines.push('|------------|-------------------|-----------------|---------------|');
  for (const opt of summary.options) {
    lines.push(
      `| ${opt.label} | ${opt.coefficientPct.toFixed(2)}% | ${opt.attendeePct.toFixed(2)}% | ${opt.nominal} |`,
    );
  }
  const totalCoef = summary.options.reduce((s, o) => s + o.coefficientPct, 0);
  const totalAtt = summary.options.reduce((s, o) => s + o.attendeePct, 0);
  const totalNom = summary.options.reduce((s, o) => s + o.nominal, 0);
  lines.push(
    `| **Total general** | **${totalCoef.toFixed(2)}%** | **${totalAtt.toFixed(2)}%** | **${totalNom}** |`,
  );
  return lines.join('\n');
}

function renderSignatureBlockMarkdown(officers: OfficerRoles): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('');
  lines.push('**En constancia firman:**');
  lines.push('');
  lines.push('________________________');
  lines.push(`**${officers.president}**`);
  lines.push('Presidente de la Asamblea');
  lines.push('');
  lines.push('________________________');
  lines.push(`**${officers.secretary}**`);
  lines.push('Secretario(a) de la Asamblea');

  for (const verificador of officers.verificadores) {
    lines.push('');
    lines.push('________________________');
    lines.push(`**${verificador}**`);
    lines.push('Verificador(a) de Quórum');
  }

  lines.push('');
  return lines.join('\n');
}
