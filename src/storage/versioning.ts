import type pg from 'pg';
import type { MemoryEntry } from '../memory/types.js';
import { toISOString } from './utils.js';

export interface EntryVersion {
  id: number;
  entryId: string;
  version: number;
  title: string;
  content: string;
  domain: string | null;
  category: string;
  tags: string[];
  priority: string;
  status: string;
  author: string;
  createdAt: string;
}

export class VersionManager {
  constructor(private pool: pg.Pool) {}

  async saveVersion(entry: MemoryEntry): Promise<number> {
    // Use advisory lock keyed on entry UUID to prevent concurrent version conflicts
    const { rows } = await this.pool.query(
      `WITH lock AS (
        SELECT pg_advisory_xact_lock(hashtext($1))
      )
      INSERT INTO entry_versions (entry_id, version, title, content, domain, category, tags, priority, status, author)
      SELECT $1::uuid, COALESCE(MAX(version), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9
      FROM entry_versions WHERE entry_id = $1::uuid
      RETURNING version`,
      [
        entry.id, entry.title, entry.content,
        entry.domain, entry.category, entry.tags, entry.priority,
        entry.status, entry.author,
      ]
    );

    return rows[0].version as number;
  }

  async getVersions(entryId: string): Promise<EntryVersion[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM entry_versions WHERE entry_id = $1::uuid ORDER BY version DESC`,
      [entryId]
    );
    return rows.map((row) => this.rowToVersion(row));
  }

  async getVersion(entryId: string, version: number): Promise<EntryVersion | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM entry_versions WHERE entry_id = $1::uuid AND version = $2`,
      [entryId, version]
    );
    return rows.length > 0 ? this.rowToVersion(rows[0]) : null;
  }

  async getCurrentVersion(entryId: string): Promise<number | null> {
    const { rows } = await this.pool.query(
      `SELECT MAX(version) as max FROM entry_versions WHERE entry_id = $1::uuid`,
      [entryId]
    );
    return rows[0]?.max ?? null;
  }

  private rowToVersion(row: Record<string, unknown>): EntryVersion {
    return {
      id: row.id as number,
      entryId: row.entry_id as string,
      version: row.version as number,
      title: row.title as string,
      content: row.content as string,
      domain: (row.domain as string) || null,
      category: row.category as string,
      tags: (row.tags as string[]) || [],
      priority: row.priority as string,
      status: row.status as string,
      author: row.author as string,
      createdAt: toISOString(row.created_at),
    };
  }
}
