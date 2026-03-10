import pg from 'pg';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import type { MemoryEntry, Project, ReadParams, DEFAULT_DOMAINS } from '../memory/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PROJECT_ID = '00000000-0000-0000-0000-000000000000';

/** Map snake_case DB row → camelCase MemoryEntry */
function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    category: row.category as MemoryEntry['category'],
    domain: (row.domain as string) || null,
    title: row.title as string,
    content: row.content as string,
    author: row.author as string,
    tags: (row.tags as string[]) || [],
    priority: row.priority as MemoryEntry['priority'],
    status: row.status as MemoryEntry['status'],
    pinned: row.pinned as boolean,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    relatedIds: (row.related_ids as string[]) || [],
  };
}

/** Map snake_case DB row → camelCase Project */
function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) || '',
    domains: (row.domains as string[]) || [],
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export class PgStorage {
  private pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 20,
    });
  }

  async initialize(): Promise<void> {
    // Run schema SQL
    const schemaPath = path.join(__dirname, 'schema.sql');
    let schemaSql: string;
    try {
      schemaSql = readFileSync(schemaPath, 'utf-8');
    } catch {
      // In compiled dist, schema.sql is alongside the JS file
      const distSchemaPath = path.join(__dirname, '..', 'storage', 'schema.sql');
      schemaSql = readFileSync(distSchemaPath, 'utf-8');
    }
    await this.pool.query(schemaSql);

    // Ensure default project exists
    await this.ensureDefaultProject();

    console.error('PgStorage initialized');
  }

  getPool(): pg.Pool {
    return this.pool;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async ensureDefaultProject(): Promise<void> {
    const { rows } = await this.pool.query(
      'SELECT id FROM projects WHERE id = $1',
      [DEFAULT_PROJECT_ID]
    );
    if (rows.length === 0) {
      const { DEFAULT_DOMAINS: domains } = await import('../memory/types.js');
      await this.pool.query(
        `INSERT INTO projects (id, name, description, domains) VALUES ($1, $2, $3, $4)`,
        [DEFAULT_PROJECT_ID, 'default', 'Default project for team memory', domains]
      );
    }
  }

  // ============ Projects ============

  async createProject(params: {
    name: string;
    description?: string;
    domains?: string[];
  }): Promise<Project> {
    const id = uuidv4();
    const { DEFAULT_DOMAINS: defaultDomains } = await import('../memory/types.js');
    const { rows } = await this.pool.query(
      `INSERT INTO projects (id, name, description, domains)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, params.name, params.description || '', params.domains || defaultDomains]
    );
    return rowToProject(rows[0]);
  }

  async getProject(id: string): Promise<Project | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM projects WHERE id = $1', [id]);
    return rows.length > 0 ? rowToProject(rows[0]) : undefined;
  }

  async listProjects(): Promise<Project[]> {
    const { rows } = await this.pool.query('SELECT * FROM projects ORDER BY created_at');
    return rows.map(rowToProject);
  }

  async updateProject(id: string, updates: Partial<Pick<Project, 'name' | 'description' | 'domains'>>): Promise<Project | undefined> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIdx++}`);
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      setClauses.push(`description = $${paramIdx++}`);
      values.push(updates.description);
    }
    if (updates.domains !== undefined) {
      setClauses.push(`domains = $${paramIdx++}`);
      values.push(updates.domains);
    }

    if (setClauses.length === 0) return this.getProject(id);

    values.push(id);
    const { rows } = await this.pool.query(
      `UPDATE projects SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      values
    );
    return rows.length > 0 ? rowToProject(rows[0]) : undefined;
  }

  async deleteProject(id: string): Promise<boolean> {
    if (id === DEFAULT_PROJECT_ID) return false; // Protect default project
    const result = await this.pool.query('DELETE FROM projects WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  // ============ Entries ============

  async count(): Promise<number> {
    const { rows } = await this.pool.query('SELECT COUNT(*)::int AS cnt FROM entries');
    return rows[0].cnt;
  }

  async getAll(projectId: string, filters?: {
    category?: string;
    domain?: string;
    status?: string;
    tags?: string[];
    limit?: number;
  }): Promise<MemoryEntry[]> {
    const conditions: string[] = ['project_id = $1'];
    const values: unknown[] = [projectId];
    let paramIdx = 2;

    if (filters?.category && filters.category !== 'all') {
      conditions.push(`category = $${paramIdx++}`);
      values.push(filters.category);
    }
    if (filters?.domain) {
      conditions.push(`domain = $${paramIdx++}`);
      values.push(filters.domain);
    }
    if (filters?.status) {
      conditions.push(`status = $${paramIdx++}`);
      values.push(filters.status);
    }
    if (filters?.tags && filters.tags.length > 0) {
      conditions.push(`tags && $${paramIdx++}`);
      values.push(filters.tags);
    }

    const limit = filters?.limit || 100;
    values.push(limit);

    const { rows } = await this.pool.query(
      `SELECT * FROM entries WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at DESC LIMIT $${paramIdx}`,
      values
    );
    return rows.map(rowToEntry);
  }

  async getById(id: string): Promise<MemoryEntry | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM entries WHERE id = $1', [id]);
    return rows.length > 0 ? rowToEntry(rows[0]) : undefined;
  }

  async search(projectId: string, query: string, limit = 50): Promise<MemoryEntry[]> {
    // Use plainto_tsquery for safe query parsing + ILIKE fallback for partial matches
    const { rows } = await this.pool.query(
      `SELECT * FROM entries
       WHERE project_id = $1
         AND (
           search_vector @@ plainto_tsquery('simple', $2)
           OR title ILIKE $3
           OR content ILIKE $3
         )
       ORDER BY updated_at DESC
       LIMIT $4`,
      [projectId, query, `%${query}%`, limit]
    );
    return rows.map(rowToEntry);
  }

  async add(entry: MemoryEntry): Promise<MemoryEntry> {
    const { rows } = await this.pool.query(
      `INSERT INTO entries (id, project_id, category, domain, title, content, author, tags, priority, status, pinned, related_ids, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        entry.id,
        entry.projectId,
        entry.category,
        entry.domain,
        entry.title,
        entry.content,
        entry.author,
        entry.tags,
        entry.priority,
        entry.status,
        entry.pinned,
        entry.relatedIds,
        entry.createdAt,
        entry.updatedAt,
      ]
    );
    return rowToEntry(rows[0]);
  }

  async update(id: string, updates: Partial<MemoryEntry>): Promise<MemoryEntry | undefined> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    const fieldMap: Record<string, string> = {
      title: 'title',
      content: 'content',
      domain: 'domain',
      category: 'category',
      author: 'author',
      priority: 'priority',
      status: 'status',
      pinned: 'pinned',
    };

    for (const [tsKey, dbKey] of Object.entries(fieldMap)) {
      const value = (updates as Record<string, unknown>)[tsKey];
      if (value !== undefined) {
        setClauses.push(`${dbKey} = $${paramIdx++}`);
        values.push(value);
      }
    }

    // Handle array fields separately
    if (updates.tags !== undefined) {
      setClauses.push(`tags = $${paramIdx++}`);
      values.push(updates.tags);
    }
    if (updates.relatedIds !== undefined) {
      setClauses.push(`related_ids = $${paramIdx++}`);
      values.push(updates.relatedIds);
    }

    if (setClauses.length === 0) return this.getById(id);

    values.push(id);
    const { rows } = await this.pool.query(
      `UPDATE entries SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      values
    );
    return rows.length > 0 ? rowToEntry(rows[0]) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM entries WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async archive(id: string): Promise<MemoryEntry | undefined> {
    return this.update(id, { status: 'archived' });
  }

  async unarchive(id: string): Promise<MemoryEntry | undefined> {
    return this.update(id, { status: 'active' });
  }

  async getChangesSince(projectId: string, since: string): Promise<MemoryEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM entries WHERE project_id = $1 AND updated_at > $2 ORDER BY updated_at DESC`,
      [projectId, since]
    );
    return rows.map(rowToEntry);
  }

  async getStats(projectId: string): Promise<{
    totalEntries: number;
    byCategory: Record<string, number>;
    byDomain: Record<string, number>;
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
    last24h: number;
    last7d: number;
  }> {
    const [catResult, domResult, statusResult, prioResult, recentResult] = await Promise.all([
      this.pool.query(
        `SELECT category, COUNT(*)::int as count FROM entries WHERE project_id = $1 GROUP BY category`,
        [projectId]
      ),
      this.pool.query(
        `SELECT COALESCE(domain, 'unset') as domain, COUNT(*)::int as count FROM entries WHERE project_id = $1 GROUP BY domain`,
        [projectId]
      ),
      this.pool.query(
        `SELECT status, COUNT(*)::int as count FROM entries WHERE project_id = $1 GROUP BY status`,
        [projectId]
      ),
      this.pool.query(
        `SELECT priority, COUNT(*)::int as count FROM entries WHERE project_id = $1 GROUP BY priority`,
        [projectId]
      ),
      this.pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '24 hours')::int as last24h,
           COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '7 days')::int as last7d,
           COUNT(*)::int as total
         FROM entries WHERE project_id = $1`,
        [projectId]
      ),
    ]);

    const byCategory: Record<string, number> = {};
    for (const row of catResult.rows) byCategory[row.category] = row.count;

    const byDomain: Record<string, number> = {};
    for (const row of domResult.rows) byDomain[row.domain] = row.count;

    const byStatus: Record<string, number> = {};
    for (const row of statusResult.rows) byStatus[row.status] = row.count;

    const byPriority: Record<string, number> = {};
    for (const row of prioResult.rows) byPriority[row.priority] = row.count;

    return {
      totalEntries: recentResult.rows[0]?.total || 0,
      byCategory,
      byDomain,
      byStatus,
      byPriority,
      last24h: recentResult.rows[0]?.last24h || 0,
      last7d: recentResult.rows[0]?.last7d || 0,
    };
  }

  /** Archive entries older than N days that are active and not pinned */
  async archiveOldEntries(days: number): Promise<number> {
    const result = await this.pool.query(
      `UPDATE entries SET status = 'archived'
       WHERE status = 'active'
         AND pinned = false
         AND updated_at < NOW() - make_interval(days => $1)
       RETURNING id`,
      [days]
    );
    return result.rowCount ?? 0;
  }

  async getLastUpdated(projectId: string): Promise<string> {
    const { rows } = await this.pool.query(
      `SELECT MAX(updated_at) as last FROM entries WHERE project_id = $1`,
      [projectId]
    );
    return rows[0]?.last ? (rows[0].last as Date).toISOString() : new Date().toISOString();
  }
}
