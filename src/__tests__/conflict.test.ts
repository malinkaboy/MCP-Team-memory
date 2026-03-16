import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VersionManager } from '../storage/versioning.js';
import { PgStorage } from '../storage/pg-storage.js';

function createMockPool() {
  return {
    query: vi.fn(),
  };
}

describe('VersionManager.getCurrentVersion', () => {
  let pool: ReturnType<typeof createMockPool>;
  let vm: VersionManager;

  beforeEach(() => {
    pool = createMockPool();
    vm = new VersionManager(pool as any);
  });

  it('returns max version for an entry with versions', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ max: 5 }] });
    const version = await vm.getCurrentVersion('entry-id');
    expect(version).toBe(5);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('MAX(version)'),
      ['entry-id']
    );
  });

  it('returns null for an entry with no versions', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ max: null }] });
    const version = await vm.getCurrentVersion('entry-id');
    expect(version).toBeNull();
  });
});

// Mock pool that simulates transaction behavior
function createTransactionMockPool() {
  const mockClient = {
    query: vi.fn(),
    release: vi.fn(),
  };

  const pool = {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(mockClient),
    on: vi.fn(),
    end: vi.fn(),
    _client: mockClient,
  };

  return pool;
}

describe('PgStorage.update with expectedVersion', () => {
  it('succeeds when expectedVersion matches current max version', async () => {
    const pool = createTransactionMockPool();
    const storage = PgStorage.__createForTest(pool as any);

    // BEGIN
    pool._client.query.mockResolvedValueOnce({ rows: [] });
    // SELECT * FROM entries WHERE id = $1 FOR UPDATE (lock row)
    pool._client.query.mockResolvedValueOnce({
      rows: [{ id: 'test-id', project_id: 'proj', title: 'T', content: 'C', category: 'tasks',
               domain: null, author: 'a', tags: [], priority: 'medium', status: 'active',
               pinned: false, related_ids: [], created_at: new Date(), updated_at: new Date() }]
    });
    // SELECT MAX(version)
    pool._client.query.mockResolvedValueOnce({ rows: [{ max: 5 }] });
    // UPDATE entries SET ... RETURNING *
    pool._client.query.mockResolvedValueOnce({
      rows: [{ id: 'test-id', project_id: 'proj', title: 'Updated', content: 'C', category: 'tasks',
               domain: null, author: 'a', tags: [], priority: 'medium', status: 'active',
               pinned: false, related_ids: [], created_at: new Date(), updated_at: new Date() }]
    });
    // COMMIT
    pool._client.query.mockResolvedValueOnce({ rows: [] });

    const result = await storage.update('test-id', { title: 'Updated' }, 5);
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('conflict');
    expect((result as any).title).toBe('Updated');
  });

  it('returns ConflictError when expectedVersion does not match', async () => {
    const pool = createTransactionMockPool();
    const storage = PgStorage.__createForTest(pool as any);

    // BEGIN
    pool._client.query.mockResolvedValueOnce({ rows: [] });
    // SELECT FOR UPDATE
    pool._client.query.mockResolvedValueOnce({
      rows: [{ id: 'test-id', project_id: 'proj', title: 'Current', content: 'C', category: 'tasks',
               domain: null, author: 'a', tags: [], priority: 'medium', status: 'active',
               pinned: false, related_ids: [], created_at: new Date(), updated_at: new Date() }]
    });
    // SELECT MAX(version)
    pool._client.query.mockResolvedValueOnce({ rows: [{ max: 6 }] });
    // ROLLBACK
    pool._client.query.mockResolvedValueOnce({ rows: [] });

    const result = await storage.update('test-id', { title: 'Updated' }, 5);
    expect(result).toHaveProperty('conflict', true);
    expect((result as any).currentVersion).toBe(6);
  });

  it('works without expectedVersion (backward compat)', async () => {
    const pool = createTransactionMockPool();
    // Regular pool.query (not transactional) for non-versioned update
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'test-id', project_id: 'proj', title: 'Updated', content: 'C', category: 'tasks',
               domain: null, author: 'a', tags: [], priority: 'medium', status: 'active',
               pinned: false, related_ids: [], created_at: new Date(), updated_at: new Date() }]
    });

    const storage = PgStorage.__createForTest(pool as any);
    const result = await storage.update('test-id', { title: 'Updated' });
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('conflict');
  });
});
