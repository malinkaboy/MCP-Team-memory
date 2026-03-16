import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VersionManager } from '../storage/versioning.js';

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
