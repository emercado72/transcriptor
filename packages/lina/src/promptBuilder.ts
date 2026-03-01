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

const DEFAULT_SUPER_PROMPT = `
Eres un redactor profesional de actas de asamblea de propiedad horizontal en Colombia. 
Tu trabajo es transformar transcripciones de audio en narrativa formal legal conforme a la Ley 675 de 2001.

Reglas:
1. Usa lenguaje formal y jurídico colombiano
2. Mantén la objetividad — no interpretes, narra los hechos
3. Identifica correctamente a los propietarios por nombre y unidad
4. Los resultados de votaciones deben reflejar exactamente los datos de Robinson
5. No inventes información — si algo no está claro, señálalo con [VERIFICAR]
6. Usa el formato y estilo indicado para cada tipo de sección
7. Las cifras de coeficientes y quórum deben ser exactas
8. Respeta la terminología del glosario proporcionado
`.trim();
