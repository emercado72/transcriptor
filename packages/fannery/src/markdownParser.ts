/**
 * Markdown Parser — Parses Lina's redacted markdown text into structured ContentBlocks
 *
 * Lina produces a single paragraph block containing markdown-formatted text.
 * This module:
 *   1. Splits the flat text into lines and groups them into ContentBlock[]
 *   2. Recognizes: bold headings, numbered lists, bullet lists, regular paragraphs
 *   3. Uses ordered keyword matching to map Robinson voting questions to text sections
 *      where the assembly discussed/voted each topic (questions are in chronological order)
 *   4. Injects `votingQuestion` + `votingResults` blocks AFTER each matched section
 *   5. Falls back to appending unmatched questions at the end
 */

import { createLogger } from '@transcriptor/shared';
import type {
  ContentBlock,
  SectionFile,
  VotingPackage,
  VotingSummary,
} from '@transcriptor/shared';

const logger = createLogger('fannery:parser');

/**
 * Enrich section files by parsing their paragraph text into structured blocks
 * and injecting voting data references using ordered keyword matching.
 *
 * Questions from Robinson are already in chronological order (the order they
 * were published during the assembly). The document text follows the same
 * chronological flow, so we scan top-to-bottom and assign each question to
 * the best-matching block that comes after the previous match.
 */
export function enrichSectionsWithVotingData(
  sectionFiles: SectionFile[],
  votingData: VotingPackage,
): SectionFile[] {
  const results: SectionFile[] = [];

  // Global matched set shared across ALL sections — prevents duplicate injection
  const globalMatchedIds = new Set<string>();

  for (const section of sectionFiles) {
    // Only process sections that have a single large paragraph block (Lina's output pattern)
    if (section.content.length === 1 && section.content[0].type === 'paragraph') {
      const rawText = section.content[0].text;
      if (rawText.length > 500) {
        logger.info(`Parsing markdown for section: ${section.sectionId} (${rawText.length} chars)`);
        const parsedBlocks = parseMarkdownToBlocks(rawText, votingData, globalMatchedIds);
        logger.info(`Parsed into ${parsedBlocks.length} content blocks`);
        results.push({ ...section, content: parsedBlocks });
        continue;
      }
    }
    results.push(section);
  }

  // Append unmatched questions ONCE at the very end of the document
  const votableQuestions = votingData.summaries
    .filter((s) => !isWarmupQuestion(s))
    .sort((a, b) => Number(a.questionId) - Number(b.questionId));

  const unmatched = votableQuestions.filter((q) => !globalMatchedIds.has(String(q.questionId)));
  if (unmatched.length > 0) {
    logger.warn(`${unmatched.length} question(s) not marked — appending once at end of document`);
    const lastOrder = results.length > 0 ? (results[results.length - 1].order ?? results.length) + 1 : 1;
    const unmatchedBlocks: ContentBlock[] = [
      { type: 'paragraph', bold: true, text: 'VOTACIONES NO UBICADAS EN EL TEXTO' },
      ...unmatched.flatMap((q): ContentBlock[] => ([
        { type: 'votingQuestion' as const, questionId: q.questionId, text: q.questionText.trim() } as ContentBlock,
        { type: 'votingResults' as const, questionId: q.questionId, source: 'robinson' as const } as ContentBlock,
      ])),
    ];
    results.push({
      sectionId: 'unmatched_voting',
      sectionTitle: 'Votaciones No Ubicadas',
      sectionStyle: 'paragraphNormal' as any,
      order: lastOrder,
      content: unmatchedBlocks,
      metadata: { agent: 'fannery', timestamp: new Date().toISOString(), confidence: 1, flags: [] },
    } as SectionFile);
  }

  return results;
}

// ── Phase 1: Parse markdown text into raw content blocks ──

function parseMarkdownToBlocks(
  text: string,
  votingData: VotingPackage,
  globalMatchedIds: Set<string>,
): ContentBlock[] {
  // Phase 1: Parse into raw blocks
  const rawBlocks = parseMarkdownIntoRawBlocks(text);
  logger.info(`Phase 1: parsed ${rawBlocks.length} raw blocks`);

  // Phase 2: Inject voting data via marker matching (updates globalMatchedIds in place)
  const enriched = injectVotingBlocksOrdered(rawBlocks, votingData, globalMatchedIds);
  logger.info(`Phase 2: enriched to ${enriched.length} blocks`);

  return enriched;
}

function parseMarkdownIntoRawBlocks(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const lines = text.split('\n');
  let currentParagraph: string[] = [];

  function flushParagraph() {
    if (currentParagraph.length === 0) return;
    const paragraphText = currentParagraph.join('\n').trim();
    if (!paragraphText) {
      currentParagraph = [];
      return;
    }

    const trimmed = paragraphText.trim();
    // Check if entire paragraph is a bold heading: **HEADING TEXT**
    const isBoldHeading =
      trimmed.startsWith('**') &&
      trimmed.endsWith('**') &&
      trimmed.indexOf('**', 2) === trimmed.length - 2;

    if (isBoldHeading) {
      blocks.push({ type: 'paragraph', bold: true, text: trimmed.slice(2, -2) });
    } else {
      blocks.push({ type: 'paragraph', bold: false, text: paragraphText });
    }

    currentParagraph = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '') {
      flushParagraph();
      continue;
    }

    // Bullet list: "- text"
    if (trimmed.startsWith('- ')) {
      flushParagraph();
      const itemText = trimmed.slice(2);
      const isBold = itemText.startsWith('**') && itemText.endsWith('**');
      blocks.push({
        type: 'listItem',
        text: isBold ? itemText.slice(2, -2) : itemText,
        bold: isBold,
      });
      continue;
    }

    // Numbered list: "1. text"
    if (/^\d+\.\s/.test(trimmed)) {
      flushParagraph();
      blocks.push({
        type: 'listItem',
        text: trimmed.replace(/^\d+\.\s/, ''),
        bold: false,
      });
      continue;
    }

    currentParagraph.push(line);
  }

  flushParagraph();
  return blocks;
}

// ── Phase 2: Marker-based voting injection ──

/**
 * Match voting questions to document blocks using explicit markers inserted by Lina.
 *
 * Lina is now instructed to insert "> [VOTACION PREGUNTA N]" markers in the
 * redacted text at the exact location where each vote was announced.
 * This function scans for those markers and replaces them with proper
 * votingQuestion + votingResults content blocks.
 *
 * Falls back to appending unmatched questions at end (same as before).
 */

/**
 * Build a map from questionId -> VotingSummary for quick lookup
 */
function buildQuestionMap(votingData: VotingPackage): Map<string, VotingSummary> {
  const map = new Map<string, VotingSummary>();
  for (const s of votingData.summaries) {
    map.set(String(s.questionId), s);
  }
  return map;
}

/**
 * Scan parsed blocks for Lina's explicit voting markers "> [VOTACION PREGUNTA N]"
 * and replace each marker block with votingQuestion + votingResults blocks.
 * Questions that were not marked are appended at the end.
 *
 * The marker regex matches both accented and unaccented variants:
 *   [VOTACION PREGUNTA 3]
 *   [VOTACIÓN PREGUNTA 3]
 */
const VOTING_MARKER_RE = /\[VOTACI[OÓ]N\s+PREGUNTA\s+(\d+)\]/i;

function injectVotingBlocksOrdered(
  rawBlocks: ContentBlock[],
  votingData: VotingPackage,
  matchedQuestionIds: Set<string>,
): ContentBlock[] {
  // Filter out warmup questions
  const votableQuestions = votingData.summaries
    .filter((s) => !isWarmupQuestion(s))
    .sort((a, b) => Number(a.questionId) - Number(b.questionId));

  if (votableQuestions.length === 0) {
    logger.info('No votable questions to inject');
    return rawBlocks;
  }

  const questionMap = buildQuestionMap(votingData);
  const result: ContentBlock[] = [];
  // Track which questions have already been injected to prevent duplicate markers
  const injectedQuestionIds = new Set<string>();

  for (const block of rawBlocks) {
    // Check if this block IS a voting marker (Lina wrote it as a blockquote paragraph)
    if ('text' in block && block.text) {
      const markerMatch = block.text.match(VOTING_MARKER_RE);
      if (markerMatch) {
        const questionId = markerMatch[1];
        // Skip duplicate markers — only inject each question once
        if (injectedQuestionIds.has(questionId)) {
          logger.warn(`Duplicate marker for Q${questionId} — skipping`);
          continue;
        }
        const question = questionMap.get(questionId);
        if (question && !isWarmupQuestion(question)) {
          matchedQuestionIds.add(questionId);
          injectedQuestionIds.add(questionId);
          logger.info(`Marker found for Q${questionId}: replacing with voting blocks`);
          result.push({
            type: 'votingQuestion',
            questionId: question.questionId,
            text: question.questionText.trim(),
          });
          result.push({
            type: 'votingResults',
            questionId: question.questionId,
            source: 'robinson' as const,
          });
          continue; // Skip the raw marker block itself
        } else {
          logger.warn(`Marker found for Q${questionId} but no matching question in votingData`);
        }
      }

      // Also check if the marker is INLINE within a paragraph (embedded in prose)
      if (VOTING_MARKER_RE.test(block.text)) {
        let remainingText = block.text;
        let hasMarker = false;

        while (VOTING_MARKER_RE.test(remainingText)) {
          hasMarker = true;
          const m = remainingText.match(VOTING_MARKER_RE)!;
          const questionId = m[1];
          const markerIdx = remainingText.indexOf(m[0]);

          // Push text before the marker as a paragraph
          const before = remainingText.slice(0, markerIdx).trim();
          if (before) {
            result.push({ ...block, text: before });
          }

          // Push voting blocks (skip if already injected)
          const question = questionMap.get(questionId);
          if (question && !isWarmupQuestion(question) && !injectedQuestionIds.has(questionId)) {
            matchedQuestionIds.add(questionId);
            injectedQuestionIds.add(questionId);
            result.push({
              type: 'votingQuestion',
              questionId: question.questionId,
              text: question.questionText.trim(),
            });
            result.push({
              type: 'votingResults',
              questionId: question.questionId,
              source: 'robinson' as const,
            });
          } else if (injectedQuestionIds.has(questionId)) {
            logger.warn(`Duplicate inline marker for Q${questionId} — skipping`);
          }

          remainingText = remainingText.slice(markerIdx + m[0].length).trim();
        }

        if (hasMarker) {
          // Push any remaining text after last marker
          if (remainingText) {
            result.push({ ...block, text: remainingText });
          }
          continue;
        }
      }
    }

    result.push(block);
  }

  logger.info(`Matched ${matchedQuestionIds.size}/${votableQuestions.length} questions via explicit markers in this section`);
  return result;
}

// ── Helper functions ──

/**
 * Identify warmup/test questions that are NOT real votes.
 * Only Q1 "COMO AMANECIO EL DIA DE HOY?" is a typical warmup.
 *
 * IMPORTANT: We do NOT filter on substring "PRUEBA" because that matches
 * "APRUEBA USTED..." which is the standard phrasing for ALL real questions.
 * Instead, we use specific patterns that only match genuine test/warmup questions.
 */
function isWarmupQuestion(summary: VotingSummary): boolean {
  const text = summary.questionText.toUpperCase().trim();

  // Q0 is always a system test question
  if (Number(summary.questionId) === 0) return true;

  // "COMO AMANECIO EL DIA DE HOY?" — warmup icebreaker
  if (text.includes('AMANECIO') || text.includes('AMANECIÓ')) return true;

  // Exact word "PRUEBA" as standalone (test question), NOT as part of "APRUEBA"
  if (/(?<![A-ZÁÉÍÓÚÑ])PRUEBA(?![A-ZÁÉÍÓÚÑ])/.test(text)) return true;

  // Exact standalone "TEST"
  if (/(?<![A-ZÁÉÍÓÚÑ])TEST(?![A-ZÁÉÍÓÚÑ])/.test(text)) return true;

  // Invalidated/replaced questions with zero votes — admin annulled and re-asked
  const totalNominal = (summary.options || []).reduce((sum, o) => sum + (o.nominal || 0), 0);
  if (totalNominal === 0) return true;

  return false;
}
