import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger (default export)
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock @qdrant/js-client-rest
const mockClient = {
  collectionExists: vi.fn(),
  createCollection: vi.fn(),
  createPayloadIndex: vi.fn(),
  upsert: vi.fn(),
  search: vi.fn(),
  delete: vi.fn(),
};

vi.mock('@qdrant/js-client-rest', () => {
  return {
    QdrantClient: class MockQdrantClient {
      constructor() {
        return mockClient;
      }
    },
  };
});

import { QdrantVectorStore } from '../vector/qdrant-store.js';

describe('QdrantVectorStore', () => {
  let store: QdrantVectorStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new QdrantVectorStore('http://localhost:6333');
  });

  describe('ensureCollection', () => {
    it('creates collection when it does not exist', async () => {
      mockClient.collectionExists.mockResolvedValue({ exists: false });
      mockClient.createCollection.mockResolvedValue(true);

      await store.ensureCollection('test', 768, { distance: 'Cosine' });

      expect(mockClient.createCollection).toHaveBeenCalledWith('test', {
        vectors: { size: 768, distance: 'Cosine' },
      });
    });

    it('skips creation when collection exists', async () => {
      mockClient.collectionExists.mockResolvedValue({ exists: true });

      await store.ensureCollection('test', 768);

      expect(mockClient.createCollection).not.toHaveBeenCalled();
    });

    it('applies scalar quantization when requested', async () => {
      mockClient.collectionExists.mockResolvedValue({ exists: false });
      mockClient.createCollection.mockResolvedValue(true);

      await store.ensureCollection('test', 768, { quantization: 'scalar' });

      expect(mockClient.createCollection).toHaveBeenCalledWith('test', expect.objectContaining({
        vectors: { size: 768, distance: 'Cosine' },
        quantization_config: { scalar: { type: 'int8', always_ram: true } },
      }));
    });
  });

  describe('createPayloadIndex', () => {
    it('creates index for a field', async () => {
      mockClient.createPayloadIndex.mockResolvedValue(true);

      await store.createPayloadIndex('test', 'project_id', 'keyword');

      expect(mockClient.createPayloadIndex).toHaveBeenCalledWith('test', {
        field_name: 'project_id',
        field_schema: 'keyword',
      });
    });
  });

  describe('upsert', () => {
    it('upserts a single point', async () => {
      mockClient.upsert.mockResolvedValue(true);
      const vector = Array(768).fill(0.1);

      await store.upsert('test', 'id-1', vector, { key: 'value' });

      expect(mockClient.upsert).toHaveBeenCalledWith('test', {
        wait: true,
        points: [{ id: 'id-1', vector, payload: { key: 'value' } }],
      });
    });
  });

  describe('upsertBatch', () => {
    it('upserts multiple points', async () => {
      mockClient.upsert.mockResolvedValue(true);
      const points = [
        { id: 'a', vector: [0.1], payload: {} },
        { id: 'b', vector: [0.2], payload: {} },
      ];

      await store.upsertBatch('test', points);

      expect(mockClient.upsert).toHaveBeenCalledWith('test', {
        wait: true,
        points: [
          { id: 'a', vector: [0.1], payload: {} },
          { id: 'b', vector: [0.2], payload: {} },
        ],
      });
    });

    it('skips empty batch', async () => {
      await store.upsertBatch('test', []);

      expect(mockClient.upsert).not.toHaveBeenCalled();
    });

    it('splits into multiple batches when > 500 points', async () => {
      mockClient.upsert.mockResolvedValue(true);
      const points = Array.from({ length: 501 }, (_, i) => ({
        id: `id-${i}`,
        vector: [0.1],
        payload: {},
      }));

      await store.upsertBatch('test', points);

      // 501 points / 500 batch size = 2 upsert calls
      expect(mockClient.upsert).toHaveBeenCalledTimes(2);
      // First batch: 500 points
      expect(mockClient.upsert.mock.calls[0][1].points).toHaveLength(500);
      // Second batch: 1 point
      expect(mockClient.upsert.mock.calls[1][1].points).toHaveLength(1);
    });
  });

  describe('search', () => {
    it('returns scored results with payload', async () => {
      mockClient.search.mockResolvedValue([
        { id: 'id-1', score: 0.95, payload: { entry_id: 'abc' } },
        { id: 'id-2', score: 0.80, payload: { entry_id: 'def' } },
      ]);

      const results = await store.search('test', [0.1], undefined, 5);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ id: 'id-1', score: 0.95, payload: { entry_id: 'abc' } });
    });

    it('passes filter to Qdrant', async () => {
      mockClient.search.mockResolvedValue([]);
      const filter = { must: [{ key: 'project_id', match: { value: 'proj-1' } }] };

      await store.search('test', [0.1], filter, 10);

      expect(mockClient.search).toHaveBeenCalledWith('test', {
        vector: [0.1],
        filter,
        limit: 10,
      });
    });
  });

  describe('delete', () => {
    it('deletes by IDs', async () => {
      mockClient.delete.mockResolvedValue(true);

      await store.delete('test', ['id-1', 'id-2']);

      expect(mockClient.delete).toHaveBeenCalledWith('test', {
        wait: true,
        points: ['id-1', 'id-2'],
      });
    });

    it('skips empty delete', async () => {
      await store.delete('test', []);

      expect(mockClient.delete).not.toHaveBeenCalled();
    });
  });

  describe('deleteByFilter', () => {
    it('deletes by filter', async () => {
      mockClient.delete.mockResolvedValue(true);
      const filter = { must: [{ key: 'session_id', match: { value: 'sess-1' } }] };

      await store.deleteByFilter('test', filter);

      expect(mockClient.delete).toHaveBeenCalledWith('test', {
        wait: true,
        filter,
      });
    });
  });

  describe('collectionExists', () => {
    it('returns true when exists', async () => {
      mockClient.collectionExists.mockResolvedValue({ exists: true });
      expect(await store.collectionExists('test')).toBe(true);
    });

    it('returns false when not exists', async () => {
      mockClient.collectionExists.mockResolvedValue({ exists: false });
      expect(await store.collectionExists('test')).toBe(false);
    });
  });
});
