import axios from 'axios';
import { getEnvConfig, createLogger, AttendanceStatus, QuestionType } from '@transcriptor/shared';
import type { AttendanceRecord, VotingSummary, VotingDetail, QuorumSnapshot } from '@transcriptor/shared';

const logger = createLogger('robinson:tecnoreuniones');

// ──────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────

interface TecnoreunionesConfig {
  apiUrl: string;  // Full URL: https://www.tecnoreuniones.com/vdev/tecnor2.php
  apiKey: string;  // Shared secret used as admin password
}

function getConfig(): TecnoreunionesConfig {
  const env = getEnvConfig();
  return {
    apiUrl: env.tecnoreunionesApiUrl,
    apiKey: env.tecnoreunionesApiKey,
  };
}

// ──────────────────────────────────────────────
// Rate limiter — Tecnoreuniones throttles at 5 req/s
// ──────────────────────────────────────────────

const RATE_LIMIT = 5;               // max calls per window
const RATE_WINDOW_MS = 1_000;       // 1 second window
const callTimestamps: number[] = [];

async function waitForSlot(): Promise<void> {
  while (true) {
    const now = Date.now();
    // Purge timestamps older than the window
    while (callTimestamps.length > 0 && callTimestamps[0] <= now - RATE_WINDOW_MS) {
      callTimestamps.shift();
    }
    if (callTimestamps.length < RATE_LIMIT) {
      callTimestamps.push(now);
      return;
    }
    // Wait until the oldest call exits the window
    const waitMs = callTimestamps[0] + RATE_WINDOW_MS - now + 1;
    logger.debug(`Rate limit reached, waiting ${waitMs}ms`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}

// ──────────────────────────────────────────────
// Low-level API transport
// ──────────────────────────────────────────────

/**
 * Calls the Tecnoreuniones PHP API.
 * All parameters are sent as application/x-www-form-urlencoded POST body.
 * The PHP backend uses $_REQUEST, so both POST body and query params work.
 * Rate-limited to 5 calls/second.
 */
export async function callService(
  serviceId: number,
  params: Record<string, string | number> = {},
): Promise<unknown> {
  const config = getConfig();

  // Wait for a rate-limit slot before sending
  await waitForSlot();

  const formData = new URLSearchParams();
  formData.append('service', String(serviceId));
  for (const [key, value] of Object.entries(params)) {
    formData.append(key, String(value));
  }

  logger.info(`Calling Tecnoreuniones service ${serviceId}`, { params });

  try {
    const response = await axios.post(config.apiUrl, formData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 30_000,
    });

    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      logger.error(`Tecnoreuniones service ${serviceId} failed`, {
        status: error.response?.status,
        data: error.response?.data,
      });
    }
    throw error;
  }
}

// ──────────────────────────────────────────────
// Session Management
// ──────────────────────────────────────────────

let cachedToken: string | null = null;
let cachedAssemblyId: number | null = null;

/**
 * Initialize the token from the API key.
 * The Tecnoreuniones API key doubles as the session token.
 */
function ensureToken(): string {
  if (!cachedToken) {
    const config = getConfig();
    cachedToken = config.apiKey; // CH253864 is both the password and the token
  }
  return cachedToken;
}

/**
 * Service 1 — Admin login.
 * Attempts login; if the API returns non-JSON (e.g. raw SQL in debug mode),
 * falls back to using the API key as the session token.
 */
export async function adminLogin(
  usuario: string,
  pass?: string,
): Promise<{ idAsamblea: number; token: string }> {
  const config = getConfig();
  const data = await callService(1, {
    usuario,
    pass: pass || config.apiKey,
    token: '',
  });

  // The response may be JSON or raw SQL text depending on the server environment
  if (data && typeof data === 'object') {
    const arr = Array.isArray(data) ? data : [data];
    const record = arr[0] as Record<string, unknown>;

    if (record.token && record.token !== 'undefined') {
      cachedToken = String(record.token);
      cachedAssemblyId = Number(record.idAsamblea) || cachedAssemblyId;
      logger.info('Admin login successful (token from response)', { idAsamblea: cachedAssemblyId });
      return { idAsamblea: cachedAssemblyId ?? 0, token: cachedToken };
    }
  }

  // Fallback: use the API key as the token (works for this API)
  cachedToken = config.apiKey;
  logger.info('Admin login successful (using API key as token)', { idAsamblea: cachedAssemblyId });
  return { idAsamblea: cachedAssemblyId ?? 0, token: cachedToken };
}

/**
 * Get the current session token, initializing from API key if needed.
 */
export function getToken(): string {
  return ensureToken();
}

/**
 * Get the current assembly ID, or throw if not logged in.
 */
export function getAssemblyId(): number {
  if (cachedAssemblyId == null) {
    throw new Error('No assembly selected. Call adminLogin() first.');
  }
  return cachedAssemblyId;
}

/**
 * Set assembly context explicitly (e.g. from an eventId).
 */
export function setAssemblyContext(idAsamblea: number, token?: string): void {
  cachedAssemblyId = idAsamblea;
  if (token) cachedToken = token;
}

// ──────────────────────────────────────────────
// Service wrappers (read-only for Robinson)
// ──────────────────────────────────────────────

/**
 * Service 1003 — Assembly metadata.
 * Returns full asambleas row.
 */
export async function fetchAssemblyMetadata(
  idAsamblea: number,
): Promise<Record<string, unknown>> {
  const data = await callService(1003, {
    token: getToken(),
    idAsamblea,
  });

  const arr = Array.isArray(data) ? data : [data];
  return arr[0] as Record<string, unknown>;
}

/**
 * Service 3 — Attendance/delegate list from `listadelegados` view.
 */
export async function fetchAttendanceList(
  idAsamblea: number,
): Promise<Record<string, unknown>[]> {
  const data = await callService(3, {
    token: getToken(),
    idAsamblea,
  });

  if (!Array.isArray(data)) {
    logger.warn('fetchAttendanceList: expected array', { data });
    return [];
  }
  return data as Record<string, unknown>[];
}

/**
 * Service 5 — List all questions for an assembly.
 */
export async function fetchQuestionList(
  idAsamblea: number,
): Promise<Record<string, unknown>[]> {
  const data = await callService(5, {
    token: getToken(),
    idAsamblea,
  });

  if (!Array.isArray(data)) return [];
  return data as Record<string, unknown>[];
}

/**
 * Service 1002 — Voting scrutiny (from `escrutiniovotacion` view).
 */
export async function fetchVotingScrutiny(
  idAsamblea: number,
  idPregunta: number,
): Promise<Record<string, unknown>[]> {
  const data = await callService(1002, {
    token: getToken(),
    idAsamblea,
    idPregunta,
  });

  if (!Array.isArray(data)) return [];
  return data as Record<string, unknown>[];
}

/**
 * Service 1012 — Aggregated voting results (texto, conteo, nominal, coeficiente).
 */
export async function fetchVotingResults(
  idAsamblea: number,
  idPregunta: number,
  opciones: number = 1,
): Promise<Record<string, unknown>[]> {
  const data = await callService(1012, {
    idAsamblea,
    idPregunta,
    opciones,
  });

  if (!Array.isArray(data)) return [];
  return data as Record<string, unknown>[];
}

/**
 * Service 1007 — Assembly status from `estadoasamblea` view.
 * Contains quorum percentages, attendee counts, state, etc.
 */
export async function fetchAssemblyStatus(
  idAsamblea: number,
): Promise<Record<string, unknown>> {
  const data = await callService(1007, {
    token: getToken(),
    idAsamblea,
  });

  const arr = Array.isArray(data) ? data : [data];
  return arr[0] as Record<string, unknown>;
}

/**
 * Service 62 — Quorum snapshot for a closed question.
 */
export async function fetchQuorumSnapshot(
  idAsamblea: number,
  idPregunta: number,
): Promise<Record<string, unknown> | null> {
  const data = await callService(62, {
    a: idAsamblea,
    p: idPregunta,
  });

  const arr = Array.isArray(data) ? data : [];
  return arr.length > 0 ? (arr[0] as Record<string, unknown>) : null;
}

/**
 * Service 8 — Administrator info.
 */
export async function fetchAdminInfo(): Promise<Record<string, unknown>> {
  const data = await callService(8, {
    token: getToken(),
  });

  const arr = Array.isArray(data) ? data : [data];
  return arr[0] as Record<string, unknown>;
}

/**
 * Service 9 — List active assemblies.
 */
export async function fetchActiveAssemblies(): Promise<Record<string, unknown>[]> {
  const data = await callService(9, { token: ensureToken() });
  if (!Array.isArray(data)) return [];
  return data as Record<string, unknown>[];
}

// ──────────────────────────────────────────────
// Data Mappers — transform PHP responses to shared types
// ──────────────────────────────────────────────

/**
 * Maps raw attendance rows from `listadelegados` view
 * to the shared AttendanceRecord type.
 */
export function mapAttendance(rawData: unknown): AttendanceRecord[] {
  if (!Array.isArray(rawData)) {
    logger.warn('mapAttendance received non-array data');
    return [];
  }

  return rawData.map((item: Record<string, unknown>) => {
    // Determine attendance status from tipoRepresentacion field
    const tipo = String(item.tipoRepresentacion || '');
    let status: AttendanceRecord['status'];
    if (!item.fhultimoingreso && tipo === '') {
      status = AttendanceStatus.ABSENT;
    } else if (tipo === 'D') {
      status = AttendanceStatus.DELEGATED_PROXY;
    } else if (tipo === 'C') {
      // Consolidated units count as present
      status = AttendanceStatus.PRESENT_IN_ROOM;
    } else {
      // P = present (owner attending directly)
      status = AttendanceStatus.PRESENT_IN_ROOM;
    }

    return {
      tower: Number(item.idtorre || item.torre || 0),
      unit: String(item.idunidad || item.unidad || ''),
      ownerName: String(item.nombrePropietario1 || ''),
      delegateName: String(item.nombrePropietario2 || ''),
      coefficientExpected: Number(item.coeficiente || 0),
      coefficientPresent: item.fhultimoingreso ? Number(item.coeficiente || 0) : 0,
      checkInTime: String(item.fhultimoingreso || item.fhRegistro || ''),
      status,
    };
  });
}

/**
 * Maps aggregated voting results from service 1012
 * into a VotingSummary. Needs the question metadata to fill the header.
 */
export function mapVotingResults(
  questionOrRaw: Record<string, unknown>,
  results?: Record<string, unknown>[],
): VotingSummary {
  // If called with two args (new API), use structured mapping
  if (results) {
    const opciones = Number(questionOrRaw.opciones || 1);
    return {
      questionId: String(questionOrRaw.idPregunta || ''),
      questionText: String(questionOrRaw.encabezadoPregunta || ''),
      questionType: opciones > 1 ? QuestionType.MULTI_CHOICE : QuestionType.SINGLE_CHOICE,
      options: results.map((r) => ({
        label: String(r.texto || ''),
        coefficientPct: Number(r.coeficiente || 0),
        attendeePct: 0,
        nominal: Number(r.nominal || 0),
      })),
    };
  }

  // Legacy single-arg call (backward compat with robinsonService.ts)
  const data = questionOrRaw;
  return {
    questionId: String(data.idPregunta || data.pregunta_id || data.questionId || ''),
    questionText: String(data.encabezadoPregunta || data.texto_pregunta || data.questionText || ''),
    questionType: Number(data.opciones || 1) > 1 ? QuestionType.MULTI_CHOICE : QuestionType.SINGLE_CHOICE,
    options: (() => {
      const opts = data.opciones || data.options;
      if (!Array.isArray(opts)) return [];
      return (opts as Record<string, unknown>[]).map((opt) => ({
        label: String(opt.etiqueta || opt.label || ''),
        coefficientPct: Number(opt.porcentaje_coeficiente || opt.coefficientPct || 0),
        attendeePct: Number(opt.porcentaje_asistentes || opt.attendeePct || 0),
        nominal: Number(opt.nominal || 0),
      }));
    })(),
  };
}

/**
 * Maps voting scrutiny from service 1002 (`escrutiniovotacion` view)
 * into a VotingDetail.
 */
export function mapVotingDetail(
  questionIdOrRaw: string | unknown,
  rawData?: Record<string, unknown>[],
): VotingDetail {
  // New API: two-arg call
  if (typeof questionIdOrRaw === 'string' && rawData) {
    return {
      questionId: questionIdOrRaw,
      votes: rawData.map((v) => ({
        unit: String(v.idunidad || v.idUnidad || ''),
        ownerName: String(v.nombrePropietario1 || ''),
        delegateName: String(v.nombrePropietario2 || ''),
        response: String(v.texto || v.respuesta || ''),
        coefficientOwner: Number(v.coeficiente || 0),
        coefficientQuorum: Number(v.coeficienteQuorum || v.coeficiente || 0),
        nominal: Number(v.nominal || 0),
        time: String(v.fhRespuesta || v.fhrespuesta || ''),
      })),
    };
  }

  // Legacy single-arg call
  const data = questionIdOrRaw as Record<string, unknown>;
  return {
    questionId: String(data.pregunta_id || data.questionId || ''),
    votes: (() => {
      const voteArr = data.votos || data.votes;
      if (!Array.isArray(voteArr)) return [];
      return (voteArr as Record<string, unknown>[]).map((v) => ({
        unit: String(v.unidad || v.unit || ''),
        ownerName: String(v.nombre_propietario || v.ownerName || ''),
        delegateName: String(v.nombre_delegado || v.delegateName || ''),
        response: String(v.respuesta || v.response || ''),
        coefficientOwner: Number(v.coeficiente_propietario || v.coefficientOwner || 0),
        coefficientQuorum: Number(v.coeficiente_quorum || v.coefficientQuorum || 0),
        nominal: Number(v.nominal || 0),
        time: String(v.hora || v.time || ''),
      }));
    })(),
  };
}

/**
 * Maps assembly status from service 1007 (`estadoasamblea` view)
 * into a QuorumSnapshot.
 */
export function mapQuorum(rawData: unknown): QuorumSnapshot {
  const data = rawData as Record<string, unknown>;
  return {
    timestamp: String(data.fhoperacion || data.timestamp || new Date().toISOString()),
    coefficientPct: Number(data.quorum || data.porcentajeCoeficiente || 0),
    unitsPresent: Number(data.asistentes || data.unidadesPresentes || 0),
    totalUnits: Number(data.totalUnidades || data.inscritos || 0),
  };
}

/**
 * Maps a quorum snapshot from service 62.
 */
export function mapQuorumSnapshot(rawData: Record<string, unknown>): QuorumSnapshot {
  return {
    timestamp: String(rawData.fhoperacion || new Date().toISOString()),
    coefficientPct: Number(rawData.quorum || 0),
    unitsPresent: Number(rawData.asistentes || 0),
    totalUnits: 0, // Not available in quorumRespuestas directly
  };
}

// ──────────────────────────────────────────────
// Legacy fetchService shim (backward compatibility)
// ──────────────────────────────────────────────

/**
 * @deprecated Use specific fetch* functions instead.
 * Kept for backward compatibility with robinsonService.ts.
 */
export async function fetchService(
  serviceId: number,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  // Convert unknown values to string|number for callService
  const cleanParams: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'number') {
      cleanParams[key] = value;
    } else {
      cleanParams[key] = String(value ?? '');
    }
  }

  // Map internal eventId to idAsamblea if needed
  if (cleanParams['eventId'] && !cleanParams['idAsamblea']) {
    cleanParams['idAsamblea'] = cleanParams['eventId'];
    delete cleanParams['eventId'];
  }

  // Inject token if not provided
  if (!cleanParams['token']) {
    try {
      cleanParams['token'] = getToken();
    } catch {
      // Token not available — service might not require it
    }
  }

  return callService(serviceId, cleanParams);
}
