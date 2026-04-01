import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotesManager } from '../notes/manager.js';

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function createMockNotesStorage() {
  return {
    create: vi.fn().mockResolvedValue({
      id: 'note-1', agentTokenId: 'tok-1', title: 'Test', content: 'Content',
      tags: [], priority: 'medium', status: 'active', projectId: null, sessionId: null,
      createdAt: '2026-01-01', updatedAt: '2026-01-01',
    }),
    getAll: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({
      id: 'note-1', agentTokenId: 'tok-1', title: 'Updated', content: 'C',
      tags: [], priority: 'medium', status: 'active', projectId: null, sessionId: null,
      createdAt: '2026-01-01', updatedAt: '2026-01-01',
    }),
    delete: vi.fn().mockResolvedValue(true),
  };
}

function createMockVectorStore() {
  return {
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    upsertBatch: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteByFilter: vi.fn().mockResolvedValue(undefined),
    setPayload: vi.fn().mockResolvedValue(undefined),
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
    modelName: 'test',
    providerType: 'ollama' as const,
  };
}

describe('NotesManager', () => {
  let manager: NotesManager;
  let storage: ReturnType<typeof createMockNotesStorage>;
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let embedding: ReturnType<typeof createMockEmbedding>;

  beforeEach(() => {
    storage = createMockNotesStorage();
    vectorStore = createMockVectorStore();
    embedding = createMockEmbedding();
    manager = new NotesManager(storage as any, vectorStore as any, embedding as any);
  });

  it('creates note and upserts embedding to Qdrant', async () => {
    const note = await manager.write('tok-1', {
      title: 'Test', content: 'Content', tags: [], priority: 'medium',
      projectId: null, sessionId: null,
    });

    expect(storage.create).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(vectorStore.upsert).toHaveBeenCalled();
    }, { timeout: 200 });

    expect(vectorStore.upsert).toHaveBeenCalledWith(
      'personal_notes', 'note-1', expect.any(Array),
      expect.objectContaining({ agent_token_id: 'tok-1' }),
    );
  });

  it('semantic search filters by agent_token_id', async () => {
    vectorStore.search.mockResolvedValue([
      { id: 'note-1', score: 0.9, payload: { note_id: 'note-1' } },
    ]);
    storage.getById.mockResolvedValue({
      id: 'note-1', title: 'Found', content: 'X', agentTokenId: 'tok-1',
      tags: [], priority: 'medium', status: 'active', projectId: null, sessionId: null,
      createdAt: '2026-01-01', updatedAt: '2026-01-01',
    });

    const results = await manager.semanticSearch('tok-1', 'test query');

    expect(vectorStore.search).toHaveBeenCalledWith(
      'personal_notes', expect.any(Array),
      expect.objectContaining({
        must: expect.arrayContaining([
          { key: 'agent_token_id', match: { value: 'tok-1' } },
        ]),
      }),
      expect.any(Number),
    );
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0.9);
  });

  it('deletes note and removes vector from Qdrant', async () => {
    await manager.delete('note-1', 'tok-1', false);

    expect(storage.delete).toHaveBeenCalledWith('note-1', 'tok-1', false);
    expect(vectorStore.delete).toHaveBeenCalledWith('personal_notes', ['note-1']);
  });

  it('archives note and updates Qdrant status', async () => {
    await manager.delete('note-1', 'tok-1', true);

    expect(storage.delete).toHaveBeenCalledWith('note-1', 'tok-1', true);
    expect(vectorStore.setPayload).toHaveBeenCalledWith('personal_notes', 'note-1', { status: 'archived' });
  });

  it('returns empty array when no embedding provider', async () => {
    const managerNoEmbed = new NotesManager(storage as any, vectorStore as any);

    const results = await managerNoEmbed.semanticSearch('tok-1', 'query');

    expect(results).toEqual([]);
  });
});
