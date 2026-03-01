import axios from 'axios';
import { getEnvConfig, createLogger, AttendanceStatus, QuestionType } from '@transcriptor/shared';
import type { AttendanceRecord, VotingSummary, VotingDetail, QuorumSnapshot } from '@transcriptor/shared';

const logger = createLogger('robinson:tecnoreuniones');

interface TecnoreunionesConfig {
  apiUrl: string;
  apiKey: string;
}

function getConfig(): TecnoreunionesConfig {
  const env = getEnvConfig();
  return {
    apiUrl: env.tecnoreunionesApiUrl,
    apiKey: env.tecnoreunionesApiKey,
  };
}

export async function fetchService(serviceId: number, params: Record<string, unknown> = {}): Promise<unknown> {
  const config = getConfig();
  logger.info(`Fetching service ${serviceId}`, { params });

  const response = await axios.post(`${config.apiUrl}/service/${serviceId}`, params, {
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  return response.data;
}

export function mapAttendance(rawData: unknown): AttendanceRecord[] {
  if (!Array.isArray(rawData)) {
    logger.warn('mapAttendance received non-array data');
    return [];
  }

  return rawData.map((item: Record<string, unknown>) => ({
    tower: Number(item.torre || item.tower || 0),
    unit: String(item.unidad || item.unit || ''),
    ownerName: String(item.nombre_propietario || item.ownerName || ''),
    delegateName: String(item.nombre_delegado || item.delegateName || ''),
    coefficientExpected: Number(item.coeficiente_esperado || item.coefficientExpected || 0),
    coefficientPresent: Number(item.coeficiente_presente || item.coefficientPresent || 0),
    checkInTime: String(item.hora_registro || item.checkInTime || ''),
    status: mapAttendanceStatus(item.estado || item.status),
  }));
}

function mapAttendanceStatus(status: unknown): AttendanceRecord['status'] {
  const statusMap: Record<string, AttendanceRecord['status']> = {
    'presencial': AttendanceStatus.PRESENT_IN_ROOM,
    'virtual': AttendanceStatus.PRESENT_VIRTUAL,
    'poder': AttendanceStatus.DELEGATED_PROXY,
    'ausente': AttendanceStatus.ABSENT,
    'presentInRoom': AttendanceStatus.PRESENT_IN_ROOM,
    'presentVirtual': AttendanceStatus.PRESENT_VIRTUAL,
    'delegatedProxy': AttendanceStatus.DELEGATED_PROXY,
    'absent': AttendanceStatus.ABSENT,
  };
  return statusMap[String(status)] || AttendanceStatus.ABSENT;
}

export function mapVotingResults(rawData: unknown): VotingSummary {
  const data = rawData as Record<string, unknown>;
  return {
    questionId: String(data.pregunta_id || data.questionId || ''),
    questionText: String(data.texto_pregunta || data.questionText || ''),
    questionType: mapQuestionType(data.tipo_pregunta || data.questionType),
    options: (() => {
      const opts = data.opciones || data.options;
      if (!Array.isArray(opts)) return [];
      return opts.map((opt: Record<string, unknown>) => ({
        label: String(opt.etiqueta || opt.label || ''),
        coefficientPct: Number(opt.porcentaje_coeficiente || opt.coefficientPct || 0),
        attendeePct: Number(opt.porcentaje_asistentes || opt.attendeePct || 0),
        nominal: Number(opt.nominal || 0),
      }));
    })(),
  };
}

function mapQuestionType(type: unknown): VotingSummary['questionType'] {
  const typeMap: Record<string, VotingSummary['questionType']> = {
    'seleccion_unica': QuestionType.SINGLE_CHOICE,
    'seleccion_multiple': QuestionType.MULTI_CHOICE,
    'eleccion': QuestionType.ELECTION,
    'singleChoice': QuestionType.SINGLE_CHOICE,
    'multiChoice': QuestionType.MULTI_CHOICE,
    'election': QuestionType.ELECTION,
  };
  return typeMap[String(type)] || QuestionType.SINGLE_CHOICE;
}

export function mapVotingDetail(rawData: unknown): VotingDetail {
  const data = rawData as Record<string, unknown>;
  return {
    questionId: String(data.pregunta_id || data.questionId || ''),
    votes: (() => {
      const voteArr = data.votos || data.votes;
      if (!Array.isArray(voteArr)) return [];
      return voteArr.map((v: Record<string, unknown>) => ({
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

export function mapQuorum(rawData: unknown): QuorumSnapshot {
  const data = rawData as Record<string, unknown>;
  return {
    timestamp: String(data.fecha_hora || data.timestamp || ''),
    coefficientPct: Number(data.porcentaje_coeficiente || data.coefficientPct || 0),
    unitsPresent: Number(data.unidades_presentes || data.unitsPresent || 0),
    totalUnits: Number(data.total_unidades || data.totalUnits || 0),
  };
}
