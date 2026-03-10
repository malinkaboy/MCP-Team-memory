import express, { type Express, type Request, type Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import type { MemoryManager } from '../memory/manager.js';
import type { SyncWebSocketServer } from '../sync/websocket.js';
import type { Category, Priority, Status } from '../memory/types.js';
import { ReadParamsSchema, WriteParamsSchema, UpdateParamsSchema, formatZodError } from '../memory/validation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class WebServer {
  private app: Express | null = null;
  private memoryManager: MemoryManager;
  private wsServer: SyncWebSocketServer | null;

  constructor(memoryManager: MemoryManager, wsServer: SyncWebSocketServer | null = null) {
    this.memoryManager = memoryManager;
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
      console.error(`Web UI available at http://localhost:${port}`);
    });
  }

  private setupRoutes(app: Express): void {
    // === Projects API ===

    app.get('/api/projects', async (_req: Request, res: Response) => {
      try {
        const projects = await this.memoryManager.listProjects();
        res.json({ success: true, projects });
      } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
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
        res.status(500).json({ success: false, error: (error as Error).message });
      }
    });

    app.put('/api/projects/:id', async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const { name, description, domains } = req.body;
        const project = await this.memoryManager.updateProject(id, { name, description, domains });
        if (!project) {
          res.status(404).json({ success: false, error: 'Project not found' });
          return;
        }
        res.json({ success: true, project });
      } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
      }
    });

    app.delete('/api/projects/:id', async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        const deleted = await this.memoryManager.deleteProject(id);
        if (!deleted) {
          res.status(400).json({ success: false, error: 'Cannot delete default project or not found' });
          return;
        }
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
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
        });

        if (!parsed.success) {
          res.status(400).json({ success: false, error: formatZodError(parsed.error) });
          return;
        }

        const { project_id, category, domain, search, status, limit } = parsed.data;
        const entries = await this.memoryManager.read({
          projectId: project_id,
          category,
          domain,
          search,
          status,
          limit,
        });

        res.json({ success: true, entries });
      } catch (error) {
        console.error('API error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    app.get('/api/stats', async (req: Request, res: Response) => {
      try {
        const projectId = req.query.project_id as string | undefined;
        const stats = await this.memoryManager.getStats(projectId);

        if (this.wsServer) {
          stats.connectedAgents = this.wsServer.getConnectedCount();
        }

        res.json({ success: true, stats });
      } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
      }
    });

    app.get('/api/agents', (_req: Request, res: Response) => {
      try {
        const agents = this.wsServer?.getConnectedClientsInfo() || [];
        res.json({ success: true, agents });
      } catch (error) {
        res.status(500).json({ success: false, error: (error as Error).message });
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
        const entry = await this.memoryManager.write({ ...writeData, projectId: project_id });
        res.json({ success: true, entry });
      } catch (error) {
        console.error('API error:', error);
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
        console.error('API error:', error);
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
        res.status(500).json({ success: false, error: (error as Error).message });
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
        res.status(500).json({ success: false, error: (error as Error).message });
      }
    });
  }
}
