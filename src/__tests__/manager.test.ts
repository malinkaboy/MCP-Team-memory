import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryManager } from '../memory/manager.js';
import type { MemoryEntry } from '../memory/types.js';

function createMockStorage() {
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
    getStats: vi.fn().mockResolvedValue({
      totalEntries: 1,
      byCategory: { tasks: 1 },
      byDomain: { backend: 1 },
      byStatus: { active: 1 },
      byPriority: { medium: 1 },
      last24h: 1,
      last7d: 1,
    }),
    archiveOldEntries: vi.fn().mockResolvedValue(0),
    count: vi.fn().mockResolvedValue(1),
    getProject: vi.fn().mockResolvedValue({ id: '00000000-0000-0000-0000-000000000000', name: 'default', description: '', domains: [], createdAt: '', updatedAt: '' }),
    createProject: vi.fn().mockImplementation(async (p: { name: string }) => ({
      id: 'new-project-id', name: p.name, description: '', domains: [], createdAt: '', updatedAt: '',
    })),
    listProjects: vi.fn().mockResolvedValue([]),
    updateProject: vi.fn().mockResolvedValue(undefined),
    deleteProject: vi.fn().mockResolvedValue(true),
    _mockEntry: mockEntry,
  };
}

describe('MemoryManager', () => {
  let manager: MemoryManager;
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(async () => {
    storage = createMockStorage();
    manager = new MemoryManager(storage as any);
    await manager.initialize();
  });

  describe('read', () => {
    it('delegates to storage.getAll by default', async () => {
      const entries = await manager.read({ category: 'tasks' });
      expect(storage.getAll).toHaveBeenCalled();
      expect(entries).toHaveLength(1);
    });

    it('delegates to storage.search when search param provided', async () => {
      await manager.read({ search: 'test' });
      expect(storage.search).toHaveBeenCalledWith(
        '00000000-0000-0000-0000-000000000000',
        'test',
        {
          category: undefined,
          domain: undefined,
          status: undefined,
          tags: undefined,
          limit: 50,
        },
      );
    });

    it('passes filters to storage.search when search param provided with filters', async () => {
      await manager.read({
        search: 'test',
        category: 'issues',
        status: 'active',
        domain: 'backend',
        tags: ['bug'],
        limit: 10,
      });
      expect(storage.search).toHaveBeenCalledWith(
        '00000000-0000-0000-0000-000000000000',
        'test',
        {
          category: 'issues',
          domain: 'backend',
          status: 'active',
          tags: ['bug'],
          limit: 10,
        },
      );
    });
  });

  describe('write', () => {
    it('creates entry with UUID and emits event', async () => {
      const listener = vi.fn();
      manager.subscribe(listener);

      const entry = await manager.write({
        category: 'tasks',
        title: 'New task',
        content: 'Body',
      });

      expect(storage.add).toHaveBeenCalled();
      expect(entry.title).toBe('New task');
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'memory:created' }),
      );
    });
  });

  describe('update', () => {
    it('returns null if entry not found', async () => {
      storage.update.mockResolvedValueOnce(undefined);
      const result = await manager.update({ id: 'nonexistent' });
      expect(result).toBeNull();
    });

    it('emits memory:updated on success', async () => {
      const listener = vi.fn();
      manager.subscribe(listener);

      await manager.update({ id: '550e8400-e29b-41d4-a716-446655440000', title: 'Updated' });
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'memory:updated' }),
      );
    });
  });

  describe('delete', () => {
    it('archives by default', async () => {
      await manager.delete({ id: 'some-id' });
      expect(storage.archive).toHaveBeenCalledWith('some-id');
    });

    it('hard deletes when archive=false', async () => {
      await manager.delete({ id: 'some-id', archive: false });
      expect(storage.delete).toHaveBeenCalledWith('some-id');
    });
  });

  describe('subscribe/unsubscribe', () => {
    it('stops receiving events after unsubscribe', async () => {
      const listener = vi.fn();
      const unsub = manager.subscribe(listener);
      unsub();

      await manager.write({ category: 'tasks', title: 'X', content: 'Y' });
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
