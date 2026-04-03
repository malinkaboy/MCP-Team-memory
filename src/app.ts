/**
 * Unified Express application: MCP + REST API + Web UI + WebSocket
 * Entry point for HTTP mode (remote server).
 */
import 'dotenv/config';
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
import { AgentTokenStore } from './auth/agent-tokens.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info({ transport: 'http', database: config.databaseUrl.replace(/\/\/.*:.*@/, '//***:***@'), port: config.port }, 'Team Memory MCP Server v2 starting');

  // Initialize storage
  const storage = new PgStorage(config.databaseUrl, config.ftsLanguage);
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
  app.use(express.json({ limit: '50mb' }));  // Large limit for session_import (sessions can be 10-50MB)

  // CORS — allow configurable origins
  const allowedOrigin = process.env.MEMORY_CORS_ORIGIN || '*';
  if (allowedOrigin === '*') {
    logger.warn('CORS origin is set to "*" — all origins allowed. Set MEMORY_CORS_ORIGIN for production.');
  }
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, X-Project-Id');
    // CSP: restrict script/style sources to prevent XSS
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; connect-src 'self' ws: wss: https://unpkg.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com");
    if (_req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Health check — no auth required
  app.get('/health', createHealthHandler(storage.getPool()));

  // Auth check — no auth required, tells UI if login is needed
  const authEnabled = !!config.apiToken?.trim();
  app.get('/api/auth/check', (_req, res) => {
    res.json({ authEnabled });
  });

  // Agent token store — per-agent identity (gracefully degrades if table doesn't exist)
  const agentTokenStore = new AgentTokenStore(storage.getPool());
  await agentTokenStore.initialize();

  // Auth middleware (optional — set MEMORY_API_TOKEN to enable)
  app.use(createAuthMiddleware(config.apiToken, agentTokenStore));

  // Auth verify — after auth middleware, returns agent info if token is valid
  // isMaster: true only for MEMORY_API_TOKEN holder (the one who deployed the server)
  app.get('/api/auth/verify', (req, res) => {
    const isMaster = !req.agentName; // master token has no agentName
    res.json({
      authenticated: true,
      agentName: req.agentName || null,
      role: req.agentRole || null, // project role from token, null for master
      isMaster,
    });
  });

  // Rate limiting
  app.use(createRateLimiter({ windowMs: 60_000, maxRequests: 100 }));

  // MCP transport is mounted later, after optional managers are created
  // (see below: mountMcpTransport call after Qdrant + NotesManager setup)

  // Mount REST API routes
  const webServer = new WebServer(memoryManager, null, agentTokenStore);
  webServer.mountRoutes(app);

  // Serve static Web UI files
  const publicPath = path.join(__dirname, 'web', 'public');
  app.use(express.static(publicPath));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
  });
  app.get('/login', (_req, res) => {
    res.sendFile(path.join(publicPath, 'login.html'));
  });

  // Create HTTP server
  const server = http.createServer(app);

  // Attach WebSocket to the same HTTP server
  const wsServer = new SyncWebSocketServer(memoryManager, config.apiToken, agentTokenStore);
  wsServer.attachToServer(server);
  webServer.setWsServer(wsServer);

  // Embedding provider — Ollama with nomic-embed-text-v2-moe
  const { OllamaEmbeddingProvider } = await import('./embedding/ollama.js');
  const embProvider = new OllamaEmbeddingProvider(config.ollamaUrl, config.ollamaEmbeddingModel);
  await embProvider.initialize();
  if (embProvider.isReady()) {
    await memoryManager.setEmbeddingProvider(embProvider);
  }

  // Qdrant vector store — shared setup (entries + personal_notes + sessions collections)
  const { setupQdrant } = await import('./vector/setup.js');
  await setupQdrant(config, memoryManager, storage.getPool());

  // Backfill embeddings AFTER Qdrant is set up (so Qdrant-based backfill works)
  if (memoryManager.getEmbeddingProvider()?.isReady()) {
    memoryManager.backfillEmbeddings().catch(err => logger.error({ err }, 'Embedding backfill failed'));
  }

  // Personal Notes manager (optional — requires agent tokens)
  let notesManager: import('./notes/manager.js').NotesManager | undefined;
  if (agentTokenStore) {
    const { PersonalNotesStorage } = await import('./notes/storage.js');
    const { NotesManager } = await import('./notes/manager.js');
    const notesStorage = new PersonalNotesStorage(storage.getPool());
    notesManager = new NotesManager(notesStorage, memoryManager.getVectorStore() ?? undefined, memoryManager.getEmbeddingProvider() ?? undefined);
    logger.info('Personal notes manager initialized');
  }

  // Session manager (optional — requires agent tokens)
  let sessionManager: import('./sessions/manager.js').SessionManager | undefined;
  let llmClient: import('./llm/ollama.js').OllamaLlmClient | undefined;
  if (agentTokenStore) {
    // LLM client for summarization (optional — requires Ollama with LLM model)
    const { OllamaLlmClient } = await import('./llm/ollama.js');
    const ollamaLlm = new OllamaLlmClient(config.ollamaUrl, config.ollamaLlmModel);
    await ollamaLlm.initialize();
    if (ollamaLlm.isReady()) llmClient = ollamaLlm;

    const { SessionStorage } = await import('./sessions/storage.js');
    const { SessionManager } = await import('./sessions/manager.js');
    const sessionStorage = new SessionStorage(storage.getPool());
    sessionManager = new SessionManager(sessionStorage, memoryManager.getVectorStore() ?? undefined, memoryManager.getEmbeddingProvider() ?? undefined, llmClient);
    logger.info('Session manager initialized');
  }

  // AI Chat endpoint
  const MAX_CHAT_SESSIONS = 100;
  const CHAT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
  type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string };
  const chatSessions = new Map<string, { messages: ChatMessage[]; lastActive: number }>();

  function evictStaleSessions() {
    const now = Date.now();
    for (const [id, session] of chatSessions) {
      if (now - session.lastActive > CHAT_SESSION_TTL_MS) chatSessions.delete(id);
    }
    // Hard cap: evict oldest if still over limit
    if (chatSessions.size > MAX_CHAT_SESSIONS) {
      const sorted = [...chatSessions.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
      for (let i = 0; i < sorted.length - MAX_CHAT_SESSIONS; i++) chatSessions.delete(sorted[i][0]);
    }
  }

  app.post('/api/chat', async (req, res) => {
    if (!llmClient?.isReady()) {
      res.status(503).json({ error: 'LLM not available' });
      return;
    }
    const { message, session_id } = req.body;
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    if (message.length > 10_000) {
      res.status(400).json({ error: 'Message too long (max 10,000 characters)' });
      return;
    }

    evictStaleSessions();

    const chatId = session_id || 'default';
    if (!chatSessions.has(chatId)) {
      chatSessions.set(chatId, {
        messages: [{ role: 'system', content: '/no_think\nYou are a helpful AI assistant. Respond in the same language as the user. Be concise — keep answers under 300 words.' }],
        lastActive: Date.now(),
      });
    }
    const session = chatSessions.get(chatId)!;
    session.lastActive = Date.now();
    session.messages.push({ role: 'user', content: message });

    // Rolling window: keep system prompt + last 30 messages
    if (session.messages.length > 31) {
      const system = session.messages[0];
      session.messages = [system, ...session.messages.slice(-30)];
    }

    try {
      const reply = await llmClient.chat(session.messages);
      session.messages.push({ role: 'assistant', content: reply });
      res.json({ reply, model: llmClient.modelName });
    } catch (err) {
      logger.error({ err }, 'Chat generation failed');
      res.status(500).json({ error: 'Generation failed' });
    }
  });

  app.get('/api/chat/status', (_req, res) => {
    res.json({
      available: !!llmClient?.isReady(),
      model: llmClient?.modelName ?? null,
    });
  });

  app.delete('/api/chat', (req, res) => {
    const chatId = req.body?.session_id || (req.query.session_id as string) || 'default';
    chatSessions.delete(chatId);
    res.json({ ok: true });
  });

  // Mount MCP transport (after all optional managers are created)
  mountMcpTransport(app, () => buildMcpServer(memoryManager, agentTokenStore, notesManager, sessionManager));

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

    // 6. Close LLM client
    await llmClient?.close();

    // 7. Close database pool (also stops auto-archive timer)
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
