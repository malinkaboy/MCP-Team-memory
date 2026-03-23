import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { ProjectRole } from '../memory/types.js';
import logger from '../logger.js';

export interface AgentInfo {
  id: string;
  agentName: string;
  role: ProjectRole;
  isActive: boolean;
  createdAt?: string;
  lastUsedAt?: string;
}

/**
 * Manages per-agent tokens for identity resolution.
 * Tokens are cached in memory for fast lookup; DB is source of truth.
 * Gracefully degrades if agent_tokens table doesn't exist yet (migration not run).
 */
export class AgentTokenStore {
  private cache = new Map<string, AgentInfo>();
  private tableExists = false;
  private lastUsedDebounce = new Map<string, number>();
  private static DEBOUNCE_MS = 60_000;

  constructor(private pool: Pool) {}

  /** Load all active tokens into in-memory cache */
  async initialize(): Promise<void> {
    try {
      const { rows } = await this.pool.query(
        `SELECT id, token, agent_name, role, is_active FROM agent_tokens WHERE is_active = TRUE`
      );
      for (const row of rows) {
        this.cache.set(row.token, {
          id: row.id,
          agentName: row.agent_name,
          role: row.role as ProjectRole,
          isActive: row.is_active,
        });
      }
      this.tableExists = true;
      logger.info({ count: rows.length }, 'Agent token store initialized');
    } catch (err: any) {
      if (err.code === '42P01') {
        logger.warn('agent_tokens table not found — agent token auth disabled');
        return;
      }
      throw err;
    }
  }

  /** Synchronous cache lookup — returns null if token not found or table doesn't exist */
  resolve(token: string): AgentInfo | null {
    if (!this.tableExists) return null;
    return this.cache.get(token) || null;
  }

  /** Create a new agent token. Returns the raw token (show once) and agent info. */
  async create(agentName: string, role: string = 'developer'): Promise<{ token: string; agent: AgentInfo }> {
    const token = 'tm_' + crypto.randomBytes(16).toString('hex');
    const { rows } = await this.pool.query(
      `INSERT INTO agent_tokens (token, agent_name, role) VALUES ($1, $2, $3) RETURNING id, created_at`,
      [token, agentName, role]
    );
    const agent: AgentInfo = {
      id: rows[0].id,
      agentName,
      role: role as ProjectRole,
      isActive: true,
      createdAt: rows[0].created_at,
    };
    this.cache.set(token, agent);
    return { token, agent };
  }

  /** Revoke token by ID. Sets is_active = FALSE and removes from cache. */
  async revoke(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE agent_tokens SET is_active = FALSE WHERE id = $1`,
      [id]
    );
    for (const [tok, info] of this.cache) {
      if (info.id === id) this.cache.delete(tok);
    }
    return (rowCount ?? 0) > 0;
  }

  /** Activate a previously revoked token by ID */
  async activate(id: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `UPDATE agent_tokens SET is_active = TRUE WHERE id = $1 RETURNING token, agent_name, role`,
      [id]
    );
    if (rows.length === 0) return false;
    const row = rows[0];
    this.cache.set(row.token, {
      id,
      agentName: row.agent_name,
      role: row.role as ProjectRole,
      isActive: true,
    });
    return true;
  }

  /** Permanently delete a token from DB */
  async remove(id: string): Promise<boolean> {
    // Remove from cache first
    for (const [tok, info] of this.cache) {
      if (info.id === id) this.cache.delete(tok);
    }
    const { rowCount } = await this.pool.query(
      `DELETE FROM agent_tokens WHERE id = $1`,
      [id]
    );
    return (rowCount ?? 0) > 0;
  }

  /** List all tokens (active and revoked). Includes raw token for admin panel. */
  async list(): Promise<(AgentInfo & { token: string })[]> {
    if (!this.tableExists) return [];
    const { rows } = await this.pool.query(
      `SELECT id, token, agent_name, role, is_active, created_at, last_used_at
       FROM agent_tokens ORDER BY created_at DESC`
    );
    return rows.map(r => ({
      id: r.id,
      token: r.token,
      agentName: r.agent_name,
      role: r.role,
      isActive: r.is_active,
      createdAt: r.created_at?.toISOString?.() || r.created_at,
      lastUsedAt: r.last_used_at?.toISOString?.() || r.last_used_at,
    }));
  }

  /** Fire-and-forget: update last_used_at (debounced — at most once per 60s per token) */
  trackLastUsed(tokenId: string): void {
    const now = Date.now();
    const last = this.lastUsedDebounce.get(tokenId) || 0;
    if (now - last < AgentTokenStore.DEBOUNCE_MS) return;
    this.lastUsedDebounce.set(tokenId, now);
    this.pool.query(`UPDATE agent_tokens SET last_used_at = NOW() WHERE id = $1`, [tokenId])
      .catch(err => logger.error({ err }, 'Failed to update last_used_at'));
  }

  isAvailable(): boolean {
    return this.tableExists;
  }
}
