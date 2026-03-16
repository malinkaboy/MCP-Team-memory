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
    dimensions: 384,
    isReady: () => ready,
    embed: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
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

    const queryEmbedding = new Array(384).fill(0.1);
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

  it('setEmbeddingProvider stores provider', () => {
    manager.setEmbeddingProvider(provider);
    expect(manager.getEmbeddingProvider()).toBe(provider);
  });

  it('write() generates embedding fire-and-forget', async () => {
    manager.setEmbeddingProvider(provider);

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
    expect(provider.embed).toHaveBeenCalledWith('New entry Content');

    // Wait for fire-and-forget to complete
    await vi.waitFor(() => {
      const saveCall = pool.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('SET embedding')
      );
      expect(saveCall).toBeDefined();
    });
  });

  it('read() uses hybridSearch when provider is ready', async () => {
    manager.setEmbeddingProvider(provider);

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

    expect(provider.embed).toHaveBeenCalledWith('test query');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Found');
  });

  it('read() falls back to FTS when provider not ready', async () => {
    const notReadyProvider = createMockEmbeddingProvider(false);
    manager.setEmbeddingProvider(notReadyProvider);

    // search query + trackReads + attachVersions use default mock

    await manager.read({ search: 'test query' });

    expect(notReadyProvider.embed).not.toHaveBeenCalled();
  });

  it('backfillEmbeddings processes entries without embeddings', async () => {
    manager.setEmbeddingProvider(provider);

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
    expect(provider.embed).toHaveBeenCalledWith('Backfill me Needs embedding');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('SET embedding'),
      expect.any(Array)
    );
  });

  it('backfillEmbeddings returns 0 when provider not ready', async () => {
    const notReady = createMockEmbeddingProvider(false);
    manager.setEmbeddingProvider(notReady);

    const count = await manager.backfillEmbeddings();
    expect(count).toBe(0);
  });
});
