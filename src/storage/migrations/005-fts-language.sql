-- Migration 005: Support configurable FTS language
-- The trigger now uses a GUC variable 'app.fts_language' (default 'simple')
-- Set it per-connection: SET app.fts_language = 'russian';

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

-- Rebuild search vectors for existing entries (will use the session variable at rebuild time)
-- Run manually after setting the language: UPDATE entries SET title = title;
