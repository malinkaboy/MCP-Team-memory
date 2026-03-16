import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VersionManager } from '../storage/versioning.js';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import type { MemoryEntry, ConflictError } from '../memory/types.js';

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

// === MemoryManager conflict resolution tests ===

function createMockStorageForManager() {
  const mockEntry: MemoryEntry = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    projectId: '00000000-0000-0000-0000-000000000000',
    category: 'tasks',
    domain: 'backend',
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

  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue([mockEntry]),
    search: vi.fn().mockResolvedValue([mockEntry]),
    add: vi.fn().mockImplementation(async (entry: MemoryEntry) => entry),
    update: vi.fn().mockImplementation(async (_id: string, updates: Partial<MemoryEntry>) => ({
      ...mockEntry,
      ...updates,
    })),
    delete: vi.fn().mockResolvedValue(true),
    archive: vi.fn().mockImplementation(async () => ({ ...mockEntry, status: 'archived' })),
    getById: vi.fn().mockResolvedValue(mockEntry),
    getChangesSince: vi.fn().mockResolvedValue([mockEntry]),
    getLastUpdated: vi.fn().mockResolvedValue('2026-01-01T00:00:00.000Z'),
    getStats: vi.fn().mockResolvedValue({ totalEntries: 1, byCategory: {}, byDomain: {}, byStatus: {}, byPriority: {}, last24h: 0, last7d: 0 }),
    archiveOldEntries: vi.fn().mockResolvedValue(0),
    count: vi.fn().mockResolvedValue(1),
    getProject: vi.fn().mockResolvedValue(undefined),
    createProject: vi.fn(),
    listProjects: vi.fn().mockResolvedValue([]),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    _mockEntry: mockEntry,
  };
}

describe('MemoryManager.update with expectedVersion', () => {
  it('passes expectedVersion to storage.update', async () => {
    const storage = createMockStorageForManager();
    const manager = new MemoryManager(storage as any);
    await manager.initialize();

    await manager.update({
      id: '550e8400-e29b-41d4-a716-446655440000',
      expectedVersion: 3,
      title: 'Updated',
    });

    expect(storage.update).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000',
      expect.objectContaining({ title: 'Updated' }),
      3
    );
  });

  it('returns ConflictError from storage without emitting event', async () => {
    const storage = createMockStorageForManager();
    const conflictResult: ConflictError = {
      conflict: true,
      currentVersion: 6,
      currentEntry: storage._mockEntry,
      message: 'Entry was modified',
    };
    storage.update.mockResolvedValueOnce(conflictResult);

    const manager = new MemoryManager(storage as any);
    await manager.initialize();

    const listener = vi.fn();
    manager.subscribe(listener);

    const result = await manager.update({
      id: '550e8400-e29b-41d4-a716-446655440000',
      expectedVersion: 5,
      title: 'Updated',
    });

    expect(result).toHaveProperty('conflict', true);
    expect(listener).not.toHaveBeenCalled(); // No event on conflict
  });
});
