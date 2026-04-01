import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryManager } from '../memory/manager.js';
import type { VectorStore } from '../vector/vector-store.js';
import type { MemoryEntry } from '../memory/types.js';

const mockEntry: MemoryEntry = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  projectId: '00000000-0000-0000-0000-000000000000',
  category: 'tasks',
  domain: null,
  title: 'Test Entry',
  content: 'Test content',
  author: 'test-agent',
  tags: ['test'],
  priority: 'medium',
  status: 'active',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  relatedIds: [],
};

function createMockStorage() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue([mockEntry]),
    search: vi.fn().mockResolvedValue([mockEntry]),
    hybridSearch: vi.fn().mockResolvedValue([mockEntry]),
    add: vi.fn().mockImplementation(async (entry: MemoryEntry) => entry),
    update: vi.fn().mockImplementation(async (_id: string, updates: Partial<MemoryEntry>) => ({
      ...mockEntry,
      ...updates,
    })),
    delete: vi.fn().mockResolvedValue(true),
    archive: vi.fn().mockResolvedValue({ ...mockEntry, status: 'archived' }),
    getById: vi.fn().mockResolvedValue(mockEntry),
    getByIds: vi.fn().mockResolvedValue([mockEntry]),
    getChangesSince: vi.fn().mockResolvedValue([mockEntry]),
    getLastUpdated: vi.fn().mockResolvedValue('2026-01-01T00:00:00.000Z'),
    getStats: vi.fn().mockResolvedValue({ total: 0, byCategory: {}, byPriority: {}, byStatus: {} }),
    archiveOldEntries: vi.fn().mockResolvedValue(0),
    count: vi.fn().mockResolvedValue(1),
    getProject: vi.fn().mockResolvedValue(null),
    createProject: vi.fn().mockResolvedValue({ id: 'proj-1', name: 'Test' }),
    listProjects: vi.fn().mockResolvedValue([]),
    updateProject: vi.fn().mockResolvedValue(undefined),
    deleteProject: vi.fn().mockResolvedValue(true),
    saveEmbedding: vi.fn().mockResolvedValue(undefined),
    getEmbeddingDimensions: vi.fn().mockResolvedValue(768),
    setEmbeddingDimensions: vi.fn().mockResolvedValue(undefined),
    clearAllEmbeddings: vi.fn().mockResolvedValue(0),
    trackReads: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockVectorStore(): VectorStore {
  return {
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    upsertBatch: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteByFilter: vi.fn().mockResolvedValue(undefined),
    createPayloadIndex: vi.fn().mockResolvedValue(undefined),
    collectionExists: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockEmbedding() {
  return {
    embed: vi.fn().mockResolvedValue(Array(768).fill(0.1)),
    embedBatch: vi.fn().mockResolvedValue([Array(768).fill(0.1)]),
    isReady: vi.fn().mockReturnValue(true),
    dimensions: 768,
    modelName: 'test-model',
    providerType: 'ollama' as const,
  };
}

describe('MemoryManager with VectorStore', () => {
  let manager: MemoryManager;
  let storage: ReturnType<typeof createMockStorage>;
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let embedding: ReturnType<typeof createMockEmbedding>;

  beforeEach(async () => {
    storage = createMockStorage();
    vectorStore = createMockVectorStore();
    embedding = createMockEmbedding();
    manager = new MemoryManager(storage as any);
    manager.setVectorStore(vectorStore);
    await manager.setEmbeddingProvider(embedding as any);
  });

  it('upserts to Qdrant on write', async () => {
    await manager.write({
      category: 'tasks',
      title: 'Test task',
      content: 'Test content',
    });

    // Wait for async embedding
    await vi.waitFor(() => {
      expect(vectorStore.upsert).toHaveBeenCalled();
    }, { timeout: 200 });

    expect(vectorStore.upsert).toHaveBeenCalledWith(
      'entries',
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        entry_id: expect.any(String),
        project_id: '00000000-0000-0000-0000-000000000000',
        category: 'tasks',
      }),
    );
  });

  it('also saves to pgvector for backward compat during migration', async () => {
    await manager.write({
      category: 'tasks',
      title: 'Test',
      content: 'Content',
    });

    await vi.waitFor(() => {
      expect(storage.saveEmbedding).toHaveBeenCalled();
    }, { timeout: 200 });
  });

  it('deletes from Qdrant on hard delete', async () => {
    storage.getById.mockResolvedValue(mockEntry);
    storage.delete.mockResolvedValue(true);

    await manager.delete({ id: mockEntry.id, archive: false });

    expect(vectorStore.delete).toHaveBeenCalledWith('entries', [mockEntry.id]);
  });

  it('does NOT delete from Qdrant on archive (soft delete)', async () => {
    await manager.delete({ id: mockEntry.id, archive: true });

    expect(vectorStore.delete).not.toHaveBeenCalled();
  });

  it('re-upserts to Qdrant on update with content change', async () => {
    storage.update.mockResolvedValue({ ...mockEntry, title: 'Updated title' });

    await manager.update({ id: mockEntry.id, title: 'Updated title' });

    await vi.waitFor(() => {
      expect(vectorStore.upsert).toHaveBeenCalled();
    }, { timeout: 200 });

    expect(vectorStore.upsert).toHaveBeenCalledWith(
      'entries',
      mockEntry.id,
      expect.any(Array),
      expect.objectContaining({ entry_id: mockEntry.id }),
    );
  });

  it('falls back gracefully when vectorStore not set', async () => {
    const managerNoVS = new MemoryManager(storage as any);
    await managerNoVS.setEmbeddingProvider(embedding as any);

    // Should not throw
    await managerNoVS.write({
      category: 'tasks',
      title: 'Test',
      content: 'Content',
    });

    // Still saves to pgvector
    await vi.waitFor(() => {
      expect(storage.saveEmbedding).toHaveBeenCalled();
    }, { timeout: 200 });
  });
});
