import type pg from 'pg';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import logger from '../logger.js';

export class Migrator {
  constructor(private pool: pg.Pool, private migrationsDir: string) {}

  async run(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await this.bootstrapExistingDb();

    const applied = await this.getAppliedVersions();
    const pending = this.getPendingMigrations(applied);

    for (const migration of pending) {
      logger.info({ version: migration.version, name: migration.name }, 'Applying migration');
      const sql = readFileSync(migration.path, 'utf-8');

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
          [migration.version, migration.name]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ version: migration.version, name: migration.name, err }, 'Migration failed');
        throw err;
      } finally {
        client.release();
      }
    }

    if (pending.length > 0) {
      logger.info({ count: pending.length }, 'Migrations applied successfully');
    }
  }

  private async getAppliedVersions(): Promise<Set<number>> {
    const { rows } = await this.pool.query('SELECT version FROM schema_migrations ORDER BY version');
    return new Set(rows.map((r: { version: number }) => r.version));
  }

  private getPendingMigrations(applied: Set<number>) {
    let files: string[];
    try {
      files = readdirSync(this.migrationsDir).filter(f => f.endsWith('.sql')).sort();
    } catch {
      logger.warn({ dir: this.migrationsDir }, 'Migrations directory not found');
      return [];
    }

    return files
      .map(f => {
        const match = f.match(/^(\d+)-(.+)\.sql$/);
        if (!match) return null;
        return {
          version: parseInt(match[1], 10),
          name: match[2],
          path: path.join(this.migrationsDir, f),
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null && !applied.has(m.version));
  }

  private async bootstrapExistingDb(): Promise<void> {
    const { rows: metaRows } = await this.pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_meta'`
    );
    if (metaRows.length === 0) return;

    const { rows: migRows } = await this.pool.query(
      `SELECT 1 FROM schema_migrations WHERE version = 1`
    );
    if (migRows.length > 0) return;

    logger.info('Bootstrapping: existing v2 DB detected, marking migration 001 as applied');
    await this.pool.query(
      `INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [1, 'initial-schema']
    );
  }
}
