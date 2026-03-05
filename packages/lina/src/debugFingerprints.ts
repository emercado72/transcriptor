/**
 * Debug script to inspect fingerprints and similarity scores
 * between problematic speaker matches.
 */
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

const AUDIO_DIR = process.env.AUDIO_TRANSCRIBER_PATH
  ? path.join(process.env.AUDIO_TRANSCRIBER_PATH, 'output')
  : path.resolve(process.cwd(), '..', 'audio-transcriber', 'output');

interface Segment { speaker: string; text: string; start: number; end: number; }

// ── Copy of detection logic from speakerReconcilerRedis.ts ──

const INTRO_PATTERNS: { pattern: RegExp; group: number }[] = [
  { pattern: /mi nombre es\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,5})/i, group: 1 },
  { pattern: /quien les habla(?:\s+es)?\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,5})/i, group: 1 },
  { pattern: /me llamo\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,5})/i, group: 1 },
  { pattern: /soy\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,5})\s*(?:,|del?\s)/i, group: 1 },
];

const NAME_BLACKLIST = new Set([
  'propietario', 'propietaria', 'residente', 'señor', 'señora', 'doctor', 'doctora',
  'presidente', 'administrador', 'administradora', 'secretario', 'secretaria',
  'revisor', 'fiscal', 'abogado', 'abogada', 'consejero', 'consejera',
  'buenos', 'buenas', 'después', 'antes', 'primero', 'segundo', 'parte',
  'uno', 'una', 'dos', 'tres', 'cuatro', 'cinco',
]);

function isValidName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 5 || trimmed.length > 60) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < 2) return false;
  if (!/^[A-ZÁÉÍÓÚÑ]/.test(words[0])) return false;
  if (NAME_BLACKLIST.has(words[0].toLowerCase())) return false;
  const lowercaseWords = words.filter(w => /^[a-záéíóúñ]/.test(w));
  if (lowercaseWords.length > words.length * 0.5) return false;
  return true;
}

const SELF_UNIT_PATTERNS: RegExp[] = [
  /(?:mi|nuestro|vivo en(?:l)?|pertenezco al?)\s+(?:apartamento|apto\.?)\s+(\d[\d\-]*)/i,
  /apartamento\s+(\d[\d\-]*)\s+(?:torre|bloque)\s+(\d+)/i,
  /torre\s+(\d+)\s+(?:apartamento|apto\.?)\s+(\d[\d\-]*)/i,
];

const GENERAL_UNIT_PATTERNS: RegExp[] = [
  /apartamento\s+(\d[\d\-]*)/i,
  /apto\.?\s*(\d[\d\-]*)/i,
  /torre\s+(\d+)/i,
];

const ROLE_SELF_PATTERNS: { pattern: RegExp; role: string }[] = [
  { pattern: /(?:^|\. )(?:yo )?(?:soy|como) (?:el |la )?presidente/i, role: 'Moderador' },
  { pattern: /(?:^|\. )(?:yo )?presido esta (?:asamblea|reunión)/i, role: 'Moderador' },
  { pattern: /(?:^|\. )les doy la bienvenida/i, role: 'Moderador' },
  { pattern: /(?:^|\. )(?:yo )?(?:soy|como) (?:el |la )?administradora?/i, role: 'Administrador' },
  { pattern: /(?:^|\. )(?:yo )?(?:soy|como) (?:el |la )?revisor(?:a)? fiscal/i, role: 'Revisor_Fiscal' },
  { pattern: /(?:^|\. )(?:yo )?(?:soy|como|actúo como) (?:el |la )?secretari[oa] de (?:esta |la )?(?:asamblea|reunión)/i, role: 'Secretario' },
  { pattern: /(?:^|\. )en (?:mi|nuestra) calidad de revisor/i, role: 'Revisor_Fiscal' },
  { pattern: /(?:^|\. )en (?:mi|nuestra) calidad de administrador/i, role: 'Administrador' },
  { pattern: /(?:^|\. )procedo a dar lectura del? informe/i, role: 'Revisor_Fiscal' },
];

interface FP {
  localLabel: string;
  chunkIndex: number;
  wordCount: number;
  segmentCount: number;
  detectedNames: string[];
  detectedUnits: string[];
  detectedRoles: Set<string>;
}

function buildFP(chunkIdx: number, label: string, segments: Segment[]): FP {
  const fp: FP = {
    localLabel: label, chunkIndex: chunkIdx, wordCount: 0, segmentCount: 0,
    detectedNames: [], detectedUnits: [], detectedRoles: new Set(),
  };
  for (const seg of segments.filter(s => s.speaker === label)) {
    fp.wordCount += seg.text.split(/\s+/).length;
    fp.segmentCount++;
    for (const { pattern, group } of INTRO_PATTERNS) {
      const m = seg.text.match(pattern);
      if (m?.[group]) {
        const name = m[group].trim();
        if (isValidName(name) && !fp.detectedNames.includes(name)) fp.detectedNames.push(name);
      }
    }
    for (const pat of SELF_UNIT_PATTERNS) {
      const m = seg.text.match(pat);
      if (m) {
        for (let g = 1; g <= 2; g++) {
          if (m[g]) {
            const u = m[g].trim();
            if (!fp.detectedUnits.includes(u)) fp.detectedUnits.push(u);
          }
        }
      }
    }
    if (fp.detectedUnits.length === 0) {
      for (const pat of GENERAL_UNIT_PATTERNS) {
        const m = seg.text.match(pat);
        if (m?.[1]) {
          const u = m[1].trim();
          if (!fp.detectedUnits.includes(u)) fp.detectedUnits.push(u);
        }
      }
    }
    for (const { pattern, role } of ROLE_SELF_PATTERNS) {
      if (pattern.test(seg.text)) fp.detectedRoles.add(role);
    }
  }
  return fp;
}

function fingerprintSimilarity(a: FP, b: FP): { score: number; reason: string } {
  if (a.detectedNames.length > 0 && b.detectedNames.length > 0) {
    const nameOverlap = a.detectedNames.some(na =>
      b.detectedNames.some(nb => {
        const la = na.toLowerCase();
        const lb = nb.toLowerCase();
        return la === lb || la.includes(lb) || lb.includes(la);
      }),
    );
    if (nameOverlap) return { score: 0.95, reason: 'name match' };
    return { score: 0.0, reason: 'name mismatch' };
  }

  if (a.detectedUnits.length > 0 && b.detectedUnits.length > 0) {
    const matchingUnits = a.detectedUnits.filter(ua =>
      b.detectedUnits.some(ub => ua === ub),
    );
    if (matchingUnits.length >= 2) {
      return { score: 0.85, reason: `compound unit match: ${matchingUnits.join(',')}` };
    }
  }

  let roleScore = 0;
  if (a.detectedRoles.size > 0 && b.detectedRoles.size > 0) {
    const roleOverlap = [...a.detectedRoles].some(r => b.detectedRoles.has(r));
    if (roleOverlap) roleScore = 0.3;
  }

  let volumeScore = 0;
  if (a.wordCount > 50 && b.wordCount > 50) {
    const ratio = Math.min(a.wordCount, b.wordCount) / Math.max(a.wordCount, b.wordCount);
    volumeScore = ratio * 0.15;
  }

  let segmentScore = 0;
  if (a.segmentCount > 3 && b.segmentCount > 3) {
    const ratio = Math.min(a.segmentCount, b.segmentCount) / Math.max(a.segmentCount, b.segmentCount);
    segmentScore = ratio * 0.1;
  }

  const total = Math.min(1.0, roleScore + volumeScore + segmentScore);
  return { score: total, reason: `role=${roleScore.toFixed(2)} vol=${volumeScore.toFixed(2)} seg=${segmentScore.toFixed(2)}` };
}

// ── Main ──

const files = readdirSync(AUDIO_DIR)
  .filter(f => f.includes('VALPARAISO') && f.endsWith('.json'))
  .sort();

const chunks = files.map(f => JSON.parse(readFileSync(path.join(AUDIO_DIR, f), 'utf-8')));

// Build fingerprints for all chunks
const allFPs = chunks.map((chunk: { segments: Segment[] }, i: number) => {
  const speakers = [...new Set(chunk.segments.map((s: Segment) => s.speaker))];
  return speakers.map(label => buildFP(i, label, chunk.segments));
});

// Print all fingerprints
for (let i = 0; i < allFPs.length; i++) {
  console.log(`\n=== Chunk ${i} ===`);
  for (const fp of allFPs[i]) {
    console.log(`  ${fp.localLabel}: ${fp.wordCount}w, ${fp.segmentCount} segs, names=[${fp.detectedNames.join(',')}], units=[${fp.detectedUnits.join(',')}], roles=[${[...fp.detectedRoles].join(',')}]`);
  }
}

// Now simulate the matching for problematic pairs
console.log('\n=== Similarity Debug ===');
const pairs = [
  { label: 'Chunk0:A vs Chunk1:H (Secretario vs Félix)', a: { chunk: 0, label: 'Speaker A' }, b: { chunk: 1, label: 'Speaker H' } },
  { label: 'Chunk0:E vs Chunk1:D (Speaker_4 vs Diana)', a: { chunk: 0, label: 'Speaker E' }, b: { chunk: 1, label: 'Speaker D' } },
  { label: 'Chunk0:A vs Chunk2:C (Secretario vs Leon)', a: { chunk: 0, label: 'Speaker A' }, b: { chunk: 2, label: 'Speaker C' } },
];

for (const p of pairs) {
  const fpA = allFPs[p.a.chunk].find((f: FP) => f.localLabel === p.a.label);
  const fpB = allFPs[p.b.chunk].find((f: FP) => f.localLabel === p.b.label);
  if (!fpA || !fpB) { console.log(`  ${p.label}: MISSING FP`); continue; }
  const result = fingerprintSimilarity(fpA, fpB);
  console.log(`  ${p.label}: score=${result.score.toFixed(3)} reason=${result.reason}`);
  console.log(`    A: names=[${fpA.detectedNames}] units=[${fpA.detectedUnits}] roles=[${[...fpA.detectedRoles]}]`);
  console.log(`    B: names=[${fpB.detectedNames}] units=[${fpB.detectedUnits}] roles=[${[...fpB.detectedRoles]}]`);
}

// Also check: does the Secretario fingerprint get MERGED data after chunk 0 processing?
// Simulate chunk processing to see accumulated fingerprints at the time chunk 1 Speaker H is compared
console.log('\n=== Simulating chunk-by-chunk fingerprint accumulation ===');

// After chunk 0: Secretario = Chunk 0 Speaker A
const secFP = { ...allFPs[0].find((f: FP) => f.localLabel === 'Speaker A')! };
console.log(`After chunk 0, Secretario FP: names=[${secFP.detectedNames}] units=[${secFP.detectedUnits}] roles=[${[...secFP.detectedRoles]}]`);

// The boundary match for chunk 1 maps Speaker A -> Speaker_8 (continued from chunk 0 Speaker I)
// So chunk 0 Speaker I's fingerprint gets merged into Speaker_8
const sp8FP = allFPs[0].find((f: FP) => f.localLabel === 'Speaker I')!;
console.log(`After chunk 0, Speaker_8 (chunk0:I) FP: names=[${sp8FP.detectedNames}] units=[${sp8FP.detectedUnits}] roles=[${[...sp8FP.detectedRoles]}]`);

// After boundary match in chunk 1, Speaker A -> Speaker_8
// Now chunk 1 Speaker A data gets merged into Speaker_8
const c1spA = allFPs[1].find((f: FP) => f.localLabel === 'Speaker A')!;
console.log(`Chunk 1 Speaker A (merged into Speaker_8): names=[${c1spA.detectedNames}] units=[${c1spA.detectedUnits}] roles=[${[...c1spA.detectedRoles]}]`);

// After this merge, Speaker_8 accumulated units = [chunk0:I units] + [chunk1:A units]
const mergedUnits = [...new Set([...sp8FP.detectedUnits, ...c1spA.detectedUnits])];
console.log(`Speaker_8 accumulated units after chunk 1 merge: [${mergedUnits}]`);

// Check if Speaker_8 accumulated units now match chunk 1 Speaker H units
const c1spH = allFPs[1].find((f: FP) => f.localLabel === 'Speaker H')!;
console.log(`Chunk 1 Speaker H units: [${c1spH.detectedUnits}]`);
const matchingUnitsHvs8 = mergedUnits.filter(u => c1spH.detectedUnits.includes(u));
console.log(`Matching units between accumulated Speaker_8 and chunk1:H: [${matchingUnitsHvs8}]`);
