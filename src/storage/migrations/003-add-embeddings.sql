-- Migration 003: Add vector embeddings for semantic search
-- Requires pgvector extension (pgvector/pgvector:pg16 Docker image)

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE entries ADD COLUMN IF NOT EXISTS embedding vector(384);

-- HNSW index: works at any scale (unlike IVFFlat which fails on small tables)
CREATE INDEX IF NOT EXISTS idx_entries_embedding
  ON entries USING hnsw (embedding vector_cosine_ops);
