import { createLogger } from '@transcriptor/shared';
import type {
  EventId,
  EventMetadata,
  QuorumSnapshot,
  AttendanceRecord,
  VotingSummary,
  VotingDetail,
  ElectionResult,
  OfficerRoles,
  QuestionId,
} from '@transcriptor/shared';
import * as adapter from './adapters/tecnoreunionesAdapter.js';

const logger = createLogger('robinson');

// ── Service IDs (Tecnoreuniones backend) ──
const SERVICE = {
  EVENT_METADATA: 1,
  QUORUM: 2,
  ATTENDANCE: 3,
  QUESTIONS: 4,
  VOTING_RESULTS: 5,
  VOTING_DETAIL: 6,
  ELECTION_RESULTS: 7,
  OFFICERS: 8,
} as const;

export async function getEventMetadata(eventId: EventId): Promise<EventMetadata> {
  logger.info(`Fetching event metadata: ${eventId}`);
  const raw = await adapter.fetchService(SERVICE.EVENT_METADATA, { eventId });
  const data = raw as Record<string, unknown>;
  return {
    eventId,
    buildingName: String(data.buildingName || data.nombre_edificio || ''),
    buildingNit: String(data.buildingNit || data.nit || ''),
    city: String(data.city || data.ciudad || ''),
    date: new Date(String(data.date || data.fecha)),
    eventType: (data.eventType || data.tipo_evento) === 'extraordinaria' ? 'extraordinaria' : 'ordinaria',
    startTime: String(data.startTime || data.hora_inicio || ''),
    endTime: String(data.endTime || data.hora_fin || ''),
  };
}

export async function validateEvent(buildingName: string, date: Date): Promise<EventMetadata | null> {
  logger.info(`Validating event: ${buildingName} on ${date.toISOString()}`);
  try {
    const raw = await adapter.fetchService(SERVICE.EVENT_METADATA, { buildingName, date: date.toISOString() });
    if (!raw) return null;
    const data = raw as Record<string, unknown>;
    return {
      eventId: String(data.eventId || data.evento_id || ''),
      buildingName: String(data.buildingName || data.nombre_edificio || ''),
      buildingNit: String(data.buildingNit || data.nit || ''),
      city: String(data.city || data.ciudad || ''),
      date,
      eventType: (data.eventType || data.tipo_evento) === 'extraordinaria' ? 'extraordinaria' : 'ordinaria',
      startTime: String(data.startTime || data.hora_inicio || ''),
      endTime: String(data.endTime || data.hora_fin || ''),
    };
  } catch {
    logger.warn('Event not found');
    return null;
  }
}

export async function getQuorumSnapshots(eventId: EventId): Promise<QuorumSnapshot[]> {
  logger.info(`Fetching quorum snapshots: ${eventId}`);
  const raw = await adapter.fetchService(SERVICE.QUORUM, { eventId });
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => adapter.mapQuorum(item));
}

export async function getInitialQuorum(eventId: EventId): Promise<QuorumSnapshot> {
  const snapshots = await getQuorumSnapshots(eventId);
  if (snapshots.length === 0) {
    throw new Error(`No quorum snapshots found for event ${eventId}`);
  }
  return snapshots[0];
}

export async function getFinalQuorum(eventId: EventId): Promise<QuorumSnapshot> {
  const snapshots = await getQuorumSnapshots(eventId);
  if (snapshots.length === 0) {
    throw new Error(`No quorum snapshots found for event ${eventId}`);
  }
  return snapshots[snapshots.length - 1];
}

export async function getAttendanceList(eventId: EventId): Promise<AttendanceRecord[]> {
  logger.info(`Fetching attendance list: ${eventId}`);
  const raw = await adapter.fetchService(SERVICE.ATTENDANCE, { eventId });
  return adapter.mapAttendance(raw);
}

export async function getQuestionList(eventId: EventId): Promise<VotingSummary[]> {
  logger.info(`Fetching question list: ${eventId}`);
  const raw = await adapter.fetchService(SERVICE.QUESTIONS, { eventId });
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => adapter.mapVotingResults(item));
}

export async function getVotingResults(eventId: EventId, questionId: QuestionId): Promise<VotingSummary> {
  logger.info(`Fetching voting results: ${eventId}, question ${questionId}`);
  const raw = await adapter.fetchService(SERVICE.VOTING_RESULTS, { eventId, questionId });
  return adapter.mapVotingResults(raw);
}

export async function getVotingDetail(eventId: EventId, questionId: QuestionId): Promise<VotingDetail> {
  logger.info(`Fetching voting detail: ${eventId}, question ${questionId}`);
  const raw = await adapter.fetchService(SERVICE.VOTING_DETAIL, { eventId, questionId });
  return adapter.mapVotingDetail(raw);
}

export async function getElectionResults(eventId: EventId, questionId: QuestionId): Promise<ElectionResult> {
  logger.info(`Fetching election results: ${eventId}, question ${questionId}`);
  const raw = await adapter.fetchService(SERVICE.ELECTION_RESULTS, { eventId, questionId });
  const data = raw as Record<string, unknown>;
  return {
    questionId,
    candidates: (() => {
      const cands = data.candidates || data.candidatos;
      if (!Array.isArray(cands)) return [];
      return cands.map((c: Record<string, unknown>) => ({
        name: String(c.name || c.nombre || ''),
        unit: String(c.unit || c.unidad || ''),
        coefficientSum: Number(c.coefficientSum || c.suma_coeficiente || 0),
        nominalSum: Number(c.nominalSum || c.suma_nominal || 0),
      }));
    })(),
  };
}

export async function getNonVoters(eventId: EventId, questionId: QuestionId): Promise<AttendanceRecord[]> {
  logger.info(`Fetching non-voters: ${eventId}, question ${questionId}`);
  const [attendance, votingDetail] = await Promise.all([
    getAttendanceList(eventId),
    getVotingDetail(eventId, questionId),
  ]);

  const voterUnits = new Set(votingDetail.votes.map((v) => v.unit));
  return attendance.filter(
    (a) => a.status !== 'absent' && !voterUnits.has(a.unit),
  );
}

export async function getOfficers(eventId: EventId): Promise<OfficerRoles> {
  logger.info(`Fetching officers: ${eventId}`);
  const raw = await adapter.fetchService(SERVICE.OFFICERS, { eventId });
  const data = raw as Record<string, unknown>;
  return {
    president: String(data.president || data.presidente || ''),
    secretary: String(data.secretary || data.secretario || ''),
    verificadores: Array.isArray(data.verificadores)
      ? data.verificadores.map(String)
      : [],
  };
}
