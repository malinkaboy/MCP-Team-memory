/**
 * Unified Express application: MCP + REST API + Web UI + WebSocket
 * Entry point for HTTP mode (remote server).
 */
import http from 'http';
import express from 'express';
import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { PgStorage } from './storage/pg-storage.js';
import { MemoryManager } from './memory/manager.js';
import { buildMcpServer } from './server.js';
import { mountMcpTransport } from './transport/http.js';
import { WebServer } from './web/server.js';
import { SyncWebSocketServer } from './sync/websocket.js';
import { migrateFromJson } from './storage/migration.js';
import { loadConfig } from './config.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createHealthHandler } from './health.js';
import { createLogger } from './logger.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { AuditLogger } from './storage/audit.js';
import { VersionManager } from './storage/versioning.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info({ transport: 'http', database: config.databaseUrl.replace(/\/\/.*:.*@/, '//***:***@'), port: config.port }, 'Team Memory MCP Server v2 starting');

  // Initialize storage
  const storage = new PgStorage(config.databaseUrl);
  const auditLogger = new AuditLogger(storage.getPool());
  const versionManager = new VersionManager(storage.getPool());
  const memoryManager = new MemoryManager(storage, auditLogger, versionManager);
  await memoryManager.initialize();

  // Auto-migrate from JSON if needed
  const jsonPath = path.join(__dirname, '..', 'data', 'memory.json');
  if (existsSync(jsonPath)) {
    logger.info('Found legacy memory.json, starting migration...');
    await migrateFromJson(jsonPath, storage);
  }

  // Create Express app
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // CORS — allow configurable origins
  const allowedOrigin = process.env.MEMORY_CORS_ORIGIN || '*';
  if (allowedOrigin === '*') {
    logger.warn('CORS origin is set to "*" — all origins allowed. Set MEMORY_CORS_ORIGIN for production.');
  }
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
    if (_req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Health check — no auth required
  app.get('/health', createHealthHandler(storage.getPool()));

  // Auth middleware (optional — set MEMORY_API_TOKEN to enable)
  app.use(createAuthMiddleware(config.apiToken));

  // Rate limiting
  app.use(createRateLimiter({ windowMs: 60_000, maxRequests: 100 }));

  // Mount MCP StreamableHTTP transport
  mountMcpTransport(app, () => buildMcpServer(memoryManager));

  // Mount REST API routes
  const webServer = new WebServer(memoryManager, null);
  webServer.mountRoutes(app);

  // Serve static Web UI files
  const publicPath = path.join(__dirname, 'web', 'public');
  app.use(express.static(publicPath));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
  });

  // Create HTTP server
  const server = http.createServer(app);

  // Attach WebSocket to the same HTTP server
  const wsServer = new SyncWebSocketServer(memoryManager, config.apiToken);
  wsServer.attachToServer(server);
  webServer.setWsServer(wsServer);

  // Embedding provider (optional — set MEMORY_EMBEDDING_PROVIDER=local to enable)
  if (config.embeddingProvider === 'local') {
    const { LocalEmbeddingProvider } = await import('./embedding/local.js');
    const embProvider = new LocalEmbeddingProvider(config.embeddingModelDir);
    await embProvider.initialize();
    if (embProvider.isReady()) {
      memoryManager.setEmbeddingProvider(embProvider);
      memoryManager.backfillEmbeddings().catch(err => logger.error({ err }, 'Embedding backfill failed'));
    }
  }

  // Auto-archive
  if (config.autoArchiveEnabled) {
    const decayConfig = config.decayThreshold !== undefined
      ? { threshold: config.decayThreshold, decayDays: config.decayDays, weights: config.decayWeights }
      : undefined;
    memoryManager.startAutoArchive(config.autoArchiveDays, undefined, decayConfig);
  }

  // Start listening
  server.listen(config.port, '0.0.0.0', () => {
    logger.info({ port: config.port, urls: { webUI: `http://localhost:${config.port}`, mcp: `http://localhost:${config.port}/mcp`, api: `http://localhost:${config.port}/api/`, ws: `ws://localhost:${config.port}/ws` } }, 'Server ready for connections');
  });

  // Graceful shutdown
  let isShuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, 'Graceful shutdown initiated');

    // 1. Stop accepting new HTTP connections
    server.close();

    // 2. Close WebSocket connections
    wsServer.stop();

    // 3. Hard-kill safety net — if graceful shutdown hangs, force exit after 10s
    setTimeout(() => {
      logger.error('Shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000).unref();

    // 4. Wait briefly for in-flight requests to complete
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 5. Force-close remaining keep-alive connections
    server.closeAllConnections();

    // 6. Close database pool (also stops auto-archive timer)
    await memoryManager.close();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  const logger = createLogger();
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
