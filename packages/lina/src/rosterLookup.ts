/**
 * Roster Lookup — matches transcription speakers against the Tecnoreuniones
 * resident roster for a given assembly.
 *
 * Data flow:
 *   Pipeline state (Redis) → idAsamblea → Robinson.getRoster() → RosterRecord[]
 *   → build indexes → lookupByUnit(), lookupByName()
 *
 * All Tecnoreuniones DB access goes through Robinson (single gateway).
 *
 * Roster names are typically in "SURNAME FIRSTNAME" format (e.g., "FORERO SANDRA",
 * "URREA BLANCA LILIANA"). Unit codes encode tower + apartment
 * (e.g., "9119" = torre 9, apt 119; "14438" = torre 14, apt 438).
 */

import { createLogger } from '@transcriptor/shared';
import { getRoster } from '@transcriptor/robinson';

const logger = createLogger('lina:roster');

// ── Types ──

export interface RosterEntry {
  tower: string;
  unit: string;
  /** Full unit code as stored in DB (e.g., "9119") */
  unitCode: string;
  ownerName: string;
  ownerName2: string;
  delegateName: string;
  coefficient: number;
}

export interface RosterIndex {
  entries: RosterEntry[];
  /** unitCode → RosterEntry */
  byUnitCode: Map<string, RosterEntry>;
  /** "tower:apt" → RosterEntry (e.g., "9:119") */
  byTowerApt: Map<string, RosterEntry>;
  /** Lowercase surname tokens → RosterEntry[] */
  bySurname: Map<string, RosterEntry[]>;
  /** Lowercase first name tokens → RosterEntry[] */
  byFirstName: Map<string, RosterEntry[]>;
}

// ── Roster Loading ──

/**
 * Load the resident roster for a given assembly ID.
 */
export async function loadRoster(idAsamblea: number): Promise<RosterEntry[]> {
  const records = await getRoster(String(idAsamblea));

  const entries: RosterEntry[] = records.map(r => {
    // Decode unit code: tower + apartment encoding
    const { tower, apt } = decodeUnitCode(r.unit);
    return {
      tower,
      unit: apt,
      unitCode: r.unit,
      ownerName: r.ownerName,
      ownerName2: r.ownerName2,
      delegateName: r.delegateName,
      coefficient: r.coefficient,
    };
  });

  logger.info(`Loaded roster for assembly ${idAsamblea}: ${entries.length} residents`);
  return entries;
}

/**
 * Decode a Tecnoreuniones unit code into tower + apartment.
 *
 * The format packs tower and apartment into a single number. The apartment
 * is typically the last 2-3 digits depending on the building's numbering scheme.
 *
 * Strategy: we try to find a split point where the "apartment" portion makes sense
 * as a unit number (typically 100-999 for 3-digit or 1-99 for 2-digit).
 * Common pattern: last 2 digits if < 4 total, otherwise last 3 digits for floor+unit.
 *
 * Actually looking at the data: units like 10121 (torre 10, apt 121) suggest
 * the last 3 digits IF the code has 5 digits, last 2 if 4 digits, etc.
 * But 1101 = torre 1, apt 101 (3 digits) and 1302 = torre 1, apt 302.
 * So the last 3 digits are ALWAYS the apartment for 4+ digit codes.
 *
 * Let's use: tower = everything except last 3 digits. If that leaves nothing, tower = first digit.
 */
function decodeUnitCode(code: string): { tower: string; apt: string } {
  // Remove non-digits
  const digits = code.replace(/\D/g, '');

  if (digits.length <= 2) {
    return { tower: '?', apt: digits };
  }

  if (digits.length === 3) {
    // e.g., "101" → tower 1, apt 01? Or just apt 101?
    return { tower: digits[0], apt: digits.slice(1) };
  }

  // 4+ digits: tower is everything except last 3
  // 1302 → tower=1, apt=302; 14438 → tower=14, apt=438; 10224 → tower=10, apt=224
  const apt = digits.slice(-3);
  const tower = digits.slice(0, -3) || '?';

  return { tower, apt };
}

// ── Index Building ──

/**
 * Build search indexes from a roster for efficient name/unit lookup.
 */
export function buildRosterIndex(entries: RosterEntry[]): RosterIndex {
  const byUnitCode = new Map<string, RosterEntry>();
  const byTowerApt = new Map<string, RosterEntry>();
  const bySurname = new Map<string, RosterEntry[]>();
  const byFirstName = new Map<string, RosterEntry[]>();

  for (const entry of entries) {
    byUnitCode.set(entry.unitCode, entry);
    byTowerApt.set(`${entry.tower}:${entry.unit}`, entry);

    // Parse names — roster format is typically "SURNAME FIRSTNAME" or "FIRSTNAME SURNAME"
    // or "SURNAME1 SURNAME2 FIRSTNAME" etc.
    for (const nameField of [entry.ownerName, entry.ownerName2, entry.delegateName]) {
      if (!nameField) continue;
      const tokens = nameField
        .toLowerCase()
        .replace(/[^a-záéíóúñü\s]/g, '')
        .split(/\s+/)
        .filter(t => t.length >= 3);

      for (const token of tokens) {
        // We don't know which are surnames vs first names in all cases,
        // so index all tokens in both maps
        if (!bySurname.has(token)) bySurname.set(token, []);
        bySurname.get(token)!.push(entry);

        if (!byFirstName.has(token)) byFirstName.set(token, []);
        byFirstName.get(token)!.push(entry);
      }
    }
  }

  logger.info(
    `Roster index built: ${entries.length} entries, ` +
    `${byUnitCode.size} unit codes, ${bySurname.size} name tokens`,
  );

  return { entries, byUnitCode, byTowerApt, bySurname, byFirstName };
}

// ── Lookup Functions ──

/**
 * Look up a resident by tower and apartment number.
 * Handles various formats the transcription might produce.
 */
export function lookupByUnit(
  index: RosterIndex,
  tower: string,
  apt: string,
): RosterEntry | null {
  // Direct tower:apt lookup
  const key = `${tower}:${apt}`;
  const direct = index.byTowerApt.get(key);
  if (direct) return direct;

  // Try constructing the unit code: tower + apt (zero-padded to 3 digits)
  const aptPadded = apt.padStart(3, '0');
  const unitCode = `${tower}${aptPadded}`;
  const byCode = index.byUnitCode.get(unitCode);
  if (byCode) return byCode;

  // Try without padding
  const unitCode2 = `${tower}${apt}`;
  const byCode2 = index.byUnitCode.get(unitCode2);
  if (byCode2) return byCode2;

  return null;
}

/**
 * Look up residents matching a name fragment from the transcription.
 * Returns all matching entries with a relevance score.
 */
export function lookupByName(
  index: RosterIndex,
  nameFragment: string,
): { entry: RosterEntry; score: number; matchedField: string }[] {
  const tokens = nameFragment
    .toLowerCase()
    .replace(/[^a-záéíóúñü\s]/g, '')
    .split(/\s+/)
    .filter(t => t.length >= 3);

  if (tokens.length === 0) return [];

  // Collect candidates from all matching tokens
  const candidateScores = new Map<RosterEntry, { score: number; matchedTokens: Set<string> }>();

  for (const token of tokens) {
    const matches = index.bySurname.get(token) || [];
    for (const entry of matches) {
      if (!candidateScores.has(entry)) {
        candidateScores.set(entry, { score: 0, matchedTokens: new Set() });
      }
      const c = candidateScores.get(entry)!;
      if (!c.matchedTokens.has(token)) {
        c.matchedTokens.add(token);
        c.score += 1;
      }
    }
  }

  // Score: fraction of query tokens that matched + fraction of name tokens that matched
  const results: { entry: RosterEntry; score: number; matchedField: string }[] = [];

  for (const [entry, { score, matchedTokens }] of candidateScores) {
    const queryRatio = score / tokens.length;

    // Check which name field matched best
    let bestField = 'ownerName';
    let bestFieldRatio = 0;
    for (const [field, name] of [
      ['ownerName', entry.ownerName],
      ['ownerName2', entry.ownerName2],
      ['delegateName', entry.delegateName],
    ] as const) {
      if (!name) continue;
      const nameTokens = name.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
      if (nameTokens.length === 0) continue;
      const matchedInField = nameTokens.filter(t => matchedTokens.has(t)).length;
      const ratio = matchedInField / nameTokens.length;
      if (ratio > bestFieldRatio) {
        bestFieldRatio = ratio;
        bestField = field;
      }
    }

    // Combined score: average of query match ratio and field match ratio
    const combined = (queryRatio + bestFieldRatio) / 2;

    if (combined >= 0.3) {
      results.push({ entry, score: combined, matchedField: bestField });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Format a roster entry as a human-readable speaker label.
 * Converts "FORERO SANDRA" → "Sandra_Forero" (first + surname).
 */
export function formatRosterLabel(entry: RosterEntry): string {
  const name = entry.ownerName || entry.ownerName2 || entry.delegateName;
  if (!name) return `Propietario_T${entry.tower}_${entry.unit}`;

  // Parse the name — try to produce "FirstName_Surname"
  const parts = name.split(/\s+/).filter(p => p.length > 0);
  if (parts.length === 0) return `Propietario_T${entry.tower}_${entry.unit}`;

  // Capitalize each part
  const capitalized = parts.map(p =>
    p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(),
  );

  // If name looks like "SURNAME FIRSTNAME" (2 parts), flip to "Firstname_Surname"
  if (capitalized.length === 2) {
    return `Propietario_${capitalized[1]}_${capitalized[0]}`;
  }

  // If 3+ parts, use first two words as label
  return `Propietario_${capitalized.slice(0, 2).join('_')}`;
}

/**
 * Get a display name suitable for replacing in transcription text.
 * "FORERO SANDRA" → "Sandra Forero (Torre 9, Apto 119)"
 */
export function formatDisplayName(entry: RosterEntry): string {
  const name = entry.ownerName || entry.ownerName2 || entry.delegateName;
  if (!name) return `Propietario Torre ${entry.tower} Apto ${entry.unit}`;

  const parts = name.split(/\s+/).filter(p => p.length > 0);
  const capitalized = parts.map(p =>
    p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(),
  );

  // Try to produce "FirstName Surname" format
  let display: string;
  if (capitalized.length === 2) {
    display = `${capitalized[1]} ${capitalized[0]}`;
  } else if (capitalized.length >= 3) {
    // Last word(s) might be first name, first word(s) surname
    // Just use the full name as-is but capitalized
    display = capitalized.join(' ');
  } else {
    display = capitalized[0];
  }

  return `${display} (Torre ${entry.tower}, Apto ${entry.unit})`;
}
