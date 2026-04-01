import type { AppConfig } from '../config.js';
import type { MemoryManager } from '../memory/manager.js';
import type { VectorStore } from './vector-store.js';
import logger from '../logger.js';

/**
 * Shared Qdrant setup used by both HTTP (app.ts) and stdio (index.ts) entry points.
 * Creates QdrantVectorStore, ensures collections and payload indexes, wires into MemoryManager.
 * Returns the vectorStore if successful, undefined if Qdrant is unavailable.
 */
export async function setupQdrant(config: AppConfig, memoryManager: MemoryManager): Promise<VectorStore | undefined> {
  if (config.vectorStore !== 'qdrant') return undefined;

  try {
    const { QdrantVectorStore } = await import('./qdrant-store.js');
    const vectorStore = new QdrantVectorStore(config.qdrantUrl, config.qdrantApiKey);

    const dims = memoryManager.getEmbeddingProvider()?.dimensions ?? 768;

    // Entries collection
    await vectorStore.ensureCollection('entries', dims);
    await vectorStore.createPayloadIndex('entries', 'project_id', 'keyword');
    await vectorStore.createPayloadIndex('entries', 'category', 'keyword');
    await vectorStore.createPayloadIndex('entries', 'status', 'keyword');
    await vectorStore.createPayloadIndex('entries', 'author', 'keyword');
    await vectorStore.createPayloadIndex('entries', 'domain', 'keyword');

    // Personal notes collection
    await vectorStore.ensureCollection('personal_notes', dims);
    await vectorStore.createPayloadIndex('personal_notes', 'agent_token_id', 'keyword');
    await vectorStore.createPayloadIndex('personal_notes', 'project_id', 'keyword');
    await vectorStore.createPayloadIndex('personal_notes', 'session_id', 'keyword');

    memoryManager.setVectorStore(vectorStore);
    logger.info({ url: config.qdrantUrl }, 'Qdrant vector store connected');
    return vectorStore;
  } catch (err) {
    logger.warn({ err }, 'Failed to connect to Qdrant — vector search will use pgvector fallback');
    return undefined;
  }
}
