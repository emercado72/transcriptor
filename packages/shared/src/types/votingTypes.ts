// ──────────────────────────────────────────────
// Voting & Attendance Types
// ──────────────────────────────────────────────

export type QuestionId = string;

export enum QuestionType {
  SINGLE_CHOICE = 'singleChoice',
  MULTI_CHOICE = 'multiChoice',
  ELECTION = 'election',
}

export interface VotingOption {
  label: string;
  coefficientPct: number;
  attendeePct: number;
  nominal: number;
}

export interface VotingSummary {
  questionId: QuestionId;
  questionText: string;
  questionType: QuestionType;
  options: VotingOption[];
}

export interface IndividualVote {
  unit: string;
  ownerName: string;
  delegateName: string;
  response: string;
  coefficientOwner: number;
  coefficientQuorum: number;
  nominal: number;
  time: string;
}

export interface VotingDetail {
  questionId: QuestionId;
  votes: IndividualVote[];
}

export interface CandidateResult {
  name: string;
  unit: string;
  coefficientSum: number;
  nominalSum: number;
}

export interface ElectionResult {
  questionId: QuestionId;
  candidates: CandidateResult[];
}

export enum AttendanceStatus {
  PRESENT_IN_ROOM = 'presentInRoom',
  PRESENT_VIRTUAL = 'presentVirtual',
  DELEGATED_PROXY = 'delegatedProxy',
  ABSENT = 'absent',
}

export interface AttendanceRecord {
  tower: number;
  unit: string;
  ownerName: string;
  delegateName: string;
  coefficientExpected: number;
  coefficientPresent: number;
  checkInTime: string;
  status: AttendanceStatus;
}

export interface QuorumSnapshot {
  timestamp: string;
  coefficientPct: number;
  unitsPresent: number;
  totalUnits: number;
}

export interface OfficerRoles {
  president: string;
  secretary: string;
  verificadores: string[];
}

export interface VotingPackage {
  summaries: VotingSummary[];
  details: VotingDetail[];
  elections: ElectionResult[];
  attendance: AttendanceRecord[];
  quorum: QuorumSnapshot[];
  officers: OfficerRoles;
}
