-- Reference schema. Already applied to the habla database.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE learners (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ DEFAULT now(),
  cefr_level      TEXT DEFAULT 'A1',
  session_count   INTEGER DEFAULT 0,
  learner_core    JSONB DEFAULT '{}',
  tutor_core      JSONB DEFAULT '{}',
  core_version    INTEGER DEFAULT 0
);

CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_id      UUID REFERENCES learners(id),
  started_at      TIMESTAMPTZ DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  transcript      JSONB DEFAULT '[]',
  pre_cores       JSONB,
  post_cores      JSONB,
  compaction_log  TEXT
);

CREATE TABLE fsrs_cards (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_id      UUID REFERENCES learners(id),
  item_type       TEXT NOT NULL,
  item_key        TEXT NOT NULL,
  item_context    TEXT,
  due             TIMESTAMPTZ NOT NULL DEFAULT now(),
  stability       REAL DEFAULT 0,
  difficulty      REAL DEFAULT 0,
  elapsed_days    REAL DEFAULT 0,
  scheduled_days  REAL DEFAULT 0,
  reps            INTEGER DEFAULT 0,
  lapses          INTEGER DEFAULT 0,
  state           INTEGER DEFAULT 0,
  last_review     TIMESTAMPTZ,
  UNIQUE(learner_id, item_type, item_key)
);

CREATE INDEX idx_fsrs_due ON fsrs_cards(learner_id, due);
