import { describe, it, expect, vi } from 'vitest';
import { calculateImportanceScore, buildArchiveByScoreQuery } from '../memory/decay.js';
import { PgStorage } from '../storage/pg-storage.js';

describe('calculateImportanceScore', () => {
  const defaultWeights: [number, number, number, number] = [0.3, 0.2, 0.3, 0.2];

  it('returns high score for frequently read critical entry', () => {
    const score = calculateImportanceScore({
      readCount: 20,
      relatedCount: 3,
      priority: 'critical',
      daysSinceLastRead: 1,
      decayDays: 30,
      weights: defaultWeights,
    });
    expect(score).toBeGreaterThan(0.8);
  });

  it('returns low score for old unread low-priority entry', () => {
    const score = calculateImportanceScore({
      readCount: 0,
      relatedCount: 0,
      priority: 'low',
      daysSinceLastRead: 60,
      decayDays: 30,
      weights: defaultWeights,
    });
    expect(score).toBeLessThan(0.05);
  });

  it('medium priority entry with moderate reads scores mid-range', () => {
    const score = calculateImportanceScore({
      readCount: 10,
      relatedCount: 2,
      priority: 'medium',
      daysSinceLastRead: 10,
      decayDays: 30,
      weights: defaultWeights,
    });
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(0.7);
  });

  it('caps frequency at 1.0 even with high read count', () => {
    const score1 = calculateImportanceScore({
      readCount: 20,
      relatedCount: 0,
      priority: 'low',
      daysSinceLastRead: 31,
      decayDays: 30,
      weights: defaultWeights,
    });
    const score2 = calculateImportanceScore({
      readCount: 100,
      relatedCount: 0,
      priority: 'low',
      daysSinceLastRead: 31,
      decayDays: 30,
      weights: defaultWeights,
    });
    expect(score1).toEqual(score2);
  });
});

describe('buildArchiveByScoreQuery', () => {
  it('returns valid SQL with parameterized threshold and decay_days', () => {
    const { sql, params } = buildArchiveByScoreQuery(0.15, 30, [0.3, 0.2, 0.3, 0.2]);
    expect(sql).toContain('UPDATE entries');
    expect(sql).toContain("status = 'archived'");
    expect(sql).toContain('pinned = false');
    expect(params).toContain(0.15);
  });
});

describe('PgStorage read tracking', () => {
  it('fires read count update after search returns results', async () => {
    const mockPool = {
      query: vi.fn(),
      on: vi.fn(),
      end: vi.fn(),
      connect: vi.fn(),
    };

    // search query returns entries
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'id1', project_id: 'proj', title: 'T', content: 'C', category: 'tasks',
          domain: null, author: 'a', tags: [], priority: 'medium', status: 'active',
          pinned: false, related_ids: [], created_at: new Date(), updated_at: new Date(),
          read_count: 0, last_read_at: null,
        }]
      })
      // attachVersions
      .mockResolvedValueOnce({ rows: [] })
      // trackReads (fire-and-forget)
      .mockResolvedValueOnce({ rows: [] });

    const storage = PgStorage.__createForTest(mockPool as any);
    await storage.search('proj', 'test');

    // Wait a tick for the async fire-and-forget
    await new Promise(resolve => setTimeout(resolve, 10));

    const readTrackingCall = mockPool.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('read_count = read_count + 1')
    );
    expect(readTrackingCall).toBeDefined();
  });

  it('fires read count update after getById returns entry', async () => {
    const mockPool = {
      query: vi.fn(),
      on: vi.fn(),
      end: vi.fn(),
      connect: vi.fn(),
    };

    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'id1', project_id: 'proj', title: 'T', content: 'C', category: 'tasks',
          domain: null, author: 'a', tags: [], priority: 'medium', status: 'active',
          pinned: false, related_ids: [], created_at: new Date(), updated_at: new Date(),
          read_count: 5, last_read_at: new Date(),
        }]
      })
      // attachVersions
      .mockResolvedValueOnce({ rows: [] })
      // trackReads (fire-and-forget)
      .mockResolvedValueOnce({ rows: [] });

    const storage = PgStorage.__createForTest(mockPool as any);
    await storage.getById('id1');

    await new Promise(resolve => setTimeout(resolve, 10));

    const readTrackingCall = mockPool.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('read_count = read_count + 1')
    );
    expect(readTrackingCall).toBeDefined();
  });
});

describe('PgStorage.archiveByScore', () => {
  it('executes score-based archive query and returns count', async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValueOnce({ rows: [{ id: '1' }, { id: '2' }], rowCount: 2 }),
      on: vi.fn(),
      end: vi.fn(),
      connect: vi.fn(),
    };

    const storage = PgStorage.__createForTest(mockPool as any);
    const count = await storage.archiveByScore(0.15, 30, [0.3, 0.2, 0.3, 0.2]);

    expect(count).toBe(2);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'archived'"),
      expect.arrayContaining([0.3, 0.2, 0.3, 0.2, 30, 0.15])
    );
  });
});
