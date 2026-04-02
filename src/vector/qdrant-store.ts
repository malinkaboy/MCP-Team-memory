import { QdrantClient } from '@qdrant/js-client-rest';
import type {
  VectorStore,
  VectorStoreSearchResult,
  VectorFilter,
  VectorPoint,
  CollectionOptions,
} from './vector-store.js';
import logger from '../logger.js';

export class QdrantVectorStore implements VectorStore {
  private client: QdrantClient;

  constructor(url: string, apiKey?: string) {
    this.client = new QdrantClient({ url, apiKey });
  }

  async ensureCollection(name: string, dimensions: number, options?: CollectionOptions): Promise<void> {
    const { exists } = await this.client.collectionExists(name);
    if (exists) return;

    const config: Record<string, unknown> = {
      vectors: {
        size: dimensions,
        distance: options?.distance ?? 'Cosine',
      },
    };

    if (options?.quantization === 'scalar') {
      config.quantization_config = { scalar: { type: 'int8', always_ram: true } };
    } else if (options?.quantization === 'binary') {
      config.quantization_config = { binary: { always_ram: true } };
    }

    if (options?.onDisk) {
      (config.vectors as Record<string, unknown>).on_disk = true;
    }

    await this.client.createCollection(name, config);
    logger.info({ collection: name, dimensions }, 'Created Qdrant collection');
  }

  async createPayloadIndex(collection: string, field: string, schema: 'keyword' | 'integer' | 'bool'): Promise<void> {
    // Qdrant createPayloadIndex is idempotent — safe to call on startup
    await this.client.createPayloadIndex(collection, {
      field_name: field,
      field_schema: schema,
    });
  }

  async upsert(collection: string, id: string, vector: number[], payload: Record<string, unknown>): Promise<void> {
    await this.client.upsert(collection, {
      wait: true,
      points: [{ id, vector, payload }],
    });
  }

  async upsertBatch(collection: string, points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;

    const BATCH_SIZE = 500;
    for (let i = 0; i < points.length; i += BATCH_SIZE) {
      const batch = points.slice(i, i + BATCH_SIZE);
      try {
        await this.client.upsert(collection, {
          wait: true,
          points: batch.map(p => ({ id: p.id, vector: p.vector, payload: p.payload })),
        });
      } catch (err) {
        logger.error({ collection, batchIndex: Math.floor(i / BATCH_SIZE), totalPoints: points.length, err },
          'Qdrant batch upsert failed');
        throw err;
      }
    }
  }

  async search(
    collection: string,
    vector: number[],
    filter?: VectorFilter,
    limit: number = 10,
  ): Promise<VectorStoreSearchResult[]> {
    const results = await this.client.search(collection, {
      vector,
      filter,
      limit,
    });

    return results.map(r => ({
      id: String(r.id),
      score: r.score,
      payload: (r.payload ?? {}) as Record<string, unknown>,
    }));
  }

  async setPayload(collection: string, id: string, payload: Record<string, unknown>): Promise<void> {
    await this.client.setPayload(collection, {
      wait: true,
      points: [id],
      payload,
    });
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.delete(collection, {
      wait: true,
      points: ids,
    });
  }

  async deleteByFilter(collection: string, filter: VectorFilter): Promise<void> {
    await this.client.delete(collection, {
      wait: true,
      filter,
    });
  }

  async getPointCount(collection: string): Promise<number> {
    try {
      const info = await this.client.getCollection(collection);
      return info.points_count ?? -1;
    } catch {
      return -1;
    }
  }

  async collectionExists(name: string): Promise<boolean> {
    const { exists } = await this.client.collectionExists(name);
    return exists;
  }

  async close(): Promise<void> {
    // QdrantClient doesn't require explicit close
  }
}
