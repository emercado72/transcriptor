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
  RosterRecord,
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

  // Resolve the actual assembly date:
  // 1) From the asambleas table (fechaAsamblea / date field)
  // 2) Fallback: earliest quorum snapshot timestamp (always reliable)
  // 3) Last resort: current date
  let assemblyDate: Date;
  const rawDate = data.fechaAsamblea || data.date;
  if (rawDate) {
    assemblyDate = new Date(String(rawDate));
  } else {
    assemblyDate = await resolveAssemblyDateFromQuorum(idAsamblea);
  }

  return {
    eventId,
    buildingName: String(data.cliente || data.buildingName || ''),
    buildingNit: String(data.nit || data.buildingNit || ''),
    city: String(data.ciudad || data.city || ''),
    date: assemblyDate,
    eventType: String(data.tipoAsamblea || data.eventType || '') === 'extraordinaria'
      ? 'extraordinaria' : 'ordinaria',
    startTime: String(data.horaInicio || data.startTime || ''),
    endTime: String(data.horaFin || data.endTime || ''),
  };
}

/**
 * Resolve the actual assembly date from the earliest quorum snapshot.
 * quorumRespuestas.fhoperacion is recorded when each question's quorum is
 * captured, so the earliest one gives us the true event date.
 */
async function resolveAssemblyDateFromQuorum(idAsamblea: number): Promise<Date> {
  try {
    const { queryTecnoreuniones } = await import('./adapters/tecnoreunionesDb.js');
    const rows = await queryTecnoreuniones(
      'SELECT fhoperacion FROM quorumRespuestas WHERE idAsamblea = ? ORDER BY fhoperacion ASC LIMIT 1',
      [idAsamblea],
    );
    if (rows.length > 0 && rows[0].fhoperacion) {
      const date = new Date(rows[0].fhoperacion as string);
      logger.info(`Resolved assembly date from quorum: ${date.toISOString().split('T')[0]}`);
      return date;
    }
  } catch (err) {
    logger.warn(`Failed to resolve assembly date from quorum: ${(err as Error).message}`);
  }
  logger.warn(`No assembly date found for idAsamblea=${idAsamblea}, falling back to current date`);
  return new Date();
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

  const { dbFetchAssemblyStatus, dbFetchQuestions, dbFetchQuorumSnapshot } =
    await import('./adapters/tecnoreunionesDb.js');

  // Get the assembly status (contains current quorum)
  const statusData = await dbFetchAssemblyStatus(idAsamblea);
  const currentSnapshot = statusData ? adapter.mapQuorum(statusData) : null;

  // Get quorum snapshots from closed questions (from quorumRespuestas table)
  const questions = await dbFetchQuestions(idAsamblea);
  const snapshots: QuorumSnapshot[] = currentSnapshot ? [currentSnapshot] : [];

  for (const q of questions) {
    const idPregunta = Number(q.idPregunta);
    if (idPregunta === 0) continue; // Skip default question
    try {
      const snap = await dbFetchQuorumSnapshot(idAsamblea, idPregunta);
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

  // Use DB route (HTTP service 5 derives idAsamblea from the session token and is unreliable)
  const { dbFetchQuestions, dbFetchVotingResults, dbFetchQuorumSnapshot } =
    await import('./adapters/tecnoreunionesDb.js');

  const questions = await dbFetchQuestions(idAsamblea);

  const summaries: VotingSummary[] = [];
  for (const q of questions) {
    const idPregunta = Number(q.idPregunta);
    if (idPregunta === 0) continue; // Skip default question
    const opciones = Number(q.opciones || 1);
    try {
      // Fetch voting results and quorum snapshot in parallel
      const [results, quorumSnap] = await Promise.all([
        dbFetchVotingResults(idAsamblea, idPregunta, opciones),
        dbFetchQuorumSnapshot(idAsamblea, idPregunta),
      ]);
      const quorumAtClose = quorumSnap ? Number(quorumSnap.quorum || 0) : 0;
      summaries.push(adapter.mapVotingResults(q, results, quorumAtClose));
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

  const { dbFetchQuestions, dbFetchVotingResults, dbFetchQuorumSnapshot } =
    await import('./adapters/tecnoreunionesDb.js');

  // Get question metadata, voting results, and quorum snapshot
  const [questions, results, quorumSnap] = await Promise.all([
    dbFetchQuestions(idAsamblea),
    dbFetchVotingResults(idAsamblea, idPregunta, 1), // will re-fetch with correct opciones below if needed
    dbFetchQuorumSnapshot(idAsamblea, idPregunta),
  ]);

  const question = questions.find((q) => Number(q.idPregunta) === idPregunta) || {};
  const opciones = Number((question as Record<string, unknown>).opciones || 1);
  const quorumAtClose = quorumSnap ? Number(quorumSnap.quorum || 0) : 0;

  // If multi-choice, re-fetch with correct opciones
  const finalResults = opciones > 1
    ? await dbFetchVotingResults(idAsamblea, idPregunta, opciones)
    : results;

  return adapter.mapVotingResults(question as Record<string, unknown>, finalResults, quorumAtClose);
}

export async function getVotingDetail(eventId: EventId, questionId: QuestionId): Promise<VotingDetail> {
  logger.info(`Fetching voting detail: ${eventId}, question ${questionId}`);
  const idAsamblea = Number(eventId);
  const idPregunta = Number(questionId);

  // Use resultsdata.php — its `detallado` array includes owner names
  // (service 1002 / escrutiniovotacion view does NOT have owner/delegate names)
  const resultsData = await adapter.fetchResultsData(idAsamblea, idPregunta);
  return adapter.mapVotingDetailFromResultsData(questionId, resultsData.detallado);
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

/**
 * Resolve a Tecnoreuniones assembly from a text hint (folder name, audio file name, etc.).
 * Extracts the building name from the hint and matches against the `asambleas` table.
 * Returns { idAsamblea, cliente } or null if no match.
 */
export async function resolveAssemblyFromHint(
  hint: string,
): Promise<{ idAsamblea: number; cliente: string } | null> {
  logger.info(`Resolving assembly from hint: "${hint}"`);
  const { dbResolveAssembly } = await import('./adapters/tecnoreunionesDb.js');
  const result = await dbResolveAssembly(hint);
  if (result) {
    logger.info(`Resolved assembly: ${result.idAsamblea} (${result.cliente})`);
  } else {
    logger.warn(`Could not resolve assembly from hint: "${hint}"`);
  }
  return result;
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

/**
 * Get the full resident roster for an assembly.
 * Returns typed RosterRecord[] — all DB schema details are encapsulated here.
 */
export async function getRoster(eventId: EventId): Promise<RosterRecord[]> {
  logger.info(`Fetching roster: ${eventId}`);
  const idAsamblea = Number(eventId);
  const { dbFetchRoster } = await import('./adapters/tecnoreunionesDb.js');
  const raw = await dbFetchRoster(idAsamblea);

  const records: RosterRecord[] = [];
  for (const r of raw) {
    const unit = String(r.idunidad || '');
    if (unit === 'ADMIN') continue;

    records.push({
      tower: String(r.idtorre || ''),
      unit,
      ownerName: String(r.nombrePropietario1 || '').trim(),
      ownerName2: String(r.nombrePropietario2 || '').trim(),
      delegateName: String(r.nombreApoderado || '').trim(),
      coefficient: parseFloat(String(r.coeficiente || '0')),
      nominal: parseFloat(String(r.nominal || '0')),
      hasMora: String(r.mora || '0') !== '0',
    });
  }

  logger.info(`Roster loaded: ${records.length} residents for assembly ${eventId}`);
  return records;
}
