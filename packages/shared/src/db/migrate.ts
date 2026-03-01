import pg from 'pg';
import { getEnvConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('migrate');

const MIGRATION_SQL = `
-- Enums
DO $$ BEGIN
  CREATE TYPE event_status AS ENUM (
    'detected', 'queued', 'preprocessing', 'transcribing',
    'sectioning', 'redacting', 'assembling', 'reviewing',
    'completed', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE job_status AS ENUM (
    'pending', 'processing', 'completed', 'failed', 'retrying'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE attendance_status AS ENUM (
    'presentInRoom', 'presentVirtual', 'delegatedProxy', 'absent'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE question_type AS ENUM (
    'singleChoice', 'multiChoice', 'election'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE event_type AS ENUM (
    'ordinaria', 'extraordinaria'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Events
CREATE TABLE IF NOT EXISTS events (
  event_id VARCHAR(255) PRIMARY KEY,
  building_name VARCHAR(500) NOT NULL,
  building_nit VARCHAR(50) NOT NULL,
  city VARCHAR(255) NOT NULL,
  date TIMESTAMP NOT NULL,
  event_type event_type NOT NULL,
  start_time VARCHAR(20),
  end_time VARCHAR(20),
  folder_id VARCHAR(500),
  folder_path TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Pipeline Jobs
CREATE TABLE IF NOT EXISTS pipeline_jobs (
  job_id VARCHAR(255) PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL REFERENCES events(event_id),
  status event_status NOT NULL DEFAULT 'detected',
  stages JSONB DEFAULT '[]',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Transcription Jobs
CREATE TABLE IF NOT EXISTS transcription_jobs (
  job_id VARCHAR(255) PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL REFERENCES events(event_id),
  audio_file_path TEXT NOT NULL,
  status job_status NOT NULL DEFAULT 'pending',
  scribe_job_id VARCHAR(255),
  started_at TIMESTAMP,
  completed_at TIMESTAMP
);

-- Attendance
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL REFERENCES events(event_id),
  tower INTEGER NOT NULL,
  unit VARCHAR(50) NOT NULL,
  owner_name VARCHAR(500) NOT NULL,
  delegate_name VARCHAR(500),
  coefficient_expected REAL NOT NULL,
  coefficient_present REAL NOT NULL,
  check_in_time VARCHAR(30),
  status attendance_status NOT NULL
);

-- Voting Questions
CREATE TABLE IF NOT EXISTS voting_questions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL REFERENCES events(event_id),
  question_id VARCHAR(255) NOT NULL,
  question_text TEXT NOT NULL,
  question_type question_type NOT NULL,
  options JSONB DEFAULT '[]'
);

-- Individual Votes
CREATE TABLE IF NOT EXISTS individual_votes (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL REFERENCES events(event_id),
  question_id VARCHAR(255) NOT NULL,
  unit VARCHAR(50) NOT NULL,
  owner_name VARCHAR(500) NOT NULL,
  delegate_name VARCHAR(500),
  response TEXT NOT NULL,
  coefficient_owner REAL NOT NULL,
  coefficient_quorum REAL NOT NULL,
  nominal INTEGER NOT NULL,
  time VARCHAR(30)
);

-- Quorum Snapshots
CREATE TABLE IF NOT EXISTS quorum_snapshots (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL REFERENCES events(event_id),
  timestamp VARCHAR(30) NOT NULL,
  coefficient_pct REAL NOT NULL,
  units_present INTEGER NOT NULL,
  total_units INTEGER NOT NULL
);

-- Sections
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL REFERENCES events(event_id),
  section_id VARCHAR(100) NOT NULL,
  section_title VARCHAR(500) NOT NULL,
  section_style VARCHAR(50) NOT NULL,
  "order" INTEGER NOT NULL,
  content JSONB DEFAULT '[]',
  metadata JSONB,
  is_approved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_event_id ON pipeline_jobs(event_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_status ON pipeline_jobs(status);
CREATE INDEX IF NOT EXISTS idx_transcription_jobs_event_id ON transcription_jobs(event_id);
CREATE INDEX IF NOT EXISTS idx_attendance_event_id ON attendance(event_id);
CREATE INDEX IF NOT EXISTS idx_voting_questions_event_id ON voting_questions(event_id);
CREATE INDEX IF NOT EXISTS idx_individual_votes_event_id ON individual_votes(event_id);
CREATE INDEX IF NOT EXISTS idx_individual_votes_question_id ON individual_votes(question_id);
CREATE INDEX IF NOT EXISTS idx_quorum_snapshots_event_id ON quorum_snapshots(event_id);
CREATE INDEX IF NOT EXISTS idx_sections_event_id ON sections(event_id);
`;

async function migrate(): Promise<void> {
  const config = getEnvConfig();
  const client = new pg.Client({ connectionString: config.databaseUrl });

  try {
    await client.connect();
    logger.info('Running database migrations...');
    await client.query(MIGRATION_SQL);
    logger.info('Migrations completed successfully');
  } catch (error) {
    logger.error('Migration failed', error as Error);
    throw error;
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
