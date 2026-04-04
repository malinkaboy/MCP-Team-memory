-- Add queue-based embedding statuses for background processing
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_embedding_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_embedding_status_check
  CHECK (embedding_status IN ('queued', 'queued_embed', 'summarizing', 'embedding', 'complete', 'failed'));

-- Update default from 'pending' to 'queued'
ALTER TABLE sessions ALTER COLUMN embedding_status SET DEFAULT 'queued';

-- Migrate any old 'pending' or 'processing' statuses to 'queued'
UPDATE sessions SET embedding_status = 'queued' WHERE embedding_status IN ('pending', 'processing');
