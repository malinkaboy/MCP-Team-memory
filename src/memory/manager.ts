import crypto from 'crypto';
import { PgStorage } from '../storage/pg-storage.js';
import { AuditLogger } from '../storage/audit.js';
import { VersionManager } from '../storage/versioning.js';
import { DEFAULT_PROJECT_ID } from './types.js';
import logger from '../logger.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import type {
  MemoryEntry,
  Project,
  Category,
  ReadParams,
  WriteParams,
  UpdateParams,
  DeleteParams,
  SyncParams,
  SyncResult,
  MemoryStats,
  WSEvent,
  WSEventType,
  ConflictError
} from './types.js';

type EventListener = (event: WSEvent) => void;

export class MemoryManager {
  private storage: PgStorage;
  private auditLogger: AuditLogger | null = null;
  private versionManager: VersionManager | null = null;
  private embeddingProvider: EmbeddingProvider | null = null;
  private listeners: Set<EventListener> = new Set();
  private autoArchiveInterval: NodeJS.Timeout | null = null;

  constructor(storage: PgStorage, auditLogger?: AuditLogger, versionManager?: VersionManager) {
    this.storage = storage;
    this.auditLogger = auditLogger || null;
    this.versionManager = versionManager || null;
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
    logger.info('Memory Manager initialized');
  }

  async close(): Promise<void> {
    this.stopAutoArchive();
    await this.storage.close();
  }

  getStorage(): PgStorage {
    return this.storage;
  }

  // === Events ===

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(type: WSEventType, payload: unknown): void {
    const event: WSEvent = {
      type,
      payload,
      timestamp: new Date().toISOString()
    };
    this.listeners.forEach(listener => listener(event));
  }

  // === Projects ===

  async createProject(params: { name: string; description?: string; domains?: string[] }): Promise<Project> {
    return this.storage.createProject(params);
  }

  async listProjects(): Promise<Project[]> {
    return this.storage.listProjects();
  }

  async getProject(id: string): Promise<Project | undefined> {
    return this.storage.getProject(id);
  }

  async updateProject(id: string, updates: Partial<Pick<Project, 'name' | 'description' | 'domains'>>): Promise<Project | undefined> {
    return this.storage.updateProject(id, updates);
  }

  async deleteProject(id: string): Promise<boolean> {
    return this.storage.deleteProject(id);
  }

  // === Entries ===

  async read(params: ReadParams): Promise<MemoryEntry[]> {
    const projectId = params.projectId || DEFAULT_PROJECT_ID;
    const { category = 'all', domain, search, limit = 50, status, tags } = params;

    if (search) {
      // Use hybrid search when embedding provider is available
      if (this.embeddingProvider?.isReady()) {
        try {
          const queryEmbedding = await this.embeddingProvider.embed(search);
          return this.storage.hybridSearch(projectId, search, queryEmbedding, {
            category: category === 'all' ? undefined : category,
            domain,
            status,
            tags,
            limit,
          });
        } catch (err) {
          logger.warn({ err }, 'Hybrid search failed, falling back to FTS');
        }
      }

      return this.storage.search(projectId, search, {
        category: category === 'all' ? undefined : category,
        domain,
        status,
        tags,
        limit,
      });
    }

    return this.storage.getAll(projectId, {
      category: category === 'all' ? undefined : category,
      domain,
      status,
      tags,
      limit,
    });
  }

  async write(params: WriteParams): Promise<MemoryEntry> {
    const now = new Date().toISOString();

    const entry: MemoryEntry = {
      id: crypto.randomUUID(),
      projectId: params.projectId || DEFAULT_PROJECT_ID,
      category: params.category,
      domain: params.domain || null,
      title: params.title,
      content: params.content,
      author: params.author || 'unknown',
      tags: params.tags || [],
      priority: params.priority || 'medium',
      status: 'active',
      pinned: params.pinned || false,
      createdAt: now,
      updatedAt: now,
      relatedIds: params.relatedIds || []
    };

    const created = await this.storage.add(entry);
    this.emit('memory:created', created);
    this.auditLogger?.log({
      entryId: created.id,
      projectId: created.projectId,
      action: 'create',
      actor: created.author,
      changes: { title: created.title, category: created.category },
    }).catch(err => logger.error({ err }, 'Audit log failed'));

    // Fire-and-forget: generate embedding for new entry
    if (this.embeddingProvider?.isReady()) {
      this.embeddingProvider.embed(`${created.title} ${created.content}`)
        .then(emb => this.storage.saveEmbedding(created.id, emb))
        .catch(err => logger.error({ err, entryId: created.id }, 'Embedding generation failed'));
    }

    return created;
  }

  async update(params: UpdateParams): Promise<MemoryEntry | ConflictError | null> {
    const { id, expectedVersion, ...updates } = params;

    const filteredUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, value]) => value !== undefined)
    ) as Partial<MemoryEntry>;

    // Save current version BEFORE the update attempt.
    // Fetch pre-update state, but commit to entry_versions only on success.
    let preUpdateEntry: MemoryEntry | undefined;
    if (this.versionManager) {
      preUpdateEntry = await this.storage.getById(id);
    }

    const result = await this.storage.update(id, filteredUpdates, expectedVersion);

    // Check for conflict — don't save version on conflict
    if (result && 'conflict' in result && result.conflict) {
      return result as ConflictError;
    }

    const updated = result as MemoryEntry | undefined;

    if (updated) {
      // Save version snapshot only AFTER successful update
      if (this.versionManager && preUpdateEntry) {
        await this.versionManager.saveVersion(preUpdateEntry).catch(err =>
          logger.error({ err }, 'Version save failed')
        );
      }

      this.emit('memory:updated', updated);
      this.auditLogger?.log({
        entryId: updated.id,
        projectId: updated.projectId,
        action: 'update',
        actor: updated.author,
        changes: Object.fromEntries(
          Object.entries(params).filter(([k]) => k !== 'id' && k !== 'expectedVersion')
        ),
      }).catch(err => logger.error({ err }, 'Audit log failed'));

      // Fire-and-forget: regenerate embedding if content or title changed
      if (this.embeddingProvider?.isReady() && (params.title || params.content)) {
        this.embeddingProvider.embed(`${updated.title} ${updated.content}`)
          .then(emb => this.storage.saveEmbedding(updated.id, emb))
          .catch(err => logger.error({ err, entryId: updated.id }, 'Embedding regeneration failed'));
      }

      return updated;
    }

    return null;
  }

  async delete(params: DeleteParams): Promise<boolean> {
    const { id, archive = true } = params;

    if (archive) {
      const archived = await this.storage.archive(id);
      if (archived) {
        this.emit('memory:updated', archived);
        this.auditLogger?.log({
          entryId: id,
          projectId: archived.projectId,
          action: 'archive',
          actor: archived.author,
        }).catch(err => logger.error({ err }, 'Audit log failed'));
        return true;
      }
      return false;
    }

    // Fetch entry before hard-delete to get projectId for audit
    const existing = await this.storage.getById(id);
    const deleted = await this.storage.delete(id);
    if (deleted) {
      this.emit('memory:deleted', { id });
      this.auditLogger?.log({
        entryId: id,
        projectId: existing?.projectId,
        action: 'delete',
        actor: existing?.author || 'system',
      }).catch(err => logger.error({ err }, 'Audit log failed'));
      return true;
    }
    return false;
  }

  async pin(id: string, pinned: boolean = true): Promise<MemoryEntry | null> {
    const result = await this.storage.update(id, { pinned });
    if (result && !('conflict' in result)) {
      this.emit('memory:updated', result);
      this.auditLogger?.log({
        entryId: result.id,
        projectId: result.projectId,
        action: pinned ? 'pin' : 'unpin',
        actor: result.author,
      }).catch(err => logger.error({ err }, 'Audit log failed'));
      return result;
    }
    return null;
  }

  getAuditLogger(): AuditLogger | null {
    return this.auditLogger;
  }

  getVersionManager(): VersionManager | null {
    return this.versionManager;
  }

  // === Embedding ===

  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
    logger.info('Embedding provider set');
  }

  getEmbeddingProvider(): EmbeddingProvider | null {
    return this.embeddingProvider;
  }

  /** Backfill embeddings for entries that don't have one yet */
  async backfillEmbeddings(batchSize: number = 50): Promise<number> {
    if (!this.embeddingProvider?.isReady()) return 0;

    const entries = await this.storage.getEntriesWithoutEmbedding(batchSize);
    let count = 0;

    for (const entry of entries) {
      try {
        const text = `${entry.title} ${entry.content}`;
        const embedding = await this.embeddingProvider.embed(text);
        await this.storage.saveEmbedding(entry.id, embedding);
        count++;
      } catch (err) {
        logger.error({ err, entryId: entry.id }, 'Embedding backfill failed for entry');
      }
    }

    if (count > 0) {
      logger.info({ count, total: entries.length }, 'Backfilled embeddings');
    }
    return count;
  }

  // === Sync ===

  async sync(params: SyncParams): Promise<SyncResult> {
    const projectId = params.projectId || DEFAULT_PROJECT_ID;
    const since = params.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const entries = await this.storage.getChangesSince(projectId, since);
    const lastUpdated = await this.storage.getLastUpdated(projectId);

    return {
      entries,
      lastUpdated,
      totalChanges: entries.length
    };
  }

  // === Overview ===

  async getOverview(projectId?: string): Promise<string> {
    const pid = projectId || DEFAULT_PROJECT_ID;
    const entries = await this.storage.getAll(pid, { status: 'active', limit: 200 });
    const project = await this.storage.getProject(pid);

    const byCategory: Record<Category, MemoryEntry[]> = {
      architecture: [],
      tasks: [],
      decisions: [],
      issues: [],
      progress: []
    };

    entries.forEach(e => {
      byCategory[e.category].push(e);
    });

    let overview = `# Обзор проекта: ${project?.name || pid}\n\n`;

    if (byCategory.architecture.length > 0) {
      overview += `## 🏗️ Архитектура (${byCategory.architecture.length})\n`;
      byCategory.architecture.slice(0, 5).forEach(e => {
        overview += `- **${e.title}**${e.domain ? ` [${e.domain}]` : ''}: ${e.content.length > 100 ? e.content.substring(0, 100) + '...' : e.content}\n`;
      });
      overview += '\n';
    }

    if (byCategory.tasks.length > 0) {
      overview += `## 📋 Активные задачи (${byCategory.tasks.length})\n`;
      byCategory.tasks.slice(0, 10).forEach(e => {
        const priority = e.priority === 'critical' ? '🔴' :
          e.priority === 'high' ? '🟠' :
            e.priority === 'medium' ? '🟡' : '🟢';
        overview += `- ${priority} **${e.title}**${e.domain ? ` [${e.domain}]` : ''} [${e.author}]\n`;
      });
      overview += '\n';
    }

    if (byCategory.issues.length > 0) {
      overview += `## 🐛 Известные проблемы (${byCategory.issues.length})\n`;
      byCategory.issues.slice(0, 5).forEach(e => {
        overview += `- **${e.title}**: ${e.content.length > 80 ? e.content.substring(0, 80) + '...' : e.content}\n`;
      });
      overview += '\n';
    }

    if (byCategory.progress.length > 0) {
      overview += `## 📈 Последний прогресс\n`;
      byCategory.progress.slice(0, 3).forEach(e => {
        overview += `- ${e.title} (${new Date(e.updatedAt).toLocaleDateString()})\n`;
      });
      overview += '\n';
    }

    if (byCategory.decisions.length > 0) {
      overview += `## ✅ Ключевые решения (${byCategory.decisions.length})\n`;
      byCategory.decisions.slice(0, 5).forEach(e => {
        overview += `- **${e.title}**\n`;
      });
    }

    return overview;
  }

  // === Stats ===

  async getStats(projectId?: string): Promise<MemoryStats> {
    const pid = projectId || DEFAULT_PROJECT_ID;
    const dbStats = await this.storage.getStats(pid);

    return {
      totalEntries: dbStats.totalEntries,
      byCategory: {
        architecture: dbStats.byCategory.architecture || 0,
        tasks: dbStats.byCategory.tasks || 0,
        decisions: dbStats.byCategory.decisions || 0,
        issues: dbStats.byCategory.issues || 0,
        progress: dbStats.byCategory.progress || 0,
      },
      byDomain: dbStats.byDomain,
      byStatus: {
        active: dbStats.byStatus.active || 0,
        completed: dbStats.byStatus.completed || 0,
        archived: dbStats.byStatus.archived || 0,
      },
      byPriority: {
        low: dbStats.byPriority.low || 0,
        medium: dbStats.byPriority.medium || 0,
        high: dbStats.byPriority.high || 0,
        critical: dbStats.byPriority.critical || 0,
      },
      recentActivity: {
        last24h: dbStats.last24h,
        last7d: dbStats.last7d,
      },
      connectedAgents: this.listeners.size,
    };
  }

  async getRecent(projectId?: string, hours = 24): Promise<MemoryEntry[]> {
    const pid = projectId || DEFAULT_PROJECT_ID;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    return this.storage.getChangesSince(pid, since);
  }

  // === Auto-archive ===

  async autoArchiveOldEntries(days: number = 14): Promise<number> {
    const archived = await this.storage.archiveOldEntries(days);
    if (archived > 0) {
      logger.info({ archived, days }, 'Auto-archived old entries');
    }
    return archived;
  }

  async autoArchiveByScore(
    threshold: number,
    decayDays: number,
    weights: [number, number, number, number]
  ): Promise<number> {
    const archived = await this.storage.archiveByScore(threshold, decayDays, weights);
    if (archived > 0) {
      logger.info({ archived, threshold, decayDays }, 'Auto-archived entries by score');
    }
    return archived;
  }

  startAutoArchive(
    days: number = 14,
    checkIntervalMs: number = 24 * 60 * 60 * 1000,
    decayConfig?: { threshold: number; decayDays: number; weights: [number, number, number, number] }
  ): void {
    if (this.autoArchiveInterval) {
      clearInterval(this.autoArchiveInterval);
    }

    const archiveTask = decayConfig
      ? () => this.autoArchiveByScore(decayConfig.threshold, decayConfig.decayDays, decayConfig.weights)
      : () => this.autoArchiveOldEntries(days);

    archiveTask().catch(err =>
      logger.error({ err }, 'Initial auto-archive failed')
    );

    this.autoArchiveInterval = setInterval(async () => {
      try {
        await archiveTask();
      } catch (error) {
        logger.error({ err: error }, 'Auto archive failed');
      }
    }, checkIntervalMs);

    logger.info({ days, intervalHours: checkIntervalMs / 1000 / 60 / 60 }, 'Auto-archive enabled');
  }

  stopAutoArchive(): void {
    if (this.autoArchiveInterval) {
      clearInterval(this.autoArchiveInterval);
      this.autoArchiveInterval = null;
    }
  }
}
