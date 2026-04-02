-- Migration 013: Sessions + session messages + FK for personal_notes
--
-- IMPORTANT: Cannot reuse update_search_vector() because:
--   - sessions has `name`/`summary` instead of `title`/`content`
--   - session_messages has only `content`, no `title` or `tags`
-- Dedicated FTS functions for each table.

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_token_id UUID NOT NULL REFERENCES agent_tokens(id),
  project_id UUID REFERENCES projects(id),

  external_id TEXT,
  name TEXT,
  summary TEXT NOT NULL,
  working_directory TEXT,
  git_branch TEXT,

  message_count INT DEFAULT 0,
  embedding_status TEXT DEFAULT 'pending'
    CHECK (embedding_status IN ('pending', 'processing', 'complete', 'failed')),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ DEFAULT NOW(),

  tags TEXT[] DEFAULT '{}',
  search_vector TSVECTOR,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(agent_token_id, external_id)
);

CREATE TABLE IF NOT EXISTS session_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  message_index INT NOT NULL,

  has_tool_use BOOLEAN DEFAULT FALSE,
  tool_names TEXT[] DEFAULT '{}',

  timestamp TIMESTAMPTZ,
  search_vector TSVECTOR,

  UNIQUE(session_id, message_index)
);

-- Session indexes
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_token_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_external ON sessions(agent_token_id, external_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(agent_token_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_search ON sessions USING GIN(search_vector);

-- Message indexes
CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_session_messages_search ON session_messages USING GIN(search_vector);

-- Dedicated FTS function for sessions (uses name/summary/tags, NOT title/content)
CREATE OR REPLACE FUNCTION update_sessions_search_vector()
RETURNS TRIGGER AS $$
DECLARE
    lang TEXT;
BEGIN
    lang := COALESCE(current_setting('app.fts_language', true), 'simple');
    NEW.search_vector :=
        setweight(to_tsvector(lang::regconfig, coalesce(NEW.name, '')), 'A') ||
        setweight(to_tsvector(lang::regconfig, coalesce(NEW.summary, '')), 'B') ||
        setweight(to_tsvector(lang::regconfig, coalesce(array_to_string(NEW.tags, ' '), '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Dedicated FTS function for session_messages (only content, no title/tags)
CREATE OR REPLACE FUNCTION update_session_messages_search_vector()
RETURNS TRIGGER AS $$
DECLARE
    lang TEXT;
BEGIN
    lang := COALESCE(current_setting('app.fts_language', true), 'simple');
    NEW.search_vector :=
        setweight(to_tsvector(lang::regconfig, coalesce(NEW.content, '')), 'A');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- FTS triggers using dedicated functions
DROP TRIGGER IF EXISTS trg_sessions_search ON sessions;
CREATE TRIGGER trg_sessions_search
  BEFORE INSERT OR UPDATE OF name, summary, tags ON sessions
  FOR EACH ROW EXECUTE FUNCTION update_sessions_search_vector();

DROP TRIGGER IF EXISTS trg_session_messages_search ON session_messages;
CREATE TRIGGER trg_session_messages_search
  BEFORE INSERT OR UPDATE OF content ON session_messages
  FOR EACH ROW EXECUTE FUNCTION update_session_messages_search_vector();

-- Timestamp trigger for sessions (separate function — sessions lacks entries-specific columns)
CREATE OR REPLACE FUNCTION update_sessions_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_sessions_timestamp ON sessions;
CREATE TRIGGER update_sessions_timestamp
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION update_sessions_timestamp();

-- Add FK from personal_notes.session_id now that sessions table exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_personal_notes_session'
  ) THEN
    ALTER TABLE personal_notes
      ADD CONSTRAINT fk_personal_notes_session
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;
  END IF;
END$$;

-- Update schema version
UPDATE schema_meta SET value = '2.5.0' WHERE key = 'version';
