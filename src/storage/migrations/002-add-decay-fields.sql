-- Migration 002: Add decay fields for smart archival
-- Adds read_count and last_read_at for tracking entry usage

ALTER TABLE entries ADD COLUMN IF NOT EXISTS read_count INT NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;

-- Fix: update_timestamp() trigger must NOT update updated_at when only
-- read_count/last_read_at change, otherwise read tracking breaks
-- sync, sorting, and recency calculations.
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.read_count IS DISTINCT FROM OLD.read_count OR NEW.last_read_at IS DISTINCT FROM OLD.last_read_at)
     AND NEW.title = OLD.title AND NEW.content = OLD.content AND NEW.status = OLD.status
     AND NEW.tags = OLD.tags AND NEW.priority = OLD.priority AND NEW.pinned = OLD.pinned
     AND NEW.domain IS NOT DISTINCT FROM OLD.domain AND NEW.related_ids = OLD.related_ids
  THEN
    NEW.updated_at = OLD.updated_at;  -- preserve original updated_at for read-only changes
  ELSE
    NEW.updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
