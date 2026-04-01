-- Migration 011: Drop pgvector embedding column
-- Run AFTER Qdrant migration has been validated
-- Embeddings are now stored in Qdrant

-- Drop HNSW index on embedding column
DROP INDEX IF EXISTS idx_entries_embedding;

-- Drop the embedding column from entries table
ALTER TABLE entries DROP COLUMN IF EXISTS embedding;

-- Update schema version
UPDATE schema_meta SET value = '2.3.0' WHERE key = 'version';
