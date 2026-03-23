import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import type { EmbeddingProvider } from '../embedding/provider.js';

function createMockPool() {
  const mockClient = {
    query: vi.fn(),
    release: vi.fn(),
  };

  return {
    // Default: return empty result so fire-and-forget calls (trackReads) don't crash
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn().mockResolvedValue(mockClient),
    on: vi.fn(),
    end: vi.fn(),
    _client: mockClient,
  };
}

function createMockEmbeddingProvider(ready = true): EmbeddingProvider {
  return {
    dimensions: 768,
    modelName: 'test-model',
    providerType: 'local',
    isReady: () => ready,
    embed: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
  };
}

describe('PgStorage.saveEmbedding', () => {
  it('stores embedding as vector string', async () => {
    const pool = createMockPool();
    const storage = PgStorage.__createForTest(pool as any);

    const embedding = [0.1, 0.2, 0.3];
    await storage.saveEmbedding('entry-1', embedding);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE entries SET embedding'),
      ['[0.1,0.2,0.3]', 'entry-1']
    );
  });
});

describe('PgStorage.getEntriesWithoutEmbedding', () => {
  it('returns entries where embedding IS NULL', async () => {
    const pool = createMockPool();
    const fakeRow = {
      id: 'entry-1',
      project_id: 'default',
      category: 'decisions',
      domain: null,
      title: 'No embedding',
      content: 'Content here',
      author: 'tester',
      tags: [],
      priority: 'medium',
      status: 'active',
      pinned: false,
      created_at: new Date(),
      updated_at: new Date(),
      related_ids: [],
      read_count: 0,
      last_read_at: null,
    };
    pool.query.mockResolvedValueOnce({ rows: [fakeRow] });
    const storage = PgStorage.__createForTest(pool as any);

    const entries = await storage.getEntriesWithoutEmbedding(10);

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('entry-1');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('embedding IS NULL'),
      [10]
    );
  });
});

describe('PgStorage.hybridSearch', () => {
  it('falls back to regular search without embedding', async () => {
    const pool = createMockPool();
    // search query → empty, trackReads + attachVersions use default mock
    pool.query.mockResolvedValueOnce({ rows: [] });
    const storage = PgStorage.__createForTest(pool as any);

    const results = await storage.hybridSearch('default', 'test query');
    expect(results).toEqual([]);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('search_vector'),
      expect.any(Array)
    );
  });

  it('combines FTS and vector when embedding provided', async () => {
    const pool = createMockPool();
    const fakeRow = {
      id: 'entry-1',
      project_id: 'default',
      category: 'decisions',
      domain: null,
      title: 'Vector result',
      content: 'Found via vector',
      author: 'tester',
      tags: [],
      priority: 'medium',
      status: 'active',
      pinned: false,
      created_at: new Date(),
      updated_at: new Date(),
      related_ids: [],
      read_count: 0,
      last_read_at: null,
      text_score: 0.3,
      vector_score: 0.8,
    };
    // hybridSearch main query
    pool.query.mockResolvedValueOnce({ rows: [fakeRow] });
    // trackReads + attachVersions use default mock
    const storage = PgStorage.__createForTest(pool as any);

    const queryEmbedding = new Array(768).fill(0.1);
    const results = await storage.hybridSearch('default', 'vector test', queryEmbedding, {
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Vector result');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('vector_score'),
      expect.arrayContaining(['default', 'vector test'])
    );
  });
});

describe('MemoryManager embedding integration', () => {
  let pool: ReturnType<typeof createMockPool>;
  let storage: PgStorage;
  let manager: MemoryManager;
  let provider: EmbeddingProvider;

  beforeEach(() => {
    pool = createMockPool();
    storage = PgStorage.__createForTest(pool as any);
    manager = new MemoryManager(storage);
    provider = createMockEmbeddingProvider();
  });

  it('setEmbeddingProvider stores provider', async () => {
    await manager.setEmbeddingProvider(provider);
    expect(manager.getEmbeddingProvider()).toBe(provider);
  });

  it('write() generates embedding fire-and-forget', async () => {
    await manager.setEmbeddingProvider(provider);

    const fakeRow = {
      id: 'new-1',
      project_id: 'default',
      category: 'decisions',
      domain: null,
      title: 'New entry',
      content: 'Content',
      author: 'tester',
      tags: [],
      priority: 'medium',
      status: 'active',
      pinned: false,
      created_at: new Date(),
      updated_at: new Date(),
      related_ids: [],
      read_count: 0,
      last_read_at: null,
    };
    // add() query
    pool.query.mockResolvedValueOnce({ rows: [fakeRow] });
    // attachVersions, saveEmbedding use default mock

    const result = await manager.write({
      category: 'decisions',
      title: 'New entry',
      content: 'Content',
    });

    expect(result.id).toBe('new-1');
    expect(provider.embed).toHaveBeenCalledWith('New entry Content', 'document');

    // Wait for fire-and-forget to complete
    await vi.waitFor(() => {
      const saveCall = pool.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('SET embedding')
      );
      expect(saveCall).toBeDefined();
    });
  });

  it('read() uses hybridSearch when provider is ready', async () => {
    await manager.setEmbeddingProvider(provider);

    const fakeRow = {
      id: 'found-1',
      project_id: 'default',
      category: 'decisions',
      domain: null,
      title: 'Found',
      content: 'Content',
      author: 'tester',
      tags: [],
      priority: 'medium',
      status: 'active',
      pinned: false,
      created_at: new Date(),
      updated_at: new Date(),
      related_ids: [],
      read_count: 0,
      last_read_at: null,
    };
    // hybridSearch main query
    pool.query.mockResolvedValueOnce({ rows: [fakeRow] });
    // trackReads + attachVersions use default mock

    const results = await manager.read({ search: 'test query' });

    expect(provider.embed).toHaveBeenCalledWith('test query', 'query');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Found');
  });

  it('read() falls back to FTS when provider not ready', async () => {
    const notReadyProvider = createMockEmbeddingProvider(false);
    await manager.setEmbeddingProvider(notReadyProvider);

    // search query + trackReads + attachVersions use default mock

    await manager.read({ search: 'test query' });

    expect(notReadyProvider.embed).not.toHaveBeenCalled();
  });

  it('backfillEmbeddings processes entries without embeddings', async () => {
    await manager.setEmbeddingProvider(provider);

    const fakeRow = {
      id: 'backfill-1',
      project_id: 'default',
      category: 'tasks',
      domain: null,
      title: 'Backfill me',
      content: 'Needs embedding',
      author: 'tester',
      tags: [],
      priority: 'medium',
      status: 'active',
      pinned: false,
      created_at: new Date(),
      updated_at: new Date(),
      related_ids: [],
      read_count: 0,
      last_read_at: null,
    };
    // getEntriesWithoutEmbedding
    pool.query.mockResolvedValueOnce({ rows: [fakeRow] });
    // saveEmbedding uses default mock

    const count = await manager.backfillEmbeddings(10);

    expect(count).toBe(1);
    expect(provider.embed).toHaveBeenCalledWith('Backfill me Needs embedding', 'document');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('SET embedding'),
      expect.any(Array)
    );
  });

  it('backfillEmbeddings returns 0 when provider not ready', async () => {
    const notReady = createMockEmbeddingProvider(false);
    await manager.setEmbeddingProvider(notReady);

    const count = await manager.backfillEmbeddings();
    expect(count).toBe(0);
  });

  it('backfillEmbeddings processes multiple batches until done', async () => {
    await manager.setEmbeddingProvider(provider);

    const fakeRow1 = {
      id: 'batch-1', project_id: 'default', category: 'tasks', domain: null,
      title: 'First', content: 'Content 1', author: 'tester', tags: [],
      priority: 'medium', status: 'active', pinned: false,
      created_at: new Date(), updated_at: new Date(), related_ids: [],
      read_count: 0, last_read_at: null,
    };
    const fakeRow2 = {
      id: 'batch-2', project_id: 'default', category: 'tasks', domain: null,
      title: 'Second', content: 'Content 2', author: 'tester', tags: [],
      priority: 'medium', status: 'archived', pinned: false,
      created_at: new Date(), updated_at: new Date(), related_ids: [],
      read_count: 0, last_read_at: null,
    };

    // Batch 1 returns one entry, batch 2 returns another, batch 3 returns empty
    pool.query
      .mockResolvedValueOnce({ rows: [fakeRow1] })  // getEntriesWithoutEmbedding batch 1
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // saveEmbedding
      .mockResolvedValueOnce({ rows: [fakeRow2] })  // getEntriesWithoutEmbedding batch 2
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // saveEmbedding
      .mockResolvedValueOnce({ rows: [] });          // getEntriesWithoutEmbedding batch 3 (empty)

    const count = await manager.backfillEmbeddings(1);

    expect(count).toBe(2);
    expect(provider.embed).toHaveBeenCalledTimes(2);
  });

  it('backfillEmbeddings stops on complete failure to prevent infinite loop', async () => {
    const failProvider = createMockEmbeddingProvider(true);
    (failProvider.embed as any).mockRejectedValue(new Error('API error'));
    await manager.setEmbeddingProvider(failProvider);

    // Reset mock call count after setEmbeddingProvider (which makes its own DB calls)
    pool.query.mockClear();

    const fakeRow = {
      id: 'fail-1', project_id: 'default', category: 'tasks', domain: null,
      title: 'Will fail', content: 'Content', author: 'tester', tags: [],
      priority: 'medium', status: 'active', pinned: false,
      created_at: new Date(), updated_at: new Date(), related_ids: [],
      read_count: 0, last_read_at: null,
    };
    pool.query.mockResolvedValueOnce({ rows: [fakeRow] });

    const count = await manager.backfillEmbeddings(10);

    expect(count).toBe(0);
    // Should only call getEntriesWithoutEmbedding once, then stop
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('backfillEmbeddings uses embedBatch when available', async () => {
    const batchProvider = {
      ...createMockEmbeddingProvider(true),
      embedBatch: vi.fn().mockResolvedValue([new Array(768).fill(0.1), new Array(768).fill(0.2)]),
    };
    await manager.setEmbeddingProvider(batchProvider);

    const fakeRows = [
      {
        id: 'b1', project_id: 'default', category: 'tasks', domain: null,
        title: 'Entry 1', content: 'Content 1', author: 'tester', tags: [],
        priority: 'medium', status: 'active', pinned: false,
        created_at: new Date(), updated_at: new Date(), related_ids: [],
        read_count: 0, last_read_at: null,
      },
      {
        id: 'b2', project_id: 'default', category: 'tasks', domain: null,
        title: 'Entry 2', content: 'Content 2', author: 'tester', tags: [],
        priority: 'medium', status: 'active', pinned: false,
        created_at: new Date(), updated_at: new Date(), related_ids: [],
        read_count: 0, last_read_at: null,
      },
    ];
    pool.query.mockResolvedValueOnce({ rows: fakeRows }); // getEntriesWithoutEmbedding

    const count = await manager.backfillEmbeddings(10);

    expect(count).toBe(2);
    expect(batchProvider.embedBatch).toHaveBeenCalledWith(
      ['Entry 1 Content 1', 'Entry 2 Content 2'],
      'document'
    );
    // embed() should NOT have been called (batch was used)
    expect(batchProvider.embed).not.toHaveBeenCalled();
  });
});

describe('GeminiEmbeddingProvider', () => {
  it('constructs correct embed request URL and body', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ embedding: { values: [0.1, 0.2, 0.3] } }),
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    try {
      const { GeminiEmbeddingProvider } = await import('../embedding/gemini.js');
      const provider = new GeminiEmbeddingProvider('test-key');
      const result = await provider.embed('hello world', 'query');

      expect(result).toEqual([0.1, 0.2, 0.3]);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('embedContent'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'x-goog-api-key': 'test-key' }),
          body: expect.stringContaining('RETRIEVAL_QUERY'),
        })
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles non-JSON error response gracefully', async () => {
    // Use 400 (not retryable) to avoid retry delays in test
    const mockResponse = {
      ok: false,
      status: 400,
      json: vi.fn().mockRejectedValue(new Error('not json')),
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    try {
      const { GeminiEmbeddingProvider } = await import('../embedding/gemini.js');
      const provider = new GeminiEmbeddingProvider('test-key');

      await expect(provider.embed('test')).rejects.toThrow('HTTP 400');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
