import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../sessions/manager.js';

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function createMockSessionStorage() {
  return {
    createSession: vi.fn().mockResolvedValue({
      id: 'sess-1', agentTokenId: 'tok-1', summary: 'Test', messageCount: 2,
      embeddingStatus: 'pending', tags: [], projectId: null, externalId: null,
      name: null, workingDirectory: null, gitBranch: null, startedAt: null,
      endedAt: null, importedAt: '2026-01-01',
    }),
    findByExternalId: vi.fn().mockResolvedValue(null),
    listSessions: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue(null),
    getMessages: vi.fn().mockResolvedValue([
      { id: 'msg-1', sessionId: 'sess-1', role: 'user', content: 'Hello', messageIndex: 0, hasToolUse: false, toolNames: [], timestamp: null },
      { id: 'msg-2', sessionId: 'sess-1', role: 'assistant', content: 'Hi there', messageIndex: 1, hasToolUse: false, toolNames: [], timestamp: null },
    ]),
    updateEmbeddingStatus: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(true),
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
    getPointCount: vi.fn().mockResolvedValue(0),
    collectionExists: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockEmbedding() {
  return {
    embed: vi.fn().mockResolvedValue(Array(768).fill(0.1)),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) =>
      texts.map(() => Array(768).fill(0.1)),
    ),
    isReady: vi.fn().mockReturnValue(true),
    dimensions: 768,
    modelName: 'test',
    providerType: 'ollama' as const,
  };
}

describe('SessionManager', () => {
  let manager: SessionManager;
  let storage: ReturnType<typeof createMockSessionStorage>;
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let embedding: ReturnType<typeof createMockEmbedding>;

  beforeEach(() => {
    storage = createMockSessionStorage();
    vectorStore = createMockVectorStore();
    embedding = createMockEmbedding();
    manager = new SessionManager(storage as any, vectorStore as any, embedding as any);
  });

  describe('import', () => {
    it('creates session and triggers async embedding', async () => {
      const result = await manager.importSession('tok-1', {
        summary: 'Discussed auth',
        messages: [
          { role: 'user', content: 'How to add JWT?', toolNames: [] },
          { role: 'assistant', content: 'Use jsonwebtoken...', toolNames: [] },
        ],
      });

      expect(storage.createSession).toHaveBeenCalled();
      expect(result.id).toBe('sess-1');

      // Wait for async embedding
      await vi.waitFor(() => {
        expect(vectorStore.upsert).toHaveBeenCalled();
      }, { timeout: 500 });

      // Summary embedded to sessions collection
      expect(vectorStore.upsert).toHaveBeenCalledWith(
        'sessions', 'sess-1', expect.any(Array),
        expect.objectContaining({ agent_token_id: 'tok-1' }),
      );

      // Messages batch-embedded to session_messages collection
      expect(vectorStore.upsertBatch).toHaveBeenCalledWith(
        'session_messages',
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({ session_id: 'sess-1', agent_token_id: 'tok-1' }),
          }),
        ]),
      );
    });

    it('returns existing session on duplicate external_id', async () => {
      storage.findByExternalId.mockResolvedValue({
        id: 'existing-sess', summary: 'Old', messageCount: 5,
      });

      const result = await manager.importSession('tok-1', {
        externalId: 'ext-1',
        summary: 'New',
        messages: [{ role: 'user', content: 'x', toolNames: [] }],
      });

      expect(result.id).toBe('existing-sess');
      expect(storage.createSession).not.toHaveBeenCalled();
    });
  });

  describe('searchSessions', () => {
    it('searches by summary embedding with agent filter', async () => {
      vectorStore.search.mockResolvedValue([
        { id: 'sess-1', score: 0.9, payload: { session_id: 'sess-1' } },
      ]);
      storage.getSession.mockResolvedValue({
        id: 'sess-1', summary: 'Auth discussion', agentTokenId: 'tok-1',
      });

      const results = await manager.searchSessions('tok-1', 'authentication');

      expect(vectorStore.search).toHaveBeenCalledWith(
        'sessions', expect.any(Array),
        expect.objectContaining({
          must: expect.arrayContaining([
            { key: 'agent_token_id', match: { value: 'tok-1' } },
          ]),
        }),
        expect.any(Number),
      );
      expect(results).toHaveLength(1);
    });
  });

  describe('searchMessages', () => {
    it('searches within specific session', async () => {
      vectorStore.search.mockResolvedValue([
        { id: 'chunk-1', score: 0.85, payload: { message_id: 'msg-1', session_id: 'sess-1', chunk_index: 0, message_index: 0, role: 'user' } },
      ]);

      const results = await manager.searchMessages('tok-1', 'JWT token', { sessionId: 'sess-1' });

      expect(vectorStore.search).toHaveBeenCalledWith(
        'session_messages', expect.any(Array),
        expect.objectContaining({
          must: expect.arrayContaining([
            { key: 'agent_token_id', match: { value: 'tok-1' } },
            { key: 'session_id', match: { value: 'sess-1' } },
          ]),
        }),
        expect.any(Number),
      );
      expect(results).toHaveLength(1);
      expect(results[0].messageId).toBe('msg-1');
    });
  });

  describe('deleteSession', () => {
    it('deletes from PG and both Qdrant collections', async () => {
      await manager.deleteSession('sess-1', 'tok-1');

      expect(storage.deleteSession).toHaveBeenCalledWith('sess-1', 'tok-1');
      expect(vectorStore.delete).toHaveBeenCalledWith('sessions', ['sess-1']);
      expect(vectorStore.deleteByFilter).toHaveBeenCalledWith('session_messages', {
        must: [{ key: 'session_id', match: { value: 'sess-1' } }],
      });
    });
  });

  describe('readSession', () => {
    it('returns session with messages', async () => {
      storage.getSession.mockResolvedValue({
        id: 'sess-1', agentTokenId: 'tok-1', summary: 'Test',
      });

      const result = await manager.readSession('sess-1', 'tok-1');

      expect(result).not.toBeNull();
      expect(result!.session.id).toBe('sess-1');
      expect(result!.messages).toHaveLength(2);
    });

    it('throws on ownership mismatch', async () => {
      storage.getSession.mockResolvedValue({
        id: 'sess-1', agentTokenId: 'other-agent',
      });

      await expect(
        manager.readSession('sess-1', 'tok-1'),
      ).rejects.toThrow(/access denied/i);
    });
  });
});
