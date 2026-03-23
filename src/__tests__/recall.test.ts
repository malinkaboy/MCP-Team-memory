import { describe, it, expect, vi } from 'vitest';
import { buildAutoContext } from '../recall.js';
import { buildMcpServer } from '../server.js';
import type { MemoryEntry } from '../memory/types.js';

const makeEntry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: `id-${Math.random().toString(36).slice(2)}`,
  projectId: '00000000-0000-0000-0000-000000000000',
  category: 'tasks',
  domain: 'backend',
  title: 'Default Title',
  content: 'Default content',
  author: 'test-agent',
  tags: ['test'],
  priority: 'medium',
  status: 'active',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  relatedIds: [],
  ...overrides,
});

function createMockManager() {
  return {
    read: vi.fn().mockResolvedValue([]),
    getStorage: vi.fn().mockReturnValue({
      getAll: vi.fn().mockResolvedValue([]),
      hybridSearch: vi.fn().mockResolvedValue([]),
    }),
    getEmbeddingProvider: vi.fn().mockReturnValue(null),
  };
}

describe('buildAutoContext', () => {
  it('returns pinned entries', async () => {
    const manager = createMockManager();
    const pinnedEntry = makeEntry({ pinned: true, title: 'Pinned Important' });

    manager.getStorage().getAll
      .mockResolvedValueOnce([pinnedEntry])  // pinned
      .mockResolvedValueOnce([])             // conventions
      .mockResolvedValueOnce([]);            // recent

    const result = await buildAutoContext(manager as any, {});
    expect(result.entries).toContainEqual(expect.objectContaining({ title: 'Pinned Important' }));
  });

  it('returns recently updated entries', async () => {
    const manager = createMockManager();
    const recentEntry = makeEntry({ title: 'Recent Update', updatedAt: new Date().toISOString() });

    manager.getStorage().getAll
      .mockResolvedValueOnce([])             // pinned
      .mockResolvedValueOnce([])             // conventions
      .mockResolvedValueOnce([recentEntry]); // recent

    const result = await buildAutoContext(manager as any, {});
    expect(result.entries).toContainEqual(expect.objectContaining({ title: 'Recent Update' }));
  });

  it('deduplicates entries appearing in multiple sources', async () => {
    const manager = createMockManager();
    const sharedEntry = makeEntry({ id: 'shared-1', pinned: true, title: 'Both Pinned and Recent' });

    manager.getStorage().getAll
      .mockResolvedValueOnce([sharedEntry])  // pinned
      .mockResolvedValueOnce([])             // conventions
      .mockResolvedValueOnce([sharedEntry]); // recent

    const result = await buildAutoContext(manager as any, {});
    const ids = result.entries.map(e => e.id);
    expect(ids.filter(id => id === 'shared-1')).toHaveLength(1);
  });

  it('includes semantic matches when context and provider available', async () => {
    const manager = createMockManager();
    const semanticEntry = makeEntry({ title: 'JWT Token Flow' });

    manager.getStorage().getAll
      .mockResolvedValueOnce([])  // pinned
      .mockResolvedValueOnce([])  // conventions
      .mockResolvedValueOnce([]); // recent

    const mockProvider = {
      embed: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
      isReady: vi.fn().mockReturnValue(true),
      dimensions: 768,
      modelName: 'test-model',
      providerType: 'local' as const,
    };
    manager.getEmbeddingProvider.mockReturnValue(mockProvider);
    manager.getStorage().hybridSearch.mockResolvedValueOnce([semanticEntry]);

    const result = await buildAutoContext(manager as any, { context: 'authentication flow' });
    expect(result.entries).toContainEqual(expect.objectContaining({ title: 'JWT Token Flow' }));
  });

  it('falls back to pinned + recent when no embeddings', async () => {
    const manager = createMockManager();
    const pinnedEntry = makeEntry({ pinned: true, title: 'Pinned Only' });

    manager.getStorage().getAll
      .mockResolvedValueOnce([pinnedEntry])  // pinned
      .mockResolvedValueOnce([])             // conventions
      .mockResolvedValueOnce([]);            // recent
    manager.getEmbeddingProvider.mockReturnValue(null);

    const result = await buildAutoContext(manager as any, { context: 'some context' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].title).toBe('Pinned Only');
  });

  it('respects limit parameter', async () => {
    const manager = createMockManager();
    const entries = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ id: `id-${i}`, pinned: true, title: `Entry ${i}` })
    );

    manager.getStorage().getAll
      .mockResolvedValueOnce(entries)  // pinned
      .mockResolvedValueOnce([])       // conventions
      .mockResolvedValueOnce([]);      // recent

    const result = await buildAutoContext(manager as any, { limit: 5 });
    expect(result.entries.length).toBeLessThanOrEqual(5);
  });

  it('formats output with titles and categories', async () => {
    const manager = createMockManager();
    const entry = makeEntry({
      title: 'Architecture Decision',
      category: 'architecture',
      priority: 'critical',
      content: 'Use microservices',
    });

    manager.getStorage().getAll
      .mockResolvedValueOnce([])       // pinned
      .mockResolvedValueOnce([])       // conventions
      .mockResolvedValueOnce([entry]); // recent

    const result = await buildAutoContext(manager as any, {});
    expect(result.formatted).toContain('Architecture Decision');
    expect(result.formatted).toContain('architecture');
  });
});

describe('buildAutoContext with role bias', () => {
  it('developer role boosts architecture entries above issues', async () => {
    const manager = createMockManager();
    const archEntry = makeEntry({ category: 'architecture', title: 'Arch Decision', domain: 'backend' });
    const issueEntry = makeEntry({ category: 'issues', title: 'Bug Report', domain: 'testing' });

    manager.getStorage().getAll
      .mockResolvedValueOnce([])                      // pinned
      .mockResolvedValueOnce([])                      // conventions
      .mockResolvedValueOnce([issueEntry, archEntry]); // recent

    const result = await buildAutoContext(manager as any, { agentRole: 'developer' });
    expect(result.entries[0].title).toBe('Arch Decision');
    expect(result.entries[1].title).toBe('Bug Report');
  });

  it('qa role boosts issues entries above architecture', async () => {
    const manager = createMockManager();
    const archEntry = makeEntry({ category: 'architecture', title: 'Arch Decision', domain: 'backend' });
    const issueEntry = makeEntry({ category: 'issues', title: 'Bug Report', domain: 'testing' });

    manager.getStorage().getAll
      .mockResolvedValueOnce([])                      // pinned
      .mockResolvedValueOnce([])                      // conventions
      .mockResolvedValueOnce([archEntry, issueEntry]); // recent

    const result = await buildAutoContext(manager as any, { agentRole: 'qa' });
    expect(result.entries[0].title).toBe('Bug Report');
    expect(result.entries[1].title).toBe('Arch Decision');
  });

  it('does not filter out any entries — all present, just reordered', async () => {
    const manager = createMockManager();
    const entries = [
      makeEntry({ category: 'progress', title: 'Progress' }),
      makeEntry({ category: 'architecture', title: 'Arch' }),
      makeEntry({ category: 'issues', title: 'Issue' }),
    ];

    manager.getStorage().getAll
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(entries);

    const result = await buildAutoContext(manager as any, { agentRole: 'developer' });
    expect(result.entries).toHaveLength(3);
  });

  it('invalid role (e.g. admin) does not reorder or crash', async () => {
    const manager = createMockManager();
    const entry1 = makeEntry({ category: 'issues', title: 'First' });
    const entry2 = makeEntry({ category: 'architecture', title: 'Second' });

    manager.getStorage().getAll
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([entry1, entry2]);

    const result = await buildAutoContext(manager as any, { agentRole: 'admin' });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].title).toBe('First'); // no reordering
  });
});

describe('MCP Server auto-context prompt', () => {
  it('builds server with prompts capability without error', () => {
    const manager = createMockManager();
    const server = buildMcpServer(manager as any);
    expect(server).toBeDefined();
  });
});
