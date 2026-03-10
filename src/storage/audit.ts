import type pg from 'pg';

export type AuditAction = 'create' | 'update' | 'delete' | 'archive' | 'unarchive' | 'pin' | 'unpin';

export interface AuditEntry {
  id: number;
  entryId: string | null;
  projectId: string | null;
  action: AuditAction;
  actor: string;
  changes: Record<string, unknown>;
  createdAt: string;
}

export class AuditLogger {
  constructor(private pool: pg.Pool) {}

  async log(params: {
    entryId?: string;
    projectId?: string;
    action: AuditAction;
    actor: string;
    changes?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (entry_id, project_id, action, actor, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        params.entryId || null,
        params.projectId || null,
        params.action,
        params.actor,
        JSON.stringify(params.changes || {}),
      ]
    );
  }

  async getByEntry(entryId: string, limit = 50): Promise<AuditEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM audit_log WHERE entry_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [entryId, limit]
    );
    return rows.map(this.rowToAudit);
  }

  async getByProject(projectId: string, limit = 100): Promise<AuditEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM audit_log WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [projectId, limit]
    );
    return rows.map(this.rowToAudit);
  }

  async getRecent(limit = 50): Promise<AuditEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows.map(this.rowToAudit);
  }

  private rowToAudit(row: Record<string, unknown>): AuditEntry {
    return {
      id: row.id as number,
      entryId: row.entry_id as string | null,
      projectId: row.project_id as string | null,
      action: row.action as AuditAction,
      actor: row.actor as string,
      changes: (row.changes as Record<string, unknown>) || {},
      createdAt: (row.created_at as Date).toISOString(),
    };
  }
}
