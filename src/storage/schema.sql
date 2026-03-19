-- Team Memory MCP v2 — PostgreSQL Schema

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    description TEXT DEFAULT '',
    domains     TEXT[] DEFAULT ARRAY['backend','frontend','infrastructure','devops','database','testing'],
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Memory entries table
CREATE TABLE IF NOT EXISTS entries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    category    TEXT NOT NULL CHECK (category IN ('architecture','tasks','decisions','issues','progress','conventions')),
    domain      TEXT DEFAULT NULL,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    author      TEXT DEFAULT 'unknown',
    tags        TEXT[] DEFAULT '{}',
    priority    TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
    pinned      BOOLEAN NOT NULL DEFAULT FALSE,
    related_ids UUID[] DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    search_vector TSVECTOR
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_entries_project    ON entries(project_id);
CREATE INDEX IF NOT EXISTS idx_entries_category   ON entries(project_id, category);
CREATE INDEX IF NOT EXISTS idx_entries_domain     ON entries(project_id, domain);
CREATE INDEX IF NOT EXISTS idx_entries_status     ON entries(project_id, status);
CREATE INDEX IF NOT EXISTS idx_entries_updated    ON entries(updated_at);
CREATE INDEX IF NOT EXISTS idx_entries_pinned     ON entries(project_id, pinned);
CREATE INDEX IF NOT EXISTS idx_entries_search     ON entries USING GIN(search_vector);

-- Auto-update search_vector trigger
CREATE OR REPLACE FUNCTION update_search_vector()
RETURNS TRIGGER AS $$
DECLARE
    lang TEXT;
BEGIN
    -- Read language from session variable, fall back to 'simple'
    BEGIN
        lang := current_setting('app.fts_language');
    EXCEPTION WHEN OTHERS THEN
        lang := 'simple';
    END;

    NEW.search_vector :=
        setweight(to_tsvector(lang::regconfig, coalesce(NEW.title, '')), 'A') ||
        setweight(to_tsvector(lang::regconfig, coalesce(NEW.content, '')), 'B') ||
        setweight(to_tsvector(lang::regconfig, coalesce(array_to_string(NEW.tags, ' '), '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_entries_search') THEN
        CREATE TRIGGER trg_entries_search BEFORE INSERT OR UPDATE ON entries
            FOR EACH ROW EXECUTE FUNCTION update_search_vector();
    END IF;
END $$;

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_entries_updated') THEN
        CREATE TRIGGER trg_entries_updated BEFORE UPDATE ON entries
            FOR EACH ROW EXECUTE FUNCTION update_timestamp();
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_projects_updated') THEN
        CREATE TRIGGER trg_projects_updated BEFORE UPDATE ON projects
            FOR EACH ROW EXECUTE FUNCTION update_timestamp();
    END IF;
END $$;

-- Audit log table
CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL PRIMARY KEY,
    entry_id    UUID,
    project_id  UUID,
    action      TEXT NOT NULL CHECK (action IN ('create','update','delete','archive','unarchive','pin','unpin')),
    actor       TEXT NOT NULL DEFAULT 'unknown',
    changes     JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_entry    ON audit_log(entry_id);
CREATE INDEX IF NOT EXISTS idx_audit_project  ON audit_log(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_created  ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action   ON audit_log(action);

-- Entry versions (history of changes)
CREATE TABLE IF NOT EXISTS entry_versions (
    id          BIGSERIAL PRIMARY KEY,
    entry_id    UUID NOT NULL,
    version     INT NOT NULL DEFAULT 1,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    domain      TEXT,
    category    TEXT NOT NULL,
    tags        TEXT[] DEFAULT '{}',
    priority    TEXT NOT NULL,
    status      TEXT NOT NULL,
    author      TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(entry_id, version)
);

CREATE INDEX IF NOT EXISTS idx_versions_entry ON entry_versions(entry_id);

-- FK: cascade-delete versions when entry is deleted
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_entry_versions_entry_id'
          AND table_name = 'entry_versions'
    ) THEN
        -- Clean up orphaned versions first
        DELETE FROM entry_versions WHERE entry_id NOT IN (SELECT id FROM entries);
        -- Add FK
        ALTER TABLE entry_versions
            ADD CONSTRAINT fk_entry_versions_entry_id
            FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO schema_meta(key, value) VALUES ('version', '2.2.0')
    ON CONFLICT (key) DO UPDATE SET value = '2.2.0';
