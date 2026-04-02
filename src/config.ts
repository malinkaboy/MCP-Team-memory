/**
 * Centralized configuration from environment variables
 */

export interface AppConfig {
  databaseUrl: string;
  transport: 'http' | 'stdio';
  port: number;
  autoArchiveEnabled: boolean;
  autoArchiveDays: number;
  apiToken: string | undefined;
  logLevel: string;
  // Decay config — undefined means use old time-based archival
  decayThreshold: number | undefined;
  decayDays: number;
  decayWeights: [number, number, number, number];
  // FTS config
  ftsLanguage: string;  // PostgreSQL text search config: 'simple', 'russian', 'english', etc.
  // Embedding config
  embeddingProvider: string | undefined;  // 'local' | 'gemini' | 'ollama' | undefined (disabled)
  embeddingModelDir: string;
  geminiApiKey: string | undefined;
  ollamaUrl: string;
  ollamaEmbeddingModel: string;
  // Qdrant / Vector Store
  vectorStore: 'qdrant' | 'pgvector';
  qdrantUrl: string;
  qdrantApiKey: string | undefined;
}

/** Parse integer with fallback to default on NaN */
export function parseIntSafe(value: string, defaultValue: number): number {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

export function loadConfig(): AppConfig {
  const decayWeightsRaw = process.env.MEMORY_DECAY_WEIGHTS || '0.3,0.2,0.3,0.2';
  const decayWeights = decayWeightsRaw.split(',').map(Number) as [number, number, number, number];

  return {
    databaseUrl: process.env.DATABASE_URL || 'postgresql://memory:memory@localhost:5432/team_memory',
    transport: (process.env.MEMORY_TRANSPORT as 'http' | 'stdio') || 'http',
    port: parseIntSafe(process.env.MEMORY_PORT || '3846', 3846),
    autoArchiveEnabled: process.env.MEMORY_AUTO_ARCHIVE !== 'false',
    autoArchiveDays: parseIntSafe(process.env.MEMORY_AUTO_ARCHIVE_DAYS || '14', 14),
    apiToken: process.env.MEMORY_API_TOKEN || undefined,
    logLevel: process.env.LOG_LEVEL || 'info',
    decayThreshold: process.env.MEMORY_DECAY_THRESHOLD
      ? parseFloat(process.env.MEMORY_DECAY_THRESHOLD)
      : undefined,
    decayDays: parseIntSafe(process.env.MEMORY_DECAY_DAYS || '30', 30),
    decayWeights,
    ftsLanguage: process.env.MEMORY_FTS_LANGUAGE || 'simple',
    embeddingProvider: process.env.MEMORY_EMBEDDING_PROVIDER || undefined,
    embeddingModelDir: process.env.MEMORY_EMBEDDING_MODEL_DIR || 'data/models',
    geminiApiKey: process.env.GEMINI_API_KEY || undefined,
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    ollamaEmbeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text-v2-moe',
    vectorStore: (process.env.VECTOR_STORE as 'qdrant' | 'pgvector') || 'pgvector',
    qdrantUrl: process.env.QDRANT_URL || 'http://localhost:6333',
    qdrantApiKey: process.env.QDRANT_API_KEY || undefined,
  };
}
