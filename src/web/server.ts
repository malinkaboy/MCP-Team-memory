import express, { type Express, type Request, type Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import type { MemoryManager } from '../memory/manager.js';
import type { SyncWebSocketServer } from '../sync/websocket.js';
import { PROJECT_ROLES } from '../memory/types.js';
import type { MemoryEntry } from '../memory/types.js';
import { ReadParamsSchema, WriteParamsSchema, UpdateParamsSchema, formatZodError } from '../memory/validation.js';
import { exportEntries, type ExportFormat } from '../export/exporter.js';
import type { AgentTokenStore } from '../auth/agent-tokens.js';
import { buildAutoContext } from '../recall.js';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class WebServer {
  private app: Express | null = null;
  private memoryManager: MemoryManager;
  private wsServer: SyncWebSocketServer | null;
  private agentTokenStore?: AgentTokenStore;

  constructor(memoryManager: MemoryManager, wsServer: SyncWebSocketServer | null = null, agentTokenStore?: AgentTokenStore) {
    this.memoryManager = memoryManager;
    this.wsServer = wsServer;
    this.agentTokenStore = agentTokenStore;
  }

  setWsServer(wsServer: SyncWebSocketServer): void {
    this.wsServer = wsServer;
  }

  /** Mount REST API routes onto an existing Express app (for unified mode) */
  mountRoutes(app: Express): void {
    this.setupRoutes(app);
  }

  /** Start a standalone Express server with built-in static files */
  start(port: number): void {
    this.app = express();
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'public')));
    this.setupRoutes(this.app);
    this.app.get('/', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
    this.app.listen(port, '0.0.0.0', () => {
      logger.info({ port }, 'Web UI available');
    });
  }

  private setupRoutes(app: Express): void {
    // === Projects API ===

    app.get('/api/projects', async (_req: Request, res: Response) => {
      try {
        const projects = await this.memoryManager.listProjects();
        res.json({ success: true, projects });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    app.post('/api/projects', async (req: Request, res: Response) => {
      try {
        const { name, description, domains } = req.body;
        if (!name) {
          res.status(400).json({ success: false, error: 'name is required' });
          return;
        }
        const project = await this.memoryManager.createProject({ name, description, domains });
        res.json({ success: true, project });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    app.put('/api/projects/:id', async (req: Request, res: Response) => {
      try {
        // Only master token holder can rename/update projects
        if ((req as any).agentName) {
          res.status(403).json({ success: false, error: 'Only administrator can update projects' });
          return;
        }
        const { id } = req.params;
        const { name, description, domains } = req.body;
        const project = await this.memoryManager.updateProject(id, { name, description, domains });
        if (!project) {
          res.status(404).json({ success: false, error: 'Project not found' });
          return;
        }
        res.json({ success: true, project });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    app.delete('/api/projects/:id', async (req: Request, res: Response) => {
      try {
        // Only master token holder can delete projects
        if ((req as any).agentName) {
          res.status(403).json({ success: false, error: 'Only administrator can delete projects' });
          return;
        }
        const { id } = req.params;
        const deleted = await this.memoryManager.deleteProject(id);
        if (!deleted) {
          res.status(400).json({ success: false, error: 'Cannot delete default project or not found' });
          return;
        }
        res.json({ success: true });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    // === Memory Entries API ===

    app.get('/api/memory', async (req: Request, res: Response) => {
      try {
        const parsed = ReadParamsSchema.safeParse({
          project_id: req.query.project_id,
          category: req.query.category || 'all',
          domain: req.query.domain,
          search: req.query.search,
          status: req.query.status,
          limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
          offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
        });

        if (!parsed.success) {
          res.status(400).json({ success: false, error: formatZodError(parsed.error) });
          return;
        }

        const { project_id, category, domain, search, status, limit, offset } = parsed.data;
        const entries = await this.memoryManager.read({
          projectId: project_id,
          category,
          domain,
          search,
          status,
          limit,
          offset,
          mode: 'full',
        });

        res.json({ success: true, entries, offset, limit, hasMore: entries.length === limit });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    app.get('/api/stats', async (req: Request, res: Response) => {
      try {
        const projectId = req.query.project_id as string | undefined;
        const stats = await this.memoryManager.getStats(projectId);

        if (this.wsServer) {
          stats.connectedAgents = this.wsServer.getConnectedCount(projectId);
        }

        const embedding = await this.memoryManager.getEmbeddingStats();
        res.json({ success: true, stats, embedding });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    app.get('/api/agents', (req: Request, res: Response) => {
      try {
        const projectId = req.query.project_id as string | undefined;
        const agents = this.wsServer?.getConnectedClientsInfo(projectId) || [];
        res.json({ success: true, agents });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    app.post('/api/memory', async (req: Request, res: Response) => {
      try {
        const parsed = WriteParamsSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ success: false, error: formatZodError(parsed.error) });
          return;
        }

        const { project_id, ...writeData } = parsed.data;
        // Override author if agent token was used
        if (req.agentName) writeData.author = req.agentName;
        const entry = await this.memoryManager.write({ ...writeData, projectId: project_id });
        res.json({ success: true, entry });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    app.put('/api/memory/:id', async (req: Request, res: Response) => {
      try {
        const parsed = UpdateParamsSchema.safeParse({ id: req.params.id, ...req.body });
        if (!parsed.success) {
          res.status(400).json({ success: false, error: formatZodError(parsed.error) });
          return;
        }

        const updated = await this.memoryManager.update(parsed.data);
        if (!updated) {
          res.status(404).json({ success: false, error: 'Entry not found' });
          return;
        }

        res.json({ success: true, entry: updated });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    app.delete('/api/memory/:id', async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const archive = req.query.archive !== 'false';

        const success = await this.memoryManager.delete({ id, archive });
        if (!success) {
          res.status(404).json({ success: false, error: 'Entry not found' });
          return;
        }

        res.json({ success: true, archived: archive });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    app.post('/api/memory/:id/pin', async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const { pinned } = req.body;

        const updated = await this.memoryManager.pin(id, pinned !== false);
        if (!updated) {
          res.status(404).json({ success: false, error: 'Entry not found' });
          return;
        }

        res.json({ success: true, entry: updated });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    // === Audit API ===

    app.get('/api/audit/:entryId', async (req: Request, res: Response) => {
      try {
        const auditLogger = this.memoryManager.getAuditLogger();
        if (!auditLogger) {
          res.status(501).json({ success: false, error: 'Audit logging not enabled' });
          return;
        }
        const entries = await auditLogger.getByEntry(req.params.entryId);
        res.json({ success: true, audit: entries });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    app.get('/api/audit', async (req: Request, res: Response) => {
      try {
        const auditLogger = this.memoryManager.getAuditLogger();
        if (!auditLogger) {
          res.status(501).json({ success: false, error: 'Audit logging not enabled' });
          return;
        }
        const projectId = req.query.project_id as string | undefined;
        const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string, 10), 200) : 50;

        const entries = projectId
          ? await auditLogger.getByProject(projectId, limit)
          : await auditLogger.getRecent(limit);

        res.json({ success: true, audit: entries });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    // === Version History API ===

    app.get('/api/memory/:id/history', async (req: Request, res: Response) => {
      try {
        const vm = this.memoryManager.getVersionManager();
        if (!vm) {
          res.status(501).json({ success: false, error: 'Versioning not enabled' });
          return;
        }
        const versions = await vm.getVersions(req.params.id);
        res.json({ success: true, versions });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    // === Export API ===

    app.get('/api/export', async (req: Request, res: Response) => {
      try {
        const projectId = req.query.project_id as string | undefined;
        const format = (req.query.format as string) || 'markdown';
        if (format !== 'markdown' && format !== 'json') {
          res.status(400).json({ success: false, error: 'Invalid format. Supported: markdown, json' });
          return;
        }
        const category = (req.query.category as string) || 'all';

        const entries = await this.memoryManager.read({
          projectId,
          category: category as any,
          limit: 500,
          status: 'active',
          mode: 'full',
        });

        const exported = exportEntries(entries as MemoryEntry[], format);

        if (format === 'json') {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Content-Disposition', 'attachment; filename="team-memory-export.json"');
        } else {
          res.setHeader('Content-Type', 'text/markdown');
          res.setHeader('Content-Disposition', 'attachment; filename="team-memory-export.md"');
        }

        res.send(exported);
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    // === Backup API (admin only) ===

    app.post('/api/backup', async (req: Request, res: Response) => {
      try {
        // Only master token holder can create backups
        if ((req as any).agentName) {
          res.status(403).json({ success: false, error: 'Only administrator can create backups' });
          return;
        }

        const { execFileSync } = await import('child_process');
        const fs = await import('fs');
        const backupDir = path.join(__dirname, '../../data/backups/pg');
        fs.mkdirSync(backupDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(backupDir, `team-memory-${timestamp}.sql`);

        const dbUrl = process.env.DATABASE_URL || 'postgresql://memory:memory@localhost:5432/team_memory';
        const container = process.env.PG_CONTAINER || 'team-memory-pg';
        const fd = fs.openSync(backupFile, 'w');
        try {
          try {
            execFileSync('pg_dump', ['--version'], { stdio: 'pipe' });
            execFileSync('pg_dump', [dbUrl], { stdio: ['pipe', fd, 'pipe'] });
          } catch {
            // pg_dump not in PATH — use docker exec
            const url = new URL(dbUrl);
            execFileSync('docker', ['exec', container, 'pg_dump', '-U', url.username, url.pathname.slice(1)],
              { stdio: ['pipe', fd, 'pipe'] });
          }
        } finally {
          fs.closeSync(fd);
        }

        // Get file size
        const stats = fs.statSync(backupFile);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

        // Clean old backups (keep last 30)
        const files = fs.readdirSync(backupDir)
          .filter((f: string) => f.startsWith('team-memory-') && f.endsWith('.sql'))
          .sort()
          .reverse();
        for (const f of files.slice(30)) {
          fs.unlinkSync(path.join(backupDir, f));
        }

        logger.info({ backupFile, sizeMB }, 'Database backup created');
        res.json({ success: true, file: path.basename(backupFile), sizeMB, totalBackups: Math.min(files.length, 30) });
      } catch (error) {
        logger.error({ err: error }, 'Backup failed');
        res.status(500).json({ success: false, error: 'Backup failed' });
      }
    });

    // Auto-recall endpoint (role-aware context)
    app.get('/api/recall', async (req: Request, res: Response) => {
      try {
        const projectId = req.query.project_id as string | undefined;
        const context = req.query.context as string | undefined;
        const limit = parseInt(req.query.limit as string) || 10;
        const result = await buildAutoContext(this.memoryManager, {
          projectId,
          context,
          limit,
          agentRole: req.agentRole,
        });
        res.json({
          success: true,
          role: req.agentRole || null,
          count: result.entries.length,
          entries: result.entries.map(e => ({ category: e.category, domain: e.domain, title: e.title, priority: e.priority, pinned: e.pinned })),
        });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    // === Agent Tokens REST API ===

    const requireAdmin = (req: Request, res: Response): boolean => {
      // Only master token (MEMORY_API_TOKEN) can manage agent tokens.
      // Agent tokens — even with role 'admin' — cannot create/delete other tokens.
      if (!req.agentName) return true; // master token has no agentName
      res.status(403).json({ success: false, error: 'Forbidden: only master token can manage agents' });
      return false;
    };

    app.get('/api/agent-tokens', async (req: Request, res: Response) => {
      try {
        if (!requireAdmin(req, res)) return;
        if (!this.agentTokenStore) {
          res.json({ success: true, tokens: [] });
          return;
        }
        const tokens = await this.agentTokenStore.list();
        res.json({ success: true, tokens });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    app.post('/api/agent-tokens', async (req: Request, res: Response) => {
      try {
        if (!requireAdmin(req, res)) return;
        if (!this.agentTokenStore) {
          res.status(503).json({ success: false, error: 'Agent tokens not available' });
          return;
        }
        const { agent_name, role } = req.body;
        if (!agent_name || typeof agent_name !== 'string' || agent_name.trim().length === 0 || agent_name.length > 64) {
          res.status(400).json({ success: false, error: 'agent_name is required (1-64 characters)' });
          return;
        }
        if (role && !PROJECT_ROLES.includes(role as any)) {
          res.status(400).json({ success: false, error: `Invalid role. Must be: ${PROJECT_ROLES.join(', ')}` });
          return;
        }
        const result = await this.agentTokenStore.create(agent_name.trim(), role || 'developer');
        res.json({ success: true, ...result });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    app.post('/api/agent-tokens/:id/revoke', async (req: Request, res: Response) => {
      try {
        if (!requireAdmin(req, res)) return;
        if (!this.agentTokenStore) {
          res.status(503).json({ success: false, error: 'Agent tokens not available' });
          return;
        }
        const success = await this.agentTokenStore.revoke(req.params.id);
        res.json({ success });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    app.post('/api/agent-tokens/:id/activate', async (req: Request, res: Response) => {
      try {
        if (!requireAdmin(req, res)) return;
        if (!this.agentTokenStore) {
          res.status(503).json({ success: false, error: 'Agent tokens not available' });
          return;
        }
        const success = await this.agentTokenStore.activate(req.params.id);
        res.json({ success });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    app.delete('/api/agent-tokens/:id', async (req: Request, res: Response) => {
      try {
        if (!requireAdmin(req, res)) return;
        if (!this.agentTokenStore) {
          res.status(503).json({ success: false, error: 'Agent tokens not available' });
          return;
        }
        const success = await this.agentTokenStore.remove(req.params.id);
        res.json({ success });
      } catch (error) {
        logger.error({ err: error }, 'API error');
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });
  }
}
