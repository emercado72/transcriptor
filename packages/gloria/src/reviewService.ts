/**
 * Review Service — LLM-powered inconsistency detection for assembled documents.
 *
 * Sends the assembled Markdown to an LLM (via OpenRouter / Claude) and receives
 * a structured list of inconsistencies, errors, and suggestions.
 *
 * Also manages review sessions in Redis.
 */

import fs from 'node:fs';
import OpenAI from 'openai';
import { createLogger, getEnvConfig, getRedisClient } from '@transcriptor/shared';
import type {
  ReviewItem,
  ReviewItemId,
  ReviewItemStatus,
  ReviewSession,
} from '@transcriptor/shared';
import { randomUUID } from 'node:crypto';

const logger = createLogger('gloria:review');

const REVIEW_SESSION_PREFIX = 'gloria:review:';

// ── In-memory review sessions ──
const reviewSessions = new Map<string, ReviewSession>();

// ── OpenRouter LLM Client ──

let llmClient: OpenAI | null = null;

function getLLMClient(): OpenAI {
  if (!llmClient) {
    const env = getEnvConfig();
    if (!env.openrouterApiKey) {
      throw new Error('OPENROUTER_API_KEY is not set in environment');
    }
    llmClient = new OpenAI({
      apiKey: env.openrouterApiKey,
      baseURL: 'https://openrouter.ai/api/v1',
    });
  }
  return llmClient;
}

function getLLMModel(): string {
  return getEnvConfig().openrouterModel || 'anthropic/claude-sonnet-4';
}

// ── System prompt for inconsistency detection ──

const REVIEW_SYSTEM_PROMPT = `Eres un revisor experto de actas de asamblea de propiedad horizontal en Colombia. Tu trabajo es analizar el acta transcrita y detectar inconsistencias, errores y problemas.

TIPOS DE PROBLEMAS A DETECTAR:

1. **factual_inconsistency**: Datos que se contradicen dentro del mismo documento (ej: un monto mencionado con valores distintos en diferentes partes).
2. **numerical_error**: Errores numéricos, porcentajes que no suman 100%, cifras incongruentes.
3. **speaker_attribution**: Intervenciones atribuidas al orador incorrecto o cambios de orador confusos.
4. **missing_content**: Secciones que parecen incompletas o con información faltante.
5. **formatting_issue**: Problemas de formato, estructura o presentación.
6. **legal_reference**: Referencias legales potencialmente incorrectas (artículos de ley, normativa).
7. **voting_mismatch**: Discrepancias en resultados de votación (porcentajes vs nominales, quórum).
8. **grammar_style**: Errores gramaticales o de estilo significativos que afectan la claridad.
9. **other**: Cualquier otro problema relevante.

SEVERIDAD:
- **critical**: Errores que podrían tener consecuencias legales o cambiar el sentido de las decisiones.
- **warning**: Problemas que podrían confundir pero no invalidan el documento.
- **info**: Sugerencias de mejora menores.

RESPONDE EN FORMATO JSON con un arreglo de objetos. Cada objeto debe tener:
{
  "type": "<tipo del problema>",
  "severity": "<critical|warning|info>",
  "title": "<título corto del problema>",
  "description": "<descripción detallada del problema encontrado>",
  "suggestedFix": "<corrección sugerida con el texto corregido>",
  "sectionHeading": "<encabezado de sección donde se encontró>",
  "contextSnippet": "<fragmento del texto donde está el problema, máximo 200 caracteres>"
}

IMPORTANTE:
- No inventes problemas. Solo reporta inconsistencias reales y verificables dentro del documento.
- El contextSnippet debe ser texto literal del documento para poder localizarlo.
- Enfócate en problemas substantivos, no en preferencias estilísticas menores.
- Revisa especialmente los resultados de votación y cifras financieras.
- Presta atención a la coherencia entre las intervenciones de los oradores.
- Verifica que los porcentajes de votación sean consistentes con los nominales reportados.

Responde ÚNICAMENTE con el JSON array, sin texto adicional ni bloques de código.`;

// ── Analysis function ──

export async function analyzeDocument(
  jobId: string,
  markdownContent: string,
): Promise<ReviewSession> {
  logger.info(`Starting LLM review analysis for job ${jobId} (${markdownContent.length} chars)`);

  // Create session
  // Resolve clientName from pipeline state for display in the dashboard
  let clientName: string | undefined;
  try {
    const supervisor = await import('@transcriptor/supervisor');
    const pipelineJob = await supervisor.loadState(jobId);
    clientName = pipelineJob?.clientName;
  } catch { /* not critical */ }

  const session: ReviewSession = {
    jobId,
    clientName,
    status: 'analyzing',
    items: [],
    markdownContent,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    stats: { total: 0, pending: 0, reviewing: 0, fixed: 0, dismissed: 0, critical: 0, warning: 0, info: 0 },
  };

  reviewSessions.set(jobId, session);
  await persistSession(session);

  try {
    const client = getLLMClient();
    const model = getLLMModel();

    // The document might be very long; we send it in the user message
    // Claude Sonnet can handle 200k tokens so this should be fine
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: REVIEW_SYSTEM_PROMPT },
        { role: 'user', content: `Analiza el siguiente acta de asamblea y detecta todas las inconsistencias:\n\n${markdownContent}` },
      ],
      temperature: 0.2,
      max_tokens: 8192,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty LLM response');
    }

    // Parse the JSON response
    const rawItems = parseReviewResponse(content);
    const now = new Date().toISOString();

    // Build ReviewItem objects with paragraph indices
    const items: ReviewItem[] = rawItems.map((raw) => {
      const paragraphIndex = findParagraphIndex(markdownContent, raw.contextSnippet);
      return {
        id: randomUUID(),
        jobId,
        type: raw.type,
        severity: raw.severity,
        status: 'pending' as ReviewItemStatus,
        title: raw.title,
        description: raw.description,
        suggestedFix: raw.suggestedFix,
        location: {
          paragraphIndex,
          contextSnippet: raw.contextSnippet,
          sectionHeading: raw.sectionHeading,
        },
        createdAt: now,
        updatedAt: now,
        audioRef: null, // Will be enriched later if transcript data available
      };
    });

    // Auto-detect square bracket placeholders (e.g. [Por identificar], [Insertar Tabla...])
    const bracketItems = detectBracketPlaceholders(markdownContent, items, jobId, now);
    if (bracketItems.length > 0) {
      logger.info(`Found ${bracketItems.length} bracket placeholders to add as review items`);
      items.push(...bracketItems);
    }

    // Enrich audio references from transcript data
    await enrichAudioReferences(jobId, items);

    session.items = items;
    session.status = 'ready';
    session.completedAt = new Date().toISOString();
    session.stats = computeStats(items);

    reviewSessions.set(jobId, session);
    await persistSession(session);

    logger.info(
      `Review analysis complete for ${jobId}: ${items.length} items found ` +
      `(${session.stats.critical} critical, ${session.stats.warning} warning, ${session.stats.info} info)`,
    );

    return session;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Review analysis failed for ${jobId}: ${msg}`);

    session.status = 'failed';
    session.error = msg;
    session.completedAt = new Date().toISOString();

    reviewSessions.set(jobId, session);
    await persistSession(session);

    throw err;
  }
}

// ── Parse LLM JSON response ──

interface RawReviewItem {
  type: ReviewItem['type'];
  severity: ReviewItem['severity'];
  title: string;
  description: string;
  suggestedFix: string;
  sectionHeading: string;
  contextSnippet: string;
}

function parseReviewResponse(content: string): RawReviewItem[] {
  // Strip code fences if present
  let cleaned = content.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      logger.warn('LLM response is not an array, wrapping');
      return [parsed];
    }
    return parsed;
  } catch (err) {
    logger.error(`Failed to parse LLM review response: ${(err as Error).message}`);
    logger.debug(`Raw response: ${content.substring(0, 500)}`);
    return [];
  }
}

// ── Find paragraph index for a context snippet ──

function findParagraphIndex(markdown: string, contextSnippet: string): number {
  if (!contextSnippet || contextSnippet.length < 10) return 0;

  const paragraphs = markdown.split(/\n\n+/);

  // Try exact substring match first
  for (let i = 0; i < paragraphs.length; i++) {
    if (paragraphs[i].includes(contextSnippet)) {
      return i;
    }
  }

  // Try fuzzy: first 50 chars of snippet
  const prefix = contextSnippet.substring(0, 50);
  for (let i = 0; i < paragraphs.length; i++) {
    if (paragraphs[i].includes(prefix)) {
      return i;
    }
  }

  // Try fuzzy: look for significant words
  const words = contextSnippet.split(/\s+/).filter((w: string) => w.length > 4).slice(0, 5);
  if (words.length > 0) {
    let bestIdx = 0;
    let bestScore = 0;
    for (let i = 0; i < paragraphs.length; i++) {
      const score = words.filter((w: string) => paragraphs[i].includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestScore > 0) return bestIdx;
  }

  return 0;
}

// ── Bracket placeholder detection ──

/**
 * Scan the markdown for [square bracket] placeholders that indicate
 * missing or unresolved content. These are auto-added as review items
 * so the reviewer can address them.
 *
 * Excludes markdown link syntax [text](url) and common non-placeholder
 * patterns like [x] checkboxes.
 */
function detectBracketPlaceholders(
  markdown: string,
  existingItems: ReviewItem[],
  jobId: string,
  now: string,
): ReviewItem[] {
  const results: ReviewItem[] = [];
  const paragraphs = markdown.split(/\n\n+/);

  // Pattern: [text] that is NOT followed by ( (which would be a markdown link)
  // Also skip [x] / [ ] checkboxes and very short brackets like [1]
  const bracketRegex = /\[([^\]]{3,})\](?!\()/g;

  // Collect existing snippet texts to avoid duplicates
  const existingSnippets = new Set(
    existingItems.map((it) => it.location.contextSnippet?.toLowerCase() ?? ''),
  );

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
    const para = paragraphs[pIdx];
    let match: RegExpExecArray | null;
    bracketRegex.lastIndex = 0;

    while ((match = bracketRegex.exec(para)) !== null) {
      const bracketContent = match[1].trim();

      // Skip numeric-only references like [1], [23]
      if (/^\d+$/.test(bracketContent)) continue;
      // Skip checkbox syntax
      if (/^[xX ]$/.test(bracketContent)) continue;

      const fullMatch = match[0]; // e.g. "[Por identificar]"

      // Get surrounding context (up to 80 chars each side)
      const start = Math.max(0, match.index - 80);
      const end = Math.min(para.length, match.index + fullMatch.length + 80);
      const contextSnippet = para.substring(start, end).trim();

      // Skip if LLM already flagged something with very similar context
      if (existingSnippets.has(contextSnippet.toLowerCase())) continue;

      // Determine section heading by scanning backwards
      let sectionHeading = '';
      for (let i = pIdx; i >= 0; i--) {
        const headingMatch = paragraphs[i].match(/^#{1,3}\s+(.+)/);
        if (headingMatch) {
          sectionHeading = headingMatch[1].trim();
          break;
        }
      }

      results.push({
        id: randomUUID(),
        jobId,
        type: 'missing_content',
        severity: 'warning',
        status: 'pending' as ReviewItemStatus,
        title: `Placeholder sin resolver: ${fullMatch}`,
        description: `Se encontró el marcador ${fullMatch} que indica contenido pendiente de completar o verificar.`,
        suggestedFix: `Reemplazar ${fullMatch} con la información correcta.`,
        location: {
          paragraphIndex: pIdx,
          contextSnippet,
          sectionHeading,
        },
        createdAt: now,
        updatedAt: now,
        audioRef: null,
      });

      existingSnippets.add(contextSnippet.toLowerCase());
    }
  }

  return results;
}

// ── Audio reference enrichment ──

interface TranscriptSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

/**
 * Load the reconciled transcript segments for a job.
 * These are the diarized segments with speaker labels and timestamps.
 */
export function loadTranscriptSegments(jobId: string): TranscriptSegment[] {
  try {
    const transcriptPath = `${process.cwd()}/data/jobs/${jobId}/transcript/transcript_reconciled.json`;
    if (!fs.existsSync(transcriptPath)) {
      return [];
    }
    const raw = fs.readFileSync(transcriptPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data.segments || !Array.isArray(data.segments)) return [];
    return data.segments as TranscriptSegment[];
  } catch {
    return [];
  }
}

/**
 * Get the list of processed audio files and their approximate time ranges.
 */
export function getAudioFileMap(jobId: string): { file: string; startSec: number; endSec: number }[] {
  try {
    const manifestPath = `${process.cwd()}/data/jobs/${jobId}/processed/manifest.json`;
    if (!fs.existsSync(manifestPath)) return [];
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const files: string[] = manifest.processedFiles || [];
    const totalDuration: number = manifest.totalDuration || 0;
    const chunkDuration = totalDuration / files.length;

    return files.map((f: string, i: number) => ({
      file: f.split('/').pop()!,
      startSec: i * chunkDuration,
      endSec: (i + 1) * chunkDuration,
    }));
  } catch {
    return [];
  }
}

async function enrichAudioReferences(jobId: string, items: ReviewItem[]): Promise<void> {
  try {
    const segments = loadTranscriptSegments(jobId);
    if (segments.length === 0) {
      logger.debug(`No transcript segments for job ${jobId}, skipping audio enrichment`);
      return;
    }

    const audioFiles = getAudioFileMap(jobId);

    // For each review item, match its contextSnippet against transcript segments
    for (const item of items) {
      const snippet = item.location.contextSnippet;
      if (!snippet || snippet.length < 15) continue;

      // Extract significant words from the snippet for fuzzy matching
      const words = snippet.toLowerCase().split(/\s+/).filter((w: string) => w.length > 4).slice(0, 10);
      if (words.length === 0) continue;

      let bestSegment: TranscriptSegment | null = null;
      let bestScore = 0;

      // Score each transcript segment
      for (const seg of segments) {
        const segText = seg.text.toLowerCase();
        const score = words.filter((w: string) => segText.includes(w)).length;
        if (score > bestScore) {
          bestScore = score;
          bestSegment = seg;
        }
      }

      if (bestSegment && bestScore >= 2) {
        // Find which audio chunk file contains this timestamp
        const segFile = audioFiles.find(
          (af) => bestSegment!.start >= af.startSec && bestSegment!.start < af.endSec,
        );

        item.audioRef = {
          segmentFile: segFile?.file || audioFiles[0]?.file || null,
          startTimeSec: bestSegment.start,
          endTimeSec: bestSegment.end,
        };
      }
    }

    const linked = items.filter(i => i.audioRef).length;
    logger.info(`Audio enrichment: ${linked}/${items.length} items linked to audio`);
  } catch (err) {
    logger.warn(`Audio enrichment failed: ${(err as Error).message}`);
  }
}

// ── Session management ──

export function getReviewSession(jobId: string): ReviewSession | undefined {
  return reviewSessions.get(jobId);
}

export function getAllReviewSessions(): ReviewSession[] {
  return Array.from(reviewSessions.values());
}

export function updateItemStatus(
  jobId: string,
  itemId: ReviewItemId,
  status: ReviewItemStatus,
): ReviewItem | null {
  const session = reviewSessions.get(jobId);
  if (!session) return null;

  const item = session.items.find(i => i.id === itemId);
  if (!item) return null;

  item.status = status;
  item.updatedAt = new Date().toISOString();

  // Update session status
  if (session.items.every(i => i.status === 'fixed' || i.status === 'dismissed')) {
    session.status = 'completed';
    session.completedAt = new Date().toISOString();
  } else if (session.items.some(i => i.status === 'reviewing')) {
    session.status = 'in_review';
  }

  session.stats = computeStats(session.items);
  void persistSession(session);

  return item;
}

export async function applyFix(
  jobId: string,
  itemId: ReviewItemId,
): Promise<{ success: boolean; message: string }> {
  const session = reviewSessions.get(jobId);
  if (!session) return { success: false, message: 'Review session not found' };

  const item = session.items.find(i => i.id === itemId);
  if (!item) return { success: false, message: 'Review item not found' };

  if (!item.suggestedFix || !item.location.contextSnippet) {
    return { success: false, message: 'No suggested fix or context available' };
  }

  // Apply the fix to the markdown content
  const oldSnippet = item.location.contextSnippet;
  if (session.markdownContent.includes(oldSnippet)) {
    session.markdownContent = session.markdownContent.replace(oldSnippet, item.suggestedFix);
    item.status = 'fixed';
    item.updatedAt = new Date().toISOString();
    session.stats = computeStats(session.items);
    await persistSession(session);

    logger.info(`Applied fix for item ${itemId} in job ${jobId}`);
    return { success: true, message: 'Fix applied to markdown' };
  }

  // Try partial match
  const words = oldSnippet.split(/\s+/).filter((w: string) => w.length > 3);
  const searchStr = words.slice(0, 6).join('.*?');
  const re = new RegExp(searchStr, 'i');
  const match = session.markdownContent.match(re);
  if (match && match[0]) {
    session.markdownContent = session.markdownContent.replace(match[0], item.suggestedFix);
    item.status = 'fixed';
    item.updatedAt = new Date().toISOString();
    session.stats = computeStats(session.items);
    await persistSession(session);

    logger.info(`Applied fix (fuzzy match) for item ${itemId} in job ${jobId}`);
    return { success: true, message: 'Fix applied (fuzzy match)' };
  }

  return { success: false, message: 'Could not locate the text in the document to apply the fix' };
}

// ── Stats helper ──

function computeStats(items: ReviewItem[]): ReviewSession['stats'] {
  return {
    total: items.length,
    pending: items.filter(i => i.status === 'pending').length,
    reviewing: items.filter(i => i.status === 'reviewing').length,
    fixed: items.filter(i => i.status === 'fixed').length,
    dismissed: items.filter(i => i.status === 'dismissed').length,
    critical: items.filter(i => i.severity === 'critical').length,
    warning: items.filter(i => i.severity === 'warning').length,
    info: items.filter(i => i.severity === 'info').length,
  };
}

// ── Save edited document ──

export async function saveDocument(
  jobId: string,
  newMarkdown: string,
): Promise<{ success: boolean; message: string; savedPath?: string }> {
  const session = reviewSessions.get(jobId);
  if (!session) return { success: false, message: 'Review session not found' };

  try {
    const path = await import('node:path');
    const fsPromises = await import('node:fs/promises');

    // Update in-memory session
    session.markdownContent = newMarkdown;
    session.status = 'in_review';
    await persistSession(session);

    // Persist to disk — overwrite the .md file in output/
    const outputDir = path.join(process.cwd(), 'data', 'jobs', jobId, 'output');
    if (!fs.existsSync(outputDir)) {
      await fsPromises.mkdir(outputDir, { recursive: true });
    }

    const mdFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.md')).sort();
    const mdFileName = mdFiles.length > 0
      ? mdFiles[mdFiles.length - 1]
      : `Acta_${jobId.substring(0, 8)}.md`;
    const mdPath = path.join(outputDir, mdFileName);

    await fsPromises.writeFile(mdPath, newMarkdown, 'utf-8');
    logger.info(`Saved edited document for job ${jobId}: ${mdPath} (${newMarkdown.length} chars)`);

    return { success: true, message: 'Document saved', savedPath: mdPath };
  } catch (err) {
    logger.error('Failed to save document', err as Error);
    return { success: false, message: (err as Error).message };
  }
}

// ── Export document (re-render DOCX + PDF from edited markdown) ──
// Gloria takes the in-memory edited markdown and calls Fannery's standalone
// renderers to produce DOCX and PDF. This does NOT re-run Fannery's pipeline
// (which would read from Lina's redacted/ directory and overwrite edits).

export async function exportDocument(
  jobId: string,
): Promise<{ success: boolean; message: string; docxPath?: string; pdfPath?: string }> {
  const session = reviewSessions.get(jobId);
  if (!session) return { success: false, message: 'Review session not found' };

  try {
    const path = await import('node:path');
    const fsPromises = await import('node:fs/promises');
    const outputDir = path.join(process.cwd(), 'data', 'jobs', jobId, 'output');

    if (!fs.existsSync(outputDir)) {
      await fsPromises.mkdir(outputDir, { recursive: true });
    }

    const markdown = session.markdownContent;

    // Determine base file name from existing .md files
    const mdFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.md')).sort();
    const baseName = mdFiles.length > 0
      ? mdFiles[mdFiles.length - 1].replace(/\.md$/, '')
      : `Acta_${jobId.substring(0, 8)}`;

    // Clean up old .docx and .pdf files to avoid cluttering the output directory
    const oldFiles = fs.readdirSync(outputDir).filter(f => /\.(docx|pdf)$/i.test(f));
    for (const oldFile of oldFiles) {
      try {
        await fsPromises.unlink(path.join(outputDir, oldFile));
        logger.info(`Removed old output file: ${oldFile}`);
      } catch {
        // Ignore removal errors
      }
    }

    // 1. Save the edited markdown to disk (overwrite)
    const mdPath = path.join(outputDir, `${baseName}.md`);
    await fsPromises.writeFile(mdPath, markdown, 'utf-8');
    logger.info(`Markdown saved before export: ${mdPath}`);

    let docxPath: string | undefined;
    let pdfPath: string | undefined;

    // 2. Re-generate DOCX from the edited markdown
    try {
      const { renderMarkdownAsDocx } = await import('@transcriptor/fannery');
      const docxBuffer = await renderMarkdownAsDocx(markdown);
      docxPath = path.join(outputDir, `${baseName}.docx`);
      await fsPromises.writeFile(docxPath, docxBuffer);
      logger.info(`DOCX re-rendered from edited markdown: ${docxPath} (${docxBuffer.length} bytes)`);
    } catch (err) {
      logger.warn(`DOCX render failed: ${(err as Error).message}`);
    }

    // 3. Re-generate PDF from the edited markdown
    try {
      const { renderMarkdownAsPdf } = await import('@transcriptor/fannery');
      const pdfBuffer = await renderMarkdownAsPdf(markdown);
      pdfPath = path.join(outputDir, `${baseName}.pdf`);
      await fsPromises.writeFile(pdfPath, pdfBuffer);
      logger.info(`PDF re-rendered from edited markdown: ${pdfPath} (${pdfBuffer.length} bytes)`);
    } catch (err) {
      logger.warn(`PDF render failed: ${(err as Error).message}`);
    }

    if (!docxPath && !pdfPath) {
      return { success: false, message: 'Both DOCX and PDF rendering failed' };
    }

    return {
      success: true,
      message: docxPath
        ? 'DOCX and PDF regenerated from edited markdown'
        : 'PDF regenerated (DOCX render failed)',
      docxPath,
      pdfPath,
    };
  } catch (err) {
    logger.error('Export failed', err as Error);
    return { success: false, message: (err as Error).message };
  }
}

// ── Redis persistence ──

async function persistSession(session: ReviewSession): Promise<void> {
  try {
    const redis = getRedisClient();
    // Store session without the full markdown content in Redis (too large)
    const toStore = {
      ...session,
      markdownContent: '', // Don't store full markdown in Redis
    };
    await redis.set(
      `${REVIEW_SESSION_PREFIX}${session.jobId}`,
      JSON.stringify(toStore),
      'EX',
      86400 * 7, // 7 days TTL
    );
  } catch (err) {
    logger.warn(`Failed to persist review session: ${(err as Error).message}`);
  }
}

export async function restoreReviewSessions(): Promise<void> {
  try {
    const redis = getRedisClient();
    const keys = await redis.keys(`${REVIEW_SESSION_PREFIX}*`);
    let restored = 0;

    for (const key of keys) {
      try {
        const raw = await redis.get(key);
        if (!raw) continue;
        const session = JSON.parse(raw) as ReviewSession;
        // Load the markdown from disk if session is ready
        if (session.status === 'ready' || session.status === 'in_review') {
          const mdContent = await loadMarkdownFromDisk(session.jobId);
          if (mdContent) session.markdownContent = mdContent;
        }
        reviewSessions.set(session.jobId, session);
        restored++;
      } catch {
        // Skip corrupt entries
      }
    }

    if (restored > 0) {
      logger.info(`Restored ${restored} review session(s) from Redis`);
    }
  } catch (err) {
    logger.warn(`Failed to restore review sessions: ${(err as Error).message}`);
  }
}

async function loadMarkdownFromDisk(jobId: string): Promise<string | null> {
  try {
    const path = await import('node:path');
    const outputDir = path.join(process.cwd(), 'data', 'jobs', jobId, 'output');
    if (!fs.existsSync(outputDir)) return null;

    const mdFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.md')).sort();
    if (mdFiles.length === 0) return null;

    const latest = mdFiles[mdFiles.length - 1];
    return fs.readFileSync(path.join(outputDir, latest), 'utf-8');
  } catch {
    return null;
  }
}
