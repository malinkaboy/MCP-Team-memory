import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { Migrator } from './migrator.js';
import { DEFAULT_PROJECT_ID } from '../memory/types.js';
import type { MemoryEntry, Project, ReadParams, ConflictError } from '../memory/types.js';
import { buildArchiveByScoreQuery } from '../memory/decay.js';
import { toISOString } from './utils.js';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Escape ILIKE special characters to prevent wildcard injection */
export function escapeIlike(query: string): string {
  return query.replace(/[\\%_]/g, '\\$&');
}

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
    createdAt: toISOString(row.created_at),
    updatedAt: toISOString(row.updated_at),
    relatedIds: (row.related_ids as string[]) || [],
    readCount: (row.read_count as number) ?? 0,
    lastReadAt: row.last_read_at ? toISOString(row.last_read_at) : undefined,
  };
}

/** Map snake_case DB row → camelCase Project */
function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) || '',
    domains: (row.domains as string[]) || [],
    createdAt: toISOString(row.created_at),
    updatedAt: toISOString(row.updated_at),
  };
}

export class PgStorage {
  private pool: pg.Pool;

  // Allowlist of valid PostgreSQL text search configurations
  private static readonly VALID_FTS_LANGUAGES = [
    'simple', 'russian', 'english', 'german', 'french', 'spanish',
    'italian', 'portuguese', 'dutch', 'swedish', 'norwegian', 'danish', 'finnish',
    'hungarian', 'turkish', 'arabic',
  ];
  private ftsLanguage: string;

  constructor(databaseUrl: string, ftsLanguage: string = 'simple') {
    // Validate FTS language against allowlist to prevent SQL injection
    if (!PgStorage.VALID_FTS_LANGUAGES.includes(ftsLanguage)) {
      logger.warn({ ftsLanguage }, `Invalid FTS language, falling back to 'simple'`);
      ftsLanguage = 'simple';
    }
    this.ftsLanguage = ftsLanguage;

    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 20,
    });

    // Set FTS language for EVERY new connection (including those created during migrations)
    this.pool.on('connect', (client: pg.PoolClient) => {
      client.query(`SET app.fts_language = '${this.ftsLanguage}'`).catch(() => {});
    });

    // Prevent unhandled error crash when idle clients lose connection
    this.pool.on('error', (err) => {
      logger.error({ err }, 'PostgreSQL pool error (idle client)');
    });
  }

  async initialize(): Promise<void> {
    const migrationsDir = path.join(__dirname, 'migrations');
    const migrator = new Migrator(this.pool, migrationsDir);
    await migrator.run();

    await this.ensureDefaultProject();

    logger.info('PgStorage initialized');
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
    const id = crypto.randomUUID();
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
    const allEntries = rows.map(rowToEntry);
    this.trackReads(allEntries.map(e => e.id));
    return this.attachVersions(allEntries);
  }

  async getById(id: string): Promise<MemoryEntry | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM entries WHERE id = $1', [id]);
    if (rows.length === 0) return undefined;
    const entry = rowToEntry(rows[0]);
    const [withVersion] = await this.attachVersions([entry]);
    this.trackReads([entry.id]);
    return withVersion;
  }

  async search(projectId: string, query: string, filters?: {
    category?: string;
    domain?: string;
    status?: string;
    tags?: string[];
    limit?: number;
  }): Promise<MemoryEntry[]> {
    const conditions: string[] = ['project_id = $1'];
    const values: unknown[] = [projectId];
    let paramIdx = 2;

    // Full-text search + ILIKE fallback
    conditions.push(`(search_vector @@ plainto_tsquery(current_setting('app.fts_language')::regconfig, $${paramIdx}) OR title ILIKE $${paramIdx + 1} OR content ILIKE $${paramIdx + 1})`);
    values.push(query, `%${escapeIlike(query)}%`);
    paramIdx += 2;

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

    const limit = filters?.limit || 50;
    values.push(limit);

    const { rows } = await this.pool.query(
      `SELECT * FROM entries WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at DESC LIMIT $${paramIdx}`,
      values
    );
    const entries = rows.map(rowToEntry);
    this.trackReads(entries.map(e => e.id));
    return this.attachVersions(entries);
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

  async update(id: string, updates: Partial<MemoryEntry>, expectedVersion?: number): Promise<MemoryEntry | ConflictError | undefined> {
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

    if (setClauses.length === 0) {
      const entry = await this.getById(id);
      return entry;
    }

    // If expectedVersion is provided, use atomic transaction with row lock
    if (expectedVersion !== undefined) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        // Lock the row
        const { rows: lockRows } = await client.query(
          'SELECT * FROM entries WHERE id = $1 FOR UPDATE',
          [id]
        );
        if (lockRows.length === 0) {
          await client.query('ROLLBACK');
          return undefined;
        }

        // Check current version
        const { rows: versionRows } = await client.query(
          'SELECT MAX(version) as max FROM entry_versions WHERE entry_id = $1::uuid',
          [id]
        );
        const currentVersion = versionRows[0]?.max ?? 0;

        if (currentVersion !== expectedVersion) {
          await client.query('ROLLBACK');
          const currentEntry = rowToEntry(lockRows[0]);
          return {
            conflict: true,
            currentVersion,
            currentEntry,
            message: `Entry was modified (expected version ${expectedVersion}, current ${currentVersion})`,
          };
        }

        // Version matches — perform update
        values.push(id);
        const { rows } = await client.query(
          `UPDATE entries SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
          values
        );
        await client.query('COMMIT');
        if (rows.length === 0) return undefined;
        const entry = rowToEntry(rows[0]);
        const [withVersion] = await this.attachVersions([entry]);
        return withVersion;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // No expectedVersion — original behavior (last-write-wins)
    values.push(id);
    const { rows } = await this.pool.query(
      `UPDATE entries SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      values
    );
    if (rows.length === 0) return undefined;
    const entry = rowToEntry(rows[0]);
    const [withVersion] = await this.attachVersions([entry]);
    return withVersion;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM entries WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async archive(id: string): Promise<MemoryEntry | undefined> {
    const result = await this.update(id, { status: 'archived' });
    // archive() never uses expectedVersion, so ConflictError is impossible
    return result as MemoryEntry | undefined;
  }

  async unarchive(id: string): Promise<MemoryEntry | undefined> {
    const result = await this.update(id, { status: 'active' });
    return result as MemoryEntry | undefined;
  }

  async getChangesSince(projectId: string, since: string): Promise<MemoryEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM entries WHERE project_id = $1 AND updated_at > $2 ORDER BY updated_at DESC`,
      [projectId, since]
    );
    const entries = rows.map(rowToEntry);
    return this.attachVersions(entries);
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
    return rows[0]?.last ? toISOString(rows[0].last) : new Date().toISOString();
  }

  /** Hybrid search: combines full-text search with vector similarity */
  async hybridSearch(
    projectId: string,
    query: string,
    queryEmbedding?: number[],
    filters?: {
      category?: string;
      domain?: string;
      status?: string;
      tags?: string[];
      limit?: number;
    }
  ): Promise<MemoryEntry[]> {
    // Fall back to regular search when no embedding available
    if (!queryEmbedding) {
      return this.search(projectId, query, filters);
    }

    const conditions: string[] = ['project_id = $1'];
    const values: unknown[] = [projectId];
    let paramIdx = 2;

    // Text + vector match condition
    conditions.push(
      `(search_vector @@ plainto_tsquery(current_setting('app.fts_language')::regconfig, $${paramIdx}) OR embedding <=> $${paramIdx + 1}::vector < 0.7)`
    );
    values.push(query, `[${queryEmbedding.join(',')}]`);
    const textParamIdx = paramIdx;
    const vectorParamIdx = paramIdx + 1;
    paramIdx += 2;

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

    const limit = filters?.limit || 50;
    values.push(limit);

    const sql = `
      SELECT *,
        ts_rank(search_vector, plainto_tsquery(current_setting('app.fts_language')::regconfig, $${textParamIdx})) AS text_score,
        1 - (embedding <=> $${vectorParamIdx}::vector) AS vector_score
      FROM entries
      WHERE ${conditions.join(' AND ')}
      ORDER BY (
        0.4 * COALESCE(ts_rank(search_vector, plainto_tsquery(current_setting('app.fts_language')::regconfig, $${textParamIdx})), 0)
        + 0.6 * COALESCE(1 - (embedding <=> $${vectorParamIdx}::vector), 0)
      ) DESC
      LIMIT $${paramIdx}
    `;

    const { rows } = await this.pool.query(sql, values);
    const entries = rows.map(rowToEntry);
    this.trackReads(entries.map(e => e.id));
    return this.attachVersions(entries);
  }

  /** Save embedding vector for an entry */
  async saveEmbedding(id: string, embedding: number[]): Promise<void> {
    await this.pool.query(
      `UPDATE entries SET embedding = $1::vector WHERE id = $2`,
      [`[${embedding.join(',')}]`, id]
    );
  }

  /** Get entries that have no embedding yet (for backfill) */
  async getEntriesWithoutEmbedding(limit: number = 50): Promise<MemoryEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM entries WHERE embedding IS NULL ORDER BY updated_at DESC LIMIT $1`,
      [limit]
    );
    return rows.map(rowToEntry);
  }

  /** Count active entries that have embeddings and total active entries */
  async countEmbeddingStats(): Promise<{ embedded: number; total: number }> {
    const { rows } = await this.pool.query(
      `SELECT
         count(*) FILTER (WHERE embedding IS NOT NULL)::int as embedded,
         count(*)::int as total
       FROM entries`
    );
    return { embedded: rows[0].embedded, total: rows[0].total };
  }

  /** Get stored embedding dimensions from schema_meta */
  async getEmbeddingDimensions(): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT value FROM schema_meta WHERE key = 'embedding_dimensions'`
    );
    return rows.length > 0 ? parseInt(rows[0].value, 10) : 0;
  }

  /** Update stored embedding dimensions, recreate HNSW index for new dimensions */
  async setEmbeddingDimensions(dims: number): Promise<void> {
    if (!Number.isInteger(dims) || dims <= 0 || dims > 10000) {
      throw new Error(`Invalid embedding dimensions: ${dims}`);
    }
    await this.pool.query(
      `INSERT INTO schema_meta(key, value) VALUES ('embedding_dimensions', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [String(dims)]
    );

    // Recreate HNSW index with correct dimensions for the active provider
    await this.pool.query(`DROP INDEX IF EXISTS idx_entries_embedding`);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_entries_embedding
       ON entries USING hnsw ((embedding::vector(${dims})) vector_cosine_ops)`
    );
    logger.info({ dims }, 'HNSW embedding index recreated for new dimensions');
  }

  /** Clear all embeddings (when switching provider with different dimensions) */
  async clearAllEmbeddings(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE entries SET embedding = NULL WHERE embedding IS NOT NULL`
    );
    return result.rowCount ?? 0;
  }

  /** Fire-and-forget: increment read_count for returned entry IDs */
  private trackReads(ids: string[]): void {
    if (ids.length === 0) return;
    this.pool.query(
      `UPDATE entries SET read_count = read_count + 1, last_read_at = NOW() WHERE id = ANY($1)`,
      [ids]
    ).catch(err => logger.error({ err }, 'Read tracking failed'));
  }

  /** Archive entries whose importance score is below the threshold */
  async archiveByScore(
    threshold: number,
    decayDays: number,
    weights: [number, number, number, number]
  ): Promise<number> {
    const { sql, params } = buildArchiveByScoreQuery(threshold, decayDays, weights);
    const result = await this.pool.query(sql, params);
    return result.rowCount ?? 0;
  }

  /** Search across ALL projects, returning entries with project info */
  async searchAcrossProjects(query: string, filters?: {
    category?: string;
    domain?: string;
    status?: string;
    limit?: number;
    excludeProjectId?: string;
  }): Promise<(MemoryEntry & { projectName: string })[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    // FTS + ILIKE
    conditions.push(`(e.search_vector @@ plainto_tsquery(current_setting('app.fts_language')::regconfig, $${paramIdx}) OR e.title ILIKE $${paramIdx + 1} OR e.content ILIKE $${paramIdx + 1})`);
    values.push(query, `%${escapeIlike(query)}%`);
    const textParamIdx = paramIdx;
    paramIdx += 2;

    if (filters?.category && filters.category !== 'all') {
      conditions.push(`e.category = $${paramIdx++}`);
      values.push(filters.category);
    }
    if (filters?.domain) {
      conditions.push(`e.domain = $${paramIdx++}`);
      values.push(filters.domain);
    }
    if (filters?.status) {
      conditions.push(`e.status = $${paramIdx++}`);
      values.push(filters.status);
    }
    if (filters?.excludeProjectId) {
      conditions.push(`e.project_id != $${paramIdx++}`);
      values.push(filters.excludeProjectId);
    }

    const limit = filters?.limit || 20;
    values.push(limit);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await this.pool.query(
      `SELECT e.*, p.name as project_name,
         ts_rank(e.search_vector, plainto_tsquery(current_setting('app.fts_language')::regconfig, $${textParamIdx})) AS relevance
       FROM entries e
       JOIN projects p ON e.project_id = p.id
       ${whereClause}
       ORDER BY relevance DESC, e.updated_at DESC
       LIMIT $${paramIdx}`,
      values
    );

    return rows.map(row => ({
      ...rowToEntry(row),
      projectName: row.project_name as string,
    }));
  }

  /** Attach currentVersion from entry_versions to entries */
  private async attachVersions(entries: MemoryEntry[]): Promise<MemoryEntry[]> {
    if (entries.length === 0) return entries;
    const ids = entries.map(e => e.id);
    const { rows } = await this.pool.query(
      `SELECT entry_id, MAX(version) as max_version FROM entry_versions WHERE entry_id = ANY($1::uuid[]) GROUP BY entry_id`,
      [ids]
    );
    const versionMap = new Map(rows.map((r: any) => [r.entry_id, r.max_version]));
    return entries.map(e => ({ ...e, currentVersion: versionMap.get(e.id) ?? undefined }));
  }

  /** @internal Test-only factory that injects a mock pool */
  static __createForTest(pool: pg.Pool): PgStorage {
    const instance = Object.create(PgStorage.prototype) as PgStorage;
    instance['pool'] = pool;
    return instance;
  }
}
