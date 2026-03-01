// ──────────────────────────────────────────────
// Section Types
// ──────────────────────────────────────────────

export type SectionId = string;

export enum SectionStyle {
  ENCABEZADO = 'encabezado',
  SUBTITULO_APERTURA = 'subtituloApertura',
  PREAMBULO = 'preambulo',
  ORDEN_DEL_DIA = 'ordenDelDia',
  SECTION_TITLE = 'sectionTitle',
  PARAGRAPH_BOLD = 'paragraphBold',
  PARAGRAPH_NORMAL = 'paragraphNormal',
  INTERVENTION = 'intervention',
  VOTING_QUESTION = 'votingQuestion',
  VOTING_RESULTS = 'votingResults',
  VOTING_ANNOUNCEMENT = 'votingAnnouncement',
  FIRMA = 'firma',
}

export interface ParagraphBlock {
  type: 'paragraph';
  bold: boolean;
  text: string;
}

export interface InterventionBlock {
  type: 'intervention';
  speaker: string;
  unit: string | null;
  text: string;
}

export interface VotingQuestionBlock {
  type: 'votingQuestion';
  questionId: string;
  text: string;
}

export interface VotingResultsBlock {
  type: 'votingResults';
  questionId: string;
  source: 'robinson';
}

export interface VotingAnnouncementBlock {
  type: 'votingAnnouncement';
  bold: boolean;
  text: string;
}

export interface ListItemBlock {
  type: 'listItem';
  text: string;
  bold: boolean;
}

export type ContentBlock =
  | ParagraphBlock
  | InterventionBlock
  | VotingQuestionBlock
  | VotingResultsBlock
  | VotingAnnouncementBlock
  | ListItemBlock;

export interface SectionMetadata {
  agent: string;
  timestamp: string;
  confidence: number;
  flags: string[];
}

export interface SectionFile {
  sectionId: SectionId;
  sectionTitle: string;
  sectionStyle: SectionStyle;
  order: number;
  content: ContentBlock[];
  metadata: SectionMetadata;
}
