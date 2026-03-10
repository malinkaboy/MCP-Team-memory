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
import { createRateLimiter } from './middleware/rate-limit.js';
import { AuditLogger } from './storage/audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  const config = loadConfig();

  console.error('='.repeat(50));
  console.error('Team Memory MCP Server v2 (HTTP mode)');
  console.error('='.repeat(50));
  console.error(`Database: ${config.databaseUrl.replace(/\/\/.*:.*@/, '//***:***@')}`);
  console.error(`Port: ${config.port}`);
  console.error('='.repeat(50));

  // Initialize storage
  const storage = new PgStorage(config.databaseUrl);
  const auditLogger = new AuditLogger(storage.getPool());
  const memoryManager = new MemoryManager(storage, auditLogger);
  await memoryManager.initialize();

  // Auto-migrate from JSON if needed
  const jsonPath = path.join(__dirname, '..', 'data', 'memory.json');
  if (existsSync(jsonPath)) {
    console.error('Found legacy memory.json, starting migration...');
    await migrateFromJson(jsonPath, storage);
  }

  // Create Express app
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // CORS — allow configurable origins
  app.use((_req, res, next) => {
    const allowedOrigin = process.env.MEMORY_CORS_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
    if (_req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

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
  const wsServer = new SyncWebSocketServer(memoryManager);
  wsServer.attachToServer(server);

  // Auto-archive
  if (config.autoArchiveEnabled) {
    memoryManager.startAutoArchive(config.autoArchiveDays);
  }

  // Start listening
  server.listen(config.port, '0.0.0.0', () => {
    console.error(`\nServer running on http://0.0.0.0:${config.port}`);
    console.error(`  Web UI:    http://localhost:${config.port}`);
    console.error(`  MCP:       http://localhost:${config.port}/mcp`);
    console.error(`  REST API:  http://localhost:${config.port}/api/`);
    console.error(`  WebSocket: ws://localhost:${config.port}/ws`);
    console.error('\nReady for connections.');
  });

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.error('\nShutting down...');
    wsServer.stop();
    await memoryManager.close();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
