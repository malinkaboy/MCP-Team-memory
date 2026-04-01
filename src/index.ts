#!/usr/bin/env node
/**
 * Team Memory MCP Server v2
 *
 * Supports two transport modes:
 * - stdio: for local Claude Code integration (default)
 * - http:  for remote server with Web UI (set MEMORY_TRANSPORT=http)
 */

import 'dotenv/config';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

if (config.transport === 'http') {
  // HTTP mode — import and run app.ts
  await import('./app.js');
} else {
  // stdio mode — original MCP server behavior
  const { PgStorage } = await import('./storage/pg-storage.js');
  const { MemoryManager } = await import('./memory/manager.js');
  const { TeamMemoryMCPServer } = await import('./server.js');

  logger.info({ transport: 'stdio', database: config.databaseUrl.replace(/\/\/.*:.*@/, '//***:***@') }, 'Team Memory MCP Server v2 starting');

  try {
    const storage = new PgStorage(config.databaseUrl, config.ftsLanguage);
    const { AuditLogger } = await import('./storage/audit.js');
    const auditLogger = new AuditLogger(storage.getPool());
    const { VersionManager } = await import('./storage/versioning.js');
    const versionManager = new VersionManager(storage.getPool());
    const memoryManager = new MemoryManager(storage, auditLogger, versionManager);
    await memoryManager.initialize();

    // Embedding provider (optional) — must be set before Qdrant and MCP server creation
    if (config.embeddingProvider === 'gemini' && config.geminiApiKey) {
      const { GeminiEmbeddingProvider } = await import('./embedding/gemini.js');
      const embProvider = new GeminiEmbeddingProvider(config.geminiApiKey);
      await embProvider.initialize();
      if (embProvider.isReady()) {
        await memoryManager.setEmbeddingProvider(embProvider);
      }
    } else if (config.embeddingProvider === 'ollama') {
      const { OllamaEmbeddingProvider } = await import('./embedding/ollama.js');
      const embProvider = new OllamaEmbeddingProvider(config.ollamaUrl, config.ollamaEmbeddingModel);
      await embProvider.initialize();
      if (embProvider.isReady()) {
        await memoryManager.setEmbeddingProvider(embProvider);
      }
    } else if (config.embeddingProvider === 'local') {
      const { LocalEmbeddingProvider } = await import('./embedding/local.js');
      const embProvider = new LocalEmbeddingProvider(config.embeddingModelDir);
      await embProvider.initialize();
      if (embProvider.isReady()) {
        await memoryManager.setEmbeddingProvider(embProvider);
      }
    }

    // Qdrant vector store — shared setup
    const { setupQdrant } = await import('./vector/setup.js');
    await setupQdrant(config, memoryManager, storage.getPool());

    // Backfill embeddings AFTER Qdrant is set up
    if (memoryManager.getEmbeddingProvider()?.isReady()) {
      memoryManager.backfillEmbeddings().catch(err => logger.error({ err }, 'Embedding backfill failed'));
    }

    // Agent tokens (optional — enables per-agent identity for notes/sessions)
    let agentTokenStore: import('./auth/agent-tokens.js').AgentTokenStore | undefined;
    let notesManager: import('./notes/manager.js').NotesManager | undefined;
    let sessionManager: import('./sessions/manager.js').SessionManager | undefined;
    if (config.apiToken) {
      const { AgentTokenStore } = await import('./auth/agent-tokens.js');
      agentTokenStore = new AgentTokenStore(storage.getPool());
      await agentTokenStore.initialize();

      const { PersonalNotesStorage } = await import('./notes/storage.js');
      const { NotesManager } = await import('./notes/manager.js');
      const notesStorage = new PersonalNotesStorage(storage.getPool());
      notesManager = new NotesManager(notesStorage, memoryManager.getVectorStore() ?? undefined, memoryManager.getEmbeddingProvider() ?? undefined);

      const { SessionStorage } = await import('./sessions/storage.js');
      const { SessionManager } = await import('./sessions/manager.js');
      const sessionStorage = new SessionStorage(storage.getPool());
      sessionManager = new SessionManager(sessionStorage, memoryManager.getVectorStore() ?? undefined, memoryManager.getEmbeddingProvider() ?? undefined);

      logger.info('Agent tokens, notes, and sessions managers initialized (stdio)');
    }

    // Create and start MCP server (after all managers are ready)
    const mcpServer = new TeamMemoryMCPServer(memoryManager, agentTokenStore, notesManager, sessionManager);
    await mcpServer.start();

    if (config.autoArchiveEnabled) {
      const decayConfig = config.decayThreshold !== undefined
        ? { threshold: config.decayThreshold, decayDays: config.decayDays, weights: config.decayWeights }
        : undefined;
      memoryManager.startAutoArchive(config.autoArchiveDays, undefined, decayConfig);
      logger.info({ days: config.autoArchiveDays, decay: !!decayConfig }, 'Auto-archive enabled');
    }

    logger.info('MCP Server ready. Waiting for commands...');

    let isShuttingDown = false;
    const shutdownStdio = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.info({ signal }, 'Shutting down stdio server');
      await memoryManager.close();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdownStdio('SIGINT'));
    process.on('SIGTERM', () => shutdownStdio('SIGTERM'));
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}
