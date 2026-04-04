import type { Pool } from 'pg';
import type { Session, SessionMessage, SessionFilters } from './types.js';
import logger from '../logger.js';

export class SessionStorage {
  constructor(private pool: Pool) {}

  async createSession(data: {
    agentTokenId: string;
    externalId?: string;
    name?: string;
    summary: string;
    projectId?: string;
    workingDirectory?: string;
    gitBranch?: string;
    tags?: string[];
    startedAt?: string;
    endedAt?: string;
    messages: Array<{
      role: string;
      content: string;
      timestamp?: string;
      toolNames: string[];
    }>;
  }): Promise<Session> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [session] } = await client.query(
        `INSERT INTO sessions (agent_token_id, external_id, name, summary, project_id, working_directory, git_branch, tags, started_at, ended_at, message_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          data.agentTokenId, data.externalId ?? null, data.name ?? null, data.summary,
          data.projectId ?? null, data.workingDirectory ?? null, data.gitBranch ?? null,
          data.tags ?? [], data.startedAt ?? null, data.endedAt ?? null, data.messages.length,
        ],
      );

      // Batch insert messages (max ~5000 per batch to stay within PG 65535 param limit, 7 params/row)
      if (data.messages.length > 0) {
        const BATCH_SIZE = 5000;
        for (let batchStart = 0; batchStart < data.messages.length; batchStart += BATCH_SIZE) {
          const batch = data.messages.slice(batchStart, batchStart + BATCH_SIZE);
          const values: string[] = [];
          const params: unknown[] = [];
          let idx = 1;

          batch.forEach((msg, i) => {
            const hasToolUse = msg.toolNames.length > 0;
            values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
            params.push(session.id, msg.role, msg.content, batchStart + i, hasToolUse, msg.toolNames, msg.timestamp ?? null);
          });

          await client.query(
            `INSERT INTO session_messages (session_id, role, content, message_index, has_tool_use, tool_names, timestamp)
             VALUES ${values.join(', ')}`,
            params,
          );
        }
      }

      await client.query('COMMIT');
      return this.rowToSession(session);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async findByExternalId(agentTokenId: string, externalId: string): Promise<Session | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM sessions WHERE agent_token_id = $1 AND external_id = $2',
      [agentTokenId, externalId],
    );
    return rows.length > 0 ? this.rowToSession(rows[0]) : null;
  }

  async listSessions(agentTokenId: string, filters: SessionFilters): Promise<Session[]> {
    const conditions = ['agent_token_id = $1'];
    const params: unknown[] = [agentTokenId];
    let idx = 2;

    if (filters.projectId) {
      conditions.push(`project_id = $${idx++}`);
      params.push(filters.projectId);
    }
    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`tags && $${idx++}`);
      params.push(filters.tags);
    }
    if (filters.dateFrom) {
      conditions.push(`started_at >= $${idx++}`);
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push(`started_at <= $${idx++}`);
      params.push(filters.dateTo);
    }
    if (filters.search) {
      const escaped = filters.search.replace(/[%_\\]/g, '\\$&');
      conditions.push(`(search_vector @@ plainto_tsquery($${idx}) OR name ILIKE $${idx + 1} ESCAPE '\\' OR summary ILIKE $${idx + 1} ESCAPE '\\')`);
      params.push(filters.search, `%${escaped}%`);
      idx += 2;
    }

    const limit = filters.limit ?? 20;
    const offset = filters.offset ?? 0;

    const { rows } = await this.pool.query(
      `SELECT * FROM sessions WHERE ${conditions.join(' AND ')} ORDER BY started_at DESC NULLS LAST LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );

    return rows.map(r => this.rowToSession(r));
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const { rows } = await this.pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    return rows.length > 0 ? this.rowToSession(rows[0]) : null;
  }

  async getMessages(sessionId: string, from: number = 0, to?: number): Promise<SessionMessage[]> {
    let sql = 'SELECT * FROM session_messages WHERE session_id = $1 AND message_index >= $2';
    const params: unknown[] = [sessionId, from];
    let idx = 3;

    if (to !== undefined) {
      sql += ` AND message_index <= $${idx++}`;
      params.push(to);
    }

    sql += ' ORDER BY message_index ASC';

    const { rows } = await this.pool.query(sql, params);
    return rows.map(r => this.rowToMessage(r));
  }

  async updateEmbeddingStatus(sessionId: string, status: string): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET embedding_status = $1 WHERE id = $2',
      [status, sessionId],
    );
  }

  async updateSummary(sessionId: string, summary: string): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET summary = $1 WHERE id = $2',
      [summary, sessionId],
    );
  }

  async getNextQueued(): Promise<Session | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM sessions WHERE embedding_status IN ('queued', 'queued_embed')
       ORDER BY imported_at ASC LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    return rows.length > 0 ? this.rowToSession(rows[0]) : null;
  }

  async recoverStuckSessions(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE sessions SET embedding_status = 'queued'
       WHERE embedding_status IN ('summarizing', 'embedding')`,
    );
    if (rowCount && rowCount > 0) {
      logger.info({ count: rowCount }, 'Recovered stuck sessions back to queue');
    }
    return rowCount ?? 0;
  }

  async deleteSession(sessionId: string, agentTokenId: string): Promise<boolean> {
    // Single query with ownership check
    const { rowCount } = await this.pool.query(
      'DELETE FROM sessions WHERE id = $1 AND agent_token_id = $2',
      [sessionId, agentTokenId],
    );

    if (rowCount === 0) {
      const { rows } = await this.pool.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);
      if (rows.length === 0) return false;
      throw new Error('Access denied: not your session');
    }
    return true;
  }

  private rowToSession(row: any): Session {
    return {
      id: row.id,
      agentTokenId: row.agent_token_id,
      projectId: row.project_id,
      externalId: row.external_id,
      name: row.name,
      summary: row.summary,
      workingDirectory: row.working_directory,
      gitBranch: row.git_branch,
      messageCount: row.message_count,
      embeddingStatus: row.embedding_status,
      startedAt: row.started_at?.toISOString?.() ?? row.started_at,
      endedAt: row.ended_at?.toISOString?.() ?? row.ended_at,
      importedAt: row.imported_at?.toISOString?.() ?? row.imported_at,
      tags: row.tags || [],
    };
  }

  private rowToMessage(row: any): SessionMessage {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      messageIndex: row.message_index,
      hasToolUse: row.has_tool_use,
      toolNames: row.tool_names || [],
      timestamp: row.timestamp?.toISOString?.() ?? row.timestamp,
    };
  }
}
