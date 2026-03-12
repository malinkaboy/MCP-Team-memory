import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Migrator } from '../storage/migrator.js';

function createMockPool() {
  const queryResults: Record<string, unknown> = {};
  const queryCalls: Array<{ text: string; values?: unknown[] }> = [];

  const queryHandler = async (text: string, values?: unknown[]) => {
    queryCalls.push({ text, values });

    if (text.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
      return { rows: [] };
    }
    if (text.includes('information_schema.tables') && text.includes('schema_meta')) {
      return queryResults['schema_meta_exists'] || { rows: [] };
    }
    if (text.includes('SELECT 1 FROM schema_migrations WHERE version = 1')) {
      return queryResults['migration_1_exists'] || { rows: [] };
    }
    if (text.includes('INSERT INTO schema_migrations') && text.includes('initial-schema')) {
      return { rows: [] };
    }
    if (text.includes('SELECT version FROM schema_migrations')) {
      return queryResults['applied_versions'] || { rows: [] };
    }
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) {
      return { rows: [] };
    }
    return { rows: [] };
  };

  const pool = {
    query: vi.fn().mockImplementation(queryHandler),
    connect: vi.fn().mockImplementation(async () => ({
      query: vi.fn().mockImplementation(queryHandler),
      release: vi.fn(),
    })),
    _setResult(key: string, value: unknown) {
      queryResults[key] = value;
    },
    _getCalls() {
      return queryCalls;
    },
  };

  return pool;
}

describe('Migrator', () => {
  let pool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    pool = createMockPool();
  });

  it('creates schema_migrations table on run', async () => {
    const migrator = new Migrator(pool as any, 'nonexistent-dir');
    try { await migrator.run(); } catch { /* expected: dir not found */ }

    const calls = pool._getCalls();
    expect(calls.some(c => c.text.includes('CREATE TABLE IF NOT EXISTS schema_migrations'))).toBe(true);
  });

  it('bootstraps existing v2 DB by marking migration 001 as applied', async () => {
    pool._setResult('schema_meta_exists', { rows: [{ '?column?': 1 }] });
    pool._setResult('migration_1_exists', { rows: [] });

    const migrator = new Migrator(pool as any, 'nonexistent-dir');
    try { await migrator.run(); } catch { /* expected: dir not found */ }

    const calls = pool._getCalls();
    expect(calls.some(c =>
      c.text.includes('INSERT INTO schema_migrations') &&
      c.values?.includes(1) &&
      c.values?.includes('initial-schema')
    )).toBe(true);
  });

  it('skips bootstrap if already bootstrapped', async () => {
    pool._setResult('schema_meta_exists', { rows: [{ '?column?': 1 }] });
    pool._setResult('migration_1_exists', { rows: [{ '?column?': 1 }] });

    const migrator = new Migrator(pool as any, 'nonexistent-dir');
    try { await migrator.run(); } catch { /* expected */ }

    const calls = pool._getCalls();
    const bootstrapInserts = calls.filter(c =>
      c.text.includes('INSERT INTO schema_migrations') &&
      c.values?.includes('initial-schema')
    );
    expect(bootstrapInserts).toHaveLength(0);
  });

  it('skips bootstrap for fresh DB (no schema_meta)', async () => {
    pool._setResult('schema_meta_exists', { rows: [] });

    const migrator = new Migrator(pool as any, 'nonexistent-dir');
    try { await migrator.run(); } catch { /* expected */ }

    const calls = pool._getCalls();
    const bootstrapInserts = calls.filter(c =>
      c.text.includes('INSERT INTO schema_migrations') &&
      c.values?.includes('initial-schema')
    );
    expect(bootstrapInserts).toHaveLength(0);
  });

  it('reads and executes pending migration SQL files from directory', async () => {
    const os = await import('os');
    const fs = await import('fs');
    const path = await import('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-test-'));
    fs.writeFileSync(path.join(tmpDir, '002-add-column.sql'), 'ALTER TABLE entries ADD COLUMN IF NOT EXISTS test_col TEXT;');

    pool._setResult('applied_versions', { rows: [{ version: 1 }] });

    const migrator = new Migrator(pool as any, tmpDir);
    await migrator.run();

    const calls = pool._getCalls();
    expect(pool.connect).toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('skips already-applied migrations', async () => {
    const os = await import('os');
    const fs = await import('fs');
    const path = await import('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrator-test-'));
    fs.writeFileSync(path.join(tmpDir, '001-initial.sql'), 'SELECT 1;');

    pool._setResult('applied_versions', { rows: [{ version: 1 }] });

    const migrator = new Migrator(pool as any, tmpDir);
    await migrator.run();

    expect(pool.connect).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true });
  });
});
