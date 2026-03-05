import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@transcriptor/shared';
import type {
  EventMetadata,
  OfficerRoles,
  SectionStyle,
  GlossaryEntry,
  TemplateConfig,
} from '@transcriptor/shared';

const logger = createLogger('lina:promptBuilder');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'prompts');

export function loadSuperPrompt(): string {
  const superPromptPath = path.join(PROMPTS_DIR, 'superPrompt.md');
  if (existsSync(superPromptPath)) {
    return readFileSync(superPromptPath, 'utf-8');
  }
  logger.warn('Super prompt not found, using default');
  return DEFAULT_SUPER_PROMPT;
}

export function buildContextBlock(eventMetadata: EventMetadata, officers: OfficerRoles): string {
  return `
## Contexto del Evento
- **Edificio/Conjunto:** ${eventMetadata.buildingName}
- **NIT:** ${eventMetadata.buildingNit}
- **Ciudad:** ${eventMetadata.city}
- **Fecha:** ${eventMetadata.date instanceof Date ? eventMetadata.date.toLocaleDateString('es-CO') : eventMetadata.date}
- **Tipo de Asamblea:** ${eventMetadata.eventType === 'ordinaria' ? 'Asamblea General Ordinaria' : 'Asamblea General Extraordinaria'}
- **Hora de inicio:** ${eventMetadata.startTime}
- **Hora de finalización:** ${eventMetadata.endTime}

## Mesa Directiva
- **Presidente:** ${officers.president}
- **Secretario(a):** ${officers.secretary}
- **Verificadores de Quórum:** ${officers.verificadores.join(', ')}
`.trim();
}

export function buildSectionInstructions(sectionStyle: SectionStyle): string {
  const instructions: Record<string, string> = {
    encabezado: 'Genera el encabezado formal del acta con el nombre del edificio, NIT, tipo de asamblea, fecha, hora y lugar.',
    preambulo: 'Redacta el preámbulo formal indicando convocatoria, verificación de quórum con coeficientes, y declaración de apertura.',
    ordenDelDia: 'Lista los puntos del orden del día tal como fueron leídos y aprobados por la asamblea.',
    paragraphNormal: 'Redacta en narrativa formal legal el contenido de esta sección, usando lenguaje propio de actas de propiedad horizontal colombiana.',
    paragraphBold: 'Redacta el título o encabezado de sección en negrilla.',
    intervention: 'Redacta las intervenciones identificando al propietario por nombre y unidad. Usa el formato: "El(la) señor(a) [NOMBRE], propietario(a) de la unidad [UNIDAD], manifiesta que..."',
    votingQuestion: 'Presenta la pregunta de votación tal como fue formulada, seguida de los resultados obtenidos de Robinson.',
    votingResults: 'Inserta la tabla de resultados de votación con coeficientes, porcentaje de asistentes y nominal.',
    votingAnnouncement: 'Redacta el anuncio de resultados de la votación: "Se aprueba/rechaza con el XX.XX% de coeficientes..."',
    firma: 'Genera el bloque de firmas con los nombres del presidente, secretario(a) y verificadores de quórum.',
  };

  return instructions[sectionStyle] || instructions.paragraphNormal;
}

export function buildGlossaryBlock(glossary: GlossaryEntry[]): string {
  if (glossary.length === 0) return '';

  const entries = glossary
    .map((g) => `- **${g.term}** → ${g.replacement} (${g.context})`)
    .join('\n');

  return `\n## Glosario de Términos\nUsa los siguientes términos correctamente:\n${entries}`;
}

export function buildExampleBlock(sectionStyle: SectionStyle): string {
  const examples: Record<string, string> = {
    encabezado: `ACTA No. ___ DE LA ASAMBLEA GENERAL ORDINARIA DE PROPIETARIOS DEL CONJUNTO RESIDENCIAL [NOMBRE]`,
    preambulo: `En la ciudad de [CIUDAD], a los [DÍA] días del mes de [MES] de [AÑO], siendo las [HORA] horas, se reunieron los propietarios del [NOMBRE DEL EDIFICIO], identificado con NIT [NIT], para celebrar la Asamblea General Ordinaria de Propietarios, previa convocatoria realizada conforme a los estatutos y a la Ley 675 de 2001.`,
    firma: `En constancia firman:\n\n________________________\n[NOMBRE PRESIDENTE]\nPresidente de la Asamblea\n\n________________________\n[NOMBRE SECRETARIO]\nSecretario(a) de la Asamblea`,
  };

  return examples[sectionStyle] ? `\n## Ejemplo de salida:\n${examples[sectionStyle]}` : '';
}

export function buildSpeakerRosterBlock(
  identifiedSpeakers: Record<string, string>,
  attendanceRoster: { unit: string; tower: string; ownerName: string; delegateName: string }[],
): string {
  const parts: string[] = [];

  // Reconciled speaker identities (from diarization + roster matching)
  const speakerEntries = Object.entries(identifiedSpeakers);
  if (speakerEntries.length > 0) {
    parts.push('\n## Hablantes Identificados (del sistema de diarización)');
    parts.push('Estos son los hablantes que el sistema de reconocimiento de voz ha identificado. Usa estos nombres y unidades en la redacción:');
    for (const [label, name] of speakerEntries) {
      parts.push(`- **${label}** → ${name}`);
    }
  }

  // Full attendance roster for context
  if (attendanceRoster.length > 0) {
    parts.push('\n## Roster de Asistentes (datos oficiales de Tecnoreuniones)');
    parts.push('Lista completa de propietarios asistentes a la asamblea. Usa esta información para resolver nombres y unidades en el texto transcrito:');
    for (const entry of attendanceRoster) {
      const delegate = entry.delegateName ? ` (Delegado: ${entry.delegateName})` : '';
      parts.push(`- Torre ${entry.tower}, Unidad ${entry.unit}: **${entry.ownerName}**${delegate}`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : '';
}

const DEFAULT_SUPER_PROMPT = `
Eres un redactor profesional de actas de asamblea de propiedad horizontal en Colombia. 
Tu trabajo es transformar transcripciones de audio en narrativa formal legal conforme a la Ley 675 de 2001.

Reglas:
1. Usa lenguaje formal y jurídico colombiano
2. Mantén la objetividad — no interpretes, narra los hechos
3. Identifica correctamente a los propietarios por nombre completo y unidad usando el roster de asistentes proporcionado
4. Los resultados de votaciones deben reflejar exactamente los datos de Robinson
5. Si un hablante no puede identificarse con certeza desde el roster, usa el nombre parcial del transcript y la unidad más probable — NO uses [VERIFICAR] si hay datos en el roster que coincidan
6. Usa el formato y estilo indicado para cada tipo de sección
7. Las cifras de coeficientes y quórum deben ser exactas
8. Respeta la terminología del glosario proporcionado
9. Los nombres propios de personas SIEMPRE se escriben en MAYÚSCULAS SOSTENIDAS (ejemplo: "El señor JUAN CARLOS PÉREZ GARCÍA, propietario de la unidad 301…"). Esto aplica para todos los nombres, apellidos y nombres compuestos que aparezcan en el acta
`.trim();


/**
 * Build a block listing all Robinson voting questions so Lina can insert
 * explicit markers [VOTACION PREGUNTA N] in the redacted text at the exact
 * point where each vote was announced. Fannery scans for these markers and
 * replaces them with the actual voting tables, eliminating keyword matching.
 */
export function buildVotingQuestionsBlock(questionList: import('@transcriptor/shared').VotingSummary[]): string {
  if (!questionList || questionList.length === 0) return '';

  // Filter warmup questions (Q0 and icebreakers) — same logic as markdownParser
  const votable = questionList.filter((q) => {
    if (Number(q.questionId) === 0) return false;
    const t = q.questionText.toUpperCase();
    if (t.includes('AMANECIO') || t.includes('AMANECIÓ')) return false;
    if (/(?<![A-ZÁÉÍÓÚÑ])PRUEBA(?![A-ZÁÉÍÓÚÑ])/.test(t)) return false;
    if (/(?<![A-ZÁÉÍÓÚÑ])TEST(?![A-ZÁÉÍÓÚÑ])/.test(t)) return false;
    return true;
  });

  if (votable.length === 0) return '';

  const lines = votable
    .map((q) => `- **Pregunta ${q.questionId}:** ${q.questionText.trim()}`)
    .join('\n');

  return `## Preguntas de Votacion Registradas por Robinson
Durante la redaccion, cuando el texto transcrito indique que se realizo una votacion, inserta el marcador exacto en el punto donde se anuncio la apertura o el resultado de esa votacion:

> [VOTACION PREGUNTA N]

Donde N es el numero de la pregunta en la lista. Fannery reemplazara ese marcador con la tabla de resultados automaticamente. Usa tu criterio para mapear la descripcion oral a la pregunta correcta (el texto de la transcripcion parafrasea la pregunta original).

Lista de preguntas en orden cronologico:
${lines}

REGLA CRITICA: Inserta el marcador dentro del parrafo donde se realizo la votacion, NO al final del documento.`.trim();
}
