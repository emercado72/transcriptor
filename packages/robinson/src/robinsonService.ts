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

// ── Tecnoreuniones Service IDs (see docs/TECNOREUNIONES_API.md) ──
const SERVICE = {
  ADMIN_LOGIN: 1,         // Admin authentication
  DELEGATION: 2,          // Grant power/delegation
  ATTENDANCE: 3,          // List delegates (listadelegados view)
  CREATE_QUESTION: 4,     // Create voting question
  LIST_QUESTIONS: 5,      // List questions for assembly
  ACTIVATE_QUESTION: 6,   // Activate question for voting
  CHANGE_STATE: 7,        // Change assembly state
  ADMIN_INFO: 8,          // Administrator info
  ACTIVE_ASSEMBLIES: 9,   // List active assemblies
  CLOSE_QUESTION: 61,     // Close question & save quorum
  QUORUM_SNAPSHOT: 62,    // Get quorum snapshot for question
  VOTING_SCRUTINY: 1002,  // Voting scrutiny (escrutiniovotacion view)
  ASSEMBLY_METADATA: 1003,// Assembly metadata
  ASSEMBLY_STATUS: 1007,  // Assembly status (estadoasamblea view)
  REPRESENTED: 1008,      // Represented units for user
  VOTING_RESULTS: 1012,   // Aggregated voting results
} as const;

export async function getEventMetadata(eventId: EventId): Promise<EventMetadata> {
  logger.info(`Fetching event metadata: ${eventId}`);
  const idAsamblea = Number(eventId);

  // Ensure we have a session context
  adapter.setAssemblyContext(idAsamblea);

  const data = await adapter.fetchAssemblyMetadata(idAsamblea);
  return {
    eventId,
    buildingName: String(data.cliente || data.buildingName || ''),
    buildingNit: String(data.nit || data.buildingNit || ''),
    city: String(data.ciudad || data.city || ''),
    date: new Date(String(data.fechaAsamblea || data.date || new Date())),
    eventType: String(data.tipoAsamblea || data.eventType || '') === 'extraordinaria'
      ? 'extraordinaria' : 'ordinaria',
    startTime: String(data.horaInicio || data.startTime || ''),
    endTime: String(data.horaFin || data.endTime || ''),
  };
}

export async function validateEvent(buildingName: string, date: Date): Promise<EventMetadata | null> {
  logger.info(`Validating event: ${buildingName} on ${date.toISOString()}`);
  try {
    // Search active assemblies and match by client name
    const assemblies = await adapter.fetchActiveAssemblies();
    const match = assemblies.find(
      (a) => String(a.cliente || '').toLowerCase().includes(buildingName.toLowerCase()),
    );
    if (!match) return null;

    const eventId = String(match.idAsamblea);
    return getEventMetadata(eventId);
  } catch {
    logger.warn('Event not found');
    return null;
  }
}

export async function getQuorumSnapshots(eventId: EventId): Promise<QuorumSnapshot[]> {
  logger.info(`Fetching quorum snapshots: ${eventId}`);
  const idAsamblea = Number(eventId);

  // Get the assembly status (contains current quorum)
  const statusData = await adapter.fetchAssemblyStatus(idAsamblea);
  const currentSnapshot = adapter.mapQuorum(statusData);

  // Also try to get quorum snapshots from closed questions (service 62)
  const questions = await adapter.fetchQuestionList(idAsamblea);
  const snapshots: QuorumSnapshot[] = [currentSnapshot];

  for (const q of questions) {
    const idPregunta = Number(q.idPregunta);
    if (idPregunta === 0) continue; // Skip default question
    try {
      const snap = await adapter.fetchQuorumSnapshot(idAsamblea, idPregunta);
      if (snap) {
        snapshots.push(adapter.mapQuorumSnapshot(snap));
      }
    } catch {
      // Question may not have been closed yet
    }
  }

  return snapshots;
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
  const idAsamblea = Number(eventId);
  const raw = await adapter.fetchAttendanceList(idAsamblea);
  return adapter.mapAttendance(raw);
}

export async function getQuestionList(eventId: EventId): Promise<VotingSummary[]> {
  logger.info(`Fetching question list: ${eventId}`);
  const idAsamblea = Number(eventId);
  const questions = await adapter.fetchQuestionList(idAsamblea);

  const summaries: VotingSummary[] = [];
  for (const q of questions) {
    const idPregunta = Number(q.idPregunta);
    if (idPregunta === 0) continue; // Skip default question
    const opciones = Number(q.opciones || 1);
    try {
      const results = await adapter.fetchVotingResults(idAsamblea, idPregunta, opciones);
      summaries.push(adapter.mapVotingResults(q, results));
    } catch {
      // If results fail, still include the question with empty options
      summaries.push(adapter.mapVotingResults(q, []));
    }
  }

  return summaries;
}

export async function getVotingResults(eventId: EventId, questionId: QuestionId): Promise<VotingSummary> {
  logger.info(`Fetching voting results: ${eventId}, question ${questionId}`);
  const idAsamblea = Number(eventId);
  const idPregunta = Number(questionId);

  // Get question metadata first
  const questions = await adapter.fetchQuestionList(idAsamblea);
  const question = questions.find((q) => Number(q.idPregunta) === idPregunta) || {};
  const opciones = Number((question as Record<string, unknown>).opciones || 1);

  // Get aggregated results
  const results = await adapter.fetchVotingResults(idAsamblea, idPregunta, opciones);
  return adapter.mapVotingResults(question as Record<string, unknown>, results);
}

export async function getVotingDetail(eventId: EventId, questionId: QuestionId): Promise<VotingDetail> {
  logger.info(`Fetching voting detail: ${eventId}, question ${questionId}`);
  const idAsamblea = Number(eventId);
  const idPregunta = Number(questionId);

  const rawData = await adapter.fetchVotingScrutiny(idAsamblea, idPregunta);
  return adapter.mapVotingDetail(questionId, rawData);
}

export async function getElectionResults(eventId: EventId, questionId: QuestionId): Promise<ElectionResult> {
  logger.info(`Fetching election results: ${eventId}, question ${questionId}`);
  const idAsamblea = Number(eventId);
  const idPregunta = Number(questionId);

  // Elections use the same voting results endpoint but with opciones > 1
  const results = await adapter.fetchVotingResults(idAsamblea, idPregunta, 2);
  return {
    questionId,
    candidates: results.map((r) => ({
      name: String(r.texto || ''),
      unit: '',
      coefficientSum: Number(r.coeficiente || 0),
      nominalSum: Number(r.nominal || 0),
    })),
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
  const data = await adapter.fetchAdminInfo();
  return {
    president: '',  // Officers are not stored in Tecnoreuniones — filled from transcription
    secretary: '',
    verificadores: [],
    // Admin info available:
    // adminName: String(data.nombreAdministrador || ''),
    // adminEmail: String(data.email || ''),
  };
}
