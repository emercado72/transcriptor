// ──────────────────────────────────────────────
// Review Types — LLM-powered inconsistency detection
// ──────────────────────────────────────────────

export type ReviewItemId = string;

export type ReviewItemStatus = 'pending' | 'reviewing' | 'fixed' | 'dismissed';

export type ReviewItemType =
  | 'factual_inconsistency'
  | 'numerical_error'
  | 'speaker_attribution'
  | 'missing_content'
  | 'formatting_issue'
  | 'legal_reference'
  | 'voting_mismatch'
  | 'grammar_style'
  | 'other';

export interface ReviewItemLocation {
  /** Approximate paragraph index from top of the markdown */
  paragraphIndex: number;
  /** Text snippet from the document surrounding the issue */
  contextSnippet: string;
  /** Section heading where the issue was found */
  sectionHeading: string;
}

export interface ReviewItem {
  id: ReviewItemId;
  jobId: string;
  type: ReviewItemType;
  severity: 'critical' | 'warning' | 'info';
  status: ReviewItemStatus;
  title: string;
  description: string;
  suggestedFix: string;
  location: ReviewItemLocation;
  createdAt: string;
  updatedAt: string;
  /** Audio reference for QC — maps to Jaime segment timestamps */
  audioRef: {
    segmentFile: string | null;
    startTimeSec: number | null;
    endTimeSec: number | null;
  } | null;
}

export interface ReviewSession {
  jobId: string;
  clientName?: string;
  status: 'analyzing' | 'ready' | 'in_review' | 'completed' | 'failed';
  items: ReviewItem[];
  markdownContent: string;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  stats: {
    total: number;
    pending: number;
    reviewing: number;
    fixed: number;
    dismissed: number;
    critical: number;
    warning: number;
    info: number;
  };
}
