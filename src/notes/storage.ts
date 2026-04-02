import type { Pool } from 'pg';
import type { PersonalNote, CompactPersonalNote, NoteFilters } from './types.js';

export class PersonalNotesStorage {
  constructor(private pool: Pool) {}

  async create(note: {
    agentTokenId: string;
    title: string;
    content: string;
    tags: string[];
    priority: string;
    projectId: string | null;
    sessionId: string | null;
  }): Promise<PersonalNote> {
    const { rows } = await this.pool.query(
      `INSERT INTO personal_notes (agent_token_id, title, content, tags, priority, project_id, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [note.agentTokenId, note.title, note.content, note.tags, note.priority, note.projectId, note.sessionId],
    );
    return this.rowToNote(rows[0]);
  }

  async getAll(agentTokenId: string | null, filters: NoteFilters): Promise<(PersonalNote | CompactPersonalNote)[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (agentTokenId !== null) {
      conditions.push(`agent_token_id = $${idx++}`);
      params.push(agentTokenId);
    }
    if (filters.projectId) {
      conditions.push(`project_id = $${idx++}`);
      params.push(filters.projectId);
    }
    if (filters.sessionId) {
      conditions.push(`session_id = $${idx++}`);
      params.push(filters.sessionId);
    }
    if (filters.status) {
      conditions.push(`status = $${idx++}`);
      params.push(filters.status);
    }
    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`tags && $${idx++}`);
      params.push(filters.tags);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const columns = filters.mode === 'full'
      ? '*'
      : 'id, agent_token_id, project_id, session_id, title, tags, priority, status, updated_at';

    const { rows } = await this.pool.query(
      `SELECT ${columns} FROM personal_notes ${where} ORDER BY updated_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );

    return rows.map(r => filters.mode === 'full' ? this.rowToNote(r) : this.rowToCompact(r));
  }

  async search(agentTokenId: string | null, query: string, filters: NoteFilters): Promise<PersonalNote[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (agentTokenId !== null) {
      conditions.push(`agent_token_id = $${idx++}`);
      params.push(agentTokenId);
    }

    const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
    conditions.push(`(search_vector @@ plainto_tsquery($${idx}) OR title ILIKE $${idx + 1} ESCAPE '\\' OR content ILIKE $${idx + 1} ESCAPE '\\')`);
    params.push(query, `%${escapedQuery}%`);
    idx += 2;

    if (filters.projectId) {
      conditions.push(`project_id = $${idx++}`);
      params.push(filters.projectId);
    }
    if (filters.sessionId) {
      conditions.push(`session_id = $${idx++}`);
      params.push(filters.sessionId);
    }
    if (filters.status) {
      conditions.push(`status = $${idx++}`);
      params.push(filters.status);
    }
    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`tags && $${idx++}`);
      params.push(filters.tags);
    }

    const where = conditions.join(' AND ');
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const { rows } = await this.pool.query(
      `SELECT * FROM personal_notes WHERE ${where} ORDER BY updated_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );

    return rows.map(r => this.rowToNote(r));
  }

  async getById(id: string, agentTokenId?: string | null): Promise<PersonalNote | null> {
    const conditions = ['id = $1'];
    const params: unknown[] = [id];
    if (agentTokenId) {
      conditions.push('agent_token_id = $2');
      params.push(agentTokenId);
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM personal_notes WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return rows.length > 0 ? this.rowToNote(rows[0]) : null;
  }

  async update(
    id: string,
    agentTokenId: string | null,
    updates: Partial<{ title: string; content: string; tags: string[]; priority: string; status: string; projectId: string | null; sessionId: string | null }>,
  ): Promise<PersonalNote> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (updates.title !== undefined) { setClauses.push(`title = $${idx++}`); params.push(updates.title); }
    if (updates.content !== undefined) { setClauses.push(`content = $${idx++}`); params.push(updates.content); }
    if (updates.tags !== undefined) { setClauses.push(`tags = $${idx++}`); params.push(updates.tags); }
    if (updates.priority !== undefined) { setClauses.push(`priority = $${idx++}`); params.push(updates.priority); }
    if (updates.status !== undefined) { setClauses.push(`status = $${idx++}`); params.push(updates.status); }
    if (updates.projectId !== undefined) { setClauses.push(`project_id = $${idx++}`); params.push(updates.projectId); }
    if (updates.sessionId !== undefined) { setClauses.push(`session_id = $${idx++}`); params.push(updates.sessionId); }

    if (setClauses.length === 0) {
      const note = await this.getById(id, agentTokenId);
      if (!note) {
        // Distinguish not-found from access-denied
        const { rows } = await this.pool.query('SELECT id FROM personal_notes WHERE id = $1', [id]);
        if (rows.length === 0) throw new Error('Note not found');
        throw new Error('Access denied: not your note');
      }
      return note;
    }

    // Single query: ownership check + update (eliminates TOCTOU race)
    const whereConditions = [`id = $${idx++}`];
    params.push(id);
    if (agentTokenId !== null) {
      whereConditions.push(`agent_token_id = $${idx++}`);
      params.push(agentTokenId);
    }

    const { rows, rowCount } = await this.pool.query(
      `UPDATE personal_notes SET ${setClauses.join(', ')} WHERE ${whereConditions.join(' AND ')} RETURNING *`,
      params,
    );

    if (rowCount === 0) {
      // Distinguish "not found" from "access denied"
      const { rows: checkRows } = await this.pool.query('SELECT id FROM personal_notes WHERE id = $1', [id]);
      if (checkRows.length === 0) throw new Error('Note not found');
      throw new Error('Access denied: not your note');
    }

    return this.rowToNote(rows[0]);
  }

  async delete(id: string, agentTokenId: string | null, archive: boolean): Promise<boolean> {
    // Single query with ownership check (eliminates TOCTOU race)
    const whereConditions = ['id = $1'];
    const params: unknown[] = [id];
    let idx = 2;
    if (agentTokenId !== null) {
      whereConditions.push(`agent_token_id = $${idx++}`);
      params.push(agentTokenId);
    }
    const where = whereConditions.join(' AND ');

    let result;
    if (archive) {
      result = await this.pool.query(`UPDATE personal_notes SET status = 'archived' WHERE ${where}`, params);
    } else {
      result = await this.pool.query(`DELETE FROM personal_notes WHERE ${where}`, params);
    }

    if (result.rowCount === 0) {
      const { rows } = await this.pool.query('SELECT id FROM personal_notes WHERE id = $1', [id]);
      if (rows.length === 0) return false;
      throw new Error('Access denied: not your note');
    }
    return true;
  }

  private rowToNote(row: any): PersonalNote {
    return {
      id: row.id,
      agentTokenId: row.agent_token_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      title: row.title,
      content: row.content,
      tags: row.tags || [],
      priority: row.priority,
      status: row.status,
      createdAt: row.created_at?.toISOString?.() ?? row.created_at,
      updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
    };
  }

  private rowToCompact(row: any): CompactPersonalNote {
    return {
      id: row.id,
      agentTokenId: row.agent_token_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      title: row.title,
      tags: row.tags || [],
      priority: row.priority,
      status: row.status,
      updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
    };
  }
}
