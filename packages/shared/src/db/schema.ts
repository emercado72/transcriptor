import { pgTable, text, timestamp, integer, real, jsonb, pgEnum, boolean, varchar } from 'drizzle-orm/pg-core';

// ── Enums ──
export const eventStatusEnum = pgEnum('event_status', [
  'detected', 'queued', 'preprocessing', 'transcribing',
  'sectioning', 'redacting', 'assembling', 'reviewing',
  'completed', 'failed',
]);

export const jobStatusEnum = pgEnum('job_status', [
  'pending', 'processing', 'completed', 'failed', 'retrying',
]);

export const attendanceStatusEnum = pgEnum('attendance_status', [
  'presentInRoom', 'presentVirtual', 'delegatedProxy', 'absent',
]);

export const questionTypeEnum = pgEnum('question_type', [
  'singleChoice', 'multiChoice', 'election',
]);

export const eventTypeEnum = pgEnum('event_type', [
  'ordinaria', 'extraordinaria',
]);

// ── Events ──
export const events = pgTable('events', {
  eventId: varchar('event_id', { length: 255 }).primaryKey(),
  buildingName: varchar('building_name', { length: 500 }).notNull(),
  buildingNit: varchar('building_nit', { length: 50 }).notNull(),
  city: varchar('city', { length: 255 }).notNull(),
  date: timestamp('date').notNull(),
  eventType: eventTypeEnum('event_type').notNull(),
  startTime: varchar('start_time', { length: 20 }),
  endTime: varchar('end_time', { length: 20 }),
  folderId: varchar('folder_id', { length: 500 }),
  folderPath: text('folder_path'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ── Pipeline Jobs ──
export const pipelineJobs = pgTable('pipeline_jobs', {
  jobId: varchar('job_id', { length: 255 }).primaryKey(),
  eventId: varchar('event_id', { length: 255 }).notNull().references(() => events.eventId),
  status: eventStatusEnum('status').notNull().default('detected'),
  stages: jsonb('stages').$type<object[]>().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ── Transcription Jobs ──
export const transcriptionJobs = pgTable('transcription_jobs', {
  jobId: varchar('job_id', { length: 255 }).primaryKey(),
  eventId: varchar('event_id', { length: 255 }).notNull().references(() => events.eventId),
  audioFilePath: text('audio_file_path').notNull(),
  status: jobStatusEnum('status').notNull().default('pending'),
  scribeJobId: varchar('scribe_job_id', { length: 255 }),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
});

// ── Attendance ──
export const attendance = pgTable('attendance', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  eventId: varchar('event_id', { length: 255 }).notNull().references(() => events.eventId),
  tower: integer('tower').notNull(),
  unit: varchar('unit', { length: 50 }).notNull(),
  ownerName: varchar('owner_name', { length: 500 }).notNull(),
  delegateName: varchar('delegate_name', { length: 500 }),
  coefficientExpected: real('coefficient_expected').notNull(),
  coefficientPresent: real('coefficient_present').notNull(),
  checkInTime: varchar('check_in_time', { length: 30 }),
  status: attendanceStatusEnum('status').notNull(),
});

// ── Voting Questions ──
export const votingQuestions = pgTable('voting_questions', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  eventId: varchar('event_id', { length: 255 }).notNull().references(() => events.eventId),
  questionId: varchar('question_id', { length: 255 }).notNull(),
  questionText: text('question_text').notNull(),
  questionType: questionTypeEnum('question_type').notNull(),
  options: jsonb('options').$type<object[]>().default([]),
});

// ── Individual Votes ──
export const individualVotes = pgTable('individual_votes', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  eventId: varchar('event_id', { length: 255 }).notNull().references(() => events.eventId),
  questionId: varchar('question_id', { length: 255 }).notNull(),
  unit: varchar('unit', { length: 50 }).notNull(),
  ownerName: varchar('owner_name', { length: 500 }).notNull(),
  delegateName: varchar('delegate_name', { length: 500 }),
  response: text('response').notNull(),
  coefficientOwner: real('coefficient_owner').notNull(),
  coefficientQuorum: real('coefficient_quorum').notNull(),
  nominal: integer('nominal').notNull(),
  time: varchar('time', { length: 30 }),
});

// ── Quorum Snapshots ──
export const quorumSnapshots = pgTable('quorum_snapshots', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  eventId: varchar('event_id', { length: 255 }).notNull().references(() => events.eventId),
  timestamp: varchar('timestamp', { length: 30 }).notNull(),
  coefficientPct: real('coefficient_pct').notNull(),
  unitsPresent: integer('units_present').notNull(),
  totalUnits: integer('total_units').notNull(),
});

// ── Sections ──
export const sections = pgTable('sections', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  eventId: varchar('event_id', { length: 255 }).notNull().references(() => events.eventId),
  sectionId: varchar('section_id', { length: 100 }).notNull(),
  sectionTitle: varchar('section_title', { length: 500 }).notNull(),
  sectionStyle: varchar('section_style', { length: 50 }).notNull(),
  order: integer('order').notNull(),
  content: jsonb('content').$type<object[]>().default([]),
  metadata: jsonb('metadata').$type<object>(),
  isApproved: boolean('is_approved').default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
