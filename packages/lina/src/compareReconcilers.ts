/**
 * Compare LLM vs Redis speaker reconciliation results.
 *
 * Usage:
 *   node --env-file=.env.local packages/lina/dist/compareReconcilers.js <jobId>
 *
 * Loads the same transcript chunks, runs the Redis reconciler,
 * and compares against the stored LLM result from transcript_reconciled.json.
 */

import path from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createLogger } from '@transcriptor/shared';
import { loadChunkTranscripts } from './speakerReconciler.js';
import type { ReconciliationResult, SpeakerMap } from './speakerReconciler.js';
import { reconcileSpeakersRedis } from './speakerReconcilerRedis.js';

const logger = createLogger('lina:compareReconcilers');

// ── Path helpers ──

function getProjectRoot(): string {
  return path.resolve(import.meta.dirname, '../../..');
}

function getAudioTranscriberOutputDir(): string {
  const envPath = process.env.AUDIO_TRANSCRIBER_PATH;
  if (envPath) return path.join(envPath, 'output');
  return path.resolve(getProjectRoot(), '..', 'audio-transcriber', 'output');
}

// ── Find transcript chunks (same logic as linaService) ──

function findTranscriptChunks(jobId: string): string[] {
  const root = getProjectRoot();
  const processedDir = path.join(root, 'data', 'jobs', jobId, 'processed');
  const outputDir = getAudioTranscriberOutputDir();

  const manifestPath = path.join(processedDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const processedFiles: string[] = manifest.processedFiles || [];

  const transcriptFiles: string[] = [];
  for (const flacPath of processedFiles) {
    const baseName = path.basename(flacPath, '.flac');
    const expectedJson = path.join(outputDir, `${baseName}_transcript.json`);
    if (existsSync(expectedJson)) {
      transcriptFiles.push(expectedJson);
    }
  }

  if (transcriptFiles.length === 0) {
    const allFiles = readdirSync(outputDir) as string[];
    const jsonFiles = allFiles
      .filter((f: string) => f.endsWith('_transcript.json'))
      .sort()
      .map((f: string) => path.join(outputDir, f));
    if (jsonFiles.length > 0) return jsonFiles;
    throw new Error(`No transcript files found`);
  }

  return transcriptFiles.sort();
}

// ── Comparison helpers ──

function buildFlatMap(chunkMaps: SpeakerMap[]): Map<string, string> {
  const flat = new Map<string, string>();
  for (let i = 0; i < chunkMaps.length; i++) {
    for (const [local, global] of Object.entries(chunkMaps[i])) {
      flat.set(`chunk${i}:${local}`, global);
    }
  }
  return flat;
}

function compareResults(
  llmResult: ReconciliationResult,
  redisResult: ReconciliationResult,
): void {
  const RESET = '\x1b[0m';
  const BOLD = '\x1b[1m';
  const GREEN = '\x1b[32m';
  const RED = '\x1b[31m';
  const YELLOW = '\x1b[33m';
  const CYAN = '\x1b[36m';
  const DIM = '\x1b[2m';

  console.log(`\n${BOLD}${'═'.repeat(80)}${RESET}`);
  console.log(`${BOLD}${CYAN}  SPEAKER RECONCILIATION COMPARISON: LLM vs Redis${RESET}`);
  console.log(`${BOLD}${'═'.repeat(80)}${RESET}\n`);

  // ── Overview ──
  console.log(`${BOLD}Overview:${RESET}`);
  console.log(`  LLM global speakers:   ${llmResult.globalSpeakers.length}`);
  console.log(`  Redis global speakers:  ${redisResult.globalSpeakers.length}`);
  console.log(`  LLM identified:         ${Object.keys(llmResult.identifiedSpeakers).length}`);
  console.log(`  Redis identified:        ${Object.keys(redisResult.identifiedSpeakers).length}`);
  console.log(`  LLM confidence:          ${llmResult.confidence}`);
  console.log(`  Redis confidence:        ${redisResult.confidence.toFixed(2)}`);
  console.log();

  // ── Per-chunk mapping comparison ──
  const numChunks = Math.max(llmResult.chunkMaps.length, redisResult.chunkMaps.length);

  for (let i = 0; i < numChunks; i++) {
    const llmMap = llmResult.chunkMaps[i] || {};
    const redisMap = redisResult.chunkMaps[i] || {};
    const allLocals = new Set([...Object.keys(llmMap), ...Object.keys(redisMap)]);

    console.log(`${BOLD}${CYAN}── Chunk ${i} ──${RESET}`);
    console.log(`  ${'Local Label'.padEnd(14)} ${'LLM → Global'.padEnd(30)} ${'Redis → Global'.padEnd(30)} Status`);
    console.log(`  ${'─'.repeat(14)} ${'─'.repeat(30)} ${'─'.repeat(30)} ${'─'.repeat(10)}`);

    for (const local of [...allLocals].sort()) {
      const llmGlobal = llmMap[local] || '(unmapped)';
      const redisGlobal = redisMap[local] || '(unmapped)';

      // Check if they map to the "same" entity
      // We can't do exact string match since labels differ (Moderator vs Speaker_1)
      // But we CAN check if the same local speakers across chunks map consistently
      let status: string;
      if (llmGlobal === redisGlobal) {
        status = `${GREEN}✓ exact${RESET}`;
      } else if (llmGlobal === '(unmapped)' || redisGlobal === '(unmapped)') {
        status = `${RED}✗ missing${RESET}`;
      } else {
        status = `${YELLOW}≈ diff label${RESET}`;
      }

      console.log(`  ${local.padEnd(14)} ${llmGlobal.padEnd(30)} ${redisGlobal.padEnd(30)} ${status}`);
    }
    console.log();
  }

  // ── Cross-chunk consistency check ──
  // The key question: do both reconcilers agree on which local speakers
  // across chunks are the SAME person?
  console.log(`${BOLD}${CYAN}── Cross-Chunk Consistency ──${RESET}`);
  console.log(`${DIM}  Do both agree on which speakers across chunks are the same person?${RESET}\n`);

  const llmFlat = buildFlatMap(llmResult.chunkMaps);
  const redisFlat = buildFlatMap(redisResult.chunkMaps);

  // For each pair of entries in the LLM map, check if Redis agrees/disagrees
  // on whether they're the same person
  const llmEntries = [...llmFlat.entries()];
  let agreements = 0;
  let disagreements = 0;
  const disagreementDetails: string[] = [];

  for (let a = 0; a < llmEntries.length; a++) {
    for (let b = a + 1; b < llmEntries.length; b++) {
      const [keyA, llmGlobalA] = llmEntries[a];
      const [keyB, llmGlobalB] = llmEntries[b];

      // Skip same-chunk comparisons (they're trivially different speakers)
      const chunkA = keyA.split(':')[0];
      const chunkB = keyB.split(':')[0];
      if (chunkA === chunkB) continue;

      const redisGlobalA = redisFlat.get(keyA);
      const redisGlobalB = redisFlat.get(keyB);
      if (!redisGlobalA || !redisGlobalB) continue;

      const llmSame = llmGlobalA === llmGlobalB;
      const redisSame = redisGlobalA === redisGlobalB;

      if (llmSame === redisSame) {
        agreements++;
      } else {
        disagreements++;
        const verb1 = llmSame ? 'SAME' : 'DIFF';
        const verb2 = redisSame ? 'SAME' : 'DIFF';
        disagreementDetails.push(
          `  ${keyA} & ${keyB}: LLM=${verb1}(${llmGlobalA}/${llmGlobalB}), Redis=${verb2}(${redisGlobalA}/${redisGlobalB})`,
        );
      }
    }
  }

  const total = agreements + disagreements;
  const pct = total > 0 ? ((agreements / total) * 100).toFixed(1) : '100.0';
  const color = disagreements === 0 ? GREEN : disagreements <= 3 ? YELLOW : RED;

  console.log(`  Cross-chunk pair agreements: ${GREEN}${agreements}${RESET}`);
  console.log(`  Cross-chunk pair disagreements: ${color}${disagreements}${RESET}`);
  console.log(`  Consistency: ${color}${pct}%${RESET}`);

  if (disagreementDetails.length > 0) {
    console.log(`\n${BOLD}${YELLOW}  Disagreements:${RESET}`);
    for (const detail of disagreementDetails.slice(0, 20)) {
      console.log(`  ${YELLOW}${detail}${RESET}`);
    }
    if (disagreementDetails.length > 20) {
      console.log(`  ${DIM}... and ${disagreementDetails.length - 20} more${RESET}`);
    }
  }

  // ── Identified speakers comparison ──
  console.log(`\n${BOLD}${CYAN}── Identified Speakers ──${RESET}`);
  console.log(`\n  ${BOLD}LLM identified:${RESET}`);
  for (const [label, name] of Object.entries(llmResult.identifiedSpeakers)) {
    console.log(`    ${label.padEnd(28)} → ${name}`);
  }
  console.log(`\n  ${BOLD}Redis identified:${RESET}`);
  if (Object.keys(redisResult.identifiedSpeakers).length === 0) {
    console.log(`    ${DIM}(none — Redis uses regex detection only)${RESET}`);
  } else {
    for (const [label, name] of Object.entries(redisResult.identifiedSpeakers)) {
      console.log(`    ${label.padEnd(28)} → ${name}`);
    }
  }

  // ── Reasoning comparison ──
  console.log(`\n${BOLD}${CYAN}── Reasoning ──${RESET}`);
  console.log(`\n  ${BOLD}LLM:${RESET}`);
  console.log(`    ${llmResult.reasoning}`);
  console.log(`\n  ${BOLD}Redis:${RESET}`);
  console.log(`    ${redisResult.reasoning}`);

  // ── Merged segment count comparison ──
  console.log(`\n${BOLD}${CYAN}── Merged Segments ──${RESET}`);
  console.log(`  LLM merged segments:   ${llmResult.mergedSegments.length}`);
  console.log(`  Redis merged segments:  ${redisResult.mergedSegments.length}`);

  // Compare speaker distribution in merged output
  const llmSpeakerDist = new Map<string, number>();
  for (const seg of llmResult.mergedSegments) {
    llmSpeakerDist.set(seg.speaker, (llmSpeakerDist.get(seg.speaker) || 0) + 1);
  }
  const redisSpeakerDist = new Map<string, number>();
  for (const seg of redisResult.mergedSegments) {
    redisSpeakerDist.set(seg.speaker, (redisSpeakerDist.get(seg.speaker) || 0) + 1);
  }

  console.log(`\n  ${BOLD}LLM speaker distribution (top 10):${RESET}`);
  const llmSorted = [...llmSpeakerDist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [spk, count] of llmSorted) {
    console.log(`    ${spk.padEnd(28)} ${count} segments`);
  }

  console.log(`\n  ${BOLD}Redis speaker distribution (top 10):${RESET}`);
  const redisSorted = [...redisSpeakerDist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [spk, count] of redisSorted) {
    console.log(`    ${spk.padEnd(28)} ${count} segments`);
  }

  console.log(`\n${BOLD}${'═'.repeat(80)}${RESET}\n`);
}

// ── Main ──

async function main() {
  const jobId = process.argv[2] || '5366ded0-40a7-4ee1-a1a1-1d70370aed09';
  const root = getProjectRoot();

  console.log(`\nComparing reconcilers for job: ${jobId}\n`);

  // Load the LLM result from disk
  const reconciledPath = path.join(root, 'data', 'jobs', jobId, 'transcript', 'transcript_reconciled.json');
  if (!existsSync(reconciledPath)) {
    console.error(`No LLM reconciliation found at: ${reconciledPath}`);
    process.exit(1);
  }

  const reconciledData = JSON.parse(readFileSync(reconciledPath, 'utf-8'));
  const llmResult: ReconciliationResult = {
    chunkMaps: reconciledData.reconciliation.chunkMaps,
    globalSpeakers: reconciledData.reconciliation.globalSpeakers,
    identifiedSpeakers: reconciledData.reconciliation.identifiedSpeakers,
    mergedSegments: reconciledData.segments || [],
    confidence: reconciledData.reconciliation.confidence,
    reasoning: reconciledData.reconciliation.reasoning,
  };

  console.log(`Loaded LLM result: ${llmResult.globalSpeakers.length} global speakers, confidence ${llmResult.confidence}`);

  // Load the same transcript chunks
  const transcriptFiles = findTranscriptChunks(jobId);
  console.log(`Loading ${transcriptFiles.length} transcript chunks...`);
  const chunks = loadChunkTranscripts(transcriptFiles);

  // Run Redis reconciler
  console.log(`Running Redis reconciler...`);
  const redisResult = await reconcileSpeakersRedis(chunks, jobId);

  // Compare
  compareResults(llmResult, redisResult);

  process.exit(0);
}

main().catch(err => {
  console.error('Comparison failed:', err);
  process.exit(1);
});
