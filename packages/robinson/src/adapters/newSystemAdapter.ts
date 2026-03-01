import { createLogger } from '@transcriptor/shared';
import type { AttendanceRecord, VotingSummary, VotingDetail, QuorumSnapshot } from '@transcriptor/shared';

const logger = createLogger('robinson:newSystem');

// ──────────────────────────────────────────────
// Future replacement system adapter
// Same interface as tecnoreunionesAdapter
// ──────────────────────────────────────────────

export async function fetchService(serviceId: number, params: Record<string, unknown> = {}): Promise<unknown> {
  logger.warn('newSystemAdapter.fetchService is not yet implemented');
  throw new Error('New system adapter not yet implemented');
}

export function mapAttendance(rawData: unknown): AttendanceRecord[] {
  logger.warn('newSystemAdapter.mapAttendance is not yet implemented');
  return [];
}

export function mapVotingResults(rawData: unknown): VotingSummary {
  logger.warn('newSystemAdapter.mapVotingResults is not yet implemented');
  throw new Error('New system adapter not yet implemented');
}

export function mapVotingDetail(rawData: unknown): VotingDetail {
  logger.warn('newSystemAdapter.mapVotingDetail is not yet implemented');
  throw new Error('New system adapter not yet implemented');
}

export function mapQuorum(rawData: unknown): QuorumSnapshot {
  logger.warn('newSystemAdapter.mapQuorum is not yet implemented');
  throw new Error('New system adapter not yet implemented');
}
