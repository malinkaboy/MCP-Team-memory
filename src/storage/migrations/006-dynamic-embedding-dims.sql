-- Migration 006: Dynamic embedding dimensions
-- Remove fixed vector size to support switching between providers (384/768/etc.)
-- HNSW index requires fixed dimensions — it will be created dynamically by the app
-- when the embedding provider is set (via setEmbeddingDimensions).

-- Store current embedding dimensions in schema_meta
INSERT INTO schema_meta(key, value) VALUES ('embedding_dimensions', '0')
    ON CONFLICT (key) DO NOTHING;

-- Drop HNSW index (it has fixed dimensions from previous migration)
DROP INDEX IF EXISTS idx_entries_embedding;

-- Change column to untyped vector (accepts any dimensionality)
ALTER TABLE entries ALTER COLUMN embedding TYPE vector;

-- NOTE: Do NOT create HNSW index here — it requires fixed dimensions.
-- The app will create it dynamically in PgStorage.setEmbeddingDimensions()
-- with the correct dimension for the active provider.
