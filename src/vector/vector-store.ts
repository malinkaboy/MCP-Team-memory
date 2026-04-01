/**
 * Abstract vector store interface.
 * Decouples embedding storage from the specific backend (Qdrant, pgvector, etc.)
 */

export interface VectorStoreSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface CollectionOptions {
  distance?: 'Cosine' | 'Euclid' | 'Dot';
  quantization?: 'scalar' | 'binary' | null;
  onDisk?: boolean;
}

export type VectorMatch =
  | { value: string | number | boolean }
  | { any: (string | number)[] };

export interface VectorFilterCondition {
  key: string;
  match: VectorMatch;
}

export interface VectorFilter {
  must?: VectorFilterCondition[];
  must_not?: VectorFilterCondition[];
  should?: VectorFilterCondition[];
}

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface VectorStore {
  /** Create collection if it doesn't exist */
  ensureCollection(name: string, dimensions: number, options?: CollectionOptions): Promise<void>;

  /** Upsert a single vector with payload */
  upsert(collection: string, id: string, vector: number[], payload: Record<string, unknown>): Promise<void>;

  /** Upsert multiple vectors in a batch */
  upsertBatch(collection: string, points: VectorPoint[]): Promise<void>;

  /** Search for nearest vectors with optional payload filtering */
  search(collection: string, vector: number[], filter?: VectorFilter, limit?: number): Promise<VectorStoreSearchResult[]>;

  /** Delete vectors by IDs */
  delete(collection: string, ids: string[]): Promise<void>;

  /** Delete vectors matching a filter */
  deleteByFilter(collection: string, filter: VectorFilter): Promise<void>;

  /** Create payload index for fast filtered search */
  createPayloadIndex(collection: string, field: string, schema: 'keyword' | 'integer' | 'bool'): Promise<void>;

  /** Check if collection exists */
  collectionExists(name: string): Promise<boolean>;

  /** Close connections */
  close(): Promise<void>;
}
